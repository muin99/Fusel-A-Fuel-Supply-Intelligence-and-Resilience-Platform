"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/components/providers";
import { api } from "./api";
import type { Alert, AuditEntry, DecisionStatus, DrillStatus, FuelRequest, HealthStatus, NetworkSnapshot, Recommendation, RiskRow } from "./types";

export const useNetwork = () => useQuery({ queryKey: ["network"], queryFn: () => api<NetworkSnapshot>("/network") });
export const useRisk = () => useQuery({ queryKey: ["risk"], queryFn: () => api<(RiskRow & { mode?: "model" | "fallback" })[]>("/forecast/risk") });
export const useAlerts = (limit = 50) => useQuery({ queryKey: ["alerts", limit], queryFn: () => api<Alert[]>(`/alerts?limit=${limit}`) });
export const useHealth = () => useQuery({ queryKey: ["health"], queryFn: () => api<HealthStatus>("/health"), refetchInterval: 5000 });
export const useAudit = () => useQuery({ queryKey: ["audit"], queryFn: () => api<AuditEntry[]>("/audit?limit=200") });
export const useDecisionStatus = () => useQuery({ queryKey: ["decision-status"], queryFn: () => api<DecisionStatus>("/decisions/status"), refetchInterval: 5000 });
export const useDrillStatus = (enabled: boolean) =>
  useQuery({ queryKey: ["drill-status"], queryFn: () => api<DrillStatus>("/chaos/status"), refetchInterval: 5000, enabled });
export const useRequests = (enabled: boolean) => useQuery({ queryKey: ["requests"], queryFn: () => api<FuelRequest[]>("/requests?limit=100"), enabled });
export const useRecommendations = (status?: string) =>
  useQuery({
    queryKey: ["recommendations", status ?? "all"],
    queryFn: () => api<Recommendation[]>(`/recommendations?limit=100${status ? `&status=${status}` : ""}`),
  });

/**
 * POST helper: shows a toast with the outcome (buttons never fail silently) and
 * refreshes every query afterwards. `success` may be a string or built from the response.
 */
export function useAction<TBody = unknown, TRes = unknown>(path: string | ((b: TBody) => string), success?: string | ((r: TRes) => string)) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (body: TBody) => api<TRes>(typeof path === "function" ? path(body) : path, { method: "POST", json: body ?? {} }),
    onSuccess: (r) => {
      if (success) toast("ok", typeof success === "function" ? success(r) : success);
    },
    onError: (e) => toast("error", (e as Error).message),
    onSettled: () => qc.invalidateQueries(),
  });
}
