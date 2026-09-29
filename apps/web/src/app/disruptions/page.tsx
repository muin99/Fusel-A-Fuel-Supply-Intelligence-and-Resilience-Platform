"use client";
import { useAuth } from "@/components/providers";
import { Badge, Card, Empty, ErrorBox, Loading, statusTone } from "@/components/ui";
import { liters } from "@/lib/format";
import { useAction, useAlerts, useNetwork } from "@/lib/hooks";

export default function DisruptionsPage() {
  const { data: net, isLoading, error } = useNetwork();
  const { data: alerts } = useAlerts(100);
  const { session } = useAuth();
  const ack = useAction<{ id: number }>((b) => `/alerts/${b.id}/ack`);
  if (isLoading) return <Loading />;
  if (error || !net) return <ErrorBox error={error} />;
  const tick = net.instance.tick;
  const upcoming = net.supplyArrivals.filter((a) => a.status !== "ARRIVED").slice(0, 12);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Simulator events">
        {net.events.length === 0 ? (
          <Empty>No events injected</Empty>
        ) : (
          <ul className="space-y-2 text-sm">
            {net.events.map((e) => (
              <li key={e.id} className="flex items-start justify-between gap-2">
                <div>
                  <div className="font-medium">{e.type.replace("_", " ")}</div>
                  <div className="text-xs text-muted">
                    ticks {e.start_tick}–{e.end_tick} · {JSON.stringify(e.parameters)}
                  </div>
                </div>
                <Badge tone={statusTone(e.status)}>{e.status}</Badge>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Routes">
        <ul className="space-y-1 text-sm">
          {net.routes.map((r) => (
            <li key={r.id} className="flex justify-between gap-2">
              <span>
                {r.source_depot_id.replace("depot-", "")} → {r.destination_station_id.replace("station-", "")}
                <span className="text-xs text-muted"> · {r.transit_ticks} ticks · max {r.max_shipment.toLocaleString()} L</span>
              </span>
              <Badge tone={statusTone(r.status)}>{r.status}</Badge>
            </li>
          ))}
        </ul>
      </Card>

      <Card title="Incoming supply">
        {upcoming.length === 0 ? (
          <Empty>No scheduled supply</Empty>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-muted">
              <tr>
                <th>Depot</th>
                <th>Fuel</th>
                <th className="text-right">Qty</th>
                <th className="text-right">ETA</th>
                <th className="text-right">Status</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {upcoming.map((a) => (
                <tr key={a.id}>
                  <td>{a.depot_id.replace("depot-", "")}</td>
                  <td>{a.fuel_type}</td>
                  <td className="text-right">{liters(a.quantity)}</td>
                  <td className="text-right">{a.planned_tick - tick > 0 ? `in ${a.planned_tick - tick} ticks` : "due"}</td>
                  <td className="text-right">
                    <Badge tone={statusTone(a.status)}>{a.status}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card title="Shipments in flight">
        {net.allocations.filter((a) => a.status === "PENDING" || a.status === "IN_TRANSIT").length === 0 ? (
          <Empty>No shipments in flight</Empty>
        ) : (
          <ul className="space-y-1 text-sm tabular-nums">
            {net.allocations
              .filter((a) => a.status === "PENDING" || a.status === "IN_TRANSIT")
              .map((a) => (
                <li key={a.id} className="flex justify-between">
                  <span>
                    #{a.id} {liters(a.quantity)} {a.fuel_type} → {a.destination_station_id.replace("station-", "")}
                  </span>
                  <span className="flex gap-2">
                    {a.expected_arrival_tick !== null && <span className="text-xs text-muted">arrives t{a.expected_arrival_tick}</span>}
                    <Badge tone={statusTone(a.status)}>{a.status}</Badge>
                  </span>
                </li>
              ))}
          </ul>
        )}
      </Card>

      <Card title="Alert log" className="lg:col-span-2">
        {!alerts?.length ? (
          <Empty>No alerts</Empty>
        ) : (
          <ul className="divide-y divide-border text-sm">
            {alerts.map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-3 py-1.5">
                <span className="flex min-w-0 items-center gap-2">
                  <Badge tone={statusTone(a.severity)}>{a.severity}</Badge>
                  <Badge>{a.kind}</Badge>
                  <span className={a.acknowledged ? "text-muted line-through" : ""}>{a.message}</span>
                </span>
                <span className="flex shrink-0 items-center gap-2 text-xs text-muted">
                  {a.tick !== null && `t${a.tick}`}
                  {!a.acknowledged && session?.role === "operator" && (
                    <button className="text-accent hover:underline" onClick={() => ack.mutate({ id: a.id })}>
                      ack
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
