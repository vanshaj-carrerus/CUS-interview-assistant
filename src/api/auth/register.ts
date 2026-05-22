import { API_PATHS } from "../paths";
import type { AuthSession } from "../types";
import { apiFetch, parseApiError } from "../http";

export type RegisterBody = {
  email: string;
  password: string;
  name?: string;
};

/**
 * POST /api/cus-assistant/auth/register
 * Body: `{ email, password, name? }`
 */
export async function apiAuthRegister(body: RegisterBody): Promise<AuthSession> {
  const res = await apiFetch(API_PATHS.authRegister, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await parseApiError(res));
  return (await res.json()) as AuthSession;
}
