"use client";
import { Pause, Play, RotateCcw, SkipForward } from "lucide-react";
import { useState } from "react";
import { useAuth, useToast } from "@/components/providers";
import { SignInPanel } from "@/components/shell";
import { Badge, Card } from "@/components/ui";
import { api } from "@/lib/api";
import { useAction, useDecisionStatus, useDrillStatus, useNetwork } from "@/lib/hooks";
import { useQueryClient } from "@tanstack/react-query";

type EventBody = { type: string; duration_ticks: number; parameters: Record<string, unknown> };
const EVENT_PRESETS: { label: string; hint: string; body: EventBody }[] = [
  { label: "Demand spike: Dhaka ×1.8", hint: "Mirpur & Tongi demand rises for 6 h", body: { type: "demand_spike", duration_ticks: 24, parameters: { region_ids: ["region-dhaka"], multiplier: 1.8 } } },
  { label: "Route disruption: Gazipur→Mirpur", hint: "Mirpur must be served cross-region (4 ticks)", body: { type: "route_disruption", duration_ticks: 16, parameters: { route_ids: ["route-gazipur-mirpur"] } } },
  { label: "Station outage: Karnaphuli", hint: "Station closed for 2 h; no deliveries", body: { type: "station_outage", duration_ticks: 8, parameters: { station_ids: ["station-karnaphuli"] } } },
  { label: "Depot constraint: Patiya", hint: "Dispatch budget halved for 4 h", body: { type: "depot_constraint", duration_ticks: 16, parameters: { depot_ids: ["depot-patiya"] } } },
  { label: "Shipment delay: all supply +6 ticks", hint: "One-shot: scheduled depot supply arrives later", body: { type: "shipment_delay", duration_ticks: 1, parameters: { delay_ticks: 6 } } },
  { label: "Supply shortfall: Diesel ×0.5", hint: "One-shot: upcoming diesel supply halved", body: { type: "supply_shortfall", duration_ticks: 1, parameters: { factor: 0.5, fuel_types: ["DIESEL"] } } },
];
const FAULTS = [
  { label: "Latency 800 ms", hint: "retries & timeouts absorb it", body: { type: "latency", duration_seconds: 60, parameters: { delay_ms: 800 } } },
  { label: "Unavailable (503) 45 s", hint: "circuit opens → cached state → recovery", body: { type: "unavailable", duration_seconds: 45, parameters: {} } },
  { label: "Error rate 30%", hint: "retries with backoff", body: { type: "error_rate", duration_seconds: 60, parameters: { rate: 0.3 } } },
  { label: "Stale data 60 s", hint: "dispatching pauses until fresh", body: { type: "stale_data", duration_seconds: 60, parameters: {} } },
  { label: "Stream disconnect 60 s", hint: "SSE reconnect + polling backstop", body: { type: "stream_disconnect", duration_seconds: 60, parameters: {} } },
];

function Btn({ onClick, children, hint, disabled }: { onClick: () => void; children: React.ReactNode; hint?: string; disabled?: boolean }) {
  return (
    <button onClick={onClick} disabled={disabled} className="rounded border border-border px-3 py-1.5 text-left text-sm hover:bg-surface-2 disabled:opacity-40">
      <span className="flex items-center gap-1.5">{children}</span>
      {hint && <span className="block text-xs text-muted">{hint}</span>}
    </button>
  );
}

export default function ControlPage() {
  const { session } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const operator = session?.role === "operator";
  const { data: net } = useNetwork();
  const { data: status } = useDecisionStatus();
  const { data: drill } = useDrillStatus(operator);
  const sim = useAction<{ action: string }>("/chaos/simulation", "Simulation command sent");
  const event = useAction<EventBody & { start_tick: number }>("/chaos/events", "Crisis scheduled: watch Alerts and the Decision Queue");
  const fault = useAction<Record<string, unknown>>("/chaos/faults", "Fault injected: watch System Health");
  const restore = useAction<void>("/chaos/restore", "Normal operations restored");
  const prediction = useAction<{ available: boolean }, { available: boolean; unchanged?: boolean }>("/chaos/prediction", (r) => (r.unchanged ? "No change" : r.available ? "Prediction model restored" : "Prediction model taken down: fallback policy active"));
  const policy = useAction<{ policy: string | null }>("/decisions/policy", "Policy updated");
  const autopilot = useAction<{ enabled: boolean }>("/decisions/autopilot", "Autopilot updated");
  const [lead, setLead] = useState(2);
  const [combo, setCombo] = useState(false);
  const busy = [sim, event, fault, restore, prediction, policy, autopilot].some((m) => m.isPending) || combo;
  const tick = net?.instance.tick ?? 0;

  if (!operator)
    return (
      <Card title="Scenario Control">
        <p className="mb-3 text-sm">Scenario control (running the simulation, injecting crises and faults) is restricted to operators.</p>
        <SignInPanel compact />
      </Card>
    );

  const combined = async () => {
    setCombo(true);
    try {
      for (const p of [EVENT_PRESETS[0], EVENT_PRESETS[1], EVENT_PRESETS[4]]) await api("/chaos/events", { method: "POST", json: { ...p.body, start_tick: tick + lead } });
      toast("ok", "Combined crisis scheduled: demand spike + route disruption + shipment delay");
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setCombo(false);
      void qc.invalidateQueries();
    }
  };

  return (
    <div className="space-y-4">
      <Card title="Current posture">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Badge tone={net?.instance.status === "RUNNING" ? "ok" : "warn"}>simulation {net?.instance.status?.toLowerCase()}</Badge>
          <Badge tone={status?.autopilot ? "ok" : "warn"}>autopilot {status?.autopilot ? "on" : "off"}</Badge>
          <Badge tone={drill?.predictionAvailable === false ? "crit" : "ok"}>prediction {drill?.predictionAvailable === false ? "offline" : "online"}</Badge>
          <Badge tone={drill?.forcedPolicy ? "warn" : "ok"}>policy {drill?.forcedPolicy ?? "LP optimizer"}</Badge>
          {(drill?.activeFaults ?? []).map((f) => (
            <Badge key={f.type} tone="crit">
              fault {f.type}
            </Badge>
          ))}
          <span className="flex-1" />
          <button disabled={busy} onClick={() => restore.mutate()} className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">
            Restore normal operations
          </button>
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Simulation">
          <div className="flex flex-wrap gap-2">
            <Btn disabled={busy} onClick={() => sim.mutate({ action: "run" })}>
              <Play size={14} /> Run
            </Btn>
            <Btn disabled={busy} onClick={() => sim.mutate({ action: "pause" })}>
              <Pause size={14} /> Pause
            </Btn>
            <Btn disabled={busy} onClick={() => sim.mutate({ action: "step" })}>
              <SkipForward size={14} /> Step 1 tick
            </Btn>
            <Btn
              disabled={busy}
              onClick={() => {
                if (window.confirm("Reset the simulated world to tick 0? History and open recommendations are cleared.")) sim.mutate({ action: "reset" });
              }}
            >
              <RotateCcw size={14} /> Reset world
            </Btn>
          </div>
          <p className="mt-2 text-xs text-muted">One tick = 15 simulated minutes. Speed is set by SIMULATION_SPEED (ticks per second) in .env.</p>
        </Card>
        <Card title="Decision engine & intelligence drills">
          <div className="grid gap-2 sm:grid-cols-2">
            <Btn disabled={busy} onClick={() => autopilot.mutate({ enabled: !status?.autopilot })} hint="routine plans dispatch automatically">
              Turn autopilot {status?.autopilot ? "OFF" : "ON"}
            </Btn>
            <Btn disabled={busy} onClick={() => prediction.mutate({ available: !(drill?.predictionAvailable ?? true) })} hint="ML model unavailable → fallback policy">
              {drill?.predictionAvailable === false ? "Restore prediction model" : "Take prediction model down"}
            </Btn>
            <Btn disabled={busy} onClick={() => policy.mutate({ policy: drill?.forcedPolicy ? null : "heuristic" })} hint="policy rollback">
              {drill?.forcedPolicy ? "Restore LP optimizer" : "Roll back policy → heuristic"}
            </Btn>
          </div>
        </Card>
        <Card
          title="Inject crisis event"
          action={
            <label className="flex items-center gap-1 text-xs text-muted">
              starts in
              <input aria-label="Lead ticks" type="number" min={0} max={96} value={lead} onChange={(e) => setLead(Math.max(0, Number(e.target.value)))} className="w-12 rounded border border-border bg-surface-2 px-1" />
              ticks
            </label>
          }
        >
          <div className="grid gap-2 sm:grid-cols-2">
            {EVENT_PRESETS.map((p) => (
              <Btn key={p.label} disabled={busy} hint={p.hint} onClick={() => event.mutate({ ...p.body, start_tick: tick + lead })}>
                {p.label}
              </Btn>
            ))}
            <Btn disabled={busy} hint="spike + route disruption + supply delay together" onClick={() => void combined()}>
              <strong>Combined crisis</strong>
            </Btn>
          </div>
        </Card>
        <Card title="Inject simulator API fault (affects /v1/* only)">
          <div className="grid gap-2 sm:grid-cols-2">
            {FAULTS.map((f) => (
              <Btn key={f.label} disabled={busy} hint={f.hint} onClick={() => fault.mutate(f.body)}>
                {f.label}
              </Btn>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
