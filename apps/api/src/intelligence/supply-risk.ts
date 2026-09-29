import type { NetworkSnapshot } from '../state/state.types.js';
import type { RiskItem } from '../forecast/forecast.service.js';
import { FUEL_TYPES } from '../simulator/simulator.schemas.js';
import { inventoryFeatures, predict } from '../forecast/operational.js';

/** Planning approximation: share forecast burden equally across reachable depots. */
export function depotSupplyRisk(s: NetworkSnapshot, risk: RiskItem[]) {
  return s.depots.flatMap((depot) => FUEL_TYPES.map((fuel) => {
    let projected = depot.inventory[fuel];
    let shortageTick: number | null = null;
    let minimum = projected;
    const burden: number[] = [];
    const supply: number[] = [];
    for (let k = 1; k <= 24; k++) {
      const arriving = s.supplyArrivals.filter((a) => a.depot_id === depot.id && a.fuel_type === fuel && a.status !== 'ARRIVED' && a.planned_tick === s.instance.tick + k).reduce((v, a) => v + a.quantity, 0);
      supply.push(arriving);
      const before = projected;
      projected += arriving;
      for (const item of risk.filter((r) => r.fuel === fuel && r.stationOpen)) {
        const sources = [...new Set(s.routes.filter((r) => r.status === 'AVAILABLE' && r.destination_station_id === item.stationId).map((r) => r.source_depot_id))];
        if (sources.includes(depot.id)) projected -= (item.forecast.perTick[k - 1] ?? 0) / sources.length;
      }
      burden.push(Math.max(0, before + arriving - projected));
      minimum = Math.min(minimum, projected);
      if (projected < 0 && shortageTick === null) shortageTick = s.instance.tick + k;
    }
    let mlHoursToShortage: number | null = null;
    try {
      const h = predict('depot_runway', inventoryFeatures(depot.inventory[fuel], burden.map((b) => Math.max(b, 1e-3)), supply, 0.12));
      mlHoursToShortage = h >= 6.25 ? null : Math.max(0, Math.round(h * 10) / 10); // 6.25 h = censored "no shortage in 6 h"
    } catch {
      mlHoursToShortage = null;
    }
    return { depotId: depot.id, fuel, projectedMinimum: Math.round(minimum), shortageTick, mlHoursToShortage,
      delayedArrivals: s.supplyArrivals.filter((a) => a.depot_id === depot.id && a.fuel_type === fuel && a.status === 'DELAYED').map((a) => ({ id: a.id, plannedTick: a.planned_tick, quantity: a.quantity })) };
  }));
}
