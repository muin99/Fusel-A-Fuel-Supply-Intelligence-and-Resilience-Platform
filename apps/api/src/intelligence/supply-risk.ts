import type { NetworkSnapshot } from '../state/state.types.js';
import type { RiskItem } from '../forecast/forecast.service.js';
import { FUEL_TYPES } from '../simulator/simulator.schemas.js';

/** Planning approximation: share forecast burden equally across reachable depots. */
export function depotSupplyRisk(s: NetworkSnapshot, risk: RiskItem[]) {
  return s.depots.flatMap((depot) => FUEL_TYPES.map((fuel) => {
    let projected = depot.inventory[fuel];
    let shortageTick: number | null = null;
    let minimum = projected;
    for (let k = 1; k <= 24; k++) {
      projected += s.supplyArrivals.filter((a) => a.depot_id === depot.id && a.fuel_type === fuel && a.status !== 'ARRIVED' && a.planned_tick === s.instance.tick + k).reduce((v, a) => v + a.quantity, 0);
      for (const item of risk.filter((r) => r.fuel === fuel && r.stationOpen)) {
        const sources = [...new Set(s.routes.filter((r) => r.status === 'AVAILABLE' && r.destination_station_id === item.stationId).map((r) => r.source_depot_id))];
        if (sources.includes(depot.id)) projected -= (item.forecast.perTick[k - 1] ?? 0) / sources.length;
      }
      minimum = Math.min(minimum, projected);
      if (projected < 0 && shortageTick === null) shortageTick = s.instance.tick + k;
    }
    return { depotId: depot.id, fuel, projectedMinimum: Math.round(minimum), shortageTick,
      delayedArrivals: s.supplyArrivals.filter((a) => a.depot_id === depot.id && a.fuel_type === fuel && a.status === 'DELAYED').map((a) => ({ id: a.id, plannedTick: a.planned_tick, quantity: a.quantity })) };
  }));
}
