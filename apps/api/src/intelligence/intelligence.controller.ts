import { ZodBody } from '../common/zod-swagger.js';
import rl from './rl-policy.json' with { type: 'json' };
import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  Req,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { DataSource } from 'typeorm';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { AuthGuard, Roles, type AuthedRequest } from '../auth/auth.guard.js';
import {
  AuditEntry,
  DemandRecord,
  InventorySnapshot,
} from '../common/entities.js';
import { ExplainService } from '../explain/explain.service.js';
import { MODEL_VERSION, ensembleForecast } from '../forecast/ensemble.js';
import { ForecastService } from '../forecast/forecast.service.js';
import { IngestionService } from '../ingestion/ingestion.service.js';
import { parseSimTime } from '../simulator/simulator.schemas.js';
import { StateService } from '../state/state.service.js';
import type { NetworkSnapshot } from '../state/state.types.js';
import { retrieve } from './retrieval.js';
import { comparePolicies } from './counterfactual.js';
import { depotSupplyRisk } from './supply-risk.js';
import { operationalInfo, predict, transportFeatures } from '../forecast/operational.js';
import { trainedModelInfo } from '../forecast/trained.js';
import { CopilotService } from './copilot.service.js';

const CounterfactualSchema = z.object({
  demandMultiplier: z.number().min(1).max(5).default(1.5),
  delayTicks: z.number().int().min(0).max(24).default(2),
});
const InvestigateSchema = z.object({ question: z.string().min(3).max(1000) });

@ApiTags('intelligence')
@Controller('intelligence')
export class IntelligenceController {
  constructor(
    private readonly state: StateService,
    private readonly forecast: ForecastService,
    private readonly explain: ExplainService,
    private readonly audit: AuditService,
    private readonly db: DataSource,
    private readonly ingestion: IngestionService,
    private readonly copilot: CopilotService,
  ) {}

  @Get('knowledge')
  knowledge(@Query('q') q = 'allocation constraints human review') {
    return retrieve(q.slice(0, 1000));
  }

  @Get('models')
  models() {
    const trained = trainedModelInfo();
    const operational = operationalInfo();
    return {
      demandForecast: { engine: trained.available ? 'trained tree ensemble (Random Forest + Extra Trees + Gradient Boosting)' : 'statistical ensemble', version: trained.version, fallback: `${MODEL_VERSION} statistical ensemble (first 12 ticks, out-of-range inputs, artifact errors)`, error: trained.error },
      operational: { version: operational.version, available: operational.available, error: operational.error, tasks: Object.fromEntries(Object.entries(operational.tasks).map(([k, t]) => [k, { models: t.models, weights: t.weights, unit: (t.report as { unit?: string }).unit, label: (t.report as { label?: string }).label }])) },
      version: trained.version ?? MODEL_VERSION,
      models: ['seasonal_ewma', 'local_mean', 'seasonal_regression'],
      selection:
        'Inverse rolling-origin MAE ensemble; last 24 holdout targets, no future observations in fitting',
      uncertainty:
        'Empirical residual intervals widened by forecast horizon and detected drift; not calibrated stockout probabilities',
      drift:
        'Recent 8 normalized observations versus previous 32; relative shift above 30%',
      agent: {
        model: this.copilot.model,
        enabled: this.copilot.enabled,
        tools: ['get_network_overview', 'get_network_runway', 'get_stockout_risk', 'get_decision_queue', 'simulate_allocation', 'compare_policies', 'get_depot_runway', 'search_playbook', 'search_incident_memory'],
        retrieval: 'BM25 over organizer documents (playbook) and platform alerts/audit history (incident memory)',
      },
      gpt: {
        configured: this.explain.llmEnabled,
        lastError: this.explain.lastError,
        requests: this.explain.requests,
        fallbacks: this.explain.fallbacks,
      },
      humanApprovalRequired: 'for exceptions (NEEDS_REVIEW); routine resupply may run on autopilot within hard guardrails',
    };
  }

  /** Live model quality from real simulator history (rolling-origin, no future leakage). */
  @Get('model-quality')
  async modelQuality() {
    const s = await this.state.get();
    if (!s) throw new ServiceUnavailableException('No simulator state');
    return { version: MODEL_VERSION, tick: s.instance.tick, rows: await this.qualityRows(s) };
  }

  private async qualityRows(s: NetworkSnapshot) {
    const rows: {
      station: string;
      fuel: string;
      samples: number;
      mae: Record<string, number>;
      weights: Record<string, number>;
      drift: boolean;
      driftScore: number;
      meanDemand: number;
    }[] = [];
    for (const station of s.stations)
      for (const fuel of ['DIESEL', 'PETROL', 'OCTANE'] as const) {
        const history = await this.ingestion.history(station.id, fuel);
        const model = ensembleForecast(
          {
            profile: station.demand_profile,
            fuel,
            regionFactor: s.regions.find((r) => r.id === station.region_id)?.demand_factor ?? 1,
            demandMultiplier: station.demand_multiplier,
            tickMinutes: s.instance.tick_minutes,
            startTime: new Date(parseSimTime(s.instance.sim_time).getTime() + s.instance.tick_minutes * 60_000),
            history,
          },
          24,
        );
        const recent = history.slice(-24);
        const meanDemand = recent.reduce((acc, h) => acc + h.demand, 0) / Math.max(1, recent.length);
        rows.push({ station: station.id, fuel, samples: model.validationSamples, mae: model.validationMae, weights: model.weights, drift: model.drift, driftScore: model.driftScore, meanDemand });
      }
    return rows;
  }

  @Get('memory')
  memory(@Query('q') q = 'shortage') {
    return this.copilot.searchMemory(q.slice(0, 500), 8);
  }

  @Get('rl')
  rlExperiment() {
    const { qTable: _table, ...report } = rl;
    return report;
  }

  @ZodBody(CounterfactualSchema, { demandMultiplier: 1.5, delayTicks: 2 })
  @Post('counterfactual')
  async counterfactual(@Body() body: unknown) {
    const opts = CounterfactualSchema.parse(body ?? {});
    const s = await this.state.get();
    if (!s || s.meta.stale) throw new ServiceUnavailableException('Fresh state required for counterfactual evaluation');
    return comparePolicies(s, await this.forecast.assess(s), opts.demandMultiplier, opts.delayTicks);
  }

  @Get('experiments')
  experiments() {
    return this.db.getRepository(AuditEntry).find({ where: { action: 'intelligence.experiment' }, order: { id: 'DESC' }, take: 30 });
  }

  @Get('replay')
  async replay(@Query('tick') value?: string) {
    const tick = z.coerce.number().int().min(0).parse(value ?? 0);
    const inventory = await this.db.getRepository(InventorySnapshot).find({ where: { tick } });
    const demand = await this.db.getRepository(DemandRecord).find({ where: { tick } });
    return { tick, inventory, demand, kind: 'Recorded observation replay; does not rewind the official simulator' };
  }

  @Get('regional-demand')
  async regional() {
    const s = await this.state.get();
    if (!s) throw new ServiceUnavailableException('No simulator state');
    const rows = await this.db.getRepository(DemandRecord).createQueryBuilder('d').where('d.tick >= :tick', { tick: Math.max(0, s.instance.tick - 96) }).getMany();
    const groups = new Map<string, { tick: number; region: string; demand: number; unmet: number }>();
    for (const d of rows) {
      const region = s.stations.find((x) => x.id === d.stationId)?.region_id ?? 'unknown';
      const key = `${d.tick}:${region}`;
      const g = groups.get(key) ?? { tick: d.tick, region, demand: 0, unmet: 0 };
      g.demand += d.demand;
      g.unmet += d.unmet;
      groups.set(key, g);
    }
    return [...groups.values()].sort((a, b) => a.tick - b.tick);
  }

  @Get('supply-risk')
  async supplyRisk() {
    const s = await this.state.get();
    if (!s) throw new ServiceUnavailableException('No simulator state');
    return { rows: depotSupplyRisk(s, await this.forecast.assess(s)), assumption: 'Demand burden split equally across reachable depots; supply timing comes from simulator planned ticks.' };
  }

  @Get('transport')
  async transport() {
    const s = await this.state.get();
    if (!s) throw new ServiceUnavailableException('No simulator state');
    return s.routes.map((r) => {
      const delays = s.allocations
        .filter((a) => a.route_id === r.id && a.actual_arrival_tick !== null && a.expected_arrival_tick !== null)
        .map((a) => Math.max(0, a.actual_arrival_tick! - a.expected_arrival_tick!));
      const meanDelay = delays.reduce((v, x) => v + x, 0) / Math.max(1, delays.length);
      const depot = s.depots.find((d) => d.id === r.source_depot_id);
      const load = s.allocations.filter((a) => a.source_depot_id === r.source_depot_id && a.status === 'PENDING').reduce((x, a) => x + a.quantity, 0) / Math.max(1, depot?.dispatch_capacity_per_tick ?? 1);
      let mlDelay: number | null = null;
      try {
        const hour = parseSimTime(s.instance.sim_time).getUTCHours();
        mlDelay = Math.max(0, Math.round(predict('transport_delay', transportFeatures(r.transit_ticks, hour, depot?.status === 'CONSTRAINED', load, meanDelay, delays.length)) * 100) / 100);
      } catch {
        mlDelay = null;
      }
      return {
        routeId: r.id,
        mlPredictedDelayTicks: mlDelay,
        samples: delays.length,
        transitTicks: r.transit_ticks,
        meanObservedDelayTicks: meanDelay,
        estimatedArrivalTick: r.status === 'AVAILABLE' ? s.instance.tick + 1 + r.transit_ticks + Math.ceil(meanDelay) : null,
        method: delays.length ? 'Nominal transit plus historical mean arrival delay' : 'Cold-start nominal transit; no observed delay samples',
        status: r.status,
      };
    });
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('operator')
  @ZodBody(InvestigateSchema, { question: 'What needs my attention right now, and what should I approve first?' })
  @Throttle({ default: { limit: 12, ttl: 60000 } })
  @Post('investigate')
  async investigate(@Body() body: unknown, @Req() req: AuthedRequest) {
    const { question } = InvestigateSchema.parse(body);
    const result = await this.copilot.ask(question);
    await this.audit.record(req.user.sub, 'intelligence.investigation', null, { question, tick: result.tick, source: result.source, tools: result.trace.map((t) => t.tool), elapsedMs: result.elapsedMs });
    return result;
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('operator')
  @Post('evaluate')
  async evaluate(@Req() req: AuthedRequest) {
    const s = await this.state.get();
    if (!s) throw new ServiceUnavailableException('No simulator state');
    const rows = await this.qualityRows(s);
    const result = {
      version: MODEL_VERSION,
      tick: s.instance.tick,
      evaluatedAt: new Date().toISOString(),
      rows,
      limitation: 'Rolling one-step model validation; no claim of out-of-sample ensemble superiority or real-world accuracy.',
    };
    await this.audit.record(req.user.sub, 'intelligence.experiment', MODEL_VERSION, result);
    return result;
  }
}
