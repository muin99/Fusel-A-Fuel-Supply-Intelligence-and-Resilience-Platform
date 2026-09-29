import { ZodBody } from '../common/zod-swagger.js';
import { Body, ConflictException, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { AuthGuard, type AuthedRequest, Roles } from '../auth/auth.guard.js';
import { ForecastService } from '../forecast/forecast.service.js';
import { InjectEventSchema, InjectFaultSchema } from '../simulator/simulator.schemas.js';
import { SimulatorClient } from '../simulator/simulator.client.js';
import { StateService } from '../state/state.service.js';
import { DecisionService } from '../decision/decision.service.js';

/** Rejects an identical injection repeated within this window (double clicks stack crises). */
const DUPLICATE_WINDOW_MS = 10_000;

const SimControlSchema = z.object({ action: z.enum(['run', 'pause', 'step', 'reset']) });
const ModelSchema = z.object({ available: z.boolean() });

/**
 * Demo & self-test controls (scenario configuration + failure injection).
 * Operator-only; every action is audited. Operates ONLY on the simulator.
 */
@ApiTags('chaos')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Roles('operator')
@Controller('chaos')
export class ChaosController {
  constructor(
    private readonly sim: SimulatorClient,
    private readonly state: StateService,
    private readonly forecast: ForecastService,
    private readonly audit: AuditService,
    private readonly decisions: DecisionService,
  ) {}

  private recent = new Map<string, number>();

  private guardDuplicate(kind: string, body: unknown) {
    const key = `${kind}:${JSON.stringify(body)}`;
    const now = Date.now();
    for (const [k, at] of this.recent) if (now - at > DUPLICATE_WINDOW_MS) this.recent.delete(k);
    if (this.recent.has(key)) throw new ConflictException('Identical injection already applied in the last 10 s (duplicate click ignored)');
    this.recent.set(key, now);
  }

  /** Live drill posture so the UI can show (and undo) anything left switched on. */
  @Get('status')
  async status() {
    const faults = ((await this.sim.admin.faults().catch(() => [])) as { type: string; active: boolean; end_wall_time?: string }[]).filter((f) => f.active);
    return { predictionAvailable: this.forecast.available, forcedPolicy: this.decisions.forcedPolicy, activeFaults: faults };
  }

  /** One click back to normal: clear faults, restore the model and the optimizer policy. */
  @Post('restore')
  async restore(@Req() req: AuthedRequest) {
    await this.sim.admin.clearFaults();
    this.forecast.available = true;
    this.decisions.forcedPolicy = null;
    await this.audit.record(req.user.sub, 'operations.restored', null, { faultsCleared: true, prediction: 'enabled', policy: 'lp_optimizer' });
    void this.state.refresh();
    return this.status();
  }

  @ZodBody(SimControlSchema, { action: 'step' })
  @Post('simulation')
  async control(@Body() body: unknown, @Req() req: AuthedRequest) {
    const { action } = SimControlSchema.parse(body);
    const res = await this.sim.admin[action]();
    await this.audit.record(req.user.sub, `simulation.${action}`, null);
    void this.state.refresh();
    return res;
  }

  @ZodBody(InjectEventSchema, { type: 'demand_spike', start_tick: 10, duration_ticks: 24, parameters: { region_ids: ['region-dhaka'], multiplier: 1.8 } })
  @Post('events')
  async event(@Body() body: unknown, @Req() req: AuthedRequest) {
    const parsed = InjectEventSchema.parse(body);
    this.guardDuplicate('event', parsed);
    const res = await this.sim.admin.injectEvent(parsed);
    await this.audit.record(req.user.sub, 'event.injected', parsed.type, parsed);
    return res;
  }

  @ZodBody(InjectFaultSchema, { type: 'unavailable', duration_seconds: 45, parameters: {} })
  @Post('faults')
  async fault(@Body() body: unknown, @Req() req: AuthedRequest) {
    const parsed = InjectFaultSchema.parse(body);
    this.guardDuplicate('fault', parsed);
    const res = await this.sim.admin.injectFault(parsed);
    await this.audit.record(req.user.sub, 'fault.injected', parsed.type, parsed);
    return res;
  }

  @Post('faults/clear')
  async clear(@Req() req: AuthedRequest) {
    const res = await this.sim.admin.clearFaults();
    await this.audit.record(req.user.sub, 'fault.cleared', null);
    return res;
  }

  @Get('faults')
  faults() {
    return this.sim.admin.faults();
  }

  /** Simulate "ML model unavailable" to demonstrate the fallback allocation policy. */
  @ZodBody(ModelSchema, { available: false })
  @Post('prediction')
  async prediction(@Body() body: unknown, @Req() req: AuthedRequest) {
    const { available } = ModelSchema.parse(body);
    if (this.forecast.available === available) return { available, unchanged: true };
    this.forecast.available = available;
    await this.audit.record(req.user.sub, available ? 'prediction.enabled' : 'prediction.disabled', null);
    return { available };
  }
}
