import { readFileSync } from 'node:fs';
import { ensembleForecast } from './ensemble.js';
import { DAILY_DEMAND } from './priors.js';
import { priorPerTick, type ForecastInput } from './forecast.math.js';

type Tree = { left: number[]; right: number[]; feature: number[]; threshold: number[]; value: number[] };
type Artifact = { version: string; features: string[]; weights: number[]; relative90Bound: number; relativeRmse: number; models: { name: string; kind: string; base: number; rate: number; trees: Tree[] }[]; report: Record<string, unknown> };
let artifact: Artifact | null = null;
let loadError: string | null = null;
try {
  const parsed = JSON.parse(readFileSync(new URL('./trained-model.json', import.meta.url), 'utf8')) as Artifact;
  if (parsed.models.length !== 3 || parsed.features.length !== 15 || !Number.isFinite(parsed.relativeRmse) || Math.abs(parsed.weights.reduce((a,b)=>a+b,0)-1)>0.001) throw new Error('Invalid model metadata');
  for (const model of parsed.models) for (const tree of model.trees) {
    if (!tree.value.length || tree.left.length !== tree.value.length || tree.right.length !== tree.value.length) throw new Error('Invalid tree');
  }
  artifact = parsed;
} catch (e) { loadError = (e as Error).message; }
export function trainedModelInfo() {
  return { available: !!artifact, version: artifact?.version ?? null, error: loadError, report: artifact?.report ?? null };
}
export function predictTrees(features: number[], model: Artifact | null = artifact): number {
  if (!model || features.length !== 15 || features.some((v)=>!Number.isFinite(v))) throw new Error('Trained model unavailable or invalid features');
  const values = model.models.map((m) => {
    let sum = 0;
    for (const tree of m.trees) {
      let n=0; let depth=0;
      while (tree.left[n] !== -1) {
        if (++depth > 64 || n < 0 || n >= tree.value.length) throw new Error('Invalid tree traversal');
        n = features[tree.feature[n]] <= tree.threshold[n] ? tree.left[n] : tree.right[n];
      }
      sum += tree.value[n];
    }
    return m.base + m.rate * sum;
  });
  const value=values.reduce((sum,v,k)=>sum+v*model.weights[k],0);
  if (!Number.isFinite(value) || value < 0) throw new Error('Invalid trained forecast');
  return value;
}
export function trainedForecast(input: ForecastInput, horizon: number) {
  const baseline=ensembleForecast(input,horizon);
  try {
    if (!artifact) throw new Error(loadError ?? 'Artifact unavailable');
    if (input.history.length < 12) throw new Error('Collecting the first 12 demand observations');
    const profiles=['urban_high','industrial','highway','regional']; const fuels=['DIESEL','PETROL','OCTANE'];
    const p=profiles.indexOf(input.profile); const f=fuels.indexOf(input.fuel);
    if (p<0 || f<0 || input.tickMinutes!==15 || input.demandMultiplier<0.5 || input.demandMultiplier>3) throw new Error('Input outside trained operating range');
    const levels=input.history.slice(-24).map((x)=>x.demand/Math.max(1,priorPerTick({...input,demandMultiplier:1},x.simTime)));
    const avg=(a:number[])=>a.reduce((s,x)=>s+x,0)/a.length;
    const scale=DAILY_DEMAND[input.profile][input.fuel]/96*input.regionFactor;
    const perTick=Array.from({length:horizon},(_,k)=>{
      const h=new Date(input.startTime.getTime()+k*15*60000).getUTCHours();
      const features=[Math.sin(h*Math.PI/12),Math.cos(h*Math.PI/12),h,...profiles.map((_,j)=>+(j===p)),...fuels.map((_,j)=>+(j===f)),input.demandMultiplier,levels.at(-1)!,avg(levels.slice(-4)),avg(levels.slice(-12)),k+1];
      return predictTrees(features)*scale;
    });
    const cv=Math.max(0.08,artifact.relativeRmse,baseline.drift?baseline.cv:0);
    const confidence=Math.max(0.2,Math.min(baseline.drift?0.55:0.95,1-artifact.relativeRmse));
    const radius=artifact.relative90Bound*(baseline.drift?1.5:1);
    return {...baseline,perTick,cv,confidence,version:artifact.version,engine:'trained' as const,fallbackReason:null,weights:Object.fromEntries(artifact.models.map((m,k)=>[m.name,artifact!.weights[k]])),lower:perTick.map(v=>Math.max(0,v*(1-radius))),upper:perTick.map(v=>v*(1+radius))};
  } catch(e) {
    return {...baseline,engine:'statistical_fallback' as const,fallbackReason:(e as Error).message};
  }
}
