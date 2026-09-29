"use client";
import { Card, Empty, ErrorBox, Loading } from "@/components/ui";
import { useAudit } from "@/lib/hooks";

export default function AuditPage() {
  const { data, isLoading, error } = useAudit();
  if (isLoading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  return (
    <Card title="Decision & action history">
      {!data?.length ? (
        <Empty>No actions recorded yet</Empty>
      ) : (
        <div className="-mx-4 overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="text-xs text-muted">
              <tr className="border-b border-border">
                <th className="px-4 py-2">Time</th>
                <th>Tick</th>
                <th>Actor</th>
                <th>Action</th>
                <th>Entity</th>
                <th className="px-4">Details</th>
              </tr>
            </thead>
            <tbody>
              {data.map((e) => (
                <tr key={e.id} className="border-b border-border/50 align-top">
                  <td className="px-4 py-1.5 whitespace-nowrap tabular-nums text-muted">{new Date(e.at).toLocaleTimeString()}</td>
                  <td className="tabular-nums">{e.tick ?? "—"}</td>
                  <td>{e.actor}</td>
                  <td className="font-medium">{e.action}</td>
                  <td className="font-mono text-xs">{e.entityId?.slice(0, 12) ?? "—"}</td>
                  <td className="px-4 font-mono text-xs text-muted">{JSON.stringify(e.details)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
