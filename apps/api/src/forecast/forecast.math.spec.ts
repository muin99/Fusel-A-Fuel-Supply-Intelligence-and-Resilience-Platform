import { assessStockout, forecastDemand, normCdf, priorPerTick } from './forecast.math.js';

const base = {
  profile: 'urban_high',
  fuel: 'DIESEL' as const,
  regionFactor: 1,
  demandMultiplier: 1,
  tickMinutes: 15,
  startTime: new Date('2026-01-01T08:00:00Z'),
};

describe('forecast math', () => {
  it('normCdf is a proper CDF', () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 3);
    expect(normCdf(1.96)).toBeCloseTo(0.975, 2);
    expect(normCdf(-5)).toBeLessThan(0.001);
  });

  it('prior applies hour-of-day busy factor', () => {
    const busy = priorPerTick(base, new Date('2026-01-01T08:00:00Z'));
    const quiet = priorPerTick(base, new Date('2026-01-01T03:00:00Z'));
    expect(busy / quiet).toBeCloseTo(1.45 / 0.7, 5);
  });

  it('cold start uses the prior and low confidence', () => {
    const f = forecastDemand({ ...base, history: [] }, 4);
    expect(f.samples).toBe(0);
    expect(f.level).toBe(1);
    expect(f.perTick[0]).toBeCloseTo(priorPerTick(base, base.startTime), 5);
    expect(f.confidence).toBeLessThan(0.5);
  });

  it('learns a demand spike from history', () => {
    const history = Array.from({ length: 30 }, (_, i) => {
      const simTime = new Date(Date.UTC(2026, 0, 1, 0, 15 * i));
      return { tick: i, simTime, demand: 2 * priorPerTick(base, simTime) };
    });
    const f = forecastDemand({ ...base, history }, 4);
    expect(f.level).toBeGreaterThan(1.9);
    expect(f.perTick[0]).toBeCloseTo(2 * priorPerTick(base, base.startTime), -1);
  });

  it('detects a stockout and its ETA', () => {
    const f = { perTick: [100, 100, 100, 100], level: 1, cv: 0.05, confidence: 0.9, samples: 50 };
    const a = assessStockout(250, f, new Map(), 15);
    expect(a.ticksToStockout).toBe(3);
    expect(a.hoursToStockout).toBeCloseTo(0.75);
    expect(a.probability).toBeGreaterThan(0.9);
  });

  it('an arrival before the stockout removes the risk', () => {
    const f = { perTick: [100, 100, 100, 100], level: 1, cv: 0.05, confidence: 0.9, samples: 50 };
    const a = assessStockout(250, f, new Map([[2, 1000]]), 15);
    expect(a.ticksToStockout).toBeNull();
    expect(a.probability).toBeLessThan(0.01);
  });
});
