import type { ReactNode } from "react";
import { cn } from "@/lib/format";
import type { Fuel } from "@/lib/types";

export function Card({ title, action, children, className }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("rounded-lg border border-border bg-surface", className)}>
      {title && (
        <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5">
          <h2 className="text-sm font-semibold">{title}</h2>
          {action}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: "ok" | "warn" | "crit" }) {
  return (
    <div className="rounded-lg border border-border bg-surface px-4 py-3">
      <div className="text-xs uppercase tracking-wide text-muted">{label}</div>
      <div className={cn("mt-1 text-2xl font-semibold tabular-nums", tone === "ok" && "text-ok", tone === "warn" && "text-warn", tone === "crit" && "text-crit")}>{value}</div>
      {hint && <div className="mt-0.5 text-xs text-muted">{hint}</div>}
    </div>
  );
}

const TONES: Record<string, string> = {
  ok: "bg-ok/15 text-ok",
  warn: "bg-warn/15 text-warn",
  crit: "bg-crit/15 text-crit",
  info: "bg-accent/15 text-accent",
  muted: "bg-surface-2 text-muted",
};
export function Badge({ tone = "muted", children }: { tone?: keyof typeof TONES; children: ReactNode }) {
  return <span className={cn("inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium", TONES[tone])}>{children}</span>;
}

export function statusTone(s: string): keyof typeof TONES {
  if (["OPEN", "AVAILABLE", "healthy", "ARRIVED", "SUBMITTED", "RESOLVED", "RUNNING"].includes(s)) return "ok";
  if (["CONSTRAINED", "DELAYED", "degraded", "NEEDS_REVIEW", "PENDING", "IN_TRANSIT", "ACTIVE", "warning", "PAUSED"].includes(s)) return "warn";
  if (["OUTAGE", "DISRUPTED", "down", "FAILED", "critical", "REJECTED"].includes(s)) return "crit";
  return "muted";
}

const FUEL_BG: Record<Fuel, string> = { DIESEL: "bg-diesel", PETROL: "bg-petrol", OCTANE: "bg-octane" };
export function FuelBar({ fuel, value, capacity }: { fuel: Fuel; value: number; capacity: number }) {
  const ratio = capacity > 0 ? Math.min(1, value / capacity) : 0;
  return (
    <div className="grid grid-cols-[4.5rem_1fr_5.5rem] items-center gap-2 text-xs">
      <span className="text-muted">{fuel}</span>
      <div className="h-2 overflow-hidden rounded bg-surface-2">
        <div className={cn("h-full rounded", ratio < 0.2 ? "bg-crit" : FUEL_BG[fuel])} style={{ width: `${ratio * 100}%` }} />
      </div>
      <span className="text-right tabular-nums">{Math.round(value).toLocaleString()}</span>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-sm text-muted">{children}</p>;
}

export function Loading() {
  return <p className="py-6 text-center text-sm text-muted">Loading…</p>;
}

export function ErrorBox({ error }: { error: unknown }) {
  return <p className="rounded border border-crit/40 bg-crit/10 px-3 py-2 text-sm text-crit">{(error as Error)?.message ?? "Request failed"}</p>;
}
