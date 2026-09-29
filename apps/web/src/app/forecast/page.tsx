"use client";
import { useState } from "react";
import { Line, LineChart, Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Badge, Card, Empty, ErrorBox, Loading } from "@/components/ui";
import { cn, hours, liters, pct } from "@/lib/format";
import { useRisk } from "@/lib/hooks";
import { FUELS } from "@/lib/types";

const FUEL_VAR = { DIESEL: "var(--diesel)", PETROL: "var(--petrol)", OCTANE: "var(--octane)" } as const;

export default function ForecastPage() {
  const [series, setSeries] = useState(0);
  const { data, isLoading, error } = useRisk();
  if (isLoading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  if (!data?.length) return <Empty>No forecast yet — start the simulation.</Empty>;

  const stations = [...new Set(data.map((r) => r.stationName))];
  const chart = stations.map((name) => {
    const row: Record<string, string | number> = { station: name.replace(" Fuel Station", "").replace(" Station", "") };
    for (const f of FUELS) row[f] = Math.round((data.find((r) => r.stationName === name && r.fuel === f)?.assessment.probability ?? 0) * 100);
    return row;
  });

  return (
    <div className="space-y-4">
      <Card title="Stockout probability within 6 h (%)">
        <div className="h-72">
          <ResponsiveContainer>
            <BarChart data={chart} layout="vertical" margin={{ left: 8, right: 16 }} barGap={2} barCategoryGap="22%">
              <CartesianGrid horizontal={false} stroke="var(--border)" strokeDasharray="2 4" />
              <XAxis type="number" domain={[0, 100]} tick={{ fill: "var(--muted)", fontSize: 12 }} axisLine={false} tickLine={false} unit="%" />
              <YAxis type="category" dataKey="station" width={120} tick={{ fill: "var(--text)", fontSize: 12 }} axisLine={false} tickLine={false} />
              <Tooltip
                cursor={{ fill: "var(--surface-2)" }}
                contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", fontSize: 12 }}
                formatter={(v) => `${v}%`}
              />
              <Legend wrapperStyle={{ fontSize: 12, color: "var(--muted)" }} />
              {FUELS.map((f) => (
                <Bar key={f} dataKey={f} fill={FUEL_VAR[f]} radius={[0, 4, 4, 0]} maxBarSize={12} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Card>

      <Card title="Demand forecast & empirical uncertainty">
        <select aria-label="Forecast series" value={series} onChange={(e) => setSeries(Number(e.target.value))} className="mb-3 rounded border border-border bg-surface-2 p-2 text-sm">{data.map((r, i) => <option key={r.stationId + r.fuel} value={i}>{r.stationName} · {r.fuel}</option>)}</select>
        {data[series]?.forecast.drift && <Badge tone="warn">Demand drift · human review</Badge>}
        <div className="h-56"><ResponsiveContainer width="100%" height="100%"><LineChart data={(data[series]?.forecast.perTick ?? data[series]?.forecast.next ?? []).map((value, k) => ({ tick: k + 1, mean: value, lower: data[series]?.forecast.lower?.[k], upper: data[series]?.forecast.upper?.[k] }))}><CartesianGrid strokeDasharray="3 3"/><XAxis dataKey="tick"/><YAxis/><Tooltip/><Legend/><Line dataKey="mean" stroke="#38bdf8" dot={false}/><Line dataKey="lower" stroke="#94a3b8" strokeDasharray="4 4" dot={false}/><Line dataKey="upper" stroke="#94a3b8" strokeDasharray="4 4" dot={false}/></LineChart></ResponsiveContainer></div>
        <p className="text-xs text-muted">Liters per future tick. Residual-based bounds widen over time and during drift; stockout probabilities are model estimates, not calibrated guarantees.</p>
      </Card>
      <Card title="Risk table (sorted by stockout probability)">
        <div className="-mx-4 overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="text-xs text-muted">
              <tr className="border-b border-border">
                <th className="px-4 py-2">Station</th>
                <th>Fuel</th>
                <th className="text-right">Inventory</th>
                <th className="text-right">In transit</th>
                <th className="text-right">6 h demand</th>
                <th className="text-right">Stockout in</th>
                <th className="text-right">P(stockout)</th>
                <th className="text-right">Demand vs normal</th>
                <th className="px-4 text-right">Confidence</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {data.map((r) => (
                <tr key={r.stationId + r.fuel} className="border-b border-border/50">
                  <td className="px-4 py-1.5">
                    {r.stationName} {!r.stationOpen && <Badge tone="crit">OUTAGE</Badge>}
                  </td>
                  <td>{r.fuel}</td>
                  <td className="text-right">{liters(r.inventory)}</td>
                  <td className="text-right">{liters(r.inTransit)}</td>
                  <td className="text-right">{liters(r.assessment.expectedDemand)}</td>
                  <td className="text-right">{hours(r.assessment.hoursToStockout)}</td>
                  <td className="text-right">
                    <Badge tone={r.assessment.probability >= 0.8 ? "crit" : r.assessment.probability >= 0.4 ? "warn" : "ok"}>{pct(r.assessment.probability)}</Badge>
                  </td>
                  <td className={cn("text-right", r.forecast.level >= 1.35 && "font-semibold text-warn")}>×{r.forecast.level.toFixed(2)}</td>
                  <td className="px-4 text-right">
                    {pct(r.forecast.confidence)} <span className="text-xs text-muted">n={r.forecast.samples}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
