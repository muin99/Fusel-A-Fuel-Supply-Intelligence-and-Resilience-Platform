"use client";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { DecisionButtons, reviewReasonsOf } from "@/components/decision";
import { Badge, Card, Empty, ErrorBox, Loading, statusTone } from "@/components/ui";
import { api } from "@/lib/api";
import { cn, hours, liters, pct } from "@/lib/format";
import { useAction, useDecisionStatus, useRecommendations } from "@/lib/hooks";
import type { Recommendation } from "@/lib/types";

const FILTERS = [
  { key: "NEEDS_REVIEW,PROPOSED", label: "Awaiting decision" },
  { key: "SUBMITTED", label: "Dispatched" },
  { key: "APPROVED", label: "Dispatch pending" },
  { key: "FAILED", label: "Failed" },
  { key: "REJECTED", label: "Rejected" },
  { key: "EXPIRED", label: "Superseded" },
  { key: "", label: "All" },
] as const;

function Inspector({ rec }: { rec: Recommendation }) {
  const explain = useAction<void, { text: string; source: string }>(`/recommendations/${rec.id}/explain`, (r) => (r.source === "llm" ? "AI explanation generated" : "AI unavailable: showing the rule-based explanation"));
  const [qty, setQty] = useState(rec.quantity);
  const [whatIf, setWhatIf] = useState<{ riskBefore: number; riskAfter: number; warnings: string[]; feasible: boolean } | null>(null);
  const [whatIfErr, setWhatIfErr] = useState<string | null>(null);
  const reasons = reviewReasonsOf(rec);

  return (
    <div className="space-y-4 text-sm">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-base font-semibold">
            {liters(rec.quantity)} {rec.fuelType} → {rec.stationId}
          </span>
          <Badge tone={statusTone(rec.status)}>{rec.status === "NEEDS_REVIEW" ? "NEEDS YOU" : rec.status}</Badge>
          <Badge tone={rec.policy.includes("fallback") ? "warn" : "info"}>{rec.policy}</Badge>
          {rec.decidedBy && <Badge tone="muted">decided by {rec.decidedBy}</Badge>}
        </div>
        <div className="mt-1 text-muted">
          from {rec.depotId} via {rec.routeId} · {rec.rationale.transitTicks} ticks transit · planned at tick {rec.tick}
          {rec.simAllocationId && <> · simulator allocation #{rec.simAllocationId}</>}
        </div>
      </div>

      {reasons.length > 0 && (
        <div className="rounded border border-warn/40 bg-warn/10 p-3">
          <h3 className="mb-1 text-xs font-semibold uppercase text-warn">Why this needs a human decision</h3>
          <ul className="space-y-0.5 text-warn">
            {reasons.map((r) => (
              <li key={r}>• {r}</li>
            ))}
          </ul>
        </div>
      )}
      {rec.error && <ErrorBox error={new Error(`Simulator response: ${rec.error}`)} />}

      <div className="flex flex-wrap items-center gap-3">
        <DecisionButtons rec={rec} size="md" />
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div className="rounded bg-surface-2 p-2">
          <div className="text-xs text-muted">Expected shortfall (6 h)</div>
          <div className="font-semibold tabular-nums">
            {rec.rationale.shortfall ? (
              <>
                {liters(rec.rationale.shortfall.before)} → <span className="text-ok">{liters(rec.rationale.shortfall.after)}</span>
              </>
            ) : (
              "n/a (model offline)"
            )}
          </div>
        </div>
        <div className="rounded bg-surface-2 p-2">
          <div className="text-xs text-muted">P(any stockout, 6 h)</div>
          <div className="font-semibold tabular-nums">
            {pct(rec.riskBefore)} → <span className="text-ok">{pct(rec.riskAfter)}</span>
          </div>
        </div>
        <div className="rounded bg-surface-2 p-2">
          <div className="text-xs text-muted">Empty in (no action)</div>
          <div className="font-semibold tabular-nums">{hours(rec.hoursToStockout)}</div>
        </div>
        <div className="rounded bg-surface-2 p-2">
          <div className="text-xs text-muted">Forecast confidence</div>
          <div className={cn("font-semibold tabular-nums", rec.confidence < 0.6 && "text-warn")}>{pct(rec.confidence)}</div>
        </div>
      </div>

      <div>
        <h3 className="mb-1 text-xs font-semibold uppercase text-muted">Explanation</h3>
        <p className="whitespace-pre-wrap">{explain.data?.text ?? rec.explanation}</p>
        <button onClick={() => explain.mutate()} disabled={explain.isPending} className="mt-2 rounded border border-border px-2 py-1 text-xs hover:bg-surface-2 disabled:opacity-50">
          {explain.isPending ? "Asking GPT…" : "Explain with AI"}
        </button>
      </div>

      <div>
        <h3 className="mb-1 text-xs font-semibold uppercase text-muted">Signals the model used</h3>
        <dl className="grid grid-cols-1 gap-x-4 gap-y-0.5 sm:grid-cols-2">
          {Object.entries(rec.rationale.signals).map(([k, v]) => (
            <div key={k} className="flex justify-between gap-2 border-b border-border/50 py-0.5">
              <dt className="text-muted">{k}</dt>
              <dd className="tabular-nums">{v === null ? "—" : typeof v === "number" ? Math.round(v * 1000) / 1000 : String(v)}</dd>
            </div>
          ))}
          <div className="flex justify-between gap-2 border-b border-border/50 py-0.5">
            <dt className="text-muted">need / tank headroom</dt>
            <dd className="tabular-nums">
              {liters(rec.rationale.need)} / {liters(rec.rationale.headroom)}
            </dd>
          </div>
        </dl>
      </div>

      {rec.rationale.constraints.length > 0 && (
        <div>
          <h3 className="mb-1 text-xs font-semibold uppercase text-muted">Constraints active when planned</h3>
          <ul className="list-inside list-disc text-muted">
            {rec.rationale.constraints.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <h3 className="mb-1 text-xs font-semibold uppercase text-muted">Alternatives</h3>
        {rec.rationale.alternatives.length === 0 ? (
          <p className="text-muted">No other available route to this station.</p>
        ) : (
          <table className="w-full text-left">
            <thead className="text-xs text-muted">
              <tr>
                <th>Route</th>
                <th>Transit</th>
                <th>Max / shipment</th>
                <th>Depot usable</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {rec.rationale.alternatives.map((a) => (
                <tr key={a.routeId}>
                  <td>{a.routeId}</td>
                  <td>{a.transitTicks} ticks</td>
                  <td>{liters(a.maxShipment)}</td>
                  <td>{liters(a.depotUsable)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="rounded border border-border p-3">
        <h3 className="mb-2 text-xs font-semibold uppercase text-muted">What-if (projection only, nothing is dispatched)</h3>
        <div className="flex flex-wrap items-center gap-2">
          <input aria-label="What-if quantity" type="number" min={100} step={100} value={qty} onChange={(e) => setQty(Number(e.target.value))} className="w-28 rounded border border-border bg-surface-2 px-2 py-1" />
          <span className="text-muted">L</span>
          <button
            className="rounded border border-border px-2 py-1 hover:bg-surface-2"
            onClick={async () => {
              setWhatIfErr(null);
              try {
                setWhatIf(await api("/decisions/what-if", { method: "POST", json: { stationId: rec.stationId, fuel: rec.fuelType, routeId: rec.routeId, quantity: qty } }));
              } catch (e) {
                setWhatIfErr((e as Error).message);
              }
            }}
          >
            Simulate
          </button>
          {whatIf && (
            <span className="flex flex-wrap items-center gap-1 tabular-nums">
              risk {pct(whatIf.riskBefore)} → {pct(whatIf.riskAfter)}
              {whatIf.feasible ? <Badge tone="ok">feasible</Badge> : whatIf.warnings.map((w) => <Badge key={w} tone="crit">{w}</Badge>)}
            </span>
          )}
        </div>
        {whatIfErr && <p className="mt-2 text-xs text-crit">{whatIfErr}</p>}
      </div>
    </div>
  );
}

export default function DecisionQueuePage() {
  return (
    <Suspense fallback={<Loading />}>
      <DecisionQueue />
    </Suspense>
  );
}

function DecisionQueue() {
  const linked = useSearchParams().get("id");
  const [filter, setFilter] = useState<string>(linked ? "" : FILTERS[0].key);
  const [selected, setSelected] = useState<string | null>(linked);
  const { data, isLoading, error } = useRecommendations(filter || undefined);
  const { data: status } = useDecisionStatus();
  const rows = [...(data ?? [])].sort((a, b) => (a.status === "NEEDS_REVIEW" ? -1 : 0) - (b.status === "NEEDS_REVIEW" ? -1 : 0));
  const current = rows.find((r) => r.id === selected) ?? rows[0];

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-surface p-3 text-sm">
        <strong>How decisions work.</strong> The engine re-plans every few seconds from live simulator state (forecast → constrained LP).{" "}
        {status?.autopilot ? (
          <>
            <Badge tone="ok">Autopilot ON</Badge> routine recommendations are dispatched automatically; items marked <Badge tone="warn">NEEDS YOU</Badge> wait for your approval with the reason shown.
          </>
        ) : (
          <>
            <Badge tone="warn">Autopilot OFF</Badge> every recommendation waits for you: approve, reject, or run a what-if first.
          </>
        )}{" "}
        Approval re-checks the plan against fresh simulator state before anything is sent.
      </div>
      <div className="flex flex-wrap gap-1">
        {FILTERS.map((f) => (
          <button key={f.label} onClick={() => setFilter(f.key)} className={cn("rounded px-2.5 py-1 text-sm", filter === f.key ? "bg-accent text-white" : "text-muted hover:bg-surface-2")}>
            {f.label}
          </button>
        ))}
      </div>
      {isLoading ? (
        <Loading />
      ) : error ? (
        <ErrorBox error={error} />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <Card title={`${rows.length} recommendation${rows.length === 1 ? "" : "s"}`}>
            {rows.length === 0 ? (
              <Empty>{filter.startsWith("NEEDS") ? (status?.autopilot ? "Nothing needs you: autopilot is handling routine resupply." : "No open recommendations right now.") : "Nothing here."}</Empty>
            ) : (
              <ul className="-m-2 max-h-[70vh] divide-y divide-border overflow-auto">
                {rows.map((r) => (
                  <li key={r.id}>
                    <button onClick={() => setSelected(r.id)} className={cn("w-full px-2 py-2 text-left text-sm hover:bg-surface-2", current?.id === r.id && "bg-surface-2")}>
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium">
                          {r.stationId.replace("station-", "")} · {r.fuelType}
                        </span>
                        <Badge tone={statusTone(r.status)}>{r.status === "NEEDS_REVIEW" ? "NEEDS YOU" : r.status}</Badge>
                      </div>
                      <div className="text-xs text-muted tabular-nums">
                        {liters(r.quantity)} from {r.depotId.replace("depot-", "")} · risk {pct(r.riskBefore)} → {pct(r.riskAfter)} · t{r.tick}
                        {r.decidedBy && ` · ${r.decidedBy}`}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="Inspect & decide">{current ? <Inspector key={current.id} rec={current} /> : <Empty>Select a recommendation</Empty>}</Card>
        </div>
      )}
    </div>
  );
}
