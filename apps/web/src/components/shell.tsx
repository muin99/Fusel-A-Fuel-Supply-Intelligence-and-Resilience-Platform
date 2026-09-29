"use client";
import { Activity, AlertTriangle, Bot, ClipboardList, Fuel, FlaskConical, Gauge, LineChart, LogIn, LogOut, PlayCircle, Sparkles, Truck, Warehouse } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, type Session } from "@/lib/api";
import { cn } from "@/lib/format";
import { useAction, useAuthConfig, useDecisionStatus, useDrillStatus, useNetwork } from "@/lib/hooks";
import type { DecisionStatus } from "@/lib/types";
import { useAuth, useToast } from "./providers";
import { Badge, statusTone } from "./ui";

const NAV = [
  { href: "/ml", label: "Trained ML Evidence", icon: LineChart, roles: ["operator", "viewer", "guest", "station", "depot"] },
  { href: "/demo", label: "Demo Guide", icon: PlayCircle, roles: ["operator", "viewer", "guest", "station", "depot"] },
  { href: "/", label: "Operations", icon: Gauge, roles: ["operator", "viewer", "guest"] },
  { href: "/recommendations", label: "Decision Queue", icon: Truck, roles: ["operator", "viewer", "guest"] },
  { href: "/assistant", label: "Ops Copilot", icon: Bot, roles: ["operator", "viewer", "guest"] },
  { href: "/forecast", label: "Risk & Forecast", icon: LineChart, roles: ["operator", "viewer", "guest", "station", "depot"] },
  { href: "/disruptions", label: "Disruptions & Alerts", icon: AlertTriangle, roles: ["operator", "viewer", "guest"] },
  { href: "/depot", label: "Depot Console", icon: Warehouse, roles: ["depot", "operator", "viewer", "guest"] },
  { href: "/station", label: "Station Portal", icon: Fuel, roles: ["station", "operator", "viewer", "guest"] },
  { href: "/intelligence", label: "Intelligence Lab", icon: Sparkles, roles: ["operator", "viewer", "guest"] },
  { href: "/audit", label: "Decision History", icon: ClipboardList, roles: ["operator", "viewer", "guest"] },
  { href: "/health", label: "System Health", icon: Activity, roles: ["operator", "viewer", "guest"] },
  { href: "/control", label: "Scenario Control", icon: FlaskConical, roles: ["operator", "viewer", "guest"] },
];

type DemoRole = { key: string; label: string; body: { role: Session["role"]; stationId?: string; depotId?: string } };

/** Demo mode: become any role in one click (the API still enforces each role's permissions). */
export function useDemoRoles(): DemoRole[] {
  const { data: net } = useNetwork();
  return [
    { key: "operator", label: "Operator (system owner)", body: { role: "operator" } },
    ...(net?.depots ?? []).map((d) => ({ key: d.id, label: `Depot manager · ${d.name.replace(" Depot", "")}`, body: { role: "depot" as const, depotId: d.id } })),
    ...(net?.stations ?? []).map((st) => ({ key: st.id, label: `Station manager · ${st.name.replace(/ (Fuel|Industrial|Highway|Regional)? ?Station/, "")}`, body: { role: "station" as const, stationId: st.id } })),
    { key: "viewer", label: "Viewer (read only)", body: { role: "viewer" } },
  ];
}

export function useBecome() {
  const { setSession } = useAuth();
  const toast = useToast();
  return async (r: DemoRole) => {
    try {
      const s = await api<Session>("/auth/demo", { method: "POST", json: r.body });
      setSession(s);
      toast("ok", `Now viewing as ${r.label}`);
      return s;
    } catch (e) {
      toast("error", (e as Error).message);
      return null;
    }
  };
}

function RoleSwitcher() {
  const { session, setSession } = useAuth();
  const roles = useDemoRoles();
  const become = useBecome();
  const current = session ? (session.depotId ?? session.stationId ?? session.role) : "guest";
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="text-xs text-muted">View as</span>
      <select
        aria-label="View as"
        value={current}
        onChange={(e) => {
          const r = roles.find((x) => x.key === e.target.value);
          if (r) void become(r);
          else setSession(null);
        }}
        className="rounded border border-accent/50 bg-accent/10 px-2 py-1 text-sm font-medium text-text"
      >
        <option value="guest">Guest (no role)</option>
        {roles.map((r) => (
          <option key={r.key} value={r.key}>
            {r.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function SignInPanel({ onDone, compact }: { onDone?: () => void; compact?: boolean }) {
  const { data: cfg } = useAuthConfig();
  const roles = useDemoRoles();
  const become = useBecome();
  if (cfg?.demoMode)
    return (
      <div className="flex flex-wrap gap-1.5">
        {roles
          .filter((r) => r.body.role !== "viewer")
          .map((r) => (
            <button key={r.key} onClick={() => void become(r).then((s) => s && onDone?.())} className="rounded border border-accent/50 bg-accent/10 px-2.5 py-1 text-xs font-medium hover:bg-accent/20">
              {r.label}
            </button>
          ))}
      </div>
    );
  return <PasswordSignIn onDone={onDone} compact={compact} />;
}

function PasswordSignIn({ onDone, compact }: { onDone?: () => void; compact?: boolean }) {
  const { setSession } = useAuth();
  const toast = useToast();
  const { data: net } = useNetwork();
  const [role, setRole] = useState<Session["role"]>("operator");
  const [username, setUsername] = useState("operator");
  const [password, setPassword] = useState("");
  const [stationId, setStationId] = useState("station-mirpur");
  const [depotId, setDepotId] = useState("depot-gazipur");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className={cn("space-y-2", !compact && "w-72")}
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          const name = role === "station" ? `${stationId}-manager` : role === "depot" ? `${depotId}-manager` : username;
          const s = await api<Session>("/auth/login", { method: "POST", json: { username: name, role, password, ...(role === "station" ? { stationId } : {}), ...(role === "depot" ? { depotId } : {}) } });
          setSession(s);
          setErr(null);
          toast("ok", `Signed in as ${s.role}${s.stationId ? ` for ${s.stationId}` : ""}${s.depotId ? ` for ${s.depotId}` : ""}`);
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
        <select aria-label="Role" value={role} onChange={(e) => setRole(e.target.value as Session["role"])} className="mt-1 w-full rounded border border-border bg-surface-2 px-2 py-1.5 text-sm text-text">
          <option value="operator">Operator (system owner): exceptions, anomalies, autopilot</option>
          <option value="depot">Depot manager: accept / reject station requests</option>
          <option value="station">Station manager: request fuel</option>
          <option value="viewer">Viewer: read only</option>
        </select>
      </label>
      {role === "depot" ? (
        <label className="block text-xs text-muted">
          Depot
          <select aria-label="Depot" value={depotId} onChange={(e) => setDepotId(e.target.value)} className="mt-1 w-full rounded border border-border bg-surface-2 px-2 py-1.5 text-sm text-text">
            {(net?.depots ?? []).map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
      ) : role === "station" ? (
        <label className="block text-xs text-muted">
          Station
          <select aria-label="Station" value={stationId} onChange={(e) => setStationId(e.target.value)} className="mt-1 w-full rounded border border-border bg-surface-2 px-2 py-1.5 text-sm text-text">
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
          <input aria-label="Name" value={username} onChange={(e) => setUsername(e.target.value)} className="mt-1 w-full rounded border border-border bg-surface-2 px-2 py-1.5 text-sm text-text" />
        </label>
      )}
      <label className="block text-xs text-muted">
        Password
        <input aria-label="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="see .env" className="mt-1 w-full rounded border border-border bg-surface-2 px-2 py-1.5 text-sm text-text" />
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
        <Badge tone={session.role === "operator" ? "info" : session.role === "viewer" ? "muted" : "warn"}>{session.role === "depot" ? "depot manager" : session.role === "station" ? "station manager" : session.role}</Badge>
        <span className="hidden sm:inline">{session.depotId ?? session.stationId ?? session.username}</span>
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
  const { data: cfg } = useAuthConfig();
  const demo = !!cfg?.demoMode;
  const nav = demo ? NAV : NAV.filter((n) => n.roles.includes(role));
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
            {!!status?.needsReview && (role === "operator" || role === "viewer" || role === "guest") && (
              <Link href="/recommendations" className="rounded-full bg-warn/15 px-2.5 py-1 text-xs font-semibold text-warn hover:bg-warn/25">
                {status.needsReview} decision{status.needsReview > 1 ? "s" : ""} waiting for you
              </Link>
            )}
          </div>
          {demo ? <RoleSwitcher /> : <Account />}
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
