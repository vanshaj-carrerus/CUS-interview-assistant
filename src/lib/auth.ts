import {
  apiGetMe,
  apiInterviewPrompt,
  apiLogin,
  apiLogout,
  apiRegister,
  HttpError,
  type AuthSession,
  type PublicUser,
} from "./apis";

export type { AuthSession, PublicUser };

const TOKEN_KEY = "cus_auth_token";

export function getStoredToken(): string | null {
  try {
    const token = localStorage.getItem(TOKEN_KEY);
    return token?.trim() ? token : null;
  } catch {
    return null;
  }
}

export function storeToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearStoredToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export async function login(
  email: string,
  password: string,
): Promise<AuthSession> {
  const data = await apiLogin({ email, password });
  storeToken(data.token);
  return data;
}

export async function register(
  email: string,
  password: string,
  name?: string,
): Promise<AuthSession> {
  const data = await apiRegister({ email, password, name });
  storeToken(data.token);
  return data;
}

export async function fetchCurrentUser(
  token: string,
): Promise<PublicUser | null> {
  try {
    return await apiGetMe(token);
  } catch (e) {
    if (e instanceof HttpError && e.status === 401) {
      clearStoredToken();
    }
    return null;
  }
}

/** Poll after login while waiting for an admin to set `aiAllowed` in MongoDB. */
export async function refreshCurrentUser(): Promise<PublicUser | null> {
  const token = getStoredToken();
  if (!token) return null;
  return fetchCurrentUser(token);
}

export async function restoreSession(): Promise<AuthSession | null> {
  const token = getStoredToken();
  if (!token) return null;
  const user = await fetchCurrentUser(token);
  if (!user) {
    return null;
  }
  return { token, user };
}

/**
 * Tell the server to end this session and clear AI permission until you enable it again.
 */
export async function logoutRemote(): Promise<void> {
  const token = getStoredToken();
  if (token) {
    try {
      await apiLogout(token);
    } catch {
      /* still clear locally */
    }
  }
  clearStoredToken();
}

export async function runAuthenticatedInterviewPrompt<T>(
  prompt: string,
): Promise<{ data: T; model: string }> {
  const token = getStoredToken();
  if (!token) {
    throw new Error("Please sign in to use AI interview coaching.");
  }

  try {
    return await apiInterviewPrompt<T>(token, prompt);
  } catch (e) {
    if (e instanceof HttpError && e.status === 401) {
      clearStoredToken();
    }
    throw e;
  }
}
