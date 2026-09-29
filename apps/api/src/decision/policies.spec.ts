import type { RiskItem } from '../forecast/forecast.service.js';
import type { NetworkSnapshot } from '../state/state.types.js';
import { detect } from '../detection/detection.service.js';
import { buildProblem, heuristicPolicy, lpPolicy } from './policies.js';

const fm = (d: number, p: number, o: number) => ({ DIESEL: d, PETROL: p, OCTANE: o });

function snapshot(over: Partial<NetworkSnapshot> = {}): NetworkSnapshot {
  return {
    instance: { id: 1, scenario_id: 'baseline', scenario_version: '1.0', seed: 1, sim_time: '2026-01-01T08:00:00', tick: 32, tick_minutes: 15, status: 'RUNNING' },
    regions: [{ id: 'region-dhaka', name: 'Dhaka', demand_factor: 1 }],
    depots: [
      { id: 'depot-a', name: 'A', region_id: 'region-dhaka', status: 'OPEN', dispatch_capacity_per_tick: 12000, capacity: fm(90000, 70000, 45000), inventory: fm(60000, 45000, 26000) },
    ],
    stations: [
      { id: 'station-x', name: 'X', region_id: 'region-dhaka', status: 'OPEN', demand_profile: 'urban_high', demand_multiplier: 1, capacity: fm(15000, 14000, 9000), inventory: fm(1000, 9000, 5000) },
    ],
    routes: [
      { id: 'route-fast', source_depot_id: 'depot-a', destination_station_id: 'station-x', transit_ticks: 2, max_shipment: 7000, status: 'AVAILABLE' },
      { id: 'route-slow', source_depot_id: 'depot-a', destination_station_id: 'station-x', transit_ticks: 4, max_shipment: 5000, status: 'AVAILABLE' },
    ],
    supplyArrivals: [],
    events: [],
    allocations: [],
    metrics: { served_demand_liters: 0, unmet_demand_liters: 0, service_level: 1, allocation_liters: 0, allocation_failures: 0 },
    meta: { fetchedAt: '', stale: false, degraded: false },
    ...over,
  };
}

function risk(inventory: number, probability: number): RiskItem {
  return {
    stationId: 'station-x',
    stationName: 'X',
    regionId: 'region-dhaka',
    fuel: 'DIESEL',
    inventory,
    capacity: 15000,
    inTransit: 0,
    arrivals: new Map(),
    forecast: { perTick: Array(24).fill(300), level: 1, cv: 0.1, confidence: 0.9, samples: 60 },
    assessment: { ticksToStockout: 4, hoursToStockout: 1, probability, expectedDemand: 7200, projectedMin: -6000 },
    stationOpen: true,
  };
}

describe('decision policies', () => {
  it('LP serves an urgent need via the fastest route within constraints', () => {
    const p = buildProblem(snapshot(), [risk(1000, 0.95)]);
    const out = lpPolicy(p);
    expect(out.length).toBeGreaterThan(0);
    const total = out.reduce((s, x) => s + x.quantity, 0);
    expect(total).toBeLessThanOrEqual(12000); // dispatch capacity
    for (const x of out) expect(x.quantity).toBeLessThanOrEqual(x.routeId === 'route-fast' ? 7000 : 5000);
    expect(out[0].routeId).toBe('route-fast');
  });

  it('excludes disrupted routes', () => {
    const s = snapshot();
    s.routes[0].status = 'DISRUPTED';
    const out = lpPolicy(buildProblem(s, [risk(1000, 0.95)]));
    expect(out.every((x) => x.routeId === 'route-slow')).toBe(true);
  });

  it('heuristic respects depot dispatch capacity', () => {
    const s = snapshot();
    s.depots[0].dispatch_capacity_per_tick = 3000;
    const out = heuristicPolicy(buildProblem(s, [risk(1000, 0.95)]));
    expect(out.reduce((a, x) => a + x.quantity, 0)).toBeLessThanOrEqual(3000);
  });

  it('fallback (no forecast) uses the reorder-point rule', () => {
    const p = buildProblem(snapshot(), null);
    expect(p.needs.map((n) => `${n.stationId}:${n.fuel}`)).toEqual(['station-x:DIESEL']);
  });

  it('no need => no proposals', () => {
    expect(lpPolicy(buildProblem(snapshot(), [risk(14000, 0)]))).toEqual([]);
  });

  it('detection flags shortages and disruptions', () => {
    const s = snapshot();
    s.routes[0].status = 'DISRUPTED';
    const d = detect(s, [risk(1000, 0.95)]);
    expect(d.some((x) => x.kind === 'shortage' && x.severity === 'critical')).toBe(true);
    expect(d.some((x) => x.kind === 'disruption' && x.entityId === 'route-fast')).toBe(true);
  });
  it('fairness: constrained dispatch still reaches every empty station first', () => {
    const s = snapshot();
    s.depots[0].dispatch_capacity_per_tick = 6000;
    s.stations = ['x', 'y', 'z'].map((k) => ({ ...s.stations[0], id: `station-${k}`, name: k.toUpperCase(), inventory: fm(0, 0, 0) }));
    s.routes = s.stations.map((st) => ({ id: `route-${st.id}`, source_depot_id: 'depot-a', destination_station_id: st.id, transit_ticks: 2, max_shipment: 7000, status: 'AVAILABLE' }));
    const p = buildProblem(s, null);
    for (const policy of [heuristicPolicy, lpPolicy]) {
      const out = policy(p);
      const served = new Set(out.map((x) => x.stationId));
      expect(served.size).toBe(3);
    }
  });
  it('station request raises the priority of a need the model already sees', () => {
    const s = snapshot();
    const base = buildProblem(s, [risk(1000, 0.95)]);
    const boosted = buildProblem(s, [risk(1000, 0.95)], [{ stationId: 'station-x', fuel: 'DIESEL', quantity: 3000, urgency: 'emergency', requestId: 7 }]);
    expect(boosted.needs[0].weight).toBeGreaterThan(base.needs[0].weight);
    expect(boosted.needs[0].requestId).toBe(7);
  });
  it('a request alone does not create optimizer work (the depot manager decides it)', () => {
    const p = buildProblem(snapshot(), [risk(14000, 0)], [{ stationId: 'station-x', fuel: 'PETROL', quantity: 3000, urgency: 'routine', requestId: 8 }]);
    expect(p.needs).toEqual([]);
  });
});
