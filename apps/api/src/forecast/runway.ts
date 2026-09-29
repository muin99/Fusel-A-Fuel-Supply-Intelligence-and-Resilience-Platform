import { FUEL_TYPES, FuelType } from '../simulator/simulator.schemas.js';
import type { NetworkSnapshot } from '../state/state.types.js';
import type { RiskItem } from './forecast.service.js';
import { networkFeatures, predict } from './operational.js';

export interface FuelRunway {
  fuel: FuelType;
  /** depots + stations + shipments in flight */
  onHandLiters: number;
  /** supply arrivals not yet arrived (scheduled or delayed) */
  scheduledSupplyLiters: number;
  demandPerHour: number;
  hoursOfCover: number | null;
  exhaustionTick: number | null;
  /** trained ML estimate of hours to network depletion (capped at 96 h) */
  mlHoursOfCover?: number | null;
}

/**
 * Network-level fuel runway: how long all fuel in the system (plus scheduled supply)
 * lasts at the forecast demand rate. Explains shortages no allocation can fix.
 */
export function networkRunway(s: NetworkSnapshot, risk: RiskItem[] | null): { fuels: FuelRunway[]; lastSupplyTick: number | null; hoursOfCover: number | null } {
  const ticksPerHour = 60 / s.instance.tick_minutes;
  const fuels = FUEL_TYPES.map((fuel) => {
    const onHand =
      s.depots.reduce((a, d) => a + d.inventory[fuel], 0) +
      s.stations.reduce((a, st) => a + st.inventory[fuel], 0) +
      s.allocations.filter((a) => a.fuel_type === fuel && (a.status === 'PENDING' || a.status === 'IN_TRANSIT')).reduce((a, x) => a + x.quantity, 0);
    const scheduled = s.supplyArrivals.filter((a) => a.fuel_type === fuel && a.status !== 'ARRIVED').reduce((a, x) => a + x.quantity, 0);
    const perTick = (risk ?? []).filter((r) => r.fuel === fuel && r.stationOpen).reduce((a, r) => a + (r.forecast.perTick.slice(0, 24).reduce((x, y) => x + y, 0) / 24 || 0), 0);
    const hours = perTick > 0 ? (onHand + scheduled) / perTick / ticksPerHour : null;
    let mlHours: number | null = null;
    if (perTick > 0) {
      try {
        const forecast = Array.from({ length: 24 }, (_, k) => (risk ?? []).filter((r) => r.fuel === fuel && r.stationOpen).reduce((a, r) => a + (r.forecast.perTick[k] ?? 0), 0));
        const supply = Array.from({ length: 384 }, (_, k) => s.supplyArrivals.filter((a) => a.fuel_type === fuel && a.status !== 'ARRIVED' && a.planned_tick === s.instance.tick + k + 1).reduce((x, a) => x + a.quantity, 0));
        const cv = (risk ?? []).find((r) => r.fuel === fuel)?.forecast.cv ?? 0.12;
        mlHours = Math.round(Math.max(0, predict('network_runway', networkFeatures(onHand, forecast, supply, cv))) * 10) / 10;
      } catch {
        mlHours = null;
      }
    }
    return {
      fuel,
      onHandLiters: Math.round(onHand),
      scheduledSupplyLiters: Math.round(scheduled),
      demandPerHour: Math.round(perTick * ticksPerHour),
      hoursOfCover: hours === null ? null : Math.round(hours * 10) / 10,
      exhaustionTick: hours === null ? null : s.instance.tick + Math.round(hours * ticksPerHour),
      mlHoursOfCover: mlHours,
    };
  });
  const pending = s.supplyArrivals.filter((a) => a.status !== 'ARRIVED');
  const covers = fuels.map((f) => f.hoursOfCover).filter((h): h is number => h !== null);
  return { fuels, lastSupplyTick: pending.length ? Math.max(...pending.map((a) => a.planned_tick)) : null, hoursOfCover: covers.length ? Math.min(...covers) : null };
}
