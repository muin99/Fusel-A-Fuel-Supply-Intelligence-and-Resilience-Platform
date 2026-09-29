"use client";
import { Check, X } from "lucide-react";
import Link from "next/link";
import { useAction } from "@/lib/hooks";
import { cn, hours, liters, pct } from "@/lib/format";
import type { Recommendation } from "@/lib/types";
import { useAuth } from "./providers";
import { Badge, statusTone } from "./ui";

export function reviewReasonsOf(r: Recommendation): string[] {
  return r.rationale.reviewReasons ?? [];
}

/** Approve / reject controls with visible outcome. Operators only. */
export function DecisionButtons({ rec, size = "sm" }: { rec: Recommendation; size?: "sm" | "md" }) {
  const { session } = useAuth();
  const approve = useAction<void, Recommendation>(`/recommendations/${rec.id}/approve`, (r) =>
    r.status === "SUBMITTED"
      ? `Dispatched ${liters(r.quantity)} ${r.fuelType} to ${r.stationId} (allocation #${r.simAllocationId})`
      : `Approval recorded; dispatch pending retry (${r.error ?? "simulator busy"})`,
  );
  const reject = useAction<{ reason?: string }>(`/recommendations/${rec.id}/reject`, `Rejected: ${rec.stationId} ${rec.fuelType} will not be dispatched`);
  const open = rec.status === "PROPOSED" || rec.status === "NEEDS_REVIEW";
  if (!open) return null;
  if (session?.role !== "operator")
    return <span className="text-xs text-muted">{session ? "Only operators can approve" : "Sign in as operator to approve"}</span>;
  const busy = approve.isPending || reject.isPending;
  const pad = size === "md" ? "px-3 py-1.5 text-sm" : "px-2 py-1 text-xs";
  return (
    <div className="flex items-center gap-1.5">
      <button disabled={busy} onClick={() => approve.mutate()} className={cn("inline-flex items-center gap-1 rounded bg-accent font-medium text-white disabled:opacity-50", pad)}>
        <Check size={14} /> {approve.isPending ? "Dispatching…" : "Approve & dispatch"}
      </button>
      <button disabled={busy} onClick={() => reject.mutate({ reason: "Rejected from operator console" })} className={cn("inline-flex items-center gap-1 rounded border border-border hover:bg-surface-2 disabled:opacity-50", pad)}>
        <X size={14} /> Reject
      </button>
    </div>
  );
}

/** Compact decision row: what, why it needs a human, expected impact, and the controls. */
export function DecisionCard({ rec, showLink = true }: { rec: Recommendation; showLink?: boolean }) {
  const reasons = reviewReasonsOf(rec);
  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="text-sm font-semibold">
            {liters(rec.quantity)} {rec.fuelType} → {rec.stationId.replace("station-", "")}
          </div>
          <div className="text-xs text-muted">
            from {rec.depotId.replace("depot-", "")} via {rec.routeId} · {rec.rationale.transitTicks} ticks ·{" "}
            {rec.rationale.shortfall ? (
              <>
                expected shortfall (6 h){" "}
                <span className="font-medium text-text tabular-nums">
                  {liters(rec.rationale.shortfall.before)} → <span className="text-ok">{liters(rec.rationale.shortfall.after)}</span>
                </span>
              </>
            ) : (
              <>
                stockout risk{" "}
                <span className="font-medium text-text tabular-nums">
                  {pct(rec.riskBefore)} → {pct(rec.riskAfter)}
                </span>
              </>
            )}
            {rec.hoursToStockout !== null && <> · empty in {hours(rec.hoursToStockout)}</>}
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <Badge tone={statusTone(rec.status)}>{rec.status === "NEEDS_REVIEW" ? "NEEDS YOU" : rec.status}</Badge>
          {rec.rationale.requestId && <Badge tone="warn">station request #{rec.rationale.requestId}</Badge>}
        </div>
      </div>
      {reasons.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-xs text-warn">
          {reasons.map((r) => (
            <li key={r}>• {r}</li>
          ))}
        </ul>
      )}
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <DecisionButtons rec={rec} />
        {showLink && (
          <Link href={`/recommendations?id=${rec.id}`} className="text-xs text-accent hover:underline">
            Inspect evidence →
          </Link>
        )}
      </div>
    </div>
  );
}
