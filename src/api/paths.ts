/** Base path for CUS Tech interview assistant API (`https://www.custech.co`). */
export const CUS_ASSISTANT_PREFIX = "/api/cus-assistant";

export const API_PATHS = {
  health: `${CUS_ASSISTANT_PREFIX}/health`,

  authGetUser: `${CUS_ASSISTANT_PREFIX}/auth/getUser`,
  authRegister: `${CUS_ASSISTANT_PREFIX}/auth/register`,
  authLogin: `${CUS_ASSISTANT_PREFIX}/auth/login`,
  authMe: `${CUS_ASSISTANT_PREFIX}/auth/me`,
  authLogout: `${CUS_ASSISTANT_PREFIX}/auth/logout`,

  usersByEmail: `${CUS_ASSISTANT_PREFIX}/users/by-email`,
  userById: (id: string) =>
    `${CUS_ASSISTANT_PREFIX}/users/${encodeURIComponent(id)}`,
  userAiAllowed: (id: string) =>
    `${CUS_ASSISTANT_PREFIX}/users/${encodeURIComponent(id)}/ai-allowed`,

  interviewPrompt: `${CUS_ASSISTANT_PREFIX}/interview/prompt`,
} as const;
