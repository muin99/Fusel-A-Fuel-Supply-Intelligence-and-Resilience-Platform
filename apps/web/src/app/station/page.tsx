"use client";
import { Fuel as FuelIcon, Truck } from "lucide-react";
import { useState } from "react";
import { useAuth } from "@/components/providers";
import { SignInPanel } from "@/components/shell";
import { Badge, Card, Empty, ErrorBox, FuelBar, Loading, statusTone } from "@/components/ui";
import { hours, liters, pct } from "@/lib/format";
import { useAction, useNetwork, useRequests, useRisk } from "@/lib/hooks";
import { FUELS, type Fuel, type FuelRequest } from "@/lib/types";

const STATUS_TONE: Record<FuelRequest["status"], "warn" | "info" | "ok" | "crit" | "muted"> = { OPEN: "warn", PLANNED: "info", FULFILLED: "ok", DECLINED: "crit", CANCELLED: "muted" };

function RequestForm({ stationId, onBehalf }: { stationId: string; onBehalf: boolean }) {
  const [fuel, setFuel] = useState<Fuel>("DIESEL");
  const [quantity, setQuantity] = useState(4000);
  const [urgency, setUrgency] = useState<FuelRequest["urgency"]>("urgent");
  const [note, setNote] = useState("");
  const create = useAction<Record<string, unknown>, FuelRequest>("/requests", (r) => `Request #${r.id} submitted: the decision engine is re-planning now`);
  return (
    <form
      className="grid gap-2 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate({ fuel, quantity, urgency, note: note || undefined, ...(onBehalf ? { stationId } : {}) }, { onSuccess: () => setNote("") });
      }}
    >
      <label className="text-xs text-muted">
        Fuel
        <select aria-label="Fuel" value={fuel} onChange={(e) => setFuel(e.target.value as Fuel)} className="mt-1 w-full rounded border border-border bg-surface-2 px-2 py-1.5 text-sm text-text">
          {FUELS.map((f) => (
            <option key={f}>{f}</option>
          ))}
        </select>
      </label>
      <label className="text-xs text-muted">
        Quantity (L)
        <input aria-label="Quantity (L)" type="number" min={500} max={20000} step={500} value={quantity} onChange={(e) => setQuantity(Number(e.target.value))} className="mt-1 w-full rounded border border-border bg-surface-2 px-2 py-1.5 text-sm text-text" />
      </label>
      <label className="text-xs text-muted">
        Urgency
        <select aria-label="Urgency" value={urgency} onChange={(e) => setUrgency(e.target.value as FuelRequest["urgency"])} className="mt-1 w-full rounded border border-border bg-surface-2 px-2 py-1.5 text-sm text-text">
          <option value="routine">Routine: next regular delivery</option>
          <option value="urgent">Urgent: queue is building</option>
          <option value="emergency">Emergency: about to run dry</option>
        </select>
      </label>
      <label className="text-xs text-muted">
        Note for the operator (optional)
        <input value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder="e.g. bus depot contract starts tonight" className="mt-1 w-full rounded border border-border bg-surface-2 px-2 py-1.5 text-sm text-text" />
      </label>
      <div className="sm:col-span-2">
        <button disabled={create.isPending} className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">
          {create.isPending ? "Submitting…" : onBehalf ? "Submit request on behalf of station" : "Submit fuel request"}
        </button>
        <p className="mt-1 text-xs text-muted">
          Your request goes to the manager of the depot that serves your station, who accepts (dispatches) or rejects it. It also raises your station&apos;s priority in the automatic planner.
        </p>
      </div>
    </form>
  );
}

function RequestRow({ r, canCancel }: { r: FuelRequest; canCancel: boolean }) {
  const cancel = useAction<void>(`/requests/${r.id}/cancel`, `Request #${r.id} cancelled`);
  return (
    <li className="flex flex-wrap items-start justify-between gap-2 py-2 text-sm">
      <div>
        <div className="font-medium">
          #{r.id} · {liters(r.quantity)} {r.fuelType} <span className="text-xs text-muted">· {r.stationId.replace("station-", "")} · t{r.tick}</span>
        </div>
        {r.note && <div className="text-xs text-muted">“{r.note}”</div>}
        {r.resolution && <div className="text-xs">{r.resolution}</div>}
      </div>
      <div className="flex items-center gap-1.5">
        <Badge tone={r.urgency === "emergency" ? "crit" : r.urgency === "urgent" ? "warn" : "muted"}>{r.urgency}</Badge>
        <Badge tone={STATUS_TONE[r.status]}>{r.status}</Badge>
        {canCancel && r.status === "OPEN" && (
          <button disabled={cancel.isPending} onClick={() => cancel.mutate()} className="rounded border border-border px-2 py-0.5 text-xs hover:bg-surface-2">
            Cancel
          </button>
        )}
      </div>
    </li>
  );
}

export default function StationPortal() {
  const { session } = useAuth();
  const { data: net, isLoading, error } = useNetwork();
  const { data: risk } = useRisk();
  const { data: requests } = useRequests(!!session && session.role !== "viewer");
  const [picked, setPicked] = useState("station-mirpur");
  if (isLoading) return <Loading />;
  if (error || !net) return <ErrorBox error={error} />;

  const isStation = session?.role === "station";
  const operator = session?.role === "operator";
  const stationId = isStation ? (session!.stationId as string) : picked;
  const station = net.stations.find((s) => s.id === stationId);
  if (!station) return <ErrorBox error={new Error(`Unknown station ${stationId}`)} />;
  const myRisk = (risk ?? []).filter((r) => r.stationId === station.id);
  const incoming = net.allocations.filter((a) => a.destination_station_id === station.id && (a.status === "PENDING" || a.status === "IN_TRANSIT"));
  const mine = (requests ?? []).filter((r) => (operator ? true : r.stationId === station.id));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <FuelIcon size={22} /> Station Portal
          </h1>
          <p className="text-sm text-muted">For station managers: see your tanks, the model&apos;s stockout forecast, deliveries on the way, and request fuel.</p>
        </div>
        {!isStation && (
          <label className="text-xs text-muted">
            Station
            <select aria-label="Choose station" value={picked} onChange={(e) => setPicked(e.target.value)} className="ml-2 rounded border border-border bg-surface-2 px-2 py-1 text-sm text-text">
              {net.stations.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title={station.name} action={<Badge tone={statusTone(station.status)}>{station.status}</Badge>}>
          <div className="space-y-1.5">
            {FUELS.map((f) => (
              <FuelBar key={f} fuel={f} value={station.inventory[f]} capacity={station.capacity[f]} />
            ))}
          </div>
          <p className="mt-2 text-xs text-muted">
            {station.region_id.replace("region-", "")} · {station.demand_profile} · demand ×{station.demand_multiplier.toFixed(2)}
          </p>
        </Card>
        <Card title="Forecast for my tanks (next 6 h)">
          {myRisk.length === 0 ? (
            <Empty>No forecast yet</Empty>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {FUELS.map((f) => {
                const r = myRisk.find((x) => x.fuel === f);
                if (!r) return null;
                return (
                  <li key={f} className="flex items-center justify-between">
                    <span>{f}</span>
                    <span className="flex items-center gap-2 tabular-nums">
                      <span className="text-xs text-muted">{r.assessment.hoursToStockout !== null ? `empty in ${hours(r.assessment.hoursToStockout)}` : "no stockout projected"}</span>
                      <Badge tone={r.assessment.probability >= 0.7 ? "crit" : r.assessment.probability >= 0.3 ? "warn" : "ok"}>{pct(r.assessment.probability)}</Badge>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
        <Card title={<span className="flex items-center gap-1.5"><Truck size={15} /> Deliveries on the way</span>}>
          {incoming.length === 0 ? (
            <Empty>No shipments in flight</Empty>
          ) : (
            <ul className="space-y-1.5 text-sm tabular-nums">
              {incoming.map((a) => (
                <li key={a.id} className="flex justify-between">
                  <span>
                    {liters(a.quantity)} {a.fuel_type}
                  </span>
                  <span className="text-xs text-muted">
                    {a.status === "PENDING" ? "departing next tick" : `arrives t${a.expected_arrival_tick} (now t${net.instance.tick})`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Request fuel">
          {isStation || operator ? (
            <RequestForm stationId={station.id} onBehalf={operator} />
          ) : (
            <div>
              <p className="mb-2 text-sm">Sign in as the station manager to request fuel.</p>
              <SignInPanel compact />
            </div>
          )}
        </Card>
        <Card title={operator ? "All station requests (depot managers decide; operator can override in the Depot Console)" : "My requests"}>
          {!session || session.role === "viewer" ? (
            <Empty>Sign in to see requests.</Empty>
          ) : mine.length === 0 ? (
            <Empty>No requests yet.</Empty>
          ) : (
            <ul className="divide-y divide-border">
              {mine.map((r) => (
                <RequestRow key={r.id} r={r} canCancel={isStation || operator} />
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
