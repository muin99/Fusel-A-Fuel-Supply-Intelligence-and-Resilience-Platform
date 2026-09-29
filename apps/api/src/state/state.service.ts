import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { Interval } from '@nestjs/schedule';
import { CacheService } from '../common/redis.module.js';
import { MetricsService } from '../metrics/metrics.service.js';
import { SimulatorClient } from '../simulator/simulator.client.js';
import type { NetworkSnapshot } from './state.types.js';

const CACHE_KEY = 'network:snapshot';
const MIN_REFRESH_GAP_MS = 400;

/**
 * Keeps the latest NetworkSnapshot.
 * Triggers: SSE tick/allocation/inventory hints (throttled) + a 3s polling backstop.
 * Emits `network.updated` for the intelligence pipeline and the UI stream.
 */
@Injectable()
export class StateService implements OnModuleInit {
  private readonly log = new Logger(StateService.name);
  private snapshot: NetworkSnapshot | null = null;
  private refreshing: Promise<NetworkSnapshot | null> | null = null;
  private lastRefresh = 0;

  constructor(
    private readonly sim: SimulatorClient,
    private readonly cache: CacheService,
    private readonly events: EventEmitter2,
    private readonly metrics: MetricsService,
  ) {}

  async onModuleInit() {
    // Warm start from Redis so the UI has something to show even if the simulator is down.
    this.snapshot = await this.cache.getJson<NetworkSnapshot>(CACHE_KEY);
    if (this.snapshot) this.snapshot.meta = { ...this.snapshot.meta, stale: true, degraded: true };
    void this.refresh();
  }

  current(): NetworkSnapshot | null {
    return this.snapshot;
  }

  async get(): Promise<NetworkSnapshot | null> {
    return this.snapshot ?? (await this.refresh());
  }

  @OnEvent('sim.simulation.tick')
  @OnEvent('sim.allocation.status_changed')
  @OnEvent('sim.inventory.updated')
  @OnEvent('sim.simulator.notice')
  @OnEvent('sim.stream.reconnected')
  onHint() {
    if (Date.now() - this.lastRefresh >= MIN_REFRESH_GAP_MS) void this.refresh();
  }

  @OnEvent('sim.simulator.notice')
  onNotice(payload: { message?: string }) {
    if (/reset/i.test(payload?.message ?? '')) this.events.emit('sim.reset', { notice: payload.message });
  }

  @Interval(3000)
  poll() {
    void this.refresh();
  }

  /** Coalesces concurrent refreshes into one. */
  refresh(): Promise<NetworkSnapshot | null> {
    if (!this.refreshing) {
      this.refreshing = this.doRefresh().finally(() => (this.refreshing = null));
    }
    return this.refreshing;
  }

  private async doRefresh(): Promise<NetworkSnapshot | null> {
    this.lastRefresh = Date.now();
    try {
      const [instance, regions, depots, stations, routes, supply, events, allocations, metrics] = await Promise.all([
        this.sim.instance(),
        this.sim.regions(),
        this.sim.depots(),
        this.sim.stations(),
        this.sim.routes(),
        this.sim.supplyArrivals(),
        this.sim.events_(),
        this.sim.allocations(),
        this.sim.simMetrics(),
      ]);
      const parts = [instance, regions, depots, stations, routes, supply, events, allocations, metrics];
      const prevTick = this.snapshot?.instance.tick;
      const next: NetworkSnapshot = {
        instance: instance.data,
        regions: regions.data,
        depots: depots.data,
        stations: stations.data,
        routes: routes.data,
        supplyArrivals: supply.data,
        events: events.data,
        allocations: allocations.data,
        metrics: metrics.data,
        meta: {
          fetchedAt: new Date().toISOString(),
          // Decision-critical resources must be fresh; slow-changing context (regions, events,
          // supply schedule, KPIs) may briefly come from cache without blocking decisions.
          stale: [instance, depots, stations, routes, allocations].some((p) => p.stale) || parts.some((p) => p.stale && !p.fromCache),
          degraded: parts.every((p) => p.fromCache),
        },
      };
      if (prevTick !== undefined && next.instance.tick < prevTick) {
        this.log.warn(`Simulator tick went backwards (${prevTick} → ${next.instance.tick}): world was reset`);
        this.events.emit('sim.reset', { fromTick: prevTick });
      }
      this.snapshot = next;
      this.metrics.degradedMode.set(next.meta.stale || next.meta.degraded ? 1 : 0);
      this.metrics.simTick.set(next.instance.tick);
      this.metrics.simServiceLevel.set(next.metrics.service_level);
      if (!next.meta.stale) await this.cache.setJson(CACHE_KEY, next);
      this.events.emit('network.updated', { snapshot: next, tickAdvanced: prevTick !== next.instance.tick });
      return next;
    } catch (err) {
      this.log.warn(`State refresh failed: ${(err as Error).message}`);
      if (this.snapshot) this.snapshot.meta = { ...this.snapshot.meta, stale: true, degraded: true };
      this.metrics.degradedMode.set(1);
      return this.snapshot;
    }
  }
}
