import {readFileSync,writeFileSync} from 'node:fs';
const env=Object.fromEntries(readFileSync('.env','utf8').split('\n').filter(x=>x.includes('=')&&!x.startsWith('#')).map(x=>[x.slice(0,x.indexOf('=')),x.slice(x.indexOf('=')+1).replace(/^['"]|['"]$/g,'')]));
const root='http://localhost:4000/api';const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function call(path,body,token){const res=await fetch(root+path,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},body:body===undefined?undefined:JSON.stringify(body)});const d=await res.json();if(!res.ok)throw Error(path+': '+JSON.stringify(d));return d;}
const login=async(role,scope={})=>(await call('/auth/login',{username:'ml-smoke-'+role,role,password:env[role.toUpperCase()+'_PASSWORD']??role,...scope})).token;
const op=await login('operator');const posture=await call('/decisions/status');const evidence={at:new Date().toISOString()};
try{
 await call('/decisions/autopilot',{enabled:false},op);
 await call('/chaos/simulation',{action:'pause'},op);
 const model=await call('/forecast/trained-model');if(!model.available)throw Error('Trained model unavailable');evidence.version=model.version;
 const t=Date.now();let risk=await call('/forecast/risk');evidence.forecastLatencyMs=Date.now()-t;evidence.trainedSeries=risk.filter(x=>x.forecast.engine==='trained').length;if(evidence.trainedSeries!==12)throw Error('Expected 12 trained series');
 const network=await call('/network');const requests=await call('/requests',undefined,op);
 let pick;
 for(const route of network.routes){if(route.status!=='AVAILABLE')continue;const s=network.stations.find(x=>x.id===route.destination_station_id);const d=network.depots.find(x=>x.id===route.source_depot_id);for(const fuel of ['DIESEL','PETROL','OCTANE'])if(s.status==='OPEN'&&s.capacity[fuel]-s.inventory[fuel]>1500&&d.inventory[fuel]>1500&&!requests.some(x=>x.stationId===s.id&&x.fuelType===fuel&&['OPEN','PLANNED'].includes(x.status))){pick={route,s,d,fuel};break;}if(pick)break;}
 if(!pick)throw Error('No clean request target in current simulator');
 const station=await login('station',{stationId:pick.s.id});const depot=await login('depot',{depotId:pick.d.id});
 const req=await call('/requests',{fuel:pick.fuel,quantity:1000,urgency:'urgent',note:'Trained ML integration verification'},station);evidence.requestId=req.id;
 const accepted=await call(`/requests/${req.id}/accept`,{routeId:pick.route.id,quantity:1000},depot);if(accepted.status!=='PLANNED')throw Error('Acceptance failed');evidence.allocationId=accepted.allocationId;
 for(let i=0;i<pick.route.transit_ticks+2;i++){await call('/chaos/simulation',{action:'step'},op);await sleep(1200);}
 let delivered;
 for(let i=0;i<10;i++){delivered=(await call('/requests',undefined,op)).find(x=>x.id===req.id);if(delivered.status==='FULFILLED')break;await sleep(1000);}
 if(delivered.status!=='FULFILLED')throw Error('Request not fulfilled');evidence.requestStatus=delivered.status;
 await call('/chaos/prediction',{available:false},op);risk=await call('/forecast/risk');if(!risk.every(x=>x.mode==='fallback'))throw Error('Offline fallback failed');evidence.offlineFallback=true;
 await call('/chaos/prediction',{available:true},op);risk=await call('/forecast/risk');if(!risk.every(x=>x.forecast.engine==='trained'))throw Error('Recovery failed');evidence.recovery=true;
 evidence.health=(await call('/health')).status;evidence.result='PASS';
}finally{await call('/chaos/prediction',{available:true},op);await call('/decisions/autopilot',{enabled:posture.autopilot},op);writeFileSync('docs/evidence/ml/live-flow.json',JSON.stringify(evidence,null,2));}
console.log(JSON.stringify(evidence,null,2));
