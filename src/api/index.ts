export { API_PATHS, CUS_ASSISTANT_PREFIX } from "./paths";
export type {
  AssistantUserRecord,
  AuthSession,
  PublicUser,
} from "./types";
export { recordToPublicUser } from "./types";
export {
  HttpError,
  apiFetch,
  apiHealth,
  apiUrl,
  getApiBaseUrl,
  usesRemoteApi,
  parseApiError,
} from "./http";

export * from "./auth";
export * from "./users";
export * from "./interview";

/** @deprecated Use `apiAuthRegister` */
export { apiAuthRegister as apiRegister } from "./auth/register";
/** @deprecated Use `apiAuthLogin` */
export { apiAuthLogin as apiLogin } from "./auth/login";
/** @deprecated Use `apiAuthMe` */
export { apiAuthMe as apiGetMe } from "./auth/me";
/** @deprecated Use `apiAuthLogout` */
export { apiAuthLogout as apiLogout } from "./auth/logout";
