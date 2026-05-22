import { API_PATHS } from "../paths";
import type { AuthSession } from "../types";
import { apiFetch, parseApiError } from "../http";

export type LoginBody = { email: string; password: string };

/**
 * POST /api/cus-assistant/auth/login
 * Body: `{ email, password }`
 */
export async function apiAuthLogin(body: LoginBody): Promise<AuthSession> {
  const res = await apiFetch(API_PATHS.authLogin, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await parseApiError(res));
  return (await res.json()) as AuthSession;
}
