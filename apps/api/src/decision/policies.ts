import solver from 'javascript-lp-solver';
import { assessStockout, expectedShortfall } from '../forecast/forecast.math.js';
import type { RiskItem } from '../forecast/forecast.service.js';
import { FUEL_TYPES, FuelType, Route } from '../simulator/simulator.schemas.js';
import type { NetworkSnapshot } from '../state/state.types.js';

export interface Need {
  stationId: string;
  fuel: FuelType;
  need: number;
  weight: number;
  headroom: number;
  riskBefore: number;
  hoursToStockout: number | null;
  signals: Record<string, number | string | null>;
  requestId?: number;
}

export interface StationRequestSignal {
  stationId: string;
  fuel: string;
  quantity: number;
  urgency: 'routine' | 'urgent' | 'emergency';
  requestId: number;
}
const URGENCY_BONUS = { routine: 1, urgent: 3, emergency: 6 } as const;

export interface Problem {
  tick: number;
  needs: Need[];
  routes: Route[];
  depotUsable: Map<string, number>; // `${depot}:${fuel}`
  dispatchRemaining: Map<string, number>;
  constraints: string[];
}

export interface Proposal {
  stationId: string;
  fuel: FuelType;
  depotId: string;
  routeId: string;
  quantity: number;
  transitTicks: number;
  need: Need;
}

const DEPOT_RESERVE = 0.05; // keep 5% of depot capacity as strategic reserve
const MIN_SHIPMENT = 500;
/**
 * Fairness: the first URGENT_TRANCHE litres of every need are worth URGENT_BONUS× more,
 * so constrained depot capacity buys a first delivery for every at-risk station
 * before topping any single station up (prevents one station starving the rest).
 */
export const URGENT_TRANCHE = 2500;
const URGENT_BONUS = 3;

/** Tranche shrinks when many needs compete for little dispatch capacity (>= one minimum shipment). */
function trancheFor(p: Problem): number {
  const budget = [...p.dispatchRemaining.values()].reduce((a, b) => a + b, 0);
  return Math.max(MIN_SHIPMENT, Math.min(URGENT_TRANCHE, Math.floor(budget / Math.max(1, p.needs.length) / 100) * 100));
}

/** Most urgent first; ties rotate across stations (DIESEL of each, then PETROL of each, ...). */
function priorityOrder(needs: Need[]): Need[] {
  const fuelRank = (n: Need) => FUEL_TYPES.indexOf(n.fuel);
  return [...needs].sort((a, b) => b.weight - a.weight || fuelRank(a) - fuelRank(b) || a.stationId.localeCompare(b.stationId));
}

// ------------------------------------------------------------------ problem
/** Builds the allocation problem from the forecast-driven risk table. */
export function buildProblem(s: NetworkSnapshot, risk: RiskItem[] | null, requests: StationRequestSignal[] = []): Problem {
  const tick = s.instance.tick;
  const disruptedByEvent = new Set(
    s.events.filter((e) => e.status === 'ACTIVE' && e.type === 'route_disruption')
      .flatMap((e) => (Array.isArray(e.parameters.route_ids) ? e.parameters.route_ids : [])),
  );
  const routes = s.routes.filter((r) => r.status === 'AVAILABLE' && !disruptedByEvent.has(r.id));
  const constraints: string[] = [];

  const depotUsable = new Map<string, number>();
  const dispatchRemaining = new Map<string, number>();
  for (const d of s.depots) {
    for (const f of FUEL_TYPES) depotUsable.set(`${d.id}:${f}`, Math.max(0, d.inventory[f] - d.capacity[f] * DEPOT_RESERVE));
    const committed = s.allocations
      .filter((a) => a.source_depot_id === d.id && (a.status === 'PENDING' || (a.status === 'IN_TRANSIT' && a.departure_tick === tick)))
      .reduce((sum, a) => sum + a.quantity, 0);
    let remaining = Math.max(0, d.dispatch_capacity_per_tick - committed);
    if (d.status === 'CONSTRAINED') {
      remaining *= 0.5;
      constraints.push(`${d.id} CONSTRAINED: dispatch budget halved`);
    }
    dispatchRemaining.set(d.id, remaining);
  }
  for (const r of s.routes) if (r.status !== 'AVAILABLE' || disruptedByEvent.has(r.id)) constraints.push(`${r.id} ${disruptedByEvent.has(r.id) ? 'ACTIVE_EVENT_DISRUPTED' : r.status}: excluded`);

  const needs: Need[] = [];
  if (risk) {
    for (const r of risk) {
      if (!r.stationOpen) continue;
      const lead = Math.min(...routes.filter((x) => x.destination_station_id === r.stationId).map((x) => x.transit_ticks), 99);
      if (lead === 99) {
        constraints.push(`${r.stationId}: no available route`);
        continue;
      }
      const coverTicks = Math.min(r.forecast.perTick.length, lead + 12);
      const demandCover = r.forecast.perTick.slice(0, coverTicks).reduce((a, b) => a + b, 0);
      const target = Math.min(r.capacity * 0.95, demandCover * (1 + 2 * r.forecast.cv) + r.capacity * 0.15);
      const projected = r.inventory + r.inTransit;
      const need = target - projected;
      const headroom = r.capacity - r.inventory - r.inTransit;
      if (need < MIN_SHIPMENT || headroom < MIN_SHIPMENT) continue;
      const h = r.assessment.hoursToStockout;
      needs.push({
        stationId: r.stationId,
        fuel: r.fuel,
        need,
        headroom,
        riskBefore: r.assessment.probability,
        hoursToStockout: h,
        weight: 1 + 6 * r.assessment.probability + (h !== null && h < 6 ? 3 : 0),
        signals: {
          inventory: r.inventory,
          inTransit: r.inTransit,
          forecastDemandCover: Math.round(demandCover),
          demandLevelVsNormal: Number(r.forecast.level.toFixed(2)),
          forecastConfidence: Number(r.forecast.confidence.toFixed(2)),
          stockoutProbability: Number(r.assessment.probability.toFixed(3)),
          hoursToStockout: h,
        },
      });
    }
  } else {
    // FALLBACK (prediction unavailable): reorder-point rule on raw inventory.
    for (const st of s.stations) {
      if (st.status !== 'OPEN') continue;
      for (const f of FUEL_TYPES) {
        const inTransit = s.allocations
          .filter((a) => a.destination_station_id === st.id && a.fuel_type === f && (a.status === 'PENDING' || a.status === 'IN_TRANSIT'))
          .reduce((x, a) => x + a.quantity, 0);
        const projected = st.inventory[f] + inTransit;
        const fill = projected / st.capacity[f];
        if (fill >= 0.4) continue;
        const need = st.capacity[f] * 0.8 - projected;
        const headroom = st.capacity[f] - st.inventory[f] - inTransit;
        if (need < MIN_SHIPMENT || headroom < MIN_SHIPMENT) continue;
        needs.push({
          stationId: st.id,
          fuel: f,
          need,
          headroom,
          riskBefore: Math.min(1, (0.4 - fill) / 0.4 + 0.3),
          hoursToStockout: null,
          weight: 1 + 5 * (1 - fill),
          signals: { inventory: st.inventory[f], inTransit, fillRatio: Number(fill.toFixed(2)), rule: 'reorder_point_40pct' },
        });
      }
    }
  }
  // Station requests: a demand signal from the field. They raise the priority of needs the
  // model already sees; whether to ship what was *requested* is the depot manager's decision.
  for (const req of requests) {
    const st = s.stations.find((x) => x.id === req.stationId);
    const fuel = req.fuel as FuelType;
    if (!st || st.status !== 'OPEN' || !FUEL_TYPES.includes(fuel)) continue;
    if (!routes.some((r) => r.destination_station_id === st.id)) {
      constraints.push(`request #${req.requestId} for ${st.id}: no available route`);
      continue;
    }
    const existing = needs.find((n) => n.stationId === st.id && n.fuel === fuel);
    if (existing) {
      existing.weight += URGENCY_BONUS[req.urgency];
      existing.requestId = req.requestId;
      existing.signals = { ...existing.signals, stationRequest: `#${req.requestId} ${req.quantity} L (${req.urgency})` };
    }
  }
  return { tick, needs, routes, depotUsable, dispatchRemaining, constraints };
}

// ------------------------------------------------------------ LP optimizer
/**
 * max Σ w·u  −  ε·Σ transit·x
 * s.t. u ≤ need, u ≤ Σ x (per station/fuel), Σ x ≤ depot usable (per depot/fuel),
 *      Σ x ≤ dispatch remaining (per depot), Σ x ≤ station headroom, x ≤ route max_shipment
 */
export function lpPolicy(p: Problem): Proposal[] {
  if (p.needs.length === 0) return [];
  const model = { optimize: 'obj', opType: 'max' as const, constraints: {} as Record<string, { max: number }>, variables: {} as Record<string, Record<string, number>> };
  const needByKey = new Map(p.needs.map((n) => [`${n.stationId}:${n.fuel}`, n]));

  const trancheSize = trancheFor(p);
  for (const n of p.needs) {
    const k = `${n.stationId}:${n.fuel}`;
    const tranche = Math.min(trancheSize, n.need);
    model.constraints[`urg|${k}`] = { max: tranche };
    model.constraints[`rest|${k}`] = { max: Math.max(0, n.need - tranche) };
    model.constraints[`link|${k}`] = { max: 0 };
    model.constraints[`head|${k}`] = { max: n.headroom };
    // served = urgent part (high value) + remainder (normal value), both backed by shipments
    model.variables[`u1|${k}`] = { obj: n.weight * URGENT_BONUS, [`urg|${k}`]: 1, [`link|${k}`]: 1 };
    model.variables[`u2|${k}`] = { obj: n.weight, [`rest|${k}`]: 1, [`link|${k}`]: 1 };
  }
  for (const [d, rem] of p.dispatchRemaining) model.constraints[`disp|${d}`] = { max: rem };
  for (const [key, usable] of p.depotUsable) model.constraints[`dep|${key}`] = { max: usable };

  for (const r of p.routes) {
    for (const f of FUEL_TYPES) {
      const k = `${r.destination_station_id}:${f}`;
      if (!needByKey.has(k)) continue;
      model.constraints[`cap|${r.id}|${f}`] = { max: r.max_shipment };
      model.variables[`x|${r.id}|${f}`] = {
        obj: -0.001 * r.transit_ticks,
        [`link|${k}`]: -1,
        [`head|${k}`]: 1,
        [`dep|${r.source_depot_id}:${f}`]: 1,
        [`disp|${r.source_depot_id}`]: 1,
        [`cap|${r.id}|${f}`]: 1,
      };
    }
  }

  const res = solver.Solve(model);
  if (!res.feasible) throw new Error('LP infeasible');

  const out: Proposal[] = [];
  for (const [name, value] of Object.entries(res)) {
    if (!name.startsWith('x|') || typeof value !== 'number') continue;
    const qty = Math.floor(value / 100) * 100;
    if (qty < MIN_SHIPMENT) continue;
    const [, routeId, fuel] = name.split('|') as [string, string, FuelType];
    const r = p.routes.find((x) => x.id === routeId)!;
    out.push({
      stationId: r.destination_station_id,
      fuel,
      depotId: r.source_depot_id,
      routeId,
      quantity: qty,
      transitTicks: r.transit_ticks,
      need: needByKey.get(`${r.destination_station_id}:${fuel}`)!,
    });
  }
  return out;
}

// ------------------------------------------------------- greedy heuristic
/** Priority heuristic: most urgent first, fastest feasible route. Always available. */
export function heuristicPolicy(p: Problem): Proposal[] {
  const usable = new Map(p.depotUsable);
  const dispatch = new Map(p.dispatchRemaining);
  const byKey = new Map<string, Proposal>(); // one shipment per (route, fuel)
  const remaining = new Map(p.needs.map((n) => [n, Math.min(n.need, n.headroom)]));
  const ordered = priorityOrder(p.needs);
  // Pass 1 funds the urgent tranche of every need (fairness), pass 2 tops up.
  for (const cap of [trancheFor(p), Infinity]) {
    for (const n of ordered) {
      const candidates = p.routes.filter((r) => r.destination_station_id === n.stationId).sort((a, b) => a.transit_ticks - b.transit_ticks);
      let budget = Math.min(remaining.get(n) ?? 0, cap === Infinity ? Infinity : Math.max(0, cap - (n.need - (remaining.get(n) ?? 0))));
      for (const r of candidates) {
        if (budget < MIN_SHIPMENT) break;
        const dk = `${r.source_depot_id}:${n.fuel}`;
        const existing = byKey.get(`${r.id}|${n.fuel}`);
        const routeLeft = r.max_shipment - (existing?.quantity ?? 0);
        const qty = Math.floor(Math.min(budget, routeLeft, usable.get(dk) ?? 0, dispatch.get(r.source_depot_id) ?? 0) / 100) * 100;
        if (qty < MIN_SHIPMENT) continue;
        usable.set(dk, (usable.get(dk) ?? 0) - qty);
        dispatch.set(r.source_depot_id, (dispatch.get(r.source_depot_id) ?? 0) - qty);
        remaining.set(n, (remaining.get(n) ?? 0) - qty);
        budget -= qty;
        if (existing) existing.quantity += qty;
        else byKey.set(`${r.id}|${n.fuel}`, { stationId: n.stationId, fuel: n.fuel, depotId: r.source_depot_id, routeId: r.id, quantity: qty, transitTicks: r.transit_ticks, need: n });
      }
    }
  }
  return [...byKey.values()];
}

/** Risk after the proposal, re-running the stockout model with the extra arrival. */
export function riskAfter(prop: Proposal, risk: RiskItem | undefined, tickMinutes: number): number {
  if (!risk) return Math.max(0, prop.need.riskBefore * (1 - prop.quantity / Math.max(prop.need.need, 1)));
  const arrivals = new Map(risk.arrivals);
  const k = 1 + prop.transitTicks;
  arrivals.set(k, (arrivals.get(k) ?? 0) + prop.quantity);
  return assessStockout(risk.inventory, risk.forecast, arrivals, tickMinutes).probability;
}

/** Expected 6 h shortfall (litres) without and with the proposal: the operator-facing impact. */
export function shortfallImpact(prop: Proposal, risk: RiskItem | undefined): { before: number; after: number } | null {
  if (!risk) return null;
  const after = new Map(risk.arrivals);
  const k = 1 + prop.transitTicks;
  after.set(k, (after.get(k) ?? 0) + prop.quantity);
  return { before: Math.round(expectedShortfall(risk.inventory, risk.forecast, risk.arrivals)), after: Math.round(expectedShortfall(risk.inventory, risk.forecast, after)) };
}

/** Other feasible ways to serve the same need — shown to the operator as alternatives. */
export function alternatives(prop: Proposal, p: Problem) {
  return p.routes
    .filter((r) => r.destination_station_id === prop.stationId && r.id !== prop.routeId)
    .map((r) => ({
      routeId: r.id,
      depotId: r.source_depot_id,
      transitTicks: r.transit_ticks,
      maxShipment: r.max_shipment,
      depotUsable: Math.round(p.depotUsable.get(`${r.source_depot_id}:${prop.fuel}`) ?? 0),
    }));
}
