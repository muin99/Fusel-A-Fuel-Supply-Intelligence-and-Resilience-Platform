import { z } from 'zod';

/**
 * Contract of the BUP Fuel Supply Simulator (see docs/02-simulator-api.md).
 * Every response is parsed through these schemas: an invalid simulator response
 * is rejected + raises an alert instead of silently corrupting decisions.
 */
export const FuelType = z.enum(['DIESEL', 'PETROL', 'OCTANE']);
export type FuelType = z.infer<typeof FuelType>;
export const FUEL_TYPES = FuelType.options;

const FuelMap = z.object({ DIESEL: z.number(), PETROL: z.number(), OCTANE: z.number() });
export type FuelMap = z.infer<typeof FuelMap>;

export const HealthSchema = z.object({
  status: z.string(),
  database: z.string(),
  simulation: z.object({ status: z.string(), tick: z.number().int() }),
});

export const InstanceSchema = z.object({
  id: z.number(),
  scenario_id: z.string(),
  scenario_version: z.string(),
  seed: z.number(),
  sim_time: z.string(),
  tick: z.number().int().nonnegative(),
  tick_minutes: z.number().int().positive(),
  status: z.enum(['PAUSED', 'RUNNING']),
});
export type Instance = z.infer<typeof InstanceSchema>;

export const RegionSchema = z.object({ id: z.string(), name: z.string(), demand_factor: z.number() });
export type Region = z.infer<typeof RegionSchema>;

export const DepotSchema = z.object({
  id: z.string(),
  name: z.string(),
  region_id: z.string(),
  status: z.enum(['OPEN', 'CONSTRAINED']).or(z.string()),
  dispatch_capacity_per_tick: z.number().nonnegative(),
  capacity: FuelMap,
  inventory: FuelMap,
});
export type Depot = z.infer<typeof DepotSchema>;

export const StationSchema = z.object({
  id: z.string(),
  name: z.string(),
  region_id: z.string(),
  status: z.enum(['OPEN', 'OUTAGE']).or(z.string()),
  demand_profile: z.string(),
  demand_multiplier: z.number(),
  capacity: FuelMap,
  inventory: FuelMap,
});
export type Station = z.infer<typeof StationSchema>;

export const RouteSchema = z.object({
  id: z.string(),
  source_depot_id: z.string(),
  destination_station_id: z.string(),
  transit_ticks: z.number().int().positive(),
  max_shipment: z.number().positive(),
  status: z.enum(['AVAILABLE', 'DISRUPTED']).or(z.string()),
});
export type Route = z.infer<typeof RouteSchema>;

export const SupplyArrivalSchema = z.object({
  id: z.string(),
  depot_id: z.string(),
  fuel_type: FuelType,
  quantity: z.number().nonnegative(),
  planned_tick: z.number().int(),
  actual_tick: z.number().int().nullable(),
  status: z.enum(['SCHEDULED', 'DELAYED', 'ARRIVED']).or(z.string()),
});
export type SupplyArrival = z.infer<typeof SupplyArrivalSchema>;

export const SimEventSchema = z.object({
  id: z.number(),
  type: z.string(),
  start_tick: z.number().int(),
  end_tick: z.number().int(),
  status: z.enum(['SCHEDULED', 'ACTIVE', 'RESOLVED']).or(z.string()),
  parameters: z.record(z.string(), z.unknown()),
});
export type SimEvent = z.infer<typeof SimEventSchema>;

export const AllocationSchema = z.object({
  id: z.number(),
  idempotency_key: z.string(),
  source_depot_id: z.string(),
  destination_station_id: z.string(),
  route_id: z.string(),
  fuel_type: FuelType,
  quantity: z.number(),
  created_tick: z.number().int(),
  departure_tick: z.number().int().nullable(),
  expected_arrival_tick: z.number().int().nullable(),
  actual_arrival_tick: z.number().int().nullable(),
  status: z.enum(['PENDING', 'IN_TRANSIT', 'ARRIVED', 'FAILED', 'CANCELLED']),
  failure_reason: z.string().nullable(),
});
export type Allocation = z.infer<typeof AllocationSchema>;

export const DemandObservationSchema = z.object({
  id: z.number(),
  station_id: z.string(),
  fuel_type: FuelType,
  tick: z.number().int(),
  sim_time: z.string(),
  demand_liters: z.number(),
  served_liters: z.number(),
  unmet_liters: z.number(),
});
export type DemandObservation = z.infer<typeof DemandObservationSchema>;

export const SimMetricsSchema = z.object({
  served_demand_liters: z.number(),
  unmet_demand_liters: z.number(),
  service_level: z.number(),
  allocation_liters: z.number(),
  allocation_failures: z.number(),
});
export type SimMetrics = z.infer<typeof SimMetricsSchema>;

export const AllocationRequestSchema = z.object({
  idempotency_key: z.string().min(1).max(150),
  source_depot_id: z.string(),
  destination_station_id: z.string(),
  route_id: z.string(),
  fuel_type: FuelType,
  quantity: z.number().positive(),
});
export type AllocationRequest = z.infer<typeof AllocationRequestSchema>;

export const EVENT_TYPES = [
  'demand_spike',
  'route_disruption',
  'station_outage',
  'depot_constraint',
  'shipment_delay',
  'supply_shortfall',
] as const;
export const FAULT_TYPES = ['latency', 'unavailable', 'error_rate', 'stale_data', 'stream_disconnect'] as const;

export const InjectEventSchema = z.object({
  type: z.enum(EVENT_TYPES),
  start_tick: z.number().int().min(0),
  duration_ticks: z.number().int().positive(),
  parameters: z.record(z.string(), z.unknown()).default({}),
});
export const InjectFaultSchema = z.object({
  type: z.enum(FAULT_TYPES),
  duration_seconds: z.number().int().positive().max(3600),
  parameters: z.record(z.string(), z.unknown()).default({}),
});

/** Simulator sometimes omits the offset ("2026-01-01T00:00:00"); it is UTC. */
export function parseSimTime(s: string): Date {
  return new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`);
}
