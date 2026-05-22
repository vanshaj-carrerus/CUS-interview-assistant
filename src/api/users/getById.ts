import { API_PATHS } from "../paths";
import type { AssistantUserRecord } from "../types";
import { apiFetch, parseApiError } from "../http";

/**
 * GET /api/cus-assistant/users/:id
 */
export async function apiUsersGetById(id: string): Promise<AssistantUserRecord> {
  const res = await apiFetch(API_PATHS.userById(id), { method: "GET" });
  if (!res.ok) throw new Error(await parseApiError(res));
  return (await res.json()) as AssistantUserRecord;
}
