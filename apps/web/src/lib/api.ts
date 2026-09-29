export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api";

const TOKEN_KEY = "fuelops.auth";

export interface Session {
  token: string;
  role: "operator" | "viewer" | "station" | "depot";
  username: string;
  stationId?: string | null;
  depotId?: string | null;
}

export const SESSION_EVENT = "fuelops:session";

export function getSession(): Session | null {
  try {
    const raw = localStorage.getItem(TOKEN_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

export function setSession(s: Session | null) {
  try {
    if (s) localStorage.setItem(TOKEN_KEY, JSON.stringify(s));
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable — session lives only in memory */
  }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const session = typeof window !== "undefined" ? getSession() : null;
  if (session) headers.set("authorization", `Bearer ${session.token}`);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(init.json);
  }
  const res = await fetch(`${API_URL}${path}`, { ...init, headers, body, cache: "no-store" });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    if (res.status === 401 && session && typeof window !== "undefined") {
      // expired or invalid token: sign out so the UI stops showing controls that will fail
      setSession(null);
      window.dispatchEvent(new Event(SESSION_EVENT));
    }
    const message = Array.isArray(data?.message) ? data.message.join("; ") : (data?.message ?? res.statusText);
    throw new ApiError(res.status, data?.error ?? `HTTP_${res.status}`, res.status === 401 ? "Session expired or not signed in. Please sign in again." : message);
  }
  return data as T;
}
