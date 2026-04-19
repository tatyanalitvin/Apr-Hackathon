// REQ-017 / REQ-018 — typed client helpers for better-auth's
// `/request-password-reset` and `/reset-password` endpoints. Called by the
// /forgot-password and /reset-password pages. Both endpoints always return
// 200 on success; errors surface via non-2xx status codes that we map to
// friendly messages at the call site.
import { BACKEND_URL } from "./backend";

export type PasswordResetErrorCode =
  | "INVALID_TOKEN"
  | "PASSWORD_TOO_SHORT"
  | "PASSWORD_TOO_LONG"
  | "UNKNOWN";

export class PasswordResetError extends Error {
  readonly code: PasswordResetErrorCode;
  readonly status: number;
  constructor(code: PasswordResetErrorCode, status: number, message: string) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// REQ-017 — POST /api/auth/request-password-reset. better-auth returns 200
// regardless of whether the email exists (anti-enumeration, verified in
// node_modules/better-auth/.../api/routes/password.mjs:51-62). Callers MUST
// show the same neutral message either way.
export async function requestPasswordReset(email: string): Promise<void> {
  const res = await fetch(`${BACKEND_URL}/api/auth/request-password-reset`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
  if (!res.ok) {
    throw new PasswordResetError("UNKNOWN", res.status, "reset request failed");
  }
}

// REQ-018 — POST /api/auth/reset-password. Consumes the token from the
// email link (stub: pulled from backend logs during the hackathon demo).
// Invalid/expired tokens come back as 400 with `code: "INVALID_TOKEN"`;
// short/long passwords come back as 400 with their own codes.
export async function confirmPasswordReset(
  token: string,
  newPassword: string,
): Promise<void> {
  const res = await fetch(`${BACKEND_URL}/api/auth/reset-password`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, newPassword }),
  });
  if (res.ok) return;

  let code: PasswordResetErrorCode = "UNKNOWN";
  let message = `Password reset failed (${res.status})`;
  try {
    const body = (await res.json()) as { code?: string; message?: string };
    if (body.code === "INVALID_TOKEN") code = "INVALID_TOKEN";
    else if (body.code === "PASSWORD_TOO_SHORT") code = "PASSWORD_TOO_SHORT";
    else if (body.code === "PASSWORD_TOO_LONG") code = "PASSWORD_TOO_LONG";
    if (body.message) message = body.message;
  } catch {
    // non-JSON error body — keep the default message
  }
  throw new PasswordResetError(code, res.status, message);
}
