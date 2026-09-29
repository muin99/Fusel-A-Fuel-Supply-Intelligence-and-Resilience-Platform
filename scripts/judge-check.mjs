import { readFile, writeFile, mkdir } from "node:fs/promises";
const env = Object.fromEntries(
  (await readFile(".env", "utf8"))
    .split("\n")
    .filter((x) => x.includes("=") && !x.startsWith("#"))
    .map((x) => {
      const i = x.indexOf("=");
      return [x.slice(0, i), x.slice(i + 1).replace(/^['"]|['"]$/g, "")];
    }),
);
const base = process.env.API_URL ?? "http://localhost:4000/api";
let token;
async function req(path, body, authorized = true) {
  const r = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "content-type": "application/json",
      ...(token && authorized ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
async function check(name, fn) {
  try {
    const result = await fn();
    checks.push({ name, passed: true, result });
    console.log("PASS", name);
  } catch (e) {
    checks.push({ name, passed: false, error: e.message });
    console.log("FAIL", name, e.message);
  }
}
function assert(v, m) {
  if (!v) throw new Error(m);
}
token = (
  await req(
    "/auth/login",
    {
      username: "judge-check",
      role: "operator",
      password: env.OPERATOR_PASSWORD,
    },
    false,
  )
).token;
await check("Live health", () => req("/health"));
await check("Knowledge retrieval", async () => {
  const r = await req("/intelligence/knowledge?q=idempotency_key");
  assert(r.length > 0, "No source evidence");
  return r.map((x) => x.id);
});
await check("Model registry", () => req("/intelligence/models"));
await check("Viewer cannot mutate", async () => {
  const r = await fetch(base + "/chaos/prediction", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: '{"available":false}',
  });
  assert(
    r.status === 401 || r.status === 403,
    "Unauthenticated mutation allowed",
  );
  return r.status;
});
await req("/chaos/simulation", { action: "pause" });
const initial = await req("/network");
await writeFile(
  "docs/evidence/pre-review-state.json",
  JSON.stringify(initial, null, 2),
);
await check("Combined demand / route / supply crisis", async () => {
  const start = initial.instance.tick + 1;
  for (const event of [
    {
      type: "demand_spike",
      parameters: { region_ids: ["region-dhaka"], multiplier: 2.5 },
    },
    {
      type: "route_disruption",
      parameters: { route_ids: ["route-gazipur-mirpur"] },
    },
    {
      type: "shipment_delay",
      parameters: { depot_ids: ["depot-gazipur"], delay_ticks: 8 },
    },
  ])
    await req("/chaos/events", {
      ...event,
      start_tick: start,
      duration_ticks: 20,
    });
  for (let i = 0; i < 12; i++)
    await req("/chaos/simulation", { action: "step" });
  await sleep(6000);
  const [network, risk, rec] = await Promise.all([
    req("/network"),
    req("/forecast/risk"),
    req("/recommendations"),
  ]);
  assert(
    network.events.some((e) => e.status === "ACTIVE"),
    "No active events",
  );
  assert(risk.length === 12, "Risk table incomplete");
  assert(
    rec
      .filter((r) => ["PROPOSED", "NEEDS_REVIEW"].includes(r.status))
      .every((r) => r.routeId !== "route-gazipur-mirpur"),
    "Disrupted route proposed",
  );
  return {
    tick: network.instance.tick,
    activeEvents: network.events.filter((e) => e.status === "ACTIVE"),
    risk,
    openRecommendations: rec.filter((r) =>
      ["PROPOSED", "NEEDS_REVIEW"].includes(r.status),
    ),
  };
});
await check("Model evaluation persisted", () =>
  req("/intelligence/evaluate", {}),
);
await check("Recorded replay", async () => {
  const s = await req("/network");
  const r = await req("/intelligence/replay?tick=" + s.instance.tick);
  assert(r.inventory.length > 0, "No recorded inventory");
  return {
    tick: r.tick,
    inventoryRows: r.inventory.length,
    demandRows: r.demand.length,
  };
});
await check("GPT grounded answer", async () => {
  const r = await req("/assistant/ask", {
    question:
      "Explain the active disruptions and current service level. Cite the relevant simulator rules.",
  });
  assert(r.source === "llm", "GPT returned fallback");
  return r;
});
await check("Specialist investigation with review trace", async () => {
  const r = await req("/intelligence/investigate", {
    question:
      "How should we respond to the combined demand spike, route disruption and delayed depot supply?",
  });
  assert(r.trace.length >= 5, "Missing specialist stages");
  assert(r.dispatched === false, "Investigation dispatched");
  return r;
});
await check("Prediction failure activates fallback", async () => {
  await req("/chaos/prediction", { available: false });
  await sleep(5000);
  const h = await req("/health");
  assert(
    h.components.find((c) => c.name === "Prediction Service")?.status ===
      "down",
    "Prediction not degraded",
  );
  assert(
    h.components
      .find((c) => c.name === "Decision Engine")
      ?.detail?.includes("fallback"),
    "Fallback not active",
  );
  return h;
});
await req("/chaos/prediction", { available: true });
await check("Stale simulator state blocks decisions", async () => {
  await req("/chaos/faults", {
    type: "stale_data",
    duration_seconds: 15,
    parameters: {},
  });
  await sleep(5000);
  const n = await req("/network");
  assert(n.meta.stale, "Stale signal not propagated");
  return { meta: n.meta, health: await req("/health") };
});
await req("/chaos/faults/clear", {});
await sleep(5000);
await check("Recovery after fault cleared", async () => {
  const n = await req("/network");
  assert(!n.meta.stale, "Still stale after recovery");
  return await req("/health");
});
await mkdir("docs/evidence", { recursive: true });
await writeFile(
  "docs/evidence/judge-check.json",
  JSON.stringify({ at: new Date().toISOString(), checks }, null, 2),
);
await writeFile(
  "docs/evidence/metrics.prom",
  await (await fetch(base + "/metrics")).text(),
);
console.log(`${checks.filter((x) => x.passed).length}/${checks.length} passed`);
if (checks.some((x) => !x.passed)) process.exitCode = 1;
