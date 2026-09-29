import type {
  Allocation,
  Depot,
  Instance,
  Region,
  Route,
  SimEvent,
  SimMetrics,
  Station,
  SupplyArrival,
} from '../simulator/simulator.schemas.js';

/** One consistent picture of the simulated world + how trustworthy it is. */
export interface NetworkSnapshot {
  instance: Instance;
  regions: Region[];
  depots: Depot[];
  stations: Station[];
  routes: Route[];
  supplyArrivals: SupplyArrival[];
  events: SimEvent[];
  allocations: Allocation[];
  metrics: SimMetrics;
  meta: {
    fetchedAt: string;
    /** simulator said stale, or we fell back to cache for at least one resource */
    stale: boolean;
    /** true when the whole snapshot is last-known-good because the simulator is unreachable */
    degraded: boolean;
  };
}
