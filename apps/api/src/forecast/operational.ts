import { readFileSync } from 'node:fs';

/**
 * Operational ML predictors (scikit-learn RF + ExtraTrees + GradientBoosting per task, exported
 * to JSON by scripts/ml/train_operational.py). Pure TypeScript inference; each task falls back
 * to the analytic calculation when the artifact is missing or features are invalid.
 */
type Tree = { left: number[]; right: number[]; feature: number[]; threshold: number[]; value: number[] };
type Model = { name: string; base: number; rate: number; transform: 'identity' | 'sigmoid'; trees: Tree[] };
type Task = { features: string[]; models: Model[]; weights: number[]; residual90: number | null; report: Record<string, unknown> };
export type TaskKey = 'stockout_probability' | 'stockout_time' | 'depot_runway' | 'network_runway' | 'transport_delay';

let tasks: Record<string, Task> | null = null;
let version: string | null = null;
let loadError: string | null = null;
try {
  const parsed = JSON.parse(readFileSync(new URL('./operational-models.json', import.meta.url), 'utf8')) as { version: string; tasks: Record<string, Task> };
  for (const [k, t] of Object.entries(parsed.tasks)) {
    if (t.models.length !== t.weights.length || Math.abs(t.weights.reduce((a, b) => a + b, 0) - 1) > 1e-3) throw new Error(`invalid weights for ${k}`);
    for (const m of t.models) for (const tr of m.trees) if (tr.left.length !== tr.value.length) throw new Error(`invalid tree in ${k}`);
  }
  tasks = parsed.tasks;
  version = parsed.version;
} catch (e) {
  loadError = (e as Error).message;
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

export function operationalInfo() {
  return {
    available: !!tasks,
    version,
    error: loadError,
    tasks: tasks ? Object.fromEntries(Object.entries(tasks).map(([k, t]) => [k, { features: t.features, models: t.models.map((m) => `${m.name} (${m.trees.length} trees)`), weights: t.weights, residual90: t.residual90, report: t.report }])) : {},
  };
}

/** Weighted tree-ensemble prediction for one task; throws on invalid input (callers fall back). */
export function predict(task: TaskKey, features: number[]): number {
  const t = tasks?.[task];
  if (!t) throw new Error(loadError ?? 'operational model unavailable');
  if (features.length !== t.features.length || features.some((v) => !Number.isFinite(v))) throw new Error(`invalid features for ${task}`);
  return t.models.reduce((acc, m, k) => {
    let sum = 0;
    for (const tree of m.trees) {
      let n = 0;
      let depth = 0;
      while (tree.left[n] !== -1) {
        if (++depth > 64) throw new Error('invalid tree traversal');
        n = features[tree.feature[n]] <= tree.threshold[n] ? tree.left[n] : tree.right[n];
      }
      sum += tree.value[n];
    }
    const raw = m.base + m.rate * sum;
    return acc + t.weights[k] * (m.transform === 'sigmoid' ? sigmoid(raw) : raw);
  }, 0);
}

export function residual90(task: TaskKey): number | null {
  return tasks?.[task]?.residual90 ?? null;
}

const sum = (a: number[]) => a.reduce((s, v) => s + v, 0);

/** Mirrors inv_features() in train_operational.py (24-tick forecast / arrivals). */
export function inventoryFeatures(inv: number, forecast: number[], arrivals: number[], cv: number): number[] {
  const mean = Math.max(1e-6, sum(forecast) / forecast.length);
  const total = Math.max(1e-6, sum(forecast));
  const path: number[] = [];
  let acc = inv;
  for (let i = 0; i < forecast.length; i++) path.push((acc += (arrivals[i] ?? 0) - forecast[i]));
  const due = arrivals.findIndex((a) => a > 0);
  const minCover = (k: number) => Math.min(inv, ...path.slice(0, k)) / mean;
  return [
    inv / mean,
    cv,
    sum(forecast.slice(0, 4)) / total,
    sum(forecast.slice(0, 12)) / total,
    minCover(4),
    minCover(12),
    minCover(24),
    due >= 0 ? due + 1 : 25,
    sum(arrivals.slice(0, 4)) / mean,
    sum(arrivals.slice(0, 12)) / mean,
    sum(arrivals.slice(0, 24)) / mean,
    Math.max(...forecast) / mean,
  ];
}

/** Mirrors net_features(): 24-tick demand forecast, 384-tick supply schedule. */
export function networkFeatures(inv: number, forecast: number[], arrivals: number[], cv: number): number[] {
  const mean = Math.max(1e-6, sum(forecast) / forecast.length);
  const total = Math.max(1e-6, sum(forecast));
  const due = arrivals.findIndex((a) => a > 0);
  return [
    inv / mean,
    cv,
    due >= 0 ? due + 1 : 385,
    ...[4, 24, 48, 96, 192, 384].map((k) => sum(arrivals.slice(0, k)) / mean),
    sum(forecast.slice(0, 4)) / total,
    sum(forecast.slice(0, 12)) / total,
    Math.max(...forecast) / mean,
  ];
}

/** [nominal_transit_ticks, hour_sin, hour_cos, depot_constrained, dispatch_load_ratio, observed_mean_delay, samples] */
export function transportFeatures(nominal: number, hour: number, constrained: boolean, loadRatio: number, meanDelay: number, samples: number): number[] {
  return [nominal, Math.sin((hour * Math.PI) / 12), Math.cos((hour * Math.PI) / 12), constrained ? 1 : 0, loadRatio, meanDelay, samples];
}
