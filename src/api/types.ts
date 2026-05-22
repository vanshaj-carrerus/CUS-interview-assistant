/** Shape returned by the desktop app auth routes (`register`, `login`, `me`). */
export type PublicUser = {
  id: string;
  email: string;
  name?: string;
  aiAllowed: boolean;
};

export type AuthSession = {
  token: string;
  user: PublicUser;
};

/**
 * Raw Mongo user document from CUS Tech user routes
 * (`getUser`, `by-email`, `GET /users/:id`, `PATCH ai-allowed`).
 */
export type AssistantUserRecord = {
  _id: string;
  email: string;
  name?: string;
  sessionId?: string | null;
  aiAllowed: boolean;
  createdAt?: string;
  updatedAt?: string;
};

export function recordToPublicUser(doc: AssistantUserRecord): PublicUser {
  return {
    id: String(doc._id),
    email: doc.email,
    name: doc.name,
    aiAllowed: Boolean(doc.aiAllowed),
  };
}
