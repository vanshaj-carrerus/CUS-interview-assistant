import { API_PATHS } from "../paths";
import { apiFetch } from "../http";

/**
 * POST /api/cus-assistant/auth/logout
 * Header: `Authorization: Bearer <token>`
 */
export async function apiAuthLogout(token: string): Promise<void> {
  await apiFetch(API_PATHS.authLogout, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
}
