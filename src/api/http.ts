import { DEFAULT_API_URL } from "./defaults";
import { API_PATHS } from "./paths";

export { DEFAULT_API_URL };

export class HttpError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/** Production / hosted API: secrets stay on CUS Tech; client only holds the user's JWT. */
export function usesRemoteApi(): boolean {
  return true;
}

/** API base URL from `VITE_API_URL` or {@link DEFAULT_API_URL}. */
export function getApiBaseUrl(): string {
  const fromEnv = import.meta.env.VITE_API_URL;
  if (typeof fromEnv === "string" && fromEnv.trim()) {
    return fromEnv.trim().replace(/\/$/, "");
  }
  return DEFAULT_API_URL;
}

export async function apiUrl(path: string): Promise<string> {
  const base = getApiBaseUrl();
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${base}${normalized}`;
}

type ApiErrorBody = { error?: string; message?: string };

export async function parseApiError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as ApiErrorBody;
    if (body.error?.trim()) return body.error.trim();
    if (body.message?.trim()) return body.message.trim();
  } catch {
    // ignore
  }
  if (res.status === 401) return "Please sign in to continue.";
  if (res.status === 403) {
    return "Your account does not have AI interview access yet. Contact an administrator.";
  }
  if (res.status === 409) {
    return "This account is already signed in on another device. Sign out there first, then try again.";
  }
  return `Request failed (${res.status}).`;
}

export async function apiFetch(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const url = await apiUrl(path);
  return fetch(url, init);
}

/** GET /api/cus-assistant/health */
export async function apiHealth(): Promise<{ ok: boolean }> {
  const res = await apiFetch(API_PATHS.health, { method: "GET" });
  if (!res.ok) throw new Error(await parseApiError(res));
  return (await res.json()) as { ok: boolean };
}
