import { ensembleForecast } from './ensemble.js';
import { priorPerTick } from './forecast.math.js';
const base = { profile: 'urban_high', fuel: 'DIESEL' as const, regionFactor: 1, demandMultiplier: 1, tickMinutes: 15, startTime: new Date('2026-01-02T00:00:00Z') };
function history(spike = false) {
  return Array.from({ length: 64 }, (_, tick) => {
    const simTime = new Date(Date.UTC(2026, 0, 1, 0, tick * 15));
    return { tick, simTime, demand: priorPerTick(base, simTime) * (spike && tick >= 56 ? 2 : 1) };
  });
}
describe('adaptive ensemble', () => {
  it('cold start stays finite, conservative and nonnegative', () => {
    const f = ensembleForecast({ ...base, history: [] }, 24);
    expect(f.perTick.every((x) => Number.isFinite(x) && x >= 0)).toBe(true);
    expect(f.confidence).toBeLessThan(0.5);
    expect(f.validationSamples).toBe(0);
  });
  it('learns normalized weights and orders interval bounds', () => {
    const f = ensembleForecast({ ...base, history: history() }, 24);
    expect(Object.values(f.weights).reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    expect(f.validationSamples).toBe(24);
    f.perTick.forEach((v, k) => { expect(f.lower[k]).toBeLessThanOrEqual(v); expect(f.upper[k]).toBeGreaterThanOrEqual(v); });
  });
  it('detects a recent distribution shift and requests review', () => {
    const f = ensembleForecast({ ...base, history: history(true) }, 24);
    expect(f.drift).toBe(true);
    expect(f.confidence).toBeLessThan(0.7);
  });
  it('historical validation does not use a future start time', () => {
    const a = ensembleForecast({ ...base, history: history() }, 24);
    const b = ensembleForecast({ ...base, startTime: new Date('2030-01-01'), history: history() }, 24);
    expect(a.validationMae).toEqual(b.validationMae);
  });
});
