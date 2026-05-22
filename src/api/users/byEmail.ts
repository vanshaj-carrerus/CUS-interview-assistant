import { API_PATHS } from "../paths";
import type { AssistantUserRecord } from "../types";
import { apiFetch, parseApiError } from "../http";

export type UsersByEmailBody = { email: string };

/**
 * POST /api/cus-assistant/users/by-email
 * Body: `{ "email": string }`
 */
export async function apiUsersByEmail(
  body: UsersByEmailBody,
): Promise<AssistantUserRecord> {
  const res = await apiFetch(API_PATHS.usersByEmail, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: body.email.trim() }),
  });
  if (!res.ok) throw new Error(await parseApiError(res));
  return (await res.json()) as AssistantUserRecord;
}
