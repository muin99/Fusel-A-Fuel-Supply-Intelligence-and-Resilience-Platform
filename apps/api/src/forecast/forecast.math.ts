import type { FuelType } from '../simulator/simulator.schemas.js';
import { DAILY_DEMAND, NOISE, hourFactor } from './priors.js';

/**
 * Baseline demand model = seasonal prior (profile × hour-of-day × region × multiplier)
 * scaled by a learned level ratio (EWMA of actual / prior). The ratio adapts to demand
 * spikes within a few ticks. Swap in a stronger model later (see docs/04-roadmap.md) —
 * keep this one as the fallback.
 */
export interface ForecastInput {
  profile: string;
  fuel: FuelType;
  regionFactor: number;
  demandMultiplier: number;
  tickMinutes: number;
  /** simulated time of the NEXT tick */
  startTime: Date;
  /** recent observations, oldest first */
  history: { tick: number; simTime: Date; demand: number }[];
}

export interface Forecast {
  perTick: number[];
  level: number;
  cv: number;
  confidence: number;
  samples: number;
}

export function priorPerTick(i: Omit<ForecastInput, 'history' | 'startTime'>, at: Date): number {
  const daily = DAILY_DEMAND[i.profile]?.[i.fuel] ?? 0;
  const ticksPerDay = (24 * 60) / i.tickMinutes;
  return (daily / ticksPerDay) * hourFactor(i.profile, at.getUTCHours()) * i.regionFactor * i.demandMultiplier;
}

export function forecastDemand(input: ForecastInput, horizon: number, alpha = 0.3): Forecast {
  // Learn level ratio over history (prior already includes the CURRENT multiplier, so
  // use multiplier=1 for history priors — the ratio then captures spikes on its own).
  const base = { ...input, demandMultiplier: 1 };
  let level = 1;
  const ratios: number[] = [];
  for (const h of input.history) {
    const p = priorPerTick(base, h.simTime);
    if (p <= 0) continue;
    const r = h.demand / p;
    ratios.push(r);
    level = alpha * r + (1 - alpha) * level;
  }
  const n = ratios.length;
  const mean = n ? ratios.reduce((a, b) => a + b, 0) / n : 1;
  const sd = n > 1 ? Math.sqrt(ratios.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  const cv = n > 5 ? Math.max(sd / Math.max(mean, 1e-6), 0.02) : (NOISE[input.profile] ?? 0.12) * 2;

  // With history the learned level already reflects the live multiplier; without it use the prior as-is.
  const effective = n > 0 ? { ...base } : input;
  const lvl = n > 0 ? level : 1;
  const stepMs = input.tickMinutes * 60_000;
  const perTick = Array.from({ length: horizon }, (_, k) =>
    Math.max(0, priorPerTick(effective, new Date(input.startTime.getTime() + k * stepMs)) * lvl),
  );

  // Confidence: more samples + lower dispersion => higher. Capped to [0.2, 0.98].
  const sampleScore = Math.min(1, n / 48);
  const confidence = Math.max(0.2, Math.min(0.98, 0.35 + 0.6 * sampleScore - Math.min(0.4, cv)));
  return { perTick, level: lvl, cv, confidence, samples: n };
}

/** Standard normal CDF (Abramowitz–Stegun). */
export function normCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}

export interface StockoutAssessment {
  /** ticks until inventory hits zero under the mean forecast; null = not within horizon */
  ticksToStockout: number | null;
  hoursToStockout: number | null;
  /** P(stockout within horizon) under forecast uncertainty */
  probability: number;
  expectedDemand: number;
  projectedMin: number;
}

/**
 * Walks inventory forward: inv_t = inv_{t-1} - demand_t + arrivals_t.
 * `arrivals` maps tick offset (1 = next tick) -> liters.
 */
export function assessStockout(
  inventory: number,
  forecast: Forecast,
  arrivals: Map<number, number>,
  tickMinutes: number,
): StockoutAssessment {
  let inv = inventory;
  let cumDemand = 0;
  let cumArrivals = 0;
  let variance = 0;
  let ticksToStockout: number | null = null;
  let projectedMin = inventory;
  let worstZ = Infinity;
  forecast.perTick.forEach((d, idx) => {
    const k = idx + 1;
    const a = arrivals.get(k) ?? 0;
    cumArrivals += a;
    cumDemand += d;
    variance += (d * forecast.cv) ** 2;
    inv = inv - d + a;
    projectedMin = Math.min(projectedMin, inv);
    if (ticksToStockout === null && inv <= 0) ticksToStockout = k;
    // stockout at step k if cumDemand_k > inventory + arrivals_k
    const z = (inventory + cumArrivals - cumDemand) / Math.max(Math.sqrt(variance), 1e-6);
    worstZ = Math.min(worstZ, z);
  });
  const probability = forecast.perTick.length ? 1 - normCdf(worstZ) : 0;
  return {
    ticksToStockout,
    hoursToStockout: ticksToStockout === null ? null : (ticksToStockout * tickMinutes) / 60,
    probability,
    expectedDemand: cumDemand,
    projectedMin,
  };
}
