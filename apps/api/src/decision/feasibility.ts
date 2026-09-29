import type { Recommendation } from '../common/entities.js';
import type { NetworkSnapshot } from '../state/state.types.js';
import type { Problem } from './policies.js';

/** A recommendation older than this (in ticks) must be re-planned, not approved. */
export const MAX_REC_AGE_TICKS = 16;
/** |demand level − 1| at or above this is treated as an anomaly (matches detection's surge rule). */
export const ANOMALY_LEVEL = 0.35;

/**
 * Hard feasibility gate, checked against the CURRENT simulator state immediately before
 * dispatch (mirrors the simulator's own validation order). Any reason blocks dispatch.
 */
export function blockingReasons(
  rec: Pick<Recommendation, 'stationId' | 'fuelType' | 'depotId' | 'routeId' | 'quantity' | 'tick'>,
  s: NetworkSnapshot,
  problem?: Problem,
): string[] {
  const reasons: string[] = [];
  if (s.meta.stale || s.meta.degraded) reasons.push('STALE_STATE: simulator data is stale; wait for fresh data');
  if (s.instance.tick - rec.tick > MAX_REC_AGE_TICKS) reasons.push(`EXPIRED: planned at tick ${rec.tick}, now ${s.instance.tick}; use the refreshed recommendation`);
  const route = s.routes.find((r) => r.id === rec.routeId);
  const station = s.stations.find((x) => x.id === rec.stationId);
  const depot = s.depots.find((d) => d.id === rec.depotId);
  const fuel = rec.fuelType as 'DIESEL' | 'PETROL' | 'OCTANE';
  if (!route || !station || !depot) return [...reasons, 'NOT_FOUND: unknown route, station or depot'];
  if (route.source_depot_id !== depot.id || route.destination_station_id !== station.id) reasons.push('ROUTE_MISMATCH');
  if (station.status !== 'OPEN') reasons.push(`STATION_CLOSED: ${station.name} is ${station.status}`);
  if (route.status !== 'AVAILABLE') reasons.push(`ROUTE_DISRUPTED: ${route.id} is ${route.status}`);
  if (rec.quantity > route.max_shipment) reasons.push(`ROUTE_CAPACITY_EXCEEDED: max ${route.max_shipment} L`);
  if (rec.quantity > depot.inventory[fuel]) reasons.push(`INSUFFICIENT_INVENTORY: ${depot.id} has ${Math.round(depot.inventory[fuel])} L ${fuel}`);
  if (problem && rec.quantity > (problem.dispatchRemaining.get(depot.id) ?? 0) + 1e-6)
    reasons.push(`DISPATCH_CAPACITY_EXCEEDED: ${Math.round(problem.dispatchRemaining.get(depot.id) ?? 0)} L left this tick at ${depot.id}`);
  if (station.inventory[fuel] + rec.quantity > station.capacity[fuel])
    reasons.push(`DESTINATION_CAPACITY_EXCEEDED: ${station.name} ${fuel} would exceed ${station.capacity[fuel]} L`);
  return reasons;
}

/** Why a feasible recommendation still needs a human (management by exception). */
export function reviewReasons(
  p: { policy: string; confidence: number; depotId: string; stationId: string; demandLevel?: number | null; drift?: boolean },
  s: NetworkSnapshot,
  minConfidence: number,
): string[] {
  const reasons: string[] = [];
  // Anomalies are the operator's call: the model is extrapolating outside normal behaviour.
  if (p.demandLevel != null && Math.abs(p.demandLevel - 1) >= ANOMALY_LEVEL)
    reasons.push(`Anomalous demand: ${p.demandLevel.toFixed(2)}× normal at this station, so the operator decides`);
  if (p.drift) reasons.push('Demand distribution drift detected (recent vs reference window)');
  if (p.policy.includes('fallback')) reasons.push('Prediction model offline: produced by the fallback reorder rule');
  if (p.confidence < minConfidence) reasons.push(`Forecast confidence ${(p.confidence * 100).toFixed(0)}% is below the ${(minConfidence * 100).toFixed(0)}% autopilot threshold`);
  const depotRegion = s.depots.find((d) => d.id === p.depotId)?.region_id;
  const stationRegion = s.stations.find((x) => x.id === p.stationId)?.region_id;
  if (depotRegion && stationRegion && depotRegion !== stationRegion) reasons.push("Cross-region transfer: draws on the other region's depot and takes longer");
  return reasons;
}

