// Load test for the Fuel Ops API.
// Run:  pnpm loadtest            (default: ramp to 50 VUs, ~2.5 min)
//       VUS=100 pnpm loadtest    (override peak concurrency)
// Workload mix (what an operations center actually does):
//   60% dashboard read path  (GET /network, /forecast/risk, /alerts)
//   25% decision read path   (GET /recommendations)
//   15% decision what-if     (POST /decisions/what-if — runs the forecast + stockout model)
import http from 'k6/http';
import { check, group } from 'k6';
import { Trend } from 'k6/metrics';

const BASE = __ENV.API_URL || 'http://host.docker.internal:4000/api';
const PEAK = Number(__ENV.VUS || 50);
const whatIfLatency = new Trend('whatif_latency', true);
const riskLatency = new Trend('risk_latency', true);

export const options = {
  scenarios: {
    operators: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: '30s', target: Math.ceil(PEAK / 2) },
        { duration: '60s', target: PEAK },
        { duration: '45s', target: PEAK },
        { duration: '15s', target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<300', 'p(99)<800'],
    whatif_latency: ['p(95)<500'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

export function setup() {
  const net = http.get(`${BASE}/network`).json();
  const route = net.routes.find((r) => r.status === 'AVAILABLE');
  return { stationId: route.destination_station_id, routeId: route.id };
}

export default function (ctx) {
  const r = Math.random();
  if (r < 0.6) {
    group('dashboard', () => {
      const res = http.batch([
        ['GET', `${BASE}/network`],
        ['GET', `${BASE}/forecast/risk`],
        ['GET', `${BASE}/alerts?limit=20`],
      ]);
      riskLatency.add(res[1].timings.duration);
      check(res[0], { 'network 200': (x) => x.status === 200 });
      check(res[1], { 'risk 200': (x) => x.status === 200 });
    });
  } else if (r < 0.85) {
    group('recommendations', () => {
      const res = http.get(`${BASE}/recommendations?limit=50`);
      check(res, { 'recs 200': (x) => x.status === 200 });
    });
  } else {
    group('what-if', () => {
      const res = http.post(
        `${BASE}/decisions/what-if`,
        JSON.stringify({ stationId: ctx.stationId, fuel: 'DIESEL', routeId: ctx.routeId, quantity: 3000 }),
        { headers: { 'Content-Type': 'application/json' } },
      );
      whatIfLatency.add(res.timings.duration);
      check(res, { 'what-if 201': (x) => x.status === 201 });
    });
  }
}

export function handleSummary(data) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return {
    stdout: textSummary(data),
    [`/results/k6-summary-${stamp}.json`]: JSON.stringify(data, null, 2),
  };
}

function textSummary(d) {
  const m = d.metrics;
  const t = (k) => m[k]?.values ?? {};
  const f = (v) => (v === undefined ? '-' : `${v.toFixed(1)} ms`);
  const rows = ['http_req_duration', 'risk_latency', 'whatif_latency'].map(
    (k) => `  ${k.padEnd(18)} avg ${f(t(k).avg)}  p50 ${f(t(k).med)}  p95 ${f(t(k)['p(95)'])}  p99 ${f(t(k)['p(99)'])}  max ${f(t(k).max)}`,
  );
  return [
    '',
    '=== Fuel Ops load test ===',
    `  peak VUs           ${t('vus_max').max}`,
    `  requests           ${t('http_reqs').count}  (${t('http_reqs').rate?.toFixed(1)} req/s)`,
    `  error rate         ${((t('http_req_failed').rate ?? 0) * 100).toFixed(2)}%`,
    ...rows,
    `  thresholds         ${Object.entries(d.metrics).filter(([, v]) => v.thresholds).map(([k, v]) => `${k}:${Object.values(v.thresholds).every((x) => x.ok) ? 'PASS' : 'FAIL'}`).join(' ')}`,
    '',
  ].join('\n');
}
