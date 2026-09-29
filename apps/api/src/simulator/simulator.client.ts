import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import axios, { AxiosError, AxiosInstance } from 'axios';
import CircuitBreaker from 'opossum';
import { z } from 'zod';
import type { Env } from '../config/env.js';
import { MetricsService } from '../metrics/metrics.service.js';
import { SimulatorError, extractCode } from './simulator.errors.js';
import {
  Allocation,
  AllocationRequest,
  AllocationSchema,
  DemandObservationSchema,
  DepotSchema,
  HealthSchema,
  InjectEventSchema,
  InjectFaultSchema,
  InstanceSchema,
  RegionSchema,
  RouteSchema,
  SimEventSchema,
  SimMetricsSchema,
  StationSchema,
  SupplyArrivalSchema,
} from './simulator.schemas.js';

export interface SimResult<T> {
  data: T;
  /** true when the simulator flagged X-Simulator-Stale or we served last-known-good data */
  stale: boolean;
  /** true when data came from our cache because the simulator failed */
  fromCache: boolean;
}

const RETRYABLE_STATUS = new Set([502, 503, 504]);

/**
 * The ONLY component that talks to the simulator.
 *
 * Resilience layers (problem statement §11, integration guide §10):
 *  1. timeout per attempt
 *  2. retry with exponential backoff + jitter (only for 503 / network / timeout)
 *  3. circuit breaker — stops hammering a dead simulator, fails fast
 *  4. schema validation — invalid response => reject + alert
 *  5. last-known-good cache — reads degrade to cached state instead of failing
 */
@Injectable()
export class SimulatorClient {
  private readonly log = new Logger(SimulatorClient.name);
  private readonly http: AxiosInstance;
  private readonly breaker: CircuitBreaker<[() => Promise<unknown>], unknown>;
  private readonly retries: number;
  private readonly lastGood = new Map<string, { data: unknown; at: number }>();

  constructor(
    config: ConfigService<Env, true>,
    private readonly metrics: MetricsService,
    private readonly events: EventEmitter2,
  ) {
    this.http = axios.create({
      baseURL: config.get('SIMULATOR_URL', { infer: true }),
      timeout: config.get('SIMULATOR_TIMEOUT_MS', { infer: true }),
      validateStatus: () => true, // we classify statuses ourselves
    });
    this.retries = config.get('SIMULATOR_RETRIES', { infer: true });

    this.breaker = new CircuitBreaker((fn: () => Promise<unknown>) => fn(), {
      timeout: false, // per-attempt timeout is handled by axios
      errorThresholdPercentage: 50,
      volumeThreshold: 5,
      resetTimeout: 10_000,
      // domain 4xx errors (e.g. INSUFFICIENT_INVENTORY) are not simulator failures
      errorFilter: (err: unknown) => err instanceof SimulatorError && !err.retryable,
    });
    this.breaker.on('open', () => this.onCircuit('open', 2));
    this.breaker.on('halfOpen', () => this.onCircuit('half-open', 1));
    this.breaker.on('close', () => this.onCircuit('closed', 0));
    this.metrics.simCircuitState.set(0);
  }

  get circuitState(): 'closed' | 'open' | 'half-open' {
    if (this.breaker.opened) return 'open';
    if (this.breaker.halfOpen) return 'half-open';
    return 'closed';
  }

  // ------------------------------------------------------------------ reads
  /** Liveness probe — bypasses faults AND our breaker so it always reflects reality. */
  async health() {
    const res = await this.http.get('/v1/health');
    this.throwIfError(res.status, res.data, '/v1/health');
    return this.parse('/v1/health', HealthSchema, res.data);
  }
  instance() {
    return this.get('/v1/instance', InstanceSchema);
  }
  regions() {
    return this.get('/v1/regions', z.array(RegionSchema));
  }
  depots() {
    return this.get('/v1/depots', z.array(DepotSchema));
  }
  stations() {
    return this.get('/v1/stations', z.array(StationSchema));
  }
  routes() {
    return this.get('/v1/routes', z.array(RouteSchema));
  }
  supplyArrivals() {
    return this.get('/v1/supply-arrivals', z.array(SupplyArrivalSchema));
  }
  events_() {
    return this.get('/v1/events', z.array(SimEventSchema));
  }
  allocations() {
    return this.get('/v1/allocations', z.array(AllocationSchema));
  }
  simMetrics() {
    return this.get('/v1/metrics', SimMetricsSchema);
  }
  demandHistory(params: { station_id?: string; limit?: number } = {}) {
    const limit = Math.min(Math.max(params.limit ?? 200, 1), 2000);
    return this.get('/v1/demand-history', z.array(DemandObservationSchema), {
      params: { ...params, limit },
      cacheKey: `/v1/demand-history?${params.station_id ?? ''}&${limit}`,
    });
  }

  // ----------------------------------------------------------------- writes
  /** Safe to retry: the idempotency_key makes replays return the original allocation. */
  async createAllocation(req: AllocationRequest): Promise<Allocation> {
    return this.call('POST /v1/allocations', async () => {
      const res = await this.http.post('/v1/allocations', req);
      this.throwIfError(res.status, res.data, 'POST /v1/allocations');
      return this.parse('POST /v1/allocations', AllocationSchema, res.data);
    });
  }

  async cancelAllocation(id: number): Promise<Allocation> {
    return this.call('POST /v1/allocations/cancel', async () => {
      const res = await this.http.post(`/v1/allocations/${id}/cancel`);
      this.throwIfError(res.status, res.data, 'cancel');
      return this.parse('cancel', AllocationSchema, res.data);
    });
  }

  // ------------------------------------------ admin (bypasses faults; demo/self-test only)
  admin = {
    run: () => this.adminPost('/admin/run'),
    pause: () => this.adminPost('/admin/pause'),
    step: () => this.adminPost('/admin/step'),
    reset: () => this.adminPost('/admin/reset'),
    clearFaults: () => this.adminPost('/admin/faults/clear'),
    injectEvent: (body: z.input<typeof InjectEventSchema>) =>
      this.adminPost('/admin/events', InjectEventSchema.parse(body)),
    injectFault: (body: z.input<typeof InjectFaultSchema>) =>
      this.adminPost('/admin/faults', InjectFaultSchema.parse(body)),
    faults: () => this.adminGet('/admin/faults'),
    audit: (limit = 200) => this.adminGet('/admin/audit', { limit }),
  };

  // ------------------------------------------------------------- internals
  private async get<S extends z.ZodType>(
    path: string,
    schema: S,
    opts: { params?: Record<string, unknown>; cache?: boolean; cacheKey?: string } = {},
  ): Promise<SimResult<z.infer<S>>> {
    const key = opts.cacheKey ?? path;
    try {
      const { data, stale } = await this.call(`GET ${path}`, async () => {
        const res = await this.http.get(path, { params: opts.params });
        this.throwIfError(res.status, res.data, path);
        const isStale = res.headers['x-simulator-stale'] === 'true';
        if (isStale) this.metrics.simStaleResponses.inc();
        return { data: this.parse(path, schema, res.data), stale: isStale };
      });
      if (opts.cache !== false && !stale) this.lastGood.set(key, { data, at: Date.now() });
      this.metrics.degradedMode.set(0);
      return { data, stale, fromCache: false };
    } catch (err) {
      const cached = opts.cache !== false ? this.lastGood.get(key) : undefined;
      if (cached) {
        this.metrics.degradedMode.set(1);
        this.log.warn(`Serving cached ${path} (age ${Date.now() - cached.at}ms): ${(err as Error).message}`);
        return { data: cached.data as z.infer<S>, stale: true, fromCache: true };
      }
      throw err;
    }
  }

  /** breaker + retry + metrics around one logical call */
  private async call<T>(endpoint: string, fn: () => Promise<T>): Promise<T> {
    const end = this.metrics.simDuration.startTimer({ endpoint });
    try {
      const result = (await this.breaker.fire(() => this.withRetry(fn))) as T;
      this.metrics.simRequests.inc({ endpoint, outcome: 'ok' });
      return result;
    } catch (err) {
      const outcome = this.breaker.opened ? 'circuit_open' : err instanceof SimulatorError ? err.code : 'error';
      this.metrics.simRequests.inc({ endpoint, outcome });
      if (this.breaker.opened && !(err instanceof SimulatorError)) {
        throw new SimulatorError('Simulator circuit open', null, 'CIRCUIT_OPEN', true);
      }
      throw err;
    } finally {
      end();
    }
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let attempt = 0;
    for (;;) {
      try {
        return await fn();
      } catch (err) {
        const e = this.normalise(err);
        if (!e.retryable || attempt >= this.retries) throw e;
        const backoff = Math.min(2000, 100 * 2 ** attempt) * (0.5 + Math.random());
        attempt++;
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
  }

  private normalise(err: unknown): SimulatorError {
    if (err instanceof SimulatorError) return err;
    if (err instanceof AxiosError) {
      return new SimulatorError(err.message, null, err.code === 'ECONNABORTED' ? 'TIMEOUT' : 'NETWORK', true);
    }
    return new SimulatorError(String(err), null, 'UNKNOWN', false);
  }

  private throwIfError(status: number, body: unknown, endpoint: string): void {
    if (status < 400) return;
    const code = extractCode(body) ?? `HTTP_${status}`;
    throw new SimulatorError(`${endpoint} -> ${status} ${code}`, status, code, RETRYABLE_STATUS.has(status));
  }

  private parse<S extends z.ZodType>(endpoint: string, schema: S, body: unknown): z.infer<S> {
    const r = schema.safeParse(body);
    if (!r.success) {
      this.metrics.simInvalidResponses.inc({ endpoint });
      this.events.emit('alert.system', {
        severity: 'critical',
        source: 'simulator',
        message: `Invalid simulator response from ${endpoint}; input rejected`,
        detail: z.prettifyError(r.error),
      });
      throw new SimulatorError(`Invalid response from ${endpoint}`, null, 'INVALID_RESPONSE', false);
    }
    return r.data;
  }

  private async adminPost(path: string, body?: unknown) {
    const res = await this.http.post(path, body);
    this.throwIfError(res.status, res.data, path);
    return res.data as unknown;
  }
  private async adminGet(path: string, params?: Record<string, unknown>) {
    const res = await this.http.get(path, { params });
    this.throwIfError(res.status, res.data, path);
    return res.data as unknown;
  }

  private onCircuit(state: string, value: number) {
    this.metrics.simCircuitState.set(value);
    this.log.warn(`Simulator circuit ${state}`);
    this.events.emit('alert.system', {
      severity: value === 2 ? 'critical' : 'info',
      source: 'simulator',
      message: `Simulator circuit breaker ${state}`,
    });
  }
}
