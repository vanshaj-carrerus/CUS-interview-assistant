import { API_PATHS } from "../paths";
import type { AssistantUserRecord } from "../types";
import { apiFetch, parseApiError } from "../http";

export type GetUserBody = { user_id: string };

/**
 * POST /api/cus-assistant/auth/getUser
 * Body: `{ "user_id": string }` — MongoDB ObjectId.
 */
export async function apiAuthGetUser(
  body: GetUserBody,
): Promise<AssistantUserRecord> {
  const res = await apiFetch(API_PATHS.authGetUser, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: body.user_id.trim() }),
  });
  if (!res.ok) throw new Error(await parseApiError(res));
  return (await res.json()) as AssistantUserRecord;
}
