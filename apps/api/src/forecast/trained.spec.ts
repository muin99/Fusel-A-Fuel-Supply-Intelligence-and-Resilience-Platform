import { readFileSync } from 'node:fs';
import { predictTrees, trainedForecast, trainedModelInfo } from './trained.js';
import { priorPerTick } from './forecast.math.js';
const input={profile:'urban_high',fuel:'DIESEL' as const,regionFactor:1,demandMultiplier:1,tickMinutes:15,startTime:new Date('2026-01-02T00:00:00Z')};
const history=Array.from({length:48},(_,tick)=>{const simTime=new Date(Date.UTC(2026,0,1,0,tick*15));return {tick,simTime,demand:priorPerTick(input,simTime)};});
describe('exported trained ensemble',()=>{
 it('matches scikit-learn held-out predictions',()=>{
  const fixtures=JSON.parse(readFileSync(new URL('./trained-fixtures.json',import.meta.url),'utf8')) as {features:number[];expected:number}[];
  expect(trainedModelInfo().available).toBe(true);
  for(const f of fixtures)expect(predictTrees(f.features)).toBeCloseTo(f.expected,5);
 });
 it('produces a complete trained forecast for the existing risk engine',()=>{
  const f=trainedForecast({...input,history},24);expect(f.engine).toBe('trained');expect(f.perTick).toHaveLength(24);
  f.perTick.forEach((v,k)=>{expect(Number.isFinite(v)&&v>=0).toBe(true);expect(f.lower[k]).toBeLessThanOrEqual(v);expect(f.upper[k]).toBeGreaterThanOrEqual(v);});
 });
 it('keeps the application usable at cold start or outside trained support',()=>{
  for(const f of [trainedForecast({...input,history:[]},24),trainedForecast({...input,history,tickMinutes:30},24)]){expect(f.engine).toBe('statistical_fallback');expect(f.perTick.every(Number.isFinite)).toBe(true);}
  expect(()=>predictTrees(Array(15).fill(NaN))).toThrow();expect(()=>predictTrees(Array(15).fill(0),null)).toThrow();
 });
});
