import type { NetworkSnapshot } from '../state/state.types.js';
import { SimulatorError } from '../simulator/simulator.errors.js';
import { DecisionService, MAX_REC_AGE_TICKS, blockingReasons, reviewReasons } from './decision.service.js';

const fm = (d: number, p: number, o: number) => ({ DIESEL: d, PETROL: p, OCTANE: o });

function snapshot(over: { tick?: number; stale?: boolean; routeStatus?: string } = {}): NetworkSnapshot {
  return {
    instance: { id: 1, scenario_id: 'baseline', scenario_version: '1.0', seed: 1, sim_time: '2026-01-01T08:00:00', tick: over.tick ?? 2, tick_minutes: 15, status: 'RUNNING' },
    regions: [{ id: 'region-a', name: 'A', demand_factor: 1 }, { id: 'region-b', name: 'B', demand_factor: 1 }],
    depots: [
      { id: 'depot-a', name: 'Depot A', region_id: 'region-a', status: 'OPEN', dispatch_capacity_per_tick: 12000, capacity: fm(90000, 70000, 45000), inventory: fm(60000, 45000, 26000) },
      { id: 'depot-b', name: 'Depot B', region_id: 'region-b', status: 'OPEN', dispatch_capacity_per_tick: 11000, capacity: fm(90000, 70000, 45000), inventory: fm(60000, 45000, 26000) },
    ],
    stations: [{ id: 'station-a', name: 'Station A', region_id: 'region-a', status: 'OPEN', demand_profile: 'urban_high', demand_multiplier: 1, capacity: fm(15000, 14000, 9000), inventory: fm(2000, 9000, 5000) }],
    routes: [
      { id: 'route-a', source_depot_id: 'depot-a', destination_station_id: 'station-a', transit_ticks: 2, max_shipment: 7000, status: over.routeStatus ?? 'AVAILABLE' },
      { id: 'route-x', source_depot_id: 'depot-b', destination_station_id: 'station-a', transit_ticks: 4, max_shipment: 5000, status: 'AVAILABLE' },
    ],
    supplyArrivals: [],
    events: [],
    allocations: [],
    metrics: { served_demand_liters: 0, unmet_demand_liters: 0, service_level: 1, allocation_liters: 0, allocation_failures: 0 },
    meta: { fetchedAt: '', stale: over.stale ?? false, degraded: false },
  };
}

function setup(opts: { stale?: boolean; status?: string; tick?: number; routeStatus?: string } = {}) {
  let row = { id: 'review-1', tick: 1, status: opts.status ?? 'APPROVED', quantity: 1000, depotId: 'depot-a', stationId: 'station-a', routeId: 'route-a', fuelType: 'DIESEL', policy: 'lp_optimizer', rationale: {} };
  const createAllocation = vi.fn();
  const service = new DecisionService(
    {
      findOneBy: async () => ({ ...row }),
      save: async (r: typeof row) => {
        row = { ...r };
        return r;
      },
      update: async (_where: unknown, values: Partial<typeof row>) => {
        row = { ...row, ...values };
        return { affected: 1 };
      },
    } as never,
    {} as never,
    {} as never,
    {} as never,
    { createAllocation } as never,
    { record: vi.fn() } as never,
    { decisions: { inc: vi.fn() } } as never,
    { emit: vi.fn() } as never,
    { get: (k: string) => (k === 'MIN_CONFIDENCE_FOR_AUTO' ? 0.6 : false) } as never,
    { refresh: async () => snapshot({ stale: opts.stale, tick: opts.tick, routeStatus: opts.routeStatus }) } as never,
    { markPlanned: vi.fn(), sync: vi.fn(), signals: async () => [] } as never,
  );
  return { service, createAllocation };
}

describe('approval invariants', () => {
  it('blocks dispatch against stale state', async () => {
    const { service, createAllocation } = setup({ stale: true });
    await expect(service.execute('review-1', 'operator')).rejects.toThrow('STALE_STATE');
    expect(createAllocation).not.toHaveBeenCalled();
  });

  it('retries an ambiguous accepted request with the identical frozen body', async () => {
    const { service, createAllocation } = setup();
    createAllocation.mockRejectedValueOnce(new SimulatorError('timeout', null, 'TIMEOUT', true)).mockResolvedValueOnce({ id: 7 });
    expect((await service.execute('review-1', 'operator')).status).toBe('APPROVED');
    expect((await service.execute('review-1', 'operator')).status).toBe('SUBMITTED');
    expect(createAllocation.mock.calls[0][0]).toEqual(createAllocation.mock.calls[1][0]);
    expect(createAllocation.mock.calls[1][0].idempotency_key).toBe('rec-review-1');
    await service.execute('review-1', 'operator');
    expect(createAllocation).toHaveBeenCalledTimes(2);
  });

  it('lets an operator approve a recommendation planned a few ticks ago while the sim runs', async () => {
    const { service, createAllocation } = setup({ status: 'NEEDS_REVIEW', tick: 5 });
    createAllocation.mockResolvedValueOnce({ id: 9 });
    expect((await service.execute('review-1', 'operator')).status).toBe('SUBMITTED');
  });

  it('refuses when the route became disrupted, with the reason', async () => {
    const { service, createAllocation } = setup({ status: 'PROPOSED', routeStatus: 'DISRUPTED' });
    await expect(service.execute('review-1', 'operator')).rejects.toThrow('ROUTE_DISRUPTED');
    expect(createAllocation).not.toHaveBeenCalled();
  });

  it('expires recommendations that are too old to trust', () => {
    const s = snapshot({ tick: 1 + MAX_REC_AGE_TICKS + 1 });
    const reasons = blockingReasons({ stationId: 'station-a', fuelType: 'DIESEL', depotId: 'depot-a', routeId: 'route-a', quantity: 1000, tick: 1 }, s);
    expect(reasons.some((r) => r.startsWith('EXPIRED'))).toBe(true);
  });

  it('flags destination overfill and depot shortage like the simulator does', () => {
    const s = snapshot();
    const over = blockingReasons({ stationId: 'station-a', fuelType: 'DIESEL', depotId: 'depot-a', routeId: 'route-a', quantity: 14000, tick: 2 }, s);
    expect(over.some((r) => r.startsWith('ROUTE_CAPACITY_EXCEEDED'))).toBe(true);
    expect(over.some((r) => r.startsWith('DESTINATION_CAPACITY_EXCEEDED'))).toBe(true);
  });
});

describe('management by exception', () => {
  it('routine, confident, same-region recommendation needs no review', () => {
    expect(reviewReasons({ policy: 'lp_optimizer', confidence: 0.8, depotId: 'depot-a', stationId: 'station-a' }, snapshot(), 0.6)).toEqual([]);
  });
  it('anomalous demand is always an operator decision', () => {
    const reasons = reviewReasons({ policy: 'lp_optimizer', confidence: 0.9, depotId: 'depot-a', stationId: 'station-a', demandLevel: 2.0 }, snapshot(), 0.6);
    expect(reasons.some((r) => r.startsWith('Anomalous demand'))).toBe(true);
  });
  it('low confidence, fallback policy and cross-region transfers go to the operator', () => {
    const reasons = reviewReasons({ policy: 'heuristic_fallback', confidence: 0.3, depotId: 'depot-b', stationId: 'station-a' }, snapshot(), 0.6);
    expect(reasons).toHaveLength(3);
  });
});
