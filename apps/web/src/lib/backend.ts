export const BACKEND_URL =
  process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000";

export const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME ?? "AI Herders Jam";

// REQ-146 — client-side CSRF double-submit helper.
//
// Reads the `csrf_token` cookie (stamped by the backend on successful
// sign-up / sign-in — see apps/backend/src/app.ts proxyToBetterAuth) and
// emits an `X-CSRF-Token: <token>` header for echoing on every mutating
// fetch. The cookie is intentionally NOT HttpOnly so JS can read it.
//
// Called by every fetch wrapper in chat-api.ts / dms-api.ts / friendship-
// api.ts / sessions-api.ts / account-api.ts / admin-api.ts / auth-api.ts
// on POST|PUT|PATCH|DELETE requests. Returns an empty object when no
// csrf_token cookie is present (pre-login pages, SSR — those requests
// are either GET-only or hit /api/auth/* which is CSRF-exempt server-
// side). Spreading `{}` over a `headers` literal is a no-op so callers
// don't need a conditional.

export function readCsrfToken(): string | undefined {
  if (typeof document === "undefined") return undefined;
  const match = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]+)/);
  return match?.[1];
}

export function csrfHeaders(): Record<string, string> {
  const token = readCsrfToken();
  return token ? { "X-CSRF-Token": token } : {};
}
