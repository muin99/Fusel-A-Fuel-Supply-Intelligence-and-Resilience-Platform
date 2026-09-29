"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Circle, Loader2, PlayCircle } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { useToast } from "@/components/providers";
import { useBecome, useDemoRoles } from "@/components/shell";
import { Badge, Card, Stat } from "@/components/ui";
import { api } from "@/lib/api";
import { liters, pct } from "@/lib/format";
import { useAuthConfig, useDecisionStatus, useNetwork } from "@/lib/hooks";
import type { AuditEntry } from "@/lib/types";

type Step = {
  title: string;
  story: string;
  role: string; // demo role key used to perform the step
  look: { href: string; label: string }[];
  expect: string;
  run: (ctx: { tick: number }) => Promise<string>;
};

const post = (path: string, json: unknown = {}) => api(path, { method: "POST", json });

const STEPS: Step[] = [
  {
    title: "Start a fresh simulated world",
    story: "Reset the simulator to tick 0 and run it. The platform observes every tick, forecasts demand per station and fuel, and autopilot dispatches routine resupply.",
    role: "operator",
    look: [{ href: "/", label: "Operations" }],
    expect: "Service level stays ~100%; 'What the system did' fills with autopilot dispatches; Decisions that need you stays small.",
    run: async () => {
      await post("/chaos/restore");
      await post("/decisions/autopilot", { enabled: true });
      await post("/chaos/simulation", { action: "reset" });
      await post("/chaos/simulation", { action: "run" });
      return "World reset and running";
    },
  },
  {
    title: "Crisis: Dhaka demand doubles",
    story: "Inject a ×2 demand spike for Dhaka (Mirpur & Tongi). The forecast learns the new level, detection flags an anomaly, and because the model is now extrapolating, those decisions go to the operator instead of autopilot.",
    role: "operator",
    look: [
      { href: "/disruptions", label: "Alerts (anomaly + surge)" },
      { href: "/recommendations", label: "Decision Queue (NEEDS YOU)" },
      { href: "/forecast", label: "Risk & Forecast (demand ×2)" },
    ],
    expect: "Within ~10 s: 'Anomalous demand' and 'regional demand surge' alerts; recommendations marked NEEDS YOU with the reason 'Anomalous demand: 2.0× normal'. Approve one; it is dispatched to the simulator.",
    run: async ({ tick }) => {
      await post("/chaos/events", { type: "demand_spike", start_tick: tick + 1, duration_ticks: 48, parameters: { region_ids: ["region-dhaka"], multiplier: 2.0 } });
      return "Demand spike scheduled for next tick";
    },
  },
  {
    title: "Crisis: the Gazipur → Mirpur road is blocked",
    story: "Disrupt Mirpur's main route. The optimizer re-plans through Patiya (cross-region, 4 ticks). Cross-region transfers are exceptions, so the operator decides.",
    role: "operator",
    look: [
      { href: "/recommendations", label: "Decision Queue" },
      { href: "/disruptions", label: "Routes" },
    ],
    expect: "No recommendation uses route-gazipur-mirpur; Mirpur is served via route-patiya-mirpur with the reason 'Cross-region transfer'. What-if on the blocked route reports ROUTE_DISRUPTED.",
    run: async ({ tick }) => {
      await post("/chaos/events", { type: "route_disruption", start_tick: tick + 1, duration_ticks: 24, parameters: { route_ids: ["route-gazipur-mirpur"] } });
      return "Route disruption scheduled";
    },
  },
  {
    title: "Station manager raises an emergency request",
    story: "Cox's Bazar's manager asks for diesel. The request raises Cox's Bazar's priority in the planner and lands in the Patiya depot manager's inbox with the model's view of whether it is justified.",
    role: "station-coxsbazar",
    look: [{ href: "/station", label: "Station Portal (request status)" }],
    expect: "Request appears as OPEN, then PLANNED after the depot accepts, then FULFILLED when the truck arrives.",
    run: async () => {
      const r = await post("/requests", { fuel: "DIESEL", quantity: 3000, urgency: "emergency", note: "Bus depot contract starts tonight" }).catch((e: Error) => {
        if (/already/.test(e.message)) return { id: "existing" };
        throw e;
      });
      return `Request #${(r as { id: number | string }).id} raised`;
    },
  },
  {
    title: "Depot manager accepts the request",
    story: "Switch to the Patiya depot manager. The inbox shows the request with tank level, shipments already on the way and the model's stockout risk. Accept dispatches from Patiya after the same feasibility checks the simulator applies.",
    role: "depot-patiya",
    look: [{ href: "/depot", label: "Depot Console (inbox)" }],
    expect: "Press 'Accept & dispatch' in the Depot Console (or let this step do it): the request becomes PLANNED with a simulator allocation id.",
    run: async () => {
      const list = await api<{ id: number; stationId: string; status: string }[]>("/requests");
      const open = list.find((r) => r.stationId === "station-coxsbazar" && r.status === "OPEN");
      if (!open) return "No open Cox's Bazar request: raise one in the previous step";
      await post(`/requests/${open.id}/accept`, {});
      return `Request #${open.id} accepted and dispatched`;
    },
  },
  {
    title: "Failure: the ML model goes down",
    story: "Take the prediction model offline. The decision engine falls back to a reorder-point rule, raises one system alert, and every fallback plan needs operator review.",
    role: "operator",
    look: [
      { href: "/health", label: "System Health" },
      { href: "/recommendations", label: "Decision Queue (heuristic_fallback)" },
    ],
    expect: "Prediction Service DOWN, policy heuristic_fallback, red 'Drill active' banner with a one-click restore. Restore → 'Prediction model restored' recovery alert.",
    run: async () => {
      await post("/chaos/prediction", { available: false });
      return "Prediction model offline: fallback active (use the red banner to restore)";
    },
  },
  {
    title: "Failure: the simulator API goes down for 30 s",
    story: "Inject an outage on the simulator API. The resilient client retries, then the circuit breaker opens; the platform serves the last known state, pauses dispatching, and recovers by itself when the fault ends.",
    role: "operator",
    look: [
      { href: "/health", label: "System Health (circuit open → closed)" },
      { href: "/", label: "Operations (degraded banner)" },
    ],
    expect: "Fuel Simulator DOWN / circuit open and a yellow 'Degraded mode' banner; after ~30 s everything returns to healthy with no operator action.",
    run: async () => {
      await post("/chaos/prediction", { available: true });
      await post("/chaos/faults", { type: "unavailable", duration_seconds: 30, parameters: {} });
      return "Outage injected for 30 s";
    },
  },
  {
    title: "Ask the AI copilot what to do",
    story: "The Ops Copilot is a GPT agent that calls read-only tools (live state, stockout risk, decision queue, what-if, network runway, rulebook and incident-memory retrieval) and recommends; approvals stay with you.",
    role: "operator",
    look: [{ href: "/assistant", label: "Ops Copilot" }],
    expect: "An answer citing recommendation ids with Approve buttons, and a trace of the tools the agent chose.",
    run: async () => "Open the Ops Copilot and click a suggested question",
  },
];

function Impact() {
  const { data: net } = useNetwork();
  const { data: status } = useDecisionStatus();
  const { data: audit } = useQuery({ queryKey: ["audit-feed", "impact"], queryFn: () => api<AuditEntry[]>("/audit?limit=500"), refetchInterval: 8000 });
  const cf = useQuery({
    queryKey: ["network", "cf-impact"],
    queryFn: () => api<{ rows: { scenario: string; policy: string; expectedUnmetLiters: number; serviceLevel: number }[] }>("/intelligence/counterfactual", { method: "POST", json: { demandMultiplier: 1.5, delayTicks: 2 } }),
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    staleTime: 30_000,
    retry: false,
  });
  if (!net) return null;
  const delivered = net.allocations.filter((a) => a.status === "ARRIVED").reduce((x, a) => x + a.quantity, 0);
  const served = net.metrics.served_demand_liters;
  const submitted = (audit ?? []).filter((e) => e.action === "allocation.submitted");
  const auto = submitted.filter((e) => e.actor === "autopilot").length;
  const human = submitted.length - auto;
  const accepted = (audit ?? []).filter((e) => e.action === "request.accepted").length;
  const row = (scenario: string, policy: string) => cf.data?.rows.find((r) => r.scenario === scenario && r.policy === policy);
  const none = row("forecast_mean", "no_action");
  const lp = row("forecast_mean", "lp_optimizer");
  return (
    <Card title="Impact (live)">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Service level" value={pct(net.metrics.service_level, 1)} tone={net.metrics.service_level > 0.98 ? "ok" : net.metrics.service_level > 0.9 ? "warn" : "crit"} hint={`tick ${net.instance.tick}`} />
        <Stat label="Fuel delivered by the platform" value={liters(delivered)} hint={served > 0 ? `${pct(Math.min(1, delivered / served))} of all fuel sold` : "since start"} />
        <Stat label="Decisions executed" value={submitted.length + accepted} hint={`${auto} autopilot · ${human} operator · ${accepted} depot`} />
        <Stat label="Waiting for the operator" value={status?.needsReview ?? 0} tone={status?.needsReview ? "warn" : "ok"} hint="exceptions only" />
        <Stat
          label="Next 6 h if we stopped acting"
          value={none ? liters(none.expectedUnmetLiters) : "—"}
          tone={none && lp && none.expectedUnmetLiters > lp.expectedUnmetLiters ? "crit" : undefined}
          hint={lp ? `vs ${liters(lp.expectedUnmetLiters)} short with the optimizer (projection)` : "projection"}
        />
      </div>
    </Card>
  );
}

export default function DemoGuide() {
  const { data: cfg } = useAuthConfig();
  const { data: net } = useNetwork();
  const roles = useDemoRoles();
  const become = useBecome();
  const toast = useToast();
  const qc = useQueryClient();
  const [done, setDone] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState<number | null>(null);

  const run = async (i: number) => {
    const step = STEPS[i];
    setBusy(i);
    try {
      const role = roles.find((r) => r.key === step.role);
      if (cfg?.demoMode && role) await become(role);
      const msg = await step.run({ tick: net?.instance.tick ?? 0 });
      setDone((d) => ({ ...d, [i]: msg }));
      toast("ok", msg);
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy(null);
      void qc.invalidateQueries();
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <PlayCircle size={22} /> Demo Guide
        </h1>
        <p className="max-w-3xl text-sm text-muted">
          The whole story in eight steps: observe → detect → predict → decide → act → monitor → recover. Each step switches to the right role, performs the action on the live simulator, and tells you where
          to look. Roles: the <strong>operator</strong> owns the system and decides exceptions and anomalies; <strong>depot managers</strong> accept or reject station requests; <strong>station
          managers</strong> raise requests; <strong>autopilot</strong> handles routine resupply.
        </p>
        {!cfg?.demoMode && <p className="mt-2 text-xs text-warn">Demo mode is off: sign in with passwords to perform steps.</p>}
      </div>

      <Impact />

      <ol className="space-y-3">
        {STEPS.map((s, i) => {
          const role = roles.find((r) => r.key === s.role);
          return (
            <li key={s.title}>
              <Card>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex min-w-0 flex-1 gap-3">
                    <span className="mt-0.5">{done[i] ? <CheckCircle2 size={20} className="text-ok" /> : <Circle size={20} className="text-muted" />}</span>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold">
                          {i + 1}. {s.title}
                        </span>
                        <Badge tone="info">as {role?.label ?? s.role}</Badge>
                      </div>
                      <p className="mt-1 text-sm">{s.story}</p>
                      <p className="mt-1 text-xs text-muted">
                        <strong>Expect:</strong> {s.expect}
                      </p>
                      <div className="mt-1.5 flex flex-wrap gap-2 text-xs">
                        {s.look.map((l) => (
                          <Link key={l.href + l.label} href={l.href} className="text-accent hover:underline">
                            → {l.label}
                          </Link>
                        ))}
                      </div>
                      {done[i] && <p className="mt-1 text-xs text-ok">{done[i]}</p>}
                    </div>
                  </div>
                  <button disabled={busy !== null} onClick={() => void run(i)} className="flex items-center gap-1.5 rounded bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">
                    {busy === i ? <Loader2 size={14} className="animate-spin" /> : <PlayCircle size={14} />} {busy === i ? "Running…" : done[i] ? "Run again" : "Do it"}
                  </button>
                </div>
              </Card>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
