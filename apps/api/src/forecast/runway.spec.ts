import type { RiskItem } from './forecast.service.js';
import type { NetworkSnapshot } from '../state/state.types.js';
import { networkRunway } from './runway.js';

const fm = (d: number, p: number, o: number) => ({ DIESEL: d, PETROL: p, OCTANE: o });

describe('network runway', () => {
  it('divides all stock plus scheduled supply by forecast demand', () => {
    const s = {
      instance: { tick: 100, tick_minutes: 15 },
      depots: [{ inventory: fm(10000, 0, 0) }],
      stations: [{ inventory: fm(2000, 0, 0) }],
      allocations: [{ fuel_type: 'DIESEL', status: 'IN_TRANSIT', quantity: 1000 }],
      supplyArrivals: [{ fuel_type: 'DIESEL', status: 'SCHEDULED', quantity: 3000, planned_tick: 120 }],
    } as unknown as NetworkSnapshot;
    const risk = [{ fuel: 'DIESEL', stationOpen: true, forecast: { perTick: Array(24).fill(100) } }] as unknown as RiskItem[];
    const r = networkRunway(s, risk);
    const d = r.fuels.find((f) => f.fuel === 'DIESEL')!;
    expect(d.onHandLiters).toBe(13000);
    expect(d.scheduledSupplyLiters).toBe(3000);
    expect(d.demandPerHour).toBe(400);
    expect(d.hoursOfCover).toBe(40); // 16000 L / 400 L/h
    expect(d.exhaustionTick).toBe(260);
    expect(r.lastSupplyTick).toBe(120);
  });
});
