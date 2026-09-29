export type Fuel = "DIESEL" | "PETROL" | "OCTANE";
export const FUELS: Fuel[] = ["DIESEL", "PETROL", "OCTANE"];
export type FuelMap = Record<Fuel, number>;

export interface Station {
  id: string;
  name: string;
  region_id: string;
  status: string;
  demand_profile: string;
  demand_multiplier: number;
  capacity: FuelMap;
  inventory: FuelMap;
}
export interface Depot {
  id: string;
  name: string;
  region_id: string;
  status: string;
  dispatch_capacity_per_tick: number;
  capacity: FuelMap;
  inventory: FuelMap;
}
export interface Route {
  id: string;
  source_depot_id: string;
  destination_station_id: string;
  transit_ticks: number;
  max_shipment: number;
  status: string;
}
export interface SupplyArrival {
  id: string;
  depot_id: string;
  fuel_type: Fuel;
  quantity: number;
  planned_tick: number;
  actual_tick: number | null;
  status: string;
}
export interface SimEvent {
  id: number;
  type: string;
  start_tick: number;
  end_tick: number;
  status: string;
  parameters: Record<string, unknown>;
}
export interface Allocation {
  id: number;
  source_depot_id: string;
  destination_station_id: string;
  route_id: string;
  fuel_type: Fuel;
  quantity: number;
  created_tick: number;
  expected_arrival_tick: number | null;
  status: string;
  failure_reason: string | null;
}
export interface NetworkSnapshot {
  instance: { tick: number; sim_time: string; status: string; tick_minutes: number; scenario_id: string; seed: number };
  regions: { id: string; name: string; demand_factor: number }[];
  depots: Depot[];
  stations: Station[];
  routes: Route[];
  supplyArrivals: SupplyArrival[];
  events: SimEvent[];
  allocations: Allocation[];
  metrics: {
    served_demand_liters: number;
    unmet_demand_liters: number;
    service_level: number;
    allocation_liters: number;
    allocation_failures: number;
  };
  meta: { fetchedAt: string; stale: boolean; degraded: boolean };
}
export interface RiskRow {
  stationId: string;
  stationName: string;
  regionId: string;
  fuel: Fuel;
  inventory: number;
  capacity: number;
  inTransit: number;
  stationOpen: boolean;
  assessment: { ticksToStockout: number | null; hoursToStockout: number | null; probability: number; expectedDemand: number; projectedMin: number };
  forecast: { engine?: string; fallbackReason?: string | null; perTick?: number[]; lower?: number[]; upper?: number[]; drift?: boolean; version?: string; next: number[]; level: number; cv: number; confidence: number; samples: number };
}
export interface Recommendation {
  id: string;
  createdAt: string;
  tick: number;
  stationId: string;
  fuelType: Fuel;
  depotId: string;
  routeId: string;
  quantity: number;
  policy: string;
  confidence: number;
  riskBefore: number;
  riskAfter: number;
  hoursToStockout: number | null;
  rationale: {
    signals: Record<string, number | string | null>;
    need: number;
    headroom: number;
    transitTicks: number;
    constraints: string[];
    alternatives: { routeId: string; depotId: string; transitTicks: number; maxShipment: number; depotUsable: number }[];
    reviewReasons?: string[];
    requestId?: number | null;
    shortfall?: { before: number; after: number } | null;
  };
  explanation: string | null;
  status: string;
  simAllocationId: number | null;
  decidedBy: string | null;
  error: string | null;
}
export interface Alert {
  id: number;
  createdAt: string;
  tick: number | null;
  kind: string;
  severity: "info" | "warning" | "critical";
  entityId: string | null;
  message: string;
  acknowledged: boolean;
}
export interface AuditEntry {
  id: number;
  at: string;
  tick: number | null;
  actor: string;
  action: string;
  entityId: string | null;
  details: Record<string, unknown>;
}
export interface HealthStatus {
  status: "healthy" | "degraded" | "down";
  components: { name: string; status: "healthy" | "degraded" | "down"; detail?: string }[];
  requestsPerMin: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  errorRate: number;
  checkedAt: string;
}

export interface DecisionStatus {
  autopilot: boolean;
  minConfidence: number;
  forcedPolicy: string | null;
  predictionAvailable: boolean;
  lastPolicy: string | null;
  lastRunAt: string | null;
  lastError: string | null;
  openRecommendations: number;
  needsReview: number;
}
export interface DrillStatus {
  predictionAvailable: boolean;
  forcedPolicy: string | null;
  activeFaults: { type: string; end_wall_time?: string }[];
}
export interface FuelRequest {
  id: number;
  createdAt: string;
  tick: number;
  stationId: string;
  fuelType: Fuel;
  quantity: number;
  urgency: "routine" | "urgent" | "emergency";
  note: string | null;
  requestedBy: string;
  status: "OPEN" | "PLANNED" | "FULFILLED" | "DECLINED" | "CANCELLED";
  recommendationId: string | null;
  allocationId: number | null;
  resolution: string | null;
  resolvedTick: number | null;
  servingDepots?: string[];
  routes?: { id: string; depotId: string; status: string; transitTicks: number; maxShipment: number }[];
  modelView?: { stockoutProbability: number | null; hoursToStockout: number | null; inventory: number; inTransit: number; capacity: number; agrees: boolean | null } | null;
}
export interface CopilotAnswer {
  text: string;
  source: "agent" | "rules";
  model: string | null;
  trace: { step: number; tool: string; args: Record<string, unknown>; summary: string; ms: number }[];
  citations: { id: string; text: string; kind: "playbook" | "memory" }[];
  actions: Recommendation[];
  tick: number | null;
  elapsedMs: number;
}
