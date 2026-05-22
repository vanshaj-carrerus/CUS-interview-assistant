import { API_PATHS } from "../paths";
import type { PublicUser } from "../types";
import { HttpError, apiFetch, parseApiError } from "../http";

/**
 * GET /api/cus-assistant/auth/me
 * Header: `Authorization: Bearer <token>`
 */
export async function apiAuthMe(token: string): Promise<PublicUser | null> {
  const res = await apiFetch(API_PATHS.authMe, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) {
    throw new HttpError(await parseApiError(res), 401);
  }
  if (!res.ok) return null;
  const data = (await res.json()) as { user: PublicUser };
  return data.user;
}
