import { API_PATHS } from "../paths";
import type { AssistantUserRecord } from "../types";
import { apiFetch, parseApiError } from "../http";

export type SetAiAllowedBody = { aiAllowed: boolean };

/**
 * PATCH /api/cus-assistant/users/:id/ai-allowed
 * Body: `{ "aiAllowed": boolean }`
 * Header: `x-admin-secret` (must match server `INTERVIEW_ADMIN_SECRET`)
 */
export async function apiUsersSetAiAllowed(
  id: string,
  body: SetAiAllowedBody,
  adminSecret: string,
): Promise<AssistantUserRecord> {
  const res = await apiFetch(API_PATHS.userAiAllowed(id), {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "x-admin-secret": adminSecret.trim(),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await parseApiError(res));
  return (await res.json()) as AssistantUserRecord;
}
