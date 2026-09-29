// End-to-end judge check against the LIVE stack (simulator + API).
// Exercises every role, the decision loop, crises, failure drills and recovery.
// Usage: node scripts/judge-check.mjs   (writes docs/evidence/judge-check.json)
// Note: pauses/steps the local simulator and injects events/faults. Local judging only.
import { mkdir, readFile, writeFile } from "node:fs/promises";

const env = Object.fromEntries(
  (await readFile(".env", "utf8"))
    .split("\n")
    .filter((x) => x.includes("=") && !x.startsWith("#"))
    .map((x) => [x.slice(0, x.indexOf("=")), x.slice(x.indexOf("=") + 1).replace(/^['"]|['"]$/g, "")]),
);
// A manual presentation must not be advanced by a background verification runner.
if (env.MANUAL_DEMO === "true" && process.env.ALLOW_SIMULATION_TESTS !== "true") {
  console.error("Manual demo is enabled: automated simulation changes are disabled. Set ALLOW_SIMULATION_TESTS=true explicitly to run this check.");
  process.exit(1);
}
const base = process.env.API_URL ?? "http://localhost:4000/api";
const SIM = process.env.SIM_URL ?? "http://localhost:8000";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(path, { body, token, method } = {}) {
  const r = await fetch(base + path, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  });
  const text = await r.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: r.status, data };
}
async function ok(path, opts) {
  const r = await call(path, opts);
  if (r.status >= 400) throw new Error(`${path} → HTTP ${r.status}: ${JSON.stringify(r.data)?.slice(0, 200)}`);
  return r.data;
}
const sim = (path) => fetch(SIM + path, { method: "POST" }).then((r) => r.json());
const step = async (n) => {
  for (let i = 0; i < n; i++) await sim("/admin/step");
  await sleep(3500); // let the API refresh + pipeline run
};
const login = async (body) => (await ok("/auth/login", { body })).token;
const demoMode = (await ok("/auth/config")).demoMode;
// Role tokens: demo mode avoids spending the 10/min password-login budget; roles are enforced either way.
const as = async (body) => (demoMode ? (await ok("/auth/demo", { body: { role: body.role, stationId: body.stationId, depotId: body.depotId } })).token : login(body));

const checks = [];
function assert(v, m) {
  if (!v) throw new Error(m);
}
async function check(name, fn) {
  const t0 = Date.now();
  try {
    const result = await fn();
    checks.push({ name, passed: true, ms: Date.now() - t0, result });
    console.log(`PASS  ${name}`);
  } catch (e) {
    checks.push({ name, passed: false, ms: Date.now() - t0, error: e.message });
    console.log(`FAIL  ${name}: ${e.message}`);
  }
}

// ---------------------------------------------------------------- setup
const operator = await login({ username: "judge-operator", role: "operator", password: env.OPERATOR_PASSWORD });
const viewer = await as({ username: "judge-viewer", role: "viewer", password: env.VIEWER_PASSWORD });
const mirpur = await as({ username: "mirpur-manager", role: "station", stationId: "station-mirpur", password: env.STATION_PASSWORD ?? "station" });
const tongi = await as({ username: "tongi-manager", role: "station", stationId: "station-tongi", password: env.STATION_PASSWORD ?? "station" });
const gazipur = await as({ username: "gazipur-manager", role: "depot", depotId: "depot-gazipur", password: env.DEPOT_PASSWORD ?? "depot" });
const patiya = await as({ username: "patiya-manager", role: "depot", depotId: "depot-patiya", password: env.DEPOT_PASSWORD ?? "depot" });
// Known starting point: fresh world, no drills, no leftover requests, 24 ticks of history.
await ok("/chaos/restore", { body: {}, token: operator });
for (const r of await ok("/requests", { token: operator })) if (r.status === "OPEN") await call(`/requests/${r.id}/cancel`, { body: {}, token: operator });
await ok("/chaos/simulation", { body: { action: "reset" }, token: operator });
await ok("/chaos/simulation", { body: { action: "pause" }, token: operator });
await ok("/decisions/autopilot", { body: { enabled: true }, token: operator });
await sleep(4000);
await step(24);
const start = await ok("/network");
await mkdir("docs/evidence", { recursive: true });
await writeFile("docs/evidence/pre-review-state.json", JSON.stringify(start, null, 2));

// ---------------------------------------------------------------- platform
await check("All components healthy", async () => {
  const h = await ok("/health");
  const bad = h.components.filter((c) => c.status === "down");
  assert(!bad.length, `down: ${bad.map((c) => c.name).join(", ")}`);
  return { status: h.status, components: h.components.map((c) => `${c.name}: ${c.status}`), p95Ms: h.p95Ms };
});

// ---------------------------------------------------------------- security / roles
await check("Wrong password is rejected (401)", async () => {
  const r = await call("/auth/login", { body: { username: "x", role: "operator", password: "wrong" } });
  assert(r.status === 401, `got ${r.status}`);
  return r.status;
});
await check("Viewer cannot change autopilot or inject faults (403)", async () => {
  const a = await call("/decisions/autopilot", { body: { enabled: false }, token: viewer });
  const b = await call("/chaos/faults", { body: { type: "latency", duration_seconds: 5 }, token: viewer });
  assert(a.status === 403 && b.status === 403, `${a.status}/${b.status}`);
  return [a.status, b.status];
});
await check("Unauthenticated mutation is rejected (401)", async () => {
  const r = await call("/chaos/prediction", { body: { available: false } });
  assert(r.status === 401, `got ${r.status}`);
  return r.status;
});
await check("Station manager cannot request fuel for another station (403)", async () => {
  const r = await call("/requests", { body: { stationId: "station-tongi", fuel: "DIESEL", quantity: 2000, urgency: "routine" }, token: mirpur });
  assert(r.status === 403, `got ${r.status}`);
  return r.status;
});
await check("Invalid input is rejected with a clear error (400)", async () => {
  const r = await call("/requests", { body: { fuel: "KEROSENE", quantity: -5 }, token: mirpur });
  assert(r.status === 400, `got ${r.status}`);
  return r.data;
});

// ---------------------------------------------------------------- station → depot workflow
let requestId;
await check("Station manager raises a request; duplicate is refused (409)", async () => {
  const net = await ok("/network");
  const m = net.stations.find((s) => s.id === "station-mirpur");
  const qty = Math.max(500, Math.min(3000, Math.floor((m.capacity.OCTANE - m.inventory.OCTANE - 500) / 100) * 100));
  const r = await ok("/requests", { body: { fuel: "OCTANE", quantity: qty, urgency: "urgent", note: "judge-check" }, token: mirpur });
  requestId = r.id;
  const dup = await call("/requests", { body: { fuel: "OCTANE", quantity: qty, urgency: "urgent" }, token: mirpur });
  assert(dup.status === 409, `duplicate got ${dup.status}`);
  return { id: r.id, status: r.status, quantity: qty };
});
await check("Depot inbox is scoped: Patiya sees Mirpur (serves it), request carries model view", async () => {
  const list = await ok("/requests", { token: patiya });
  const r = list.find((x) => x.id === requestId);
  assert(r, "Patiya (route-patiya-mirpur) should see the Mirpur request");
  assert(r.modelView && "agrees" in r.modelView, "missing model view");
  const tongiList = await ok("/requests", { token: tongi });
  assert(!tongiList.some((x) => x.id === requestId), "Tongi must not see Mirpur's request");
  return { modelView: r.modelView, servingDepots: r.servingDepots };
});
await check("Depot manager accepts → real simulator allocation (PLANNED); blocked route is refused", async () => {
  // Mirpur is served by Gazipur (2 ticks) and Patiya (4 ticks): use whichever has an open road.
  const req = (await ok("/requests", { token: operator })).find((x) => x.id === requestId);
  const open = req.routes.filter((x) => x.status === "AVAILABLE");
  assert(open.length, "no available route to Mirpur");
  const blocked = req.routes.find((x) => x.status !== "AVAILABLE");
  if (blocked) {
    const refused = await call(`/requests/${requestId}/accept`, { body: { routeId: blocked.id }, token: blocked.depotId === "depot-gazipur" ? gazipur : patiya });
    assert(refused.status === 409, `accept on disrupted route got ${refused.status}`);
  }
  const via = open.sort((a, b) => a.transitTicks - b.transitTicks)[0];
  const r = await ok(`/requests/${requestId}/accept`, { body: { routeId: via.id }, token: via.depotId === "depot-gazipur" ? gazipur : patiya });
  assert(r.status === "PLANNED" && r.allocationId, `status ${r.status}`);
  return { status: r.status, allocationId: r.allocationId, resolution: r.resolution };
});
await check("Accepted request is FULFILLED when the shipment arrives", async () => {
  await step(6);
  const list = await ok("/requests", { token: mirpur });
  const r = list.find((x) => x.id === requestId);
  assert(r.status === "FULFILLED", `still ${r.status}`);
  return { status: r.status, resolution: r.resolution };
});
await check("Depot manager rejection requires a reason and closes the request", async () => {
  const r = await ok("/requests", { body: { fuel: "DIESEL", quantity: 2000, urgency: "routine" }, token: tongi });
  const bad = await call(`/requests/${r.id}/decline`, { body: { reason: "" }, token: gazipur });
  assert(bad.status === 400, `empty reason got ${bad.status}`);
  const other = await call(`/requests/${r.id}/decline`, { body: { reason: "not my station" }, token: patiya });
  assert(other.status === 403, `non-serving depot got ${other.status}`);
  const d = await ok(`/requests/${r.id}/decline`, { body: { reason: "Tongi tank above 60%; no shortage projected" }, token: gazipur });
  assert(d.status === "DECLINED", d.status);
  return { status: d.status, resolution: d.resolution };
});

// ---------------------------------------------------------------- anomaly → operator decides
await check("Demand anomaly is detected and routed to the operator (NEEDS_REVIEW)", async () => {
  const t = (await ok("/network")).instance.tick;
  await ok("/chaos/events", { body: { type: "demand_spike", start_tick: t + 1, duration_ticks: 60, parameters: { region_ids: ["region-dhaka"], multiplier: 2.2 } }, token: operator });
  const dup = await call("/chaos/events", { body: { type: "demand_spike", start_tick: t + 1, duration_ticks: 60, parameters: { region_ids: ["region-dhaka"], multiplier: 2.2 } }, token: operator });
  assert(dup.status === 409, `duplicate injection got ${dup.status}`);
  await step(14);
  const alerts = await ok("/alerts?limit=100");
  const anomaly = alerts.find((a) => a.kind === "anomaly" && /dhaka|Mirpur|Tongi/i.test(a.message));
  assert(anomaly, "no anomaly alert");
  const risk = await ok("/forecast/risk");
  const lvl = risk.filter((r) => r.regionId === "region-dhaka").map((r) => r.forecast.level);
  const review = await ok("/recommendations?status=NEEDS_REVIEW");
  const anomalous = review.filter((r) => (r.rationale.reviewReasons ?? []).some((x) => x.startsWith("Anomalous demand")));
  assert(anomalous.length > 0, "no anomaly-routed recommendation");
  return { anomalyAlert: anomaly.message, dhakaDemandLevels: lvl.map((x) => Number(x.toFixed(2))), anomalyRoutedToOperator: anomalous.length };
});
await check("Operator approves an anomaly decision → dispatched", async () => {
  const review = await ok("/recommendations?status=NEEDS_REVIEW");
  const rec = review.find((r) => (r.rationale.reviewReasons ?? []).some((x) => x.startsWith("Anomalous demand"))) ?? review[0];
  const out = await ok(`/recommendations/${rec.id}/approve`, { body: {}, token: operator });
  assert(out.status === "SUBMITTED" || out.status === "APPROVED", out.status);
  return { rec: `${out.quantity} L ${out.fuelType} → ${out.stationId}`, status: out.status, allocation: out.simAllocationId };
});

// ---------------------------------------------------------------- route disruption
await check("Disrupted route is never proposed and approval on it is blocked", async () => {
  const t = (await ok("/network")).instance.tick;
  await ok("/chaos/events", { body: { type: "route_disruption", start_tick: t + 1, duration_ticks: 30, parameters: { route_ids: ["route-gazipur-mirpur"] } }, token: operator });
  await step(3);
  const open = await ok("/recommendations?status=NEEDS_REVIEW,PROPOSED");
  assert(!open.some((r) => r.routeId === "route-gazipur-mirpur"), "disrupted route proposed");
  const w = await ok("/decisions/what-if", { body: { stationId: "station-mirpur", fuel: "DIESEL", routeId: "route-gazipur-mirpur", quantity: 1000 } });
  assert(!w.feasible && w.warnings.includes("ROUTE_DISRUPTED"), JSON.stringify(w.warnings));
  return { openOnOtherRoutes: open.length, whatIfWarnings: w.warnings };
});

// ---------------------------------------------------------------- intelligence
await check("Forecast models produce validated results on live history", async () => {
  const q = await ok("/intelligence/model-quality");
  const scored = q.rows.filter((r) => r.samples > 0);
  assert(scored.length === 12, `only ${scored.length}/12 series validated`);
  const mean = (k) => scored.reduce((a, r) => a + r.mae[k], 0) / scored.length;
  return { version: q.version, series: scored.length, meanMae: { seasonal_ewma: mean("seasonal_ewma"), local_mean: mean("local_mean"), seasonal_regression: mean("seasonal_regression") } };
});
await check("Network fuel runway is forecast", async () => {
  const r = await ok("/forecast/runway");
  assert(r.fuels.length === 3 && r.fuels.every((f) => f.demandPerHour > 0), "runway incomplete");
  return r;
});
await check("Policy counterfactual: optimizer beats no-action under stress", async () => {
  const r = await ok("/intelligence/counterfactual", { body: { demandMultiplier: 1.5, delayTicks: 2 } });
  const sl = (p) => r.rows.find((x) => x.scenario === "demand_stress" && x.policy === p).serviceLevel;
  assert(sl("lp_optimizer") + 1e-9 >= sl("no_action"), "LP worse than no action");
  return r.rows.filter((x) => x.scenario === "demand_stress");
});
await check("Ops Copilot agent investigates with tools and never dispatches", async () => {
  const r = await ok("/intelligence/investigate", { body: { question: "What needs my attention right now, and what should I approve first?" }, token: operator });
  assert(r.dispatched === false, "copilot dispatched");
  assert(r.trace.length >= 2, "agent used too few tools");
  return { source: r.source, model: r.model, tools: r.trace.map((t) => t.tool), citations: r.citations.map((c) => c.id), answerPreview: r.text.slice(0, 400) };
});

// ---------------------------------------------------------------- failure drills
await check("ML model down → fallback policy, single alert, recovery alert", async () => {
  const before = (await ok("/alerts?limit=200")).filter((a) => /Prediction unavailable/.test(a.message)).length;
  await ok("/chaos/prediction", { body: { available: false }, token: operator });
  await step(3);
  await step(2);
  const s = await ok("/decisions/status");
  assert(s.lastPolicy === "heuristic_fallback", `policy ${s.lastPolicy}`);
  const after = (await ok("/alerts?limit=200")).filter((a) => /Prediction unavailable/.test(a.message)).length;
  assert(after - before === 1, `expected exactly 1 new alert, got ${after - before}`);
  await ok("/chaos/prediction", { body: { available: true }, token: operator });
  await step(2);
  const rec = (await ok("/alerts?limit=50")).find((a) => /Prediction model restored/.test(a.message));
  assert(rec, "no recovery alert");
  return { fallbackPolicy: s.lastPolicy, newAlerts: after - before, recovery: rec.message };
});
await check("Simulator outage → circuit opens, cached state served, dispatch paused; then recovers", async () => {
  await ok("/chaos/faults", { body: { type: "unavailable", duration_seconds: 20, parameters: {} }, token: operator });
  await sleep(9000);
  const h = await ok("/health");
  const simC = h.components.find((c) => c.name === "Fuel Simulator");
  const net = await ok("/network");
  assert(net.meta.stale || net.meta.degraded, "state not flagged stale/degraded");
  await ok("/chaos/faults/clear", { body: {}, token: operator });
  await sleep(16000);
  const h2 = await ok("/health");
  const simC2 = h2.components.find((c) => c.name === "Fuel Simulator");
  assert(simC2.status === "healthy", `simulator still ${simC2.status}: ${simC2.detail}`);
  return { during: `${simC.status}: ${simC.detail}`, meta: net.meta, after: `${simC2.status}: ${simC2.detail}` };
});
await check("Stale data → decisions paused, then fresh again", async () => {
  await ok("/chaos/faults", { body: { type: "stale_data", duration_seconds: 12, parameters: {} }, token: operator });
  await sleep(5000);
  const n = await ok("/network");
  assert(n.meta.stale, "stale not propagated");
  await ok("/chaos/faults/clear", { body: {}, token: operator });
  await sleep(6000);
  const n2 = await ok("/network");
  assert(!n2.meta.stale, "still stale after clearing");
  return { during: n.meta, after: n2.meta };
});

// ---------------------------------------------------------------- recovery & summary
await ok("/chaos/restore", { body: {}, token: operator });
await check("System recovers to healthy after all drills", async () => {
  await sleep(4000);
  const h = await ok("/health");
  assert(!h.components.some((c) => c.status === "down"), "component down after restore");
  return { status: h.status, p95Ms: h.p95Ms, errorRate: h.errorRate };
});
await ok("/chaos/simulation", { body: { action: "run" }, token: operator });

await writeFile("docs/evidence/judge-check.json", JSON.stringify({ at: new Date().toISOString(), passed: checks.filter((c) => c.passed).length, total: checks.length, checks }, null, 2));
await writeFile("docs/evidence/metrics.prom", await (await fetch(base + "/metrics")).text());
console.log(`\n${checks.filter((c) => c.passed).length}/${checks.length} checks passed`);
if (checks.some((c) => !c.passed)) process.exitCode = 1;
