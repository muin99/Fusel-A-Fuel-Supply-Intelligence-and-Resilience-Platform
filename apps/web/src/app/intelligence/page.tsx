"use client";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import Link from "next/link";
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useAuth, useToast } from "@/components/providers";
import { Badge, Card, Empty, ErrorBox } from "@/components/ui";
import { api } from "@/lib/api";
import { liters, pct } from "@/lib/format";

// Validated categorical triad (same hues as the fuel palette; order fixed per chart).
const C = ["var(--diesel)", "var(--petrol)", "var(--octane)"];
const MODELS = ["seasonal_ewma", "local_mean", "seasonal_regression"] as const;
const POLICIES = ["no_action", "heuristic", "lp_optimizer"] as const;
const tooltipStyle = { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", fontSize: 12 };
const axis = { fill: "var(--muted)", fontSize: 11 };

type Quality = { version: string; tick: number; rows: { station: string; fuel: string; samples: number; mae: Record<string, number>; weights: Record<string, number>; drift: boolean; meanDemand: number }[] };
type Models = { version: string; selection: string; uncertainty: string; drift: string; agent: { model: string; enabled: boolean; tools: string[]; retrieval: string } };
type Counterfactual = { rows: { scenario: string; policy: string; expectedUnmetLiters: number; serviceLevel: number; stationFuelStockouts: number; allocatedLiters: number }[]; assumptions: string };
type Rl = { version: string; environment: string; trainingEpisodes: number; testEpisodes: number; reward: string; results: Record<string, { serviceLevel: number; reward: number; shippedLiters: number; unmetLiters: number }>; promotion: string };

export default function IntelligenceLab() {
  const { session } = useAuth();
  const toast = useToast();
  const operator = session?.role === "operator";
  const quality = useQuery({ queryKey: ["model-quality"], queryFn: () => api<Quality>("/intelligence/model-quality"), refetchInterval: 20_000 });
  const models = useQuery({ queryKey: ["models"], queryFn: () => api<Models>("/intelligence/models") });
  const demand = useQuery({ queryKey: ["regional"], queryFn: () => api<{ tick: number; region: string; demand: number; unmet: number }[]>("/intelligence/regional-demand"), refetchInterval: 15_000 });
  const transport = useQuery({ queryKey: ["transport"], queryFn: () => api<{ routeId: string; transitTicks: number; meanObservedDelayTicks: number; samples: number; status: string }[]>("/intelligence/transport") });
  const runway = useQuery({ queryKey: ["supply"], queryFn: () => api<{ rows: { depotId: string; fuel: string; projectedMinimum: number; shortageTick: number | null; delayedArrivals: unknown[] }[]; assumption: string }>("/intelligence/supply-risk") });
  const rl = useQuery({ queryKey: ["rl"], queryFn: () => api<Rl>("/intelligence/rl") });
  const cf = useMutation({ mutationFn: (b: { demandMultiplier: number; delayTicks: number }) => api<Counterfactual>("/intelligence/counterfactual", { method: "POST", json: b }), onError: (e) => toast("error", (e as Error).message) });
  const evaluate = useMutation({ mutationFn: () => api<Quality>("/intelligence/evaluate", { method: "POST", json: {} }), onSuccess: (r) => toast("ok", `Evaluation of ${r.rows.length} station·fuel models saved to Decision History (tick ${r.tick})`), onError: (e) => toast("error", (e as Error).message) });

  const rows = quality.data?.rows ?? [];
  const byFuel = ["DIESEL", "PETROL", "OCTANE"].map((fuel) => {
    const rs = rows.filter((r) => r.fuel === fuel && r.samples > 0);
    return { fuel, ...Object.fromEntries(MODELS.map((m) => [m, rs.length ? Math.round((rs.reduce((a, r) => a + (r.mae[m] ?? 0), 0) / rs.length) * 10) / 10 : 0])) };
  });
  const weights = rows.map((r) => ({ name: `${r.station.replace("station-", "")} ${r.fuel[0]}`, ...Object.fromEntries(MODELS.map((m) => [m, Math.round((r.weights[m] ?? 0) * 100)])) }));
  const samples = rows.reduce((a, r) => a + r.samples, 0);
  const drifting = rows.filter((r) => r.drift);
  const regions = [...new Set((demand.data ?? []).map((x) => x.region))];
  const demandSeries = [...new Set((demand.data ?? []).map((x) => x.tick))].map((tick) => ({
    tick,
    ...Object.fromEntries(regions.map((r) => [r.replace("region-", ""), Math.round((demand.data ?? []).find((x) => x.tick === tick && x.region === r)?.demand ?? 0)])),
  }));
  const scenarios = [...new Set((cf.data?.rows ?? []).map((r) => r.scenario))].map((scenario) => ({
    scenario: scenario.replace("_", " "),
    ...Object.fromEntries(POLICIES.map((p) => [p, Math.round((cf.data!.rows.find((r) => r.scenario === scenario && r.policy === p)?.serviceLevel ?? 0) * 1000) / 10])),
  }));
  const rlRows = rl.data ? Object.entries(rl.data.results).map(([policy, r]) => ({ policy: policy.replace("_", " "), shipped: Math.round(r.shippedLiters), unmet: Math.round(r.unmetLiters), service: r.serviceLevel, reward: Math.round(r.reward) })) : [];

  return (
    <div className="space-y-5">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <Sparkles size={22} /> Intelligence Lab
        </h1>
        <p className="max-w-3xl text-sm text-muted">
          The models behind every recommendation, measured on this run&apos;s real simulator history. Forecast → stockout probability → constrained LP (with heuristic fallback) →
          GPT agent that explains and investigates. Operators decide; autopilot only executes routine, high-confidence plans.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card title="Forecast model">
          <p className="text-lg font-semibold">{quality.data?.version ?? "…"}</p>
          <p className="text-xs text-muted">3 candidates, inverse-MAE ensemble, rolling-origin validation</p>
        </Card>
        <Card title="Validation points">
          <p className="text-lg font-semibold tabular-nums">{samples.toLocaleString()}</p>
          <p className="text-xs text-muted">one-step-ahead predictions scored against actual demand (tick {quality.data?.tick ?? "…"})</p>
        </Card>
        <Card title="Demand drift">
          <p className={`text-lg font-semibold ${drifting.length ? "text-warn" : "text-ok"}`}>{drifting.length ? `${drifting.length} series drifting` : "Stable"}</p>
          <p className="text-xs text-muted">{drifting.length ? drifting.map((d) => `${d.station.replace("station-", "")} ${d.fuel}`).join(", ") : "recent vs reference window shift < 30%"}</p>
        </Card>
        <Card title="Copilot agent">
          <p className="text-lg font-semibold">{models.data?.agent.enabled ? models.data.agent.model : "rules fallback"}</p>
          <p className="text-xs text-muted">{models.data?.agent.tools.length ?? 8} read-only tools · RAG over rulebook + incident memory</p>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card title="Forecast error by model (mean absolute error, L per tick; lower is better)">
          {quality.isError ? (
            <ErrorBox error={quality.error} />
          ) : samples === 0 ? (
            <Empty>Needs a few ticks of history: start the simulation.</Empty>
          ) : (
            <div className="h-64">
              <ResponsiveContainer>
                <BarChart data={byFuel} barGap={2}>
                  <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="2 4" />
                  <XAxis dataKey="fuel" tick={axis} axisLine={false} tickLine={false} />
                  <YAxis tick={axis} axisLine={false} tickLine={false} />
                  <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "var(--surface-2)" }} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  {MODELS.map((m, i) => (
                    <Bar key={m} dataKey={m} name={m.replace("_", " ")} fill={C[i]} radius={[4, 4, 0, 0]} maxBarSize={28} />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>
        <Card title="Learned ensemble weights per station·fuel (%)">
          {samples === 0 ? (
            <Empty>Weights appear once validation points exist.</Empty>
          ) : (
            <div className="h-64">
              <ResponsiveContainer>
                <BarChart data={weights} stackOffset="expand">
                  <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="2 4" />
                  <XAxis dataKey="name" tick={{ ...axis, fontSize: 9 }} interval={0} angle={-35} textAnchor="end" height={50} axisLine={false} tickLine={false} />
                  <YAxis tick={axis} tickFormatter={(v) => `${Math.round(v * 100)}%`} axisLine={false} tickLine={false} />
                  <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "var(--surface-2)" }} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  {MODELS.map((m, i) => (
                    <Bar key={m} dataKey={m} name={m.replace("_", " ")} stackId="w" fill={C[i]} stroke="var(--surface)" strokeWidth={1} />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>
      </div>

      <Card
        title="Policy comparison: projected service level over the next 6 h (%)"
        action={
          <button disabled={cf.isPending} onClick={() => cf.mutate({ demandMultiplier: 1.5, delayTicks: 2 })} className="rounded bg-accent px-3 py-1 text-xs font-medium text-white disabled:opacity-50">
            {cf.isPending ? "Projecting…" : cf.data ? "Re-run" : "Run comparison"}
          </button>
        }
      >
        {!cf.data ? (
          <Empty>Compares doing nothing, the greedy heuristic and the LP optimizer on the current state under normal demand, 1.5× demand, and 1.5× demand + 2-tick delays.</Empty>
        ) : (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <div className="h-64">
              <ResponsiveContainer>
                <BarChart data={scenarios} barGap={2}>
                  <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="2 4" />
                  <XAxis dataKey="scenario" tick={axis} axisLine={false} tickLine={false} />
                  <YAxis domain={[0, 100]} tick={axis} unit="%" axisLine={false} tickLine={false} />
                  <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "var(--surface-2)" }} formatter={(v) => `${v}%`} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  {POLICIES.map((p, i) => (
                    <Bar key={p} dataKey={p} name={p.replace("_", " ")} fill={C[i]} radius={[4, 4, 0, 0]} maxBarSize={28} />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="overflow-x-auto text-sm">
              <table className="w-full text-left tabular-nums">
                <thead className="text-xs text-muted">
                  <tr>
                    <th>Scenario</th>
                    <th>Policy</th>
                    <th className="text-right">Unmet</th>
                    <th className="text-right">Stockouts</th>
                  </tr>
                </thead>
                <tbody>
                  {cf.data.rows.map((r) => (
                    <tr key={r.scenario + r.policy} className="border-t border-border/50">
                      <td>{r.scenario.replace("_", " ")}</td>
                      <td>{r.policy.replace("_", " ")}</td>
                      <td className="text-right">{liters(r.expectedUnmetLiters)}</td>
                      <td className="text-right">{r.stationFuelStockouts}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-xs text-muted">{cf.data.assumptions}</p>
            </div>
          </div>
        )}
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card title="Regional demand (L per tick, last 24 h)">
          {demandSeries.length === 0 ? (
            <Empty>No demand history yet.</Empty>
          ) : (
            <div className="h-64">
              <ResponsiveContainer>
                <LineChart data={demandSeries}>
                  <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="2 4" />
                  <XAxis dataKey="tick" tick={axis} axisLine={false} tickLine={false} minTickGap={24} />
                  <YAxis tick={axis} axisLine={false} tickLine={false} />
                  <Tooltip contentStyle={tooltipStyle} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  {regions.map((r, i) => (
                    <Line key={r} dataKey={r.replace("region-", "")} stroke={C[i]} strokeWidth={2} dot={false} />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>
        <Card title="Transport: nominal transit vs observed extra delay (ticks)">
          <div className="h-64">
            <ResponsiveContainer>
              <BarChart data={(transport.data ?? []).map((r) => ({ route: r.routeId.replace("route-", ""), transit: r.transitTicks, delay: Math.round(r.meanObservedDelayTicks * 100) / 100 }))} barGap={2}>
                <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="2 4" />
                <XAxis dataKey="route" tick={{ ...axis, fontSize: 9 }} interval={0} angle={-25} textAnchor="end" height={50} axisLine={false} tickLine={false} />
                <YAxis tick={axis} axisLine={false} tickLine={false} allowDecimals={false} />
                <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "var(--surface-2)" }} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="transit" name="nominal transit" fill={C[0]} radius={[4, 4, 0, 0]} maxBarSize={24} />
                <Bar dataKey="delay" name="observed extra delay" fill={C[2]} radius={[4, 4, 0, 0]} maxBarSize={24} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card title="Reinforcement-learning research benchmark (offline surrogate)">
          {!rl.data ? (
            <Empty>Loading…</Empty>
          ) : (
            <>
              <div className="h-48">
                <ResponsiveContainer>
                  <BarChart data={rlRows} layout="vertical" margin={{ left: 12 }}>
                    <CartesianGrid horizontal={false} stroke="var(--border)" strokeDasharray="2 4" />
                    <XAxis type="number" tick={axis} axisLine={false} tickLine={false} />
                    <YAxis type="category" dataKey="policy" tick={axis} width={100} axisLine={false} tickLine={false} />
                    <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "var(--surface-2)" }} />
                    <Bar dataKey="shipped" name="litres shipped (test episodes)" fill={C[1]} radius={[0, 4, 4, 0]} maxBarSize={20} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <table className="mt-2 w-full text-left text-sm tabular-nums">
                <thead className="text-xs text-muted">
                  <tr>
                    <th>Policy</th>
                    <th className="text-right">Service</th>
                    <th className="text-right">Unmet</th>
                    <th className="text-right">Reward</th>
                  </tr>
                </thead>
                <tbody>
                  {rlRows.map((r) => (
                    <tr key={r.policy} className="border-t border-border/50">
                      <td>{r.policy}</td>
                      <td className="text-right">{pct(r.service, 1)}</td>
                      <td className="text-right">{liters(r.unmet)}</td>
                      <td className="text-right">{r.reward.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-xs text-muted">
                Tabular Q-learning, {rl.data.trainingEpisodes} training / {rl.data.testEpisodes} held-out episodes. {rl.data.environment}. Status: {rl.data.promotion}
              </p>
            </>
          )}
        </Card>
        <Card title="Depot runway (6 h, including scheduled & delayed supply)">
          {!runway.data ? (
            <Empty>Loading…</Empty>
          ) : (
            <>
              <table className="w-full text-left text-sm tabular-nums">
                <thead className="text-xs text-muted">
                  <tr>
                    <th>Depot · fuel</th>
                    <th className="text-right">Projected minimum</th>
                    <th className="text-right">Runs dry</th>
                    <th className="text-right">Delayed supply</th>
                  </tr>
                </thead>
                <tbody>
                  {runway.data.rows.map((r) => (
                    <tr key={r.depotId + r.fuel} className="border-t border-border/50">
                      <td>
                        {r.depotId.replace("depot-", "")} · {r.fuel}
                      </td>
                      <td className="text-right">{liters(r.projectedMinimum)}</td>
                      <td className="text-right">{r.shortageTick ? <Badge tone="crit">t{r.shortageTick}</Badge> : "not in horizon"}</td>
                      <td className="text-right">{r.delayedArrivals.length}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-xs text-muted">{runway.data.assumption}</p>
            </>
          )}
        </Card>
      </div>

      <Card
        title="Model registry & evaluation"
        action={
          <button disabled={!operator || evaluate.isPending} onClick={() => evaluate.mutate()} className="rounded border border-border px-3 py-1 text-xs hover:bg-surface-2 disabled:opacity-50" title={operator ? "" : "Sign in as operator"}>
            {evaluate.isPending ? "Evaluating…" : "Run & record evaluation"}
          </button>
        }
      >
        <dl className="grid gap-2 text-sm md:grid-cols-2">
          <div>
            <dt className="text-xs uppercase text-muted">Selection</dt>
            <dd>{models.data?.selection}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-muted">Uncertainty</dt>
            <dd>{models.data?.uncertainty}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-muted">Drift rule</dt>
            <dd>{models.data?.drift}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-muted">Agent retrieval</dt>
            <dd>{models.data?.agent.retrieval}</dd>
          </div>
        </dl>
        <p className="mt-3 text-xs text-muted">
          Ask the <Link href="/assistant" className="text-accent underline">Ops Copilot</Link> to use these models on the live state; see forecast bands per station on{" "}
          <Link href="/forecast" className="text-accent underline">Risk &amp; Forecast</Link>.
        </p>
      </Card>
    </div>
  );
}
