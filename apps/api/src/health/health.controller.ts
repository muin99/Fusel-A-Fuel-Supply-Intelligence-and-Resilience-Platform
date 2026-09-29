import { SkipThrottle } from '@nestjs/throttler';
import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { DataSource } from 'typeorm';
import { CacheService } from '../common/redis.module.js';
import { DecisionService } from '../decision/decision.service.js';
import { ExplainService } from '../explain/explain.service.js';
import { ForecastService } from '../forecast/forecast.service.js';
import { MetricsService } from '../metrics/metrics.service.js';
import { SimulatorClient } from '../simulator/simulator.client.js';
import { SimulatorStream } from '../simulator/simulator.stream.js';
import { StateService } from '../state/state.service.js';

type Status = 'healthy' | 'degraded' | 'down';
interface Component {
  name: string;
  status: Status;
  detail?: string;
}

async function timed<T>(fn: () => Promise<T>, ms = 1500): Promise<T> {
  return Promise.race([fn(), new Promise<T>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
}

@ApiTags('health')
@Controller('health')
@SkipThrottle()
export class HealthController {
  constructor(
    private readonly db: DataSource,
    private readonly cache: CacheService,
    private readonly sim: SimulatorClient,
    private readonly stream: SimulatorStream,
    private readonly state: StateService,
    private readonly forecast: ForecastService,
    private readonly decisions: DecisionService,
    private readonly explain: ExplainService,
    private readonly metrics: MetricsService,
  ) {}

  /** Liveness: process is up. Used by Docker/K8s. */
  @Get('live')
  live() {
    return { status: 'ok' };
  }

  /** Full component status for the operator "System Status" panel (problem statement §15). */
  @Get()
  async status() {
    const components: Component[] = [{ name: 'Backend API', status: 'healthy' }];

    try {
      await timed(() => this.db.query('SELECT 1'));
      components.push({ name: 'Database', status: 'healthy' });
    } catch (e) {
      components.push({ name: 'Database', status: 'down', detail: (e as Error).message });
    }

    components.push((await this.cache.ping()) ? { name: 'Cache (Redis)', status: 'healthy' } : { name: 'Cache (Redis)', status: 'degraded', detail: 'unreachable — running without cache' });

    try {
      const h = await timed(() => this.sim.health());
      const circuit = this.sim.circuitState;
      const snap = this.state.current();
      const status: Status = circuit === 'open' ? 'down' : circuit === 'half-open' || snap?.meta.stale ? 'degraded' : 'healthy';
      components.push({
        name: 'Fuel Simulator',
        status,
        detail: `${h.simulation.status} tick ${h.simulation.tick}; circuit ${circuit}${snap?.meta.stale ? '; data stale' : ''}`,
      });
    } catch (e) {
      components.push({ name: 'Fuel Simulator', status: 'down', detail: (e as Error).message });
    }
    components.push({ name: 'Simulator Stream', status: this.stream.connected ? 'healthy' : 'degraded', detail: this.stream.connected ? 'connected' : 'reconnecting — polling fallback' });

    components.push({
      name: 'Prediction Service',
      status: !this.forecast.available ? 'down' : this.forecast.lastError ? 'degraded' : 'healthy',
      detail: this.forecast.lastError ?? (this.forecast.lastRunAt ? `last run ${this.forecast.lastRunAt.toISOString()}` : 'waiting for data'),
    });
    components.push({
      name: 'Decision Engine',
      status: this.decisions.lastError ? 'degraded' : 'healthy',
      detail: this.decisions.lastError ?? `policy ${this.decisions.lastPolicy ?? 'n/a'}${this.decisions.forcedPolicy ? ` (forced ${this.decisions.forcedPolicy})` : ''}`,
    });
    components.push({ name: 'GenAI Explainer', status: this.explain.llmEnabled && !this.explain.lastError ? 'healthy' : 'degraded', detail: this.explain.lastError ?? (this.explain.llmEnabled ? 'GPT configured; requests ' + this.explain.requests : 'template fallback (no API key)') });

    const overall: Status = components.some((c) => c.status === 'down') ? 'down' : components.some((c) => c.status === 'degraded') ? 'degraded' : 'healthy';
    return { status: overall, components, ...this.metrics.rollingStats(), checkedAt: new Date().toISOString() };
  }
}
