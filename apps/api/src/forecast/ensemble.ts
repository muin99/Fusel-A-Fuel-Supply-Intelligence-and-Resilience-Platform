import {
  forecastDemand,
  priorPerTick,
  type Forecast,
  type ForecastInput,
} from './forecast.math.js';

export const MODEL_VERSION = 'adaptive-ensemble-2.0.0';
const mean = (a: number[]) =>
  a.reduce((s, v) => s + v, 0) / Math.max(a.length, 1);
const quantile = (a: number[], p: number) =>
  [...a].sort((x, y) => x - y)[
    Math.min(a.length - 1, Math.ceil((a.length + 1) * p) - 1)
  ] ?? 0;

function candidates(i: ForecastInput, horizon: number) {
  const baseline = forecastDemand(i, horizon);
  const recent = i.history.slice(-12);
  const level = mean(recent.map((x) => x.demand));
  const ratios = recent.map(
    (x) =>
      x.demand /
      Math.max(1, priorPerTick({ ...i, demandMultiplier: 1 }, x.simTime)),
  );
  const ratio = ratios.length ? mean(ratios) : i.demandMultiplier;
  return {
    seasonal_ewma: baseline.perTick,
    local_mean: Array(horizon).fill(
      recent.length ? level : baseline.perTick[0],
    ) as number[],
    seasonal_regression: Array.from(
      { length: horizon },
      (_, k) =>
        priorPerTick(
          { ...i, demandMultiplier: 1 },
          new Date(i.startTime.getTime() + k * i.tickMinutes * 60000),
        ) * ratio,
    ),
  };
}

/** Rolling-origin validation uses only observations strictly before each target. */
export function ensembleForecast(
  i: ForecastInput,
  horizon: number,
): Forecast & {
  version: string;
  weights: Record<string, number>;
  validationMae: Record<string, number>;
  lower: number[];
  upper: number[];
  drift: boolean;
  driftScore: number;
  validationSamples: number;
} {
  const baseline = forecastDemand(i, horizon);
  const names = ['seasonal_ewma', 'local_mean', 'seasonal_regression'] as const;
  const errors: Record<string, number[]> = Object.fromEntries(
    names.map((n) => [n, []]),
  );
  for (let t = Math.max(8, i.history.length - 24); t < i.history.length; t++) {
    const target = i.history[t];
    const pred = candidates(
      { ...i, history: i.history.slice(0, t), startTime: target.simTime },
      1,
    );
    for (const name of names)
      errors[name].push(Math.abs(pred[name][0] - target.demand));
  }
  const validationMae = Object.fromEntries(
    names.map((n) => [n, mean(errors[n])]),
  );
  const inv = names.map((n) =>
    errors[n].length
      ? 1 / Math.max(1, validationMae[n])
      : n === 'seasonal_ewma'
        ? 1
        : 0,
  );
  const total = inv.reduce((a, b) => a + b, 0);
  const weights = Object.fromEntries(names.map((n, k) => [n, inv[k] / total]));
  const next = candidates(i, horizon);
  const perTick = Array.from({ length: horizon }, (_, k) =>
    names.reduce((s, n) => s + weights[n] * next[n][k], 0),
  );
  const recent = i.history
    .slice(-8)
    .map(
      (x) =>
        x.demand /
        Math.max(1, priorPerTick({ ...i, demandMultiplier: 1 }, x.simTime)),
    );
  const reference = i.history
    .slice(-40, -8)
    .map(
      (x) =>
        x.demand /
        Math.max(1, priorPerTick({ ...i, demandMultiplier: 1 }, x.simTime)),
    );
  const driftScore =
    reference.length >= 8
      ? Math.abs(mean(recent) - mean(reference)) /
        Math.max(0.1, mean(reference))
      : 0;
  const drift = driftScore > 0.3;
  // Conservative weighted individual-model residual bounds; empirical, not a coverage guarantee.
  const residualBound = names.reduce(
    (s, n) => s + weights[n] * quantile(errors[n], 0.9),
    0,
  );
  const radius = (k: number) =>
    Math.max(residualBound, perTick[k] * baseline.cv) *
    Math.sqrt(k + 1) *
    (drift ? 1.5 : 1);
  return {
    ...baseline,
    perTick,
    confidence: drift
      ? Math.min(0.55, baseline.confidence)
      : baseline.confidence,
    version: MODEL_VERSION,
    weights,
    validationMae,
    lower: perTick.map((v, k) => Math.max(0, v - radius(k))),
    upper: perTick.map((v, k) => v + radius(k)),
    drift,
    driftScore,
    validationSamples: errors[names[0]].length,
  };
}
