"use client";
import { CheckCircle2, CircleAlert, XCircle } from "lucide-react";
import { Card, ErrorBox, Loading, Stat } from "@/components/ui";
import { pct } from "@/lib/format";
import { useHealth } from "@/lib/hooks";

const ICON = { healthy: CheckCircle2, degraded: CircleAlert, down: XCircle };
const COLOR = { healthy: "text-ok", degraded: "text-warn", down: "text-crit" };

export default function HealthPage() {
  const { data, isLoading, error } = useHealth();
  if (isLoading) return <Loading />;
  if (error || !data) return <ErrorBox error={error ?? new Error("Backend API unreachable")} />;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Overall" value={data.status} tone={data.status === "healthy" ? "ok" : data.status === "degraded" ? "warn" : "crit"} />
        <Stat label="p95 latency (60 s)" value={`${data.p95Ms.toFixed(0)} ms`} hint={`p50 ${data.p50Ms.toFixed(0)} · p99 ${data.p99Ms.toFixed(0)} ms`} />
        <Stat label="Error rate (60 s)" value={pct(data.errorRate, 1)} tone={data.errorRate > 0.05 ? "crit" : "ok"} />
        <Stat label="Requests / min" value={data.requestsPerMin} />
      </div>
      <Card title="Components">
        <ul className="divide-y divide-border text-sm">
          {data.components.map((c) => {
            const Icon = ICON[c.status];
            return (
              <li key={c.name} className="flex items-center justify-between gap-3 py-2">
                <span className="flex items-center gap-2">
                  <Icon size={16} className={COLOR[c.status]} />
                  {c.name}
                </span>
                <span className="text-right">
                  <span className={`font-medium ${COLOR[c.status]}`}>{c.status}</span>
                  {c.detail && <span className="block text-xs text-muted">{c.detail}</span>}
                </span>
              </li>
            );
          })}
        </ul>
      </Card>
      <p className="text-xs text-muted">
        Full metrics: Prometheus <a className="underline" href="http://localhost:9090">:9090</a> · Grafana <a className="underline" href="http://localhost:3001">:3001</a> · raw{" "}
        <code>/api/metrics</code>
      </p>
    </div>
  );
}
