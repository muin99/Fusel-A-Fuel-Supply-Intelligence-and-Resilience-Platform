"use client";
import { Check, Warehouse, X } from "lucide-react";
import { useState } from "react";
import { useAuth } from "@/components/providers";
import { SignInPanel } from "@/components/shell";
import { Badge, Card, Empty, ErrorBox, FuelBar, Loading, statusTone } from "@/components/ui";
import { hours, liters, pct } from "@/lib/format";
import { useAction, useNetwork, useRequests } from "@/lib/hooks";
import { FUELS, type FuelRequest } from "@/lib/types";

function RequestDecision({ r, depotId, canAct }: { r: FuelRequest; depotId: string | null; canAct: boolean }) {
  const routes = (r.routes ?? []).filter((x) => !depotId || x.depotId === depotId);
  const [routeId, setRouteId] = useState(routes.find((x) => x.status === "AVAILABLE")?.id ?? routes[0]?.id ?? "");
  const route = routes.find((x) => x.id === routeId);
  const [quantity, setQuantity] = useState(Math.min(r.quantity, route?.maxShipment ?? r.quantity));
  const [reason, setReason] = useState("");
  const accept = useAction<{ routeId: string; quantity: number }, FuelRequest>(`/requests/${r.id}/accept`, (x) => x.resolution ?? `Request #${r.id} accepted`);
  const decline = useAction<{ reason: string }>(`/requests/${r.id}/decline`, `Request #${r.id} rejected`);
  const m = r.modelView;
  const busy = accept.isPending || decline.isPending;
  return (
    <div className="rounded-lg border border-border p-3 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="font-semibold">
            #{r.id} · {r.stationId.replace("station-", "")} wants {liters(r.quantity)} {r.fuelType}
          </div>
          <div className="text-xs text-muted">
            raised at t{r.tick} by {r.requestedBy}
            {r.note && <> · “{r.note}”</>}
          </div>
        </div>
        <div className="flex gap-1.5">
          <Badge tone={r.urgency === "emergency" ? "crit" : r.urgency === "urgent" ? "warn" : "muted"}>{r.urgency}</Badge>
          <Badge tone={r.status === "OPEN" ? "warn" : r.status === "FULFILLED" ? "ok" : r.status === "PLANNED" ? "info" : "muted"}>{r.status}</Badge>
        </div>
      </div>
      {m && (
        <div className="mt-2 grid grid-cols-2 gap-2 rounded bg-surface-2 p-2 text-xs sm:grid-cols-4">
          <div>
            <div className="text-muted">Station tank</div>
            <div className="font-medium tabular-nums">
              {liters(m.inventory)} / {liters(m.capacity)}
            </div>
          </div>
          <div>
            <div className="text-muted">Already on the way</div>
            <div className="font-medium tabular-nums">{liters(m.inTransit)}</div>
          </div>
          <div>
            <div className="text-muted">Model stockout risk (6 h)</div>
            <div className="font-medium tabular-nums">{m.stockoutProbability === null ? "model offline" : `${pct(m.stockoutProbability)}${m.hoursToStockout !== null ? `, empty in ${hours(m.hoursToStockout)}` : ""}`}</div>
          </div>
          <div>
            <div className="text-muted">Model view</div>
            <div className={`font-medium ${m.agrees === false ? "text-warn" : m.agrees ? "text-ok" : ""}`}>{m.agrees === null ? "n/a" : m.agrees ? "agrees: shortage likely" : "no shortage projected"}</div>
          </div>
        </div>
      )}
      {r.resolution && <p className="mt-2 text-xs">{r.resolution}</p>}
      {r.status === "OPEN" && canAct && (
        <div className="mt-3 space-y-2">
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-xs text-muted">
              Route
              <select aria-label="Route" value={routeId} onChange={(e) => setRouteId(e.target.value)} className="mt-1 block rounded border border-border bg-surface-2 px-2 py-1 text-sm text-text">
                {routes.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.id} ({x.transitTicks} ticks, max {x.maxShipment.toLocaleString()} L){x.status !== "AVAILABLE" ? `: ${x.status}` : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-muted">
              Litres
              <input aria-label="Litres" type="number" min={500} step={100} max={route?.maxShipment} value={quantity} onChange={(e) => setQuantity(Number(e.target.value))} className="mt-1 block w-28 rounded border border-border bg-surface-2 px-2 py-1 text-sm text-text" />
            </label>
            <button disabled={busy || !routeId} onClick={() => accept.mutate({ routeId, quantity })} className="inline-flex items-center gap-1 rounded bg-accent px-3 py-1.5 font-medium text-white disabled:opacity-50">
              <Check size={14} /> {accept.isPending ? "Dispatching…" : "Accept & dispatch"}
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="Reason for rejecting (required)" className="min-w-0 flex-1 rounded border border-border bg-surface-2 px-2 py-1 text-sm" />
            <button disabled={busy || reason.trim().length < 3} onClick={() => decline.mutate({ reason: reason.trim() })} className="inline-flex items-center gap-1 rounded border border-border px-3 py-1.5 hover:bg-surface-2 disabled:opacity-50">
              <X size={14} /> Reject
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function DepotConsole() {
  const { session } = useAuth();
  const { data: net, isLoading, error } = useNetwork();
  const isDepot = session?.role === "depot";
  const operator = session?.role === "operator";
  const { data: requests } = useRequests(isDepot || operator);
  const [picked, setPicked] = useState("depot-gazipur");
  if (isLoading) return <Loading />;
  if (error || !net) return <ErrorBox error={error} />;
  const depotId = isDepot ? (session!.depotId as string) : picked;
  const depot = net.depots.find((d) => d.id === depotId);
  if (!depot) return <ErrorBox error={new Error(`Unknown depot ${depotId}`)} />;
  const served = new Set(net.routes.filter((r) => r.source_depot_id === depot.id).map((r) => r.destination_station_id));
  const mine = (requests ?? []).filter((r) => served.has(r.stationId));
  const inbox = mine.filter((r) => r.status === "OPEN").sort((a, b) => ["emergency", "urgent", "routine"].indexOf(a.urgency) - ["emergency", "urgent", "routine"].indexOf(b.urgency));
  const handled = mine.filter((r) => r.status !== "OPEN").slice(0, 12);
  const outgoing = net.allocations.filter((a) => a.source_depot_id === depot.id && (a.status === "PENDING" || a.status === "IN_TRANSIT"));
  const committed = outgoing.filter((a) => a.status === "PENDING").reduce((x, a) => x + a.quantity, 0);
  const supply = net.supplyArrivals.filter((a) => a.depot_id === depot.id && a.status !== "ARRIVED");

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <Warehouse size={22} /> Depot Console
          </h1>
          <p className="text-sm text-muted">For depot managers: decide station fuel requests for the stations your depot serves. Routine resupply is planned automatically; the operator oversees exceptions.</p>
        </div>
        {!isDepot && (
          <label className="text-xs text-muted">
            Depot
            <select aria-label="Choose depot" value={picked} onChange={(e) => setPicked(e.target.value)} className="ml-2 rounded border border-border bg-surface-2 px-2 py-1 text-sm text-text">
              {net.depots.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title={depot.name} action={<Badge tone={statusTone(depot.status)}>{depot.status}</Badge>}>
          <div className="space-y-1.5">
            {FUELS.map((f) => (
              <FuelBar key={f} fuel={f} value={depot.inventory[f]} capacity={depot.capacity[f]} />
            ))}
          </div>
          <p className="mt-2 text-xs text-muted">
            Dispatch this tick: {liters(committed)} of {liters(depot.dispatch_capacity_per_tick * (depot.status === "CONSTRAINED" ? 0.5 : 1))} used
            {depot.status === "CONSTRAINED" && " (constrained: budget halved)"}
          </p>
        </Card>
        <Card title="Leaving the depot">
          {outgoing.length === 0 ? (
            <Empty>No shipments in flight</Empty>
          ) : (
            <ul className="space-y-1 text-sm tabular-nums">
              {outgoing.slice(0, 8).map((a) => (
                <li key={a.id} className="flex justify-between">
                  <span>
                    {liters(a.quantity)} {a.fuel_type} → {a.destination_station_id.replace("station-", "")}
                  </span>
                  <span className="text-xs text-muted">{a.status === "PENDING" ? "departing" : `arrives t${a.expected_arrival_tick}`}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Incoming supply">
          {supply.length === 0 ? (
            <Empty>No further supply scheduled for this depot</Empty>
          ) : (
            <ul className="space-y-1 text-sm tabular-nums">
              {supply.map((a) => (
                <li key={a.id} className="flex justify-between">
                  <span>
                    {liters(a.quantity)} {a.fuel_type}
                  </span>
                  <span className="text-xs text-muted">
                    t{a.planned_tick} {a.status === "DELAYED" && <Badge tone="warn">DELAYED</Badge>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card title={<span className="flex items-center gap-2">Request inbox <Badge tone={inbox.length ? "warn" : "ok"}>{inbox.length}</Badge></span>}>
        {!session ? (
          <div>
            <p className="mb-2 text-sm">Sign in as this depot&apos;s manager to decide requests.</p>
            <SignInPanel compact />
          </div>
        ) : !isDepot && !operator ? (
          <Empty>Only depot managers and the operator can decide requests.</Empty>
        ) : inbox.length === 0 ? (
          <Empty>No open requests from the stations you serve.</Empty>
        ) : (
          <div className="space-y-2">
            {operator && <p className="text-xs text-muted">You are viewing as the operator: decisions here override the depot manager.</p>}
            {inbox.map((r) => (
              <RequestDecision key={r.id} r={r} depotId={depot.id} canAct />
            ))}
          </div>
        )}
      </Card>

      {handled.length > 0 && (
        <Card title="Recently decided">
          <div className="space-y-2">
            {handled.map((r) => (
              <RequestDecision key={r.id} r={r} depotId={depot.id} canAct={false} />
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
