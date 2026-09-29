"use client";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { DecisionCard } from "@/components/decision";
import { useAuth } from "@/components/providers";
import { SignInPanel } from "@/components/shell";
import { Badge, Card, Empty, ErrorBox, FuelBar, Loading, Stat, statusTone } from "@/components/ui";
import { api } from "@/lib/api";
import { liters, pct } from "@/lib/format";
import { useAlerts, useDecisionStatus, useNetwork, useRecommendations, useRequests, useRisk } from "@/lib/hooks";
import { FUELS, type AuditEntry } from "@/lib/types";

const ACTIVITY = new Set(["allocation.submitted", "recommendation.rejected", "allocation.failed", "allocation.abandoned", "request.created", "autopilot.enabled", "autopilot.disabled", "operations.restored", "event.injected", "fault.injected"]);

function describe(e: AuditEntry): string {
  const d = e.details as Record<string, string | number>;
  switch (e.action) {
    case "allocation.submitted":
      return `${e.actor === "autopilot" ? "Autopilot" : e.actor} dispatched ${Number(d.quantity).toLocaleString()} L ${d.fuel} → ${String(d.stationId).replace("station-", "")} (alloc #${d.allocationId})`;
    case "request.created":
      return `${String(d.stationId).replace("station-", "")} requested ${Number(d.quantity).toLocaleString()} L ${d.fuel} (${d.urgency})`;
    case "recommendation.rejected":
      return `${e.actor} rejected a recommendation`;
    case "allocation.failed":
    case "allocation.abandoned":
      return `Dispatch failed: ${d.error ?? (d.reasons as unknown as string[])?.[0] ?? "see audit"}`;
    case "event.injected":
      return `Crisis injected: ${e.entityId}`;
    case "fault.injected":
      return `Fault injected: ${e.entityId}`;
    default:
      return `${e.actor}: ${e.action.replace(".", " ")}`;
  }
}

export default function Operations() {
  const { session } = useAuth();
  const router = useRouter();
  useEffect(() => {
    if (session?.role === "station") router.replace("/station");
  }, [session, router]);
  const { data: net, error, isLoading } = useNetwork();
  const { data: risk } = useRisk();
  const { data: alerts } = useAlerts(12);
  const { data: status } = useDecisionStatus();
  const { data: open } = useRecommendations("NEEDS_REVIEW,PROPOSED");
  const { data: requests } = useRequests(!!session);
  const { data: feed } = useQuery({ queryKey: ["audit-feed"], queryFn: () => api<AuditEntry[]>("/audit?limit=120") });
  const { data: runway } = useQuery({
    queryKey: ["network", "runway"],
    queryFn: () => api<{ hoursOfCover: number | null; lastSupplyTick: number | null; fuels: { fuel: string; hoursOfCover: number | null; onHandLiters: number; scheduledSupplyLiters: number; exhaustionTick: number | null }[] }>("/forecast/runway"),
  });

  if (isLoading) return <Loading />;
  if (error || !net) return <ErrorBox error={error} />;

  const sl = net.metrics.service_level;
  const atRisk = (risk ?? []).filter((r) => r.assessment.probability >= 0.5);
  const inFlight = net.allocations.filter((a) => a.status === "PENDING" || a.status === "IN_TRANSIT");
  const queue = (open ?? []).filter((r) => r.status === "NEEDS_REVIEW" || !status?.autopilot);
  const routine = (open ?? []).filter((r) => r.status === "PROPOSED" && status?.autopilot);
  const activeRequests = (requests ?? []).filter((r) => r.status === "OPEN" || r.status === "PLANNED");
  const activity = (feed ?? []).filter((e) => ACTIVITY.has(e.action)).slice(0, 12);
  const riskMode = risk?.[0]?.mode;

  return (
    <div className="space-y-5">
      {runway?.hoursOfCover !== null && runway?.hoursOfCover !== undefined && runway.hoursOfCover <= 48 && (
        <div className={`rounded-lg border p-3 text-sm ${runway.hoursOfCover <= 12 ? "border-crit/40 bg-crit/10 text-crit" : "border-warn/40 bg-warn/10 text-warn"}`}>
          <strong>Network-wide supply is running out.</strong>{" "}
          {runway.fuels
            .filter((f) => f.hoursOfCover !== null && f.hoursOfCover <= 48)
            .map((f) => `${f.fuel}: ~${Math.round(f.hoursOfCover!)} h left (${liters(f.onHandLiters)} in the system${f.scheduledSupplyLiters ? ` + ${liters(f.scheduledSupplyLiters)} scheduled` : ""})`)
            .join(" · ")}
          . {runway.lastSupplyTick === null ? "No further supply is scheduled in this scenario: " : ""}allocation can only ration fuel fairly, not prevent the shortfall. Station stockouts after this point reflect total supply, not dispatch decisions.
        </div>
      )}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Service level" value={pct(sl, 1)} tone={sl > 0.98 ? "ok" : sl > 0.9 ? "warn" : "crit"} hint="served ÷ demand, since start" />
        <Stat label="Unmet demand" value={liters(net.metrics.unmet_demand_liters)} tone={net.metrics.unmet_demand_liters > 0 ? "warn" : "ok"} hint="since simulation start" />
        <Stat label="At-risk station·fuels" value={atRisk.length} tone={atRisk.length ? "crit" : "ok"} hint={riskMode === "fallback" ? "model offline: inventory-based" : "stockout probability ≥ 50% in 6 h"} />
        <Stat label="Shipments in flight" value={inFlight.length} hint={`${liters(inFlight.reduce((a, x) => a + x.quantity, 0))} on the road`} />
        <Stat
          label="Network fuel runway"
          value={runway?.hoursOfCover === null || runway?.hoursOfCover === undefined ? "—" : `${Math.round(runway.hoursOfCover)} h`}
          tone={runway?.hoursOfCover == null ? undefined : runway.hoursOfCover <= 12 ? "crit" : runway.hoursOfCover <= 48 ? "warn" : "ok"}
          hint={runway?.lastSupplyTick ? `last scheduled supply t${runway.lastSupplyTick}` : "no further supply scheduled"}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-5">
        <Card
          className="lg:col-span-3"
          title={
            <span className="flex items-center gap-2">
              Decisions that need you <Badge tone={queue.length ? "warn" : "ok"}>{queue.length}</Badge>
            </span>
          }
          action={
            <Link href="/recommendations" className="text-xs text-accent">
              full queue →
            </Link>
          }
        >
          {!session && (
            <div className="mb-3 rounded border border-accent/40 bg-accent/5 p-3">
              <p className="mb-2 text-sm">
                <strong>You are viewing as a guest.</strong> Sign in as an <em>operator</em> to approve or reject dispatches, or as a <em>station manager</em> to request fuel.
              </p>
              <SignInPanel compact />
            </div>
          )}
          <p className="mb-3 text-xs text-muted">
            {status?.autopilot
              ? `Autopilot is ON: routine, high-confidence resupply is dispatched automatically (${routine.length} in progress). Only exceptions (low forecast confidence, fallback model, cross-region transfers, station requests the model does not support) are listed here.`
              : "Autopilot is OFF: every recommendation waits for an operator decision."}
          </p>
          {queue.length === 0 ? (
            <Empty>{status?.autopilot ? "Nothing needs you right now: the network is being resupplied automatically." : "No open recommendations."}</Empty>
          ) : (
            <div className="space-y-2">
              {queue.slice(0, 6).map((r) => (
                <DecisionCard key={r.id} rec={r} />
              ))}
              {queue.length > 6 && (
                <Link href="/recommendations" className="block text-center text-xs text-accent">
                  + {queue.length - 6} more in the queue
                </Link>
              )}
            </div>
          )}
        </Card>

        <div className="space-y-4 lg:col-span-2">
          <Card title="What the system did" action={<Link href="/audit" className="text-xs text-accent">history →</Link>}>
            {activity.length === 0 ? (
              <Empty>No actions yet: start the simulation from Scenario Control.</Empty>
            ) : (
              <ul className="space-y-1.5 text-sm">
                {activity.map((e) => (
                  <li key={e.id} className="flex gap-2">
                    <span className="w-12 shrink-0 text-xs text-muted tabular-nums">t{e.tick ?? "?"}</span>
                    <span className="min-w-0">{describe(e)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="Station requests" action={<Link href="/station" className="text-xs text-accent">portal →</Link>}>
            {!session ? (
              <Empty>Sign in to see station requests.</Empty>
            ) : activeRequests.length === 0 ? (
              <Empty>No open requests from stations.</Empty>
            ) : (
              <ul className="space-y-1.5 text-sm">
                {activeRequests.map((r) => (
                  <li key={r.id} className="flex items-center justify-between gap-2">
                    <span>
                      #{r.id} {r.stationId.replace("station-", "")} · {liters(r.quantity)} {r.fuelType}
                    </span>
                    <span className="flex gap-1">
                      <Badge tone={r.urgency === "emergency" ? "crit" : r.urgency === "urgent" ? "warn" : "muted"}>{r.urgency}</Badge>
                      <Badge tone={r.status === "PLANNED" ? "info" : "warn"}>{r.status}</Badge>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Stations" className="lg:col-span-2">
          <div className="grid gap-4 sm:grid-cols-2">
            {net.stations.map((s) => {
              const worst = (risk ?? []).filter((r) => r.stationId === s.id).sort((a, b) => b.assessment.probability - a.assessment.probability)[0];
              return (
                <div key={s.id} className="space-y-1.5 rounded border border-border p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <div className="text-sm font-medium">{s.name}</div>
                      <div className="text-xs text-muted">
                        {s.region_id.replace("region-", "")} · {s.demand_profile} · demand ×{s.demand_multiplier.toFixed(2)}
                      </div>
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      <Badge tone={statusTone(s.status)}>{s.status}</Badge>
                      {worst && worst.assessment.probability >= 0.3 && (
                        <Badge tone={worst.assessment.probability >= 0.7 ? "crit" : "warn"}>
                          {worst.fuel} risk {pct(worst.assessment.probability)}
                        </Badge>
                      )}
                    </div>
                  </div>
                  {FUELS.map((f) => (
                    <FuelBar key={f} fuel={f} value={s.inventory[f]} capacity={s.capacity[f]} />
                  ))}
                </div>
              );
            })}
          </div>
        </Card>
        <Card title="Latest alerts" action={<Link href="/disruptions" className="text-xs text-accent">all →</Link>}>
          {!alerts?.length ? (
            <Empty>No alerts</Empty>
          ) : (
            <ul className="space-y-2 text-sm">
              {alerts.map((a) => (
                <li key={a.id} className="flex gap-2">
                  <Badge tone={a.kind === "recovery" ? "ok" : statusTone(a.severity)}>{a.kind}</Badge>
                  <span className="min-w-0">
                    {a.message}
                    {a.tick !== null && <span className="text-xs text-muted"> · t{a.tick}</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card title="Depots">
        <div className="grid gap-4 sm:grid-cols-2">
          {net.depots.map((d) => (
            <div key={d.id} className="space-y-1.5 rounded border border-border p-3">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-medium">{d.name}</div>
                  <div className="text-xs text-muted">dispatch {d.dispatch_capacity_per_tick.toLocaleString()} L/tick</div>
                </div>
                <Badge tone={statusTone(d.status)}>{d.status}</Badge>
              </div>
              {FUELS.map((f) => (
                <FuelBar key={f} fuel={f} value={d.inventory[f]} capacity={d.capacity[f]} />
              ))}
            </div>
          ))}
        </div>
        <p className="mt-2 text-xs text-muted">
          Next supply:{" "}
          {net.supplyArrivals
            .filter((a) => a.status !== "ARRIVED")
            .slice(0, 3)
            .map((a) => `${a.depot_id.replace("depot-", "")} ${liters(a.quantity)} ${a.fuel_type} at t${a.planned_tick}${a.status === "DELAYED" ? " (DELAYED)" : ""}`)
            .join(" · ") || "none scheduled"}
        </p>
      </Card>
    </div>
  );
}
