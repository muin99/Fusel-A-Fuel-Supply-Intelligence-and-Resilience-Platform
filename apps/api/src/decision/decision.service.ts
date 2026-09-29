import { Injectable, Logger, NotFoundException, ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service.js';
import { Recommendation } from '../common/entities.js';
import type { Env } from '../config/env.js';
import { DetectionService } from '../detection/detection.service.js';
import { ExplainService } from '../explain/explain.service.js';
import { ForecastService, RiskItem } from '../forecast/forecast.service.js';
import { MetricsService } from '../metrics/metrics.service.js';
import { SimulatorError } from '../simulator/simulator.errors.js';
import { SimulatorClient } from '../simulator/simulator.client.js';
import type { NetworkSnapshot } from '../state/state.types.js';
import { StateService } from '../state/state.service.js';
import { RequestsService } from '../requests/requests.service.js';
import { blockingReasons, reviewReasons } from './feasibility.js';
import { Problem, Proposal, alternatives, buildProblem, heuristicPolicy, lpPolicy, riskAfter, shortfallImpact } from './policies.js';

export { MAX_REC_AGE_TICKS, blockingReasons, reviewReasons } from './feasibility.js';

const PIPELINE_MIN_GAP_MS = 2000;
const MAX_DISPATCH_ATTEMPTS = 5;

/** Decisions only need recomputing when something decision-relevant changed. */
function worldKey(s: NetworkSnapshot, predictionUp: boolean, forced: string | null): string {
  return [
    s.instance.tick,
    s.meta.stale,
    predictionUp,
    forced,
    s.allocations.map((a) => `${a.id}:${a.status}`).join(','),
    s.routes.map((r) => r.status).join(','),
    s.stations.map((x) => x.status).join(','),
    s.depots.map((d) => d.status).join(','),
  ].join('|');
}
const OPEN: Recommendation['status'][] = ['PROPOSED', 'NEEDS_REVIEW'];

/**
 * The Observe → Detect → Predict → Decide → Act loop.
 * Runs after each state refresh (throttled). Management by exception:
 *  - routine recommendations (PROPOSED) dispatch automatically when autopilot is on;
 *  - exceptions (NEEDS_REVIEW, with stated reasons) always wait for an authenticated operator.
 * Every dispatch passes the hard feasibility gate against fresh state and is audited.
 */
@Injectable()
export class DecisionService {
  private readonly log = new Logger(DecisionService.name);
  private running = false;
  private lastRun = 0;
  lastRunAt: Date | null = null;
  lastPolicy: string | null = null;
  lastError: string | null = null;
  /** operator can force the heuristic (policy rollback) */
  forcedPolicy: 'lp_optimizer' | 'heuristic' | null = null;
  /** routine recommendations dispatch without a click; toggled by operators at runtime */
  autopilot: boolean;
  readonly minConfidence: number;
  /** fingerprint of the world the last decisions were made on */
  private lastKey: string | null = null;
  private historyRevision = 0;
  private predictionDownAlerted = false;
  private attempts = new Map<string, number>();

  constructor(
    @InjectRepository(Recommendation) private readonly recs: Repository<Recommendation>,
    private readonly forecast: ForecastService,
    private readonly detection: DetectionService,
    private readonly explain: ExplainService,
    private readonly sim: SimulatorClient,
    private readonly audit: AuditService,
    private readonly metrics: MetricsService,
    private readonly events: EventEmitter2,
    config: ConfigService<Env, true>,
    private readonly state: StateService,
    private readonly requests: RequestsService,
  ) {
    this.autopilot = config.get('AUTO_DISPATCH', { infer: true });
    this.minConfidence = config.get('MIN_CONFIDENCE_FOR_AUTO', { infer: true });
  }

  @OnEvent('sim.reset')
  async onReset() {
    this.lastKey = null;
    this.attempts.clear();
    await this.recs.update({ status: In([...OPEN, 'APPROVED']) }, { status: 'EXPIRED' });
    await this.audit.record('system', 'simulation.reset.detected', null);
  }

  @OnEvent('history.updated')
  onHistory() {
    this.historyRevision++;
  }

  @OnEvent('network.updated')
  async onNetwork({ snapshot }: { snapshot: NetworkSnapshot }) {
    if (this.running || Date.now() - this.lastRun < PIPELINE_MIN_GAP_MS) return;
    const key = `${worldKey(snapshot, this.forecast.available, this.forcedPolicy)}|${this.historyRevision}|${this.autopilot}`;
    if (key === this.lastKey) return; // nothing changed since the last decision
    this.running = true;
    this.lastRun = Date.now();
    try {
      await this.runPipeline(snapshot);
      this.lastKey = key;
    } catch (e) {
      this.lastError = (e as Error).message;
      this.log.error(`pipeline failed: ${this.lastError}`);
    } finally {
      this.running = false;
    }
  }

  async runPipeline(s: NetworkSnapshot) {
    // PREDICT (with fallback if the model is unavailable)
    let risk: RiskItem[] | null = null;
    try {
      risk = await this.forecast.assess(s);
      if (this.predictionDownAlerted) {
        this.predictionDownAlerted = false;
        this.events.emit('alert.recovery', { kind: 'recovery', severity: 'info', source: 'prediction', message: 'Prediction model restored: optimizer policy resumed' });
      }
    } catch (e) {
      this.metrics.decisionFallback.inc({ reason: 'prediction_unavailable' });
      if (!this.predictionDownAlerted) {
        this.predictionDownAlerted = true;
        this.events.emit('alert.system', { severity: 'warning', source: 'prediction', message: `Prediction unavailable: fallback reorder-point policy active (${(e as Error).message})` });
      }
    }

    // DETECT
    this.detection.evaluate(s, risk);

    // Stale data => don't decide on it (show, but don't act)
    if (s.meta.stale) {
      this.log.warn('Skipping decisions: network state is stale');
      return;
    }

    // DECIDE (model risk + station requests as demand signals)
    await this.requests.sync(s);
    const problem = buildProblem(s, risk, await this.requests.signals());
    const { proposals, policy } = this.decide(problem, risk === null);
    this.lastPolicy = policy;
    this.lastRunAt = new Date();
    this.lastError = null;

    // Keep IDs stable: update an open recommendation for the same (station, fuel, route)
    // in place, and expire only the ones no longer proposed.
    const reserved = await this.recs.find({ where: { status: 'APPROVED' } });
    const existing = await this.recs.find({ where: { status: In(OPEN) } });
    const byTarget = new Map(existing.map((r) => [`${r.stationId}|${r.fuelType}|${r.routeId}`, r]));
    const riskByKey = new Map((risk ?? []).map((r) => [`${r.stationId}:${r.fuel}`, r]));
    const saved: Recommendation[] = [];
    for (const p of proposals) {
      if (reserved.some((r) => r.stationId === p.stationId && r.fuelType === p.fuel)) continue;
      const r = riskByKey.get(`${p.stationId}:${p.fuel}`);
      const confidence = r ? r.forecast.confidence : 0.5;
      const prev = byTarget.get(`${p.stationId}|${p.fuel}|${p.routeId}`);
      byTarget.delete(`${p.stationId}|${p.fuel}|${p.routeId}`);
      const review = reviewReasons(
        { policy, confidence, depotId: p.depotId, stationId: p.stationId, demandLevel: r?.forecast.level ?? null, drift: (r?.forecast as { drift?: boolean } | undefined)?.drift ?? false },
        s,
        this.minConfidence,
      );
      const rec = this.recs.create({
        ...(prev ? { id: prev.id, createdAt: prev.createdAt } : {}),
        tick: s.instance.tick,
        stationId: p.stationId,
        fuelType: p.fuel,
        depotId: p.depotId,
        routeId: p.routeId,
        quantity: p.quantity,
        policy,
        confidence,
        riskBefore: p.need.riskBefore,
        riskAfter: riskAfter(p, r, s.instance.tick_minutes),
        hoursToStockout: p.need.hoursToStockout,
        rationale: {
          signals: p.need.signals,
          need: Math.round(p.need.need),
          headroom: Math.round(p.need.headroom),
          transitTicks: p.transitTicks,
          constraints: problem.constraints,
          alternatives: alternatives(p, problem),
          reviewReasons: review,
          requestId: p.need.requestId ?? null,
          shortfall: shortfallImpact(p, r),
        },
        status: review.length ? 'NEEDS_REVIEW' : 'PROPOSED',
      });
      rec.explanation = this.explain.template(rec);
      if (prev) {
        // A concurrent approval must freeze its payload and idempotency key.
        const { id: _id, createdAt: _created, ...values } = rec;
        const updated = await this.recs.update({ id: prev.id, status: In(OPEN) }, values as unknown as Parameters<Repository<Recommendation>['update']>[1]);
        if (!updated.affected) continue;
        saved.push(await this.get(prev.id));
      } else {
        saved.push(await this.recs.save(rec));
        this.metrics.decisions.inc({ policy, outcome: 'proposed' });
      }
    }
    const stale = [...byTarget.values()].map((r) => r.id);
    if (stale.length) await this.recs.update({ id: In(stale), status: In(OPEN) }, { status: 'EXPIRED' });

    // ACT: finish ambiguous dispatches (same idempotency key => never a duplicate shipment)
    for (const r of reserved) await this.dispatch(r, r.decidedBy ?? 'autopilot', s, problem);
    // ACT: autopilot handles routine recommendations; exceptions stay in the operator queue.
    if (this.autopilot) {
      for (const rec of saved.filter((x) => x.status === 'PROPOSED')) {
        const res = await this.recs.update({ id: rec.id, status: 'PROPOSED' }, { status: 'APPROVED', decidedBy: 'autopilot' });
        if (res.affected) await this.dispatch(await this.get(rec.id), 'autopilot', s, problem);
      }
    }
    if (saved.length) this.events.emit('ui.recommendations', { count: saved.length, tick: s.instance.tick });
  }

  /** LP optimizer first; on failure fall back to the greedy heuristic. */
  decide(problem: Problem, predictionDown: boolean): { proposals: Proposal[]; policy: string } {
    if (predictionDown) return { proposals: heuristicPolicy(problem), policy: 'heuristic_fallback' };
    if (this.forcedPolicy === 'heuristic') return { proposals: heuristicPolicy(problem), policy: 'heuristic' };
    try {
      return { proposals: lpPolicy(problem), policy: 'lp_optimizer' };
    } catch (e) {
      this.metrics.decisionFallback.inc({ reason: 'optimizer_error' });
      this.log.warn(`optimizer failed (${(e as Error).message}); using heuristic`);
      return { proposals: heuristicPolicy(problem), policy: 'heuristic_fallback' };
    }
  }

  async setAutopilot(enabled: boolean, actor: string) {
    this.autopilot = enabled;
    this.lastKey = null; // re-run the pipeline so the change takes effect immediately
    await this.audit.record(actor, enabled ? 'autopilot.enabled' : 'autopilot.disabled', null);
    void this.state.refresh();
    return this.status();
  }

  async status() {
    const open = await this.recs.count({ where: { status: In(OPEN) } });
    const review = await this.recs.count({ where: { status: 'NEEDS_REVIEW' } });
    return {
      autopilot: this.autopilot,
      minConfidence: this.minConfidence,
      forcedPolicy: this.forcedPolicy,
      predictionAvailable: this.forecast.available,
      lastPolicy: this.lastPolicy,
      lastRunAt: this.lastRunAt,
      lastError: this.lastError,
      openRecommendations: open,
      needsReview: review,
    };
  }

  list(status?: string, limit = 50) {
    const statuses = status?.split(',').filter(Boolean) as Recommendation['status'][] | undefined;
    return this.recs.find({
      where: statuses?.length ? { status: In(statuses) } : {},
      order: { createdAt: 'DESC' },
      take: Math.min(limit, 200),
    });
  }

  async get(id: string) {
    const r = await this.recs.findOneBy({ id });
    if (!r) throw new NotFoundException('Recommendation not found');
    return r;
  }

  async reject(id: string, actor: string, reason?: string) {
    const r = await this.get(id);
    if (!OPEN.includes(r.status)) throw new ConflictException(`Cannot reject a ${r.status} recommendation`);
    r.status = 'REJECTED';
    r.decidedBy = actor;
    await this.recs.save(r);
    this.metrics.decisions.inc({ policy: r.policy, outcome: 'rejected' });
    await this.audit.record(actor, 'recommendation.rejected', id, { reason });
    return r;
  }

  /** Operator approval: re-validate against fresh state, then dispatch. */
  async execute(id: string, actor: string) {
    const r = await this.get(id);
    if (r.status === 'SUBMITTED') return r;
    if (!OPEN.includes(r.status) && r.status !== 'APPROVED') throw new ConflictException(`This recommendation is ${r.status}; it can no longer be approved`);
    const snapshot = await this.state.refresh();
    if (!snapshot) throw new ConflictException('Simulator state unavailable; try again shortly');
    const problem = buildProblem(snapshot, null);
    const blocked = blockingReasons(r, snapshot, problem);
    if (blocked.length) throw new ConflictException({ message: `Cannot dispatch: ${blocked.join('; ')}`, reasons: blocked });
    if (OPEN.includes(r.status)) {
      const res = await this.recs.update({ id, status: In(OPEN) }, { status: 'APPROVED', decidedBy: actor });
      if (!res.affected) throw new ConflictException('Recommendation changed during approval; review it again');
    }
    await this.audit.record(actor, 'recommendation.approved', id, { quantity: r.quantity, routeId: r.routeId, reviewReasons: (r.rationale as Record<string, unknown>).reviewReasons ?? [] });
    return this.dispatch(await this.get(id), actor, snapshot, problem);
  }

  /** Sends a frozen APPROVED recommendation to the simulator with a stable idempotency key. */
  private async dispatch(r: Recommendation, actor: string, s: NetworkSnapshot, problem: Problem): Promise<Recommendation> {
    if (r.status !== 'APPROVED') return r;
    const attempt = (this.attempts.get(r.id) ?? 0) + 1;
    this.attempts.set(r.id, attempt);
    const blocked = blockingReasons(r, s, problem).filter((x) => !x.startsWith('DISPATCH_CAPACITY') && !x.startsWith('EXPIRED'));
    if (blocked.length && attempt > 1) {
      // Only abandon an ambiguous earlier attempt once the world makes it impossible.
      r.status = 'FAILED';
      r.error = blocked[0].split(':')[0];
      this.attempts.delete(r.id);
      await this.audit.record(actor, 'allocation.abandoned', r.id, { reasons: blocked });
      return this.recs.save(r);
    }
    try {
      const alloc = await this.sim.createAllocation({
        idempotency_key: `rec-${r.id}`,
        source_depot_id: r.depotId,
        destination_station_id: r.stationId,
        route_id: r.routeId,
        fuel_type: r.fuelType as 'DIESEL',
        quantity: r.quantity,
      });
      r.status = 'SUBMITTED';
      r.simAllocationId = alloc.id;
      r.error = null;
      this.attempts.delete(r.id);
      // keep the depot budget honest for the rest of this pipeline run
      problem.dispatchRemaining.set(r.depotId, (problem.dispatchRemaining.get(r.depotId) ?? 0) - r.quantity);
      this.metrics.decisions.inc({ policy: r.policy, outcome: actor === 'autopilot' ? 'auto_submitted' : 'submitted' });
      await this.audit.record(actor, 'allocation.submitted', r.id, { allocationId: alloc.id, quantity: r.quantity, stationId: r.stationId, fuel: r.fuelType, routeId: r.routeId });
    } catch (e) {
      // Ambiguous transport failure may have been accepted: keep APPROVED and retry the
      // frozen payload with the same key on the next run (bounded attempts).
      const retryable = e instanceof SimulatorError && (e.retryable || e.code === 'INVALID_RESPONSE' || e.code === 'CIRCUIT_OPEN');
      r.error = e instanceof SimulatorError ? e.code : (e as Error).message;
      if (!retryable || attempt >= MAX_DISPATCH_ATTEMPTS) {
        r.status = 'FAILED';
        this.attempts.delete(r.id);
        this.metrics.decisions.inc({ policy: r.policy, outcome: 'failed' });
        this.events.emit('alert.decision', { severity: 'warning', entityId: r.stationId, message: `Dispatch to ${r.stationId} ${r.fuelType} rejected by simulator: ${r.error}` });
      }
      await this.audit.record(actor, r.status === 'APPROVED' ? 'allocation.retry_pending' : 'allocation.failed', r.id, { error: r.error, attempt });
    }
    return this.recs.save(r);
  }

  async explainWithLlm(id: string) {
    const r = await this.get(id);
    const res = await this.explain.explainRecommendation(r);
    r.explanation = res.text;
    await this.recs.save(r);
    return res;
  }

  /** What-if: risk before/after for a hypothetical allocation — no side effects. */
  async whatIf(s: NetworkSnapshot, q: { stationId: string; fuel: string; routeId: string; quantity: number }) {
    const risk = await this.forecast.assess(s);
    const item = risk.find((r) => r.stationId === q.stationId && r.fuel === q.fuel);
    const route = s.routes.find((r) => r.id === q.routeId);
    if (!item || !route) throw new NotFoundException('Unknown station/fuel/route');
    const problem = buildProblem(s, risk);
    const warnings = blockingReasons(
      { stationId: q.stationId, fuelType: q.fuel, depotId: route.source_depot_id, routeId: route.id, quantity: q.quantity, tick: s.instance.tick },
      s,
      problem,
    ).map((x) => x.split(':')[0]);
    if (item.inventory + item.inTransit + q.quantity > item.capacity && !warnings.includes('DESTINATION_CAPACITY_EXCEEDED')) warnings.push('OVERFILL_ON_ARRIVAL');
    const need = { riskBefore: item.assessment.probability, need: q.quantity } as Proposal['need'];
    const after = riskAfter(
      { stationId: q.stationId, fuel: item.fuel, depotId: route.source_depot_id, routeId: route.id, quantity: q.quantity, transitTicks: route.transit_ticks, need },
      item,
      s.instance.tick_minutes,
    );
    return {
      riskBefore: item.assessment.probability,
      riskAfter: warnings.length ? item.assessment.probability : after,
      feasible: warnings.length === 0,
      projectionOnly: true,
      hoursToStockout: item.assessment.hoursToStockout,
      warnings,
    };
  }
}
