import { API_PATHS } from "../paths";
import { HttpError, apiFetch, parseApiError } from "../http";

/**
 * POST /api/cus-assistant/interview/prompt
 * Body: `{ "prompt": string }`
 * Header: `Authorization: Bearer <token>`
 */
export async function apiInterviewPrompt<T>(
  token: string,
  prompt: string,
): Promise<{ data: T; model: string }> {
  const res = await apiFetch(API_PATHS.interviewPrompt, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ prompt }),
  });
  if (!res.ok) {
    throw new HttpError(await parseApiError(res), res.status);
  }
  return (await res.json()) as { data: T; model: string };
}
