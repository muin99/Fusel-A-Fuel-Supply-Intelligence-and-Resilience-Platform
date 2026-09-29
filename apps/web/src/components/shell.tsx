"use client";
import { Activity, AlertTriangle, Bot, ClipboardList, Fuel, FlaskConical, Gauge, LineChart, LogIn, LogOut, Sparkles, Truck } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, type Session } from "@/lib/api";
import { cn } from "@/lib/format";
import { useAction, useDecisionStatus, useDrillStatus, useNetwork } from "@/lib/hooks";
import type { DecisionStatus } from "@/lib/types";
import { useAuth, useToast } from "./providers";
import { Badge, statusTone } from "./ui";

const NAV = [
  { href: "/", label: "Operations", icon: Gauge, roles: ["operator", "viewer", "guest"] },
  { href: "/recommendations", label: "Decision Queue", icon: Truck, roles: ["operator", "viewer", "guest"] },
  { href: "/assistant", label: "Ops Copilot", icon: Bot, roles: ["operator", "viewer", "guest"] },
  { href: "/forecast", label: "Risk & Forecast", icon: LineChart, roles: ["operator", "viewer", "guest", "station"] },
  { href: "/disruptions", label: "Disruptions & Alerts", icon: AlertTriangle, roles: ["operator", "viewer", "guest"] },
  { href: "/station", label: "Station Portal", icon: Fuel, roles: ["station", "operator", "viewer", "guest"] },
  { href: "/intelligence", label: "Intelligence Lab", icon: Sparkles, roles: ["operator", "viewer", "guest"] },
  { href: "/audit", label: "Decision History", icon: ClipboardList, roles: ["operator", "viewer", "guest"] },
  { href: "/health", label: "System Health", icon: Activity, roles: ["operator", "viewer", "guest"] },
  { href: "/control", label: "Scenario Control", icon: FlaskConical, roles: ["operator", "viewer", "guest"] },
];

export function SignInPanel({ onDone, compact }: { onDone?: () => void; compact?: boolean }) {
  const { setSession } = useAuth();
  const toast = useToast();
  const { data: net } = useNetwork();
  const [role, setRole] = useState<Session["role"]>("operator");
  const [username, setUsername] = useState("operator");
  const [password, setPassword] = useState("");
  const [stationId, setStationId] = useState("station-mirpur");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className={cn("space-y-2", !compact && "w-72")}
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          const s = await api<Session>("/auth/login", { method: "POST", json: { username: role === "station" ? `${stationId}-manager` : username, role, password, ...(role === "station" ? { stationId } : {}) } });
          setSession(s);
          setErr(null);
          toast("ok", `Signed in as ${s.role}${s.stationId ? ` for ${s.stationId}` : ""}`);
          onDone?.();
        } catch (x) {
          setErr((x as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <label className="block text-xs text-muted">
        Role
        <select value={role} onChange={(e) => setRole(e.target.value as Session["role"])} className="mt-1 w-full rounded border border-border bg-surface-2 px-2 py-1.5 text-sm text-text">
          <option value="operator">Operator: approve & dispatch</option>
          <option value="station">Station manager: request fuel</option>
          <option value="viewer">Viewer: read only</option>
        </select>
      </label>
      {role === "station" ? (
        <label className="block text-xs text-muted">
          Station
          <select value={stationId} onChange={(e) => setStationId(e.target.value)} className="mt-1 w-full rounded border border-border bg-surface-2 px-2 py-1.5 text-sm text-text">
            {(net?.stations ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <label className="block text-xs text-muted">
          Name
          <input value={username} onChange={(e) => setUsername(e.target.value)} className="mt-1 w-full rounded border border-border bg-surface-2 px-2 py-1.5 text-sm text-text" />
        </label>
      )}
      <label className="block text-xs text-muted">
        Password
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="see .env" className="mt-1 w-full rounded border border-border bg-surface-2 px-2 py-1.5 text-sm text-text" />
      </label>
      {err && <p className="text-xs text-crit">{err}</p>}
      <button disabled={busy} className="w-full rounded bg-accent px-2 py-1.5 text-sm font-medium text-white disabled:opacity-50">
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}

function Account() {
  const { session, setSession } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);
  if (session)
    return (
      <div className="flex items-center gap-2 text-sm">
        <Badge tone={session.role === "operator" ? "info" : session.role === "station" ? "warn" : "muted"}>{session.role}</Badge>
        <span className="hidden sm:inline">{session.stationId ?? session.username}</span>
        <button onClick={() => setSession(null)} className="rounded p-1 text-muted hover:bg-surface-2 hover:text-text" aria-label="Log out" title="Log out">
          <LogOut size={16} />
        </button>
      </div>
    );
  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen(!open)} className="flex items-center gap-1.5 rounded bg-accent px-3 py-1.5 text-sm font-medium text-white">
        <LogIn size={15} /> Sign in to act
      </button>
      {open && (
        <div className="absolute right-0 z-30 mt-2 rounded-lg border border-border bg-surface p-3 shadow-xl">
          <SignInPanel onDone={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}

function AutopilotSwitch({ status, canToggle }: { status?: DecisionStatus; canToggle: boolean }) {
  const toggle = useAction<{ enabled: boolean }, DecisionStatus>("/decisions/autopilot", (r) =>
    r.autopilot ? "Autopilot ON: routine resupply dispatches automatically; exceptions come to you." : "Autopilot OFF: every recommendation now waits for your approval.",
  );
  if (!status) return null;
  const on = status.autopilot;
  return (
    <button
      disabled={!canToggle || toggle.isPending}
      onClick={() => toggle.mutate({ enabled: !on })}
      title={canToggle ? "Toggle autopilot" : "Operators can toggle autopilot"}
      className={cn(
        "flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs font-medium",
        on ? "border-ok/50 bg-ok/10 text-ok" : "border-warn/50 bg-warn/10 text-warn",
        canToggle ? "hover:opacity-80" : "cursor-default",
      )}
    >
      <span className={cn("relative inline-flex h-3.5 w-6 rounded-full", on ? "bg-ok" : "bg-border")}>
        <span className={cn("absolute top-0.5 h-2.5 w-2.5 rounded-full bg-white transition-all", on ? "left-3" : "left-0.5")} />
      </span>
      Autopilot {on ? "ON" : "OFF"}
    </button>
  );
}

function DrillBanner({ operator }: { operator: boolean }) {
  const { data: drill } = useDrillStatus(operator);
  const restore = useAction<void>("/chaos/restore", "Normal operations restored: faults cleared, model and optimizer back online.");
  if (!drill) return null;
  const items = [
    !drill.predictionAvailable && "Prediction model OFFLINE (fallback policy)",
    drill.forcedPolicy && `Policy forced to ${drill.forcedPolicy}`,
    ...drill.activeFaults.map((f) => `Simulator fault: ${f.type}`),
  ].filter(Boolean) as string[];
  if (!items.length) return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-crit/40 bg-crit/10 px-4 py-1.5 text-sm text-crit">
      <span>
        <strong>Drill active:</strong> {items.join(" · ")}
      </span>
      <button disabled={restore.isPending} onClick={() => restore.mutate()} className="rounded border border-crit/50 px-2 py-0.5 text-xs font-medium hover:bg-crit/10 disabled:opacity-50">
        {restore.isPending ? "Restoring…" : "Restore normal operations"}
      </button>
    </div>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const { session } = useAuth();
  const role = session?.role ?? "guest";
  const operator = role === "operator";
  const { data: net, isError } = useNetwork();
  const { data: status } = useDecisionStatus();
  const nav = NAV.filter((n) => n.roles.includes(role));
  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-56 shrink-0 border-r border-border bg-surface md:block">
        <div className="px-4 py-4">
          <div className="text-sm font-bold">Fuel Ops Center</div>
          <div className="text-xs text-muted">Simulated network · BUP</div>
        </div>
        <nav className="space-y-0.5 px-2">
          {nav.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className={cn("flex items-center gap-2 rounded px-2 py-1.5 text-sm text-muted hover:bg-surface-2 hover:text-text", path === href && "bg-surface-2 font-medium text-text")}
            >
              <Icon size={16} /> <span className="flex-1">{label}</span>
              {href === "/recommendations" && !!status?.needsReview && <span className="rounded-full bg-warn px-1.5 text-[11px] font-semibold text-white">{status.needsReview}</span>}
            </Link>
          ))}
        </nav>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-surface px-4 py-2">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <select aria-label="Navigate" className="rounded border border-border bg-surface-2 px-2 py-1 md:hidden" value={path} onChange={(e) => (window.location.href = e.target.value)}>
              {nav.map((n) => (
                <option key={n.href} value={n.href}>
                  {n.label}
                </option>
              ))}
            </select>
            {net ? (
              <>
                <Badge tone={statusTone(net.instance.status)}>{net.instance.status === "RUNNING" ? "SIM RUNNING" : "SIM PAUSED"}</Badge>
                <span className="tabular-nums">Tick {net.instance.tick}</span>
                <span className="hidden text-muted tabular-nums sm:inline">{net.instance.sim_time.replace("T", " ").slice(0, 16)} sim time</span>
              </>
            ) : (
              <span className="text-muted">Connecting…</span>
            )}
            <AutopilotSwitch status={status} canToggle={operator} />
            {!!status?.needsReview && role !== "station" && (
              <Link href="/recommendations" className="rounded-full bg-warn/15 px-2.5 py-1 text-xs font-semibold text-warn hover:bg-warn/25">
                {status.needsReview} decision{status.needsReview > 1 ? "s" : ""} waiting for you
              </Link>
            )}
          </div>
          <Account />
        </header>
        {operator && <DrillBanner operator={operator} />}
        {(isError || net?.meta.degraded || net?.meta.stale) && (
          <div className="border-b border-warn/40 bg-warn/10 px-4 py-1.5 text-sm text-warn">
            {isError
              ? "Backend unreachable: showing the last data held by the browser."
              : net?.meta.degraded
                ? "Degraded mode: simulator unreachable, showing last known good state. Dispatching is paused."
                : "Simulator data flagged stale: dispatching is paused until fresh data arrives."}
          </div>
        )}
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-5">{children}</main>
        <footer className="border-t border-border px-4 py-2 text-xs text-muted">All data is simulated (BUP Fuel Supply Simulator). No real fuel infrastructure is accessed.</footer>
      </div>
    </div>
  );
}
