"use client";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { API_URL, SESSION_EVENT, getSession, setSession, type Session } from "@/lib/api";

/** Backend SSE is a hint: on any event, invalidate queries and let React Query re-GET. */
function LiveUpdates() {
  const qc = useQueryClient();
  useEffect(() => {
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout>;
    const connect = () => {
      es = new EventSource(`${API_URL}/stream`);
      es.addEventListener("network", () => {
        for (const key of ["network", "risk", "decision-status", "requests", "audit-feed"]) qc.invalidateQueries({ queryKey: [key] });
      });
      es.addEventListener("alert", () => qc.invalidateQueries({ queryKey: ["alerts"] }));
      es.addEventListener("recommendations", () => qc.invalidateQueries({ queryKey: ["recommendations"] }));
      es.onerror = () => {
        es?.close();
        retry = setTimeout(connect, 3000);
      };
    };
    connect();
    return () => {
      es?.close();
      clearTimeout(retry);
    };
  }, [qc]);
  return null;
}

let cached: { raw: string | null; value: Session | null } = { raw: null, value: null };
function readSession(): Session | null {
  const value = getSession();
  const raw = value ? JSON.stringify(value) : null;
  if (raw !== cached.raw) cached = { raw, value };
  return cached.value; // stable reference while unchanged
}
function subscribeSession(cb: () => void) {
  window.addEventListener("storage", cb);
  window.addEventListener(SESSION_EVENT, cb);
  return () => {
    window.removeEventListener("storage", cb);
    window.removeEventListener(SESSION_EVENT, cb);
  };
}

const AuthCtx = createContext<{ session: Session | null; setSession: (s: Session | null) => void }>({
  session: null,
  setSession: () => {},
});
export const useAuth = () => useContext(AuthCtx);

// ---------------------------------------------------------------- toasts
type Toast = { id: number; tone: "ok" | "error" | "info"; text: string };
const ToastCtx = createContext<(tone: Toast["tone"], text: string) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

function Toasts({ items, dismiss }: { items: Toast[]; dismiss: (id: number) => void }) {
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2" aria-live="polite">
      {items.map((t) => (
        <div
          key={t.id}
          role={t.tone === "error" ? "alert" : "status"}
          className={`pointer-events-auto rounded-lg border px-3 py-2 text-sm shadow-lg ${
            t.tone === "ok" ? "border-ok/40 bg-surface text-ok" : t.tone === "error" ? "border-crit/40 bg-surface text-crit" : "border-accent/40 bg-surface text-text"
          }`}
        >
          <div className="flex items-start justify-between gap-3">
            <span>{t.text}</span>
            <button onClick={() => dismiss(t.id)} className="text-muted hover:text-text" aria-label="Dismiss">
              ×
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          // polling backstop in case the push stream is down
          queries: { refetchInterval: 8_000, retry: 1, staleTime: 1000, refetchOnWindowFocus: false },
        },
      }),
  );
  const session = useSyncExternalStore(subscribeSession, readSession, () => null);
  const update = (s: Session | null) => {
    setSession(s);
    window.dispatchEvent(new Event(SESSION_EVENT));
    void client.invalidateQueries();
  };
  const [toasts, setToasts] = useState<Toast[]>([]);
  const dismiss = useCallback((id: number) => setToasts((xs) => xs.filter((x) => x.id !== id)), []);
  const push = useCallback(
    (tone: Toast["tone"], text: string) => {
      const id = Date.now() + Math.random();
      setToasts((xs) => [...xs.slice(-3), { id, tone, text }]);
      setTimeout(() => dismiss(id), tone === "error" ? 9000 : 5000);
    },
    [dismiss],
  );
  return (
    <QueryClientProvider client={client}>
      <AuthCtx.Provider value={{ session, setSession: update }}>
        <ToastCtx.Provider value={push}>
          <LiveUpdates />
          {children}
          <Toasts items={toasts} dismiss={dismiss} />
        </ToastCtx.Provider>
      </AuthCtx.Provider>
    </QueryClientProvider>
  );
}
