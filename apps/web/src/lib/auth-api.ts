// REQ-017 / REQ-018 — typed client helpers for better-auth's
// `/request-password-reset` and `/reset-password` endpoints. Called by the
// /forgot-password and /reset-password pages. Both endpoints always return
// 200 on success; errors surface via non-2xx status codes that we map to
// friendly messages at the call site.
import type { FieldValues, UseFormReturn, Path } from "react-hook-form";
import { BACKEND_URL } from "./backend";

// REQ-006 — humanise the backend's machine-code password prefixes for UI
// display. The prefixes are the contract; never rewrite them on the wire.
// Mirrors the inline helper in apps/web/src/app/register/page.tsx so every
// password-bearing form surfaces the same copy.
export function prettyPasswordMessage(raw: string): string {
  if (raw.startsWith("password_common"))
    return "This password is too common — please pick a stronger one.";
  if (raw.startsWith("password_too_short"))
    return "Password is too short (minimum 12 characters).";
  if (raw.startsWith("password_too_long"))
    return "Password is too long (maximum 128 characters).";
  if (raw.startsWith("password_mismatch"))
    return "Passwords do not match.";
  return raw;
}

type ValidationEnvelope = {
  error?: string;
  issues?: { path?: unknown; message?: string; code?: string }[];
  code?: string;
  message?: string;
} | null;

// REQ-006 / REQ-007 / REQ-018 — walk the zodBodyGuard envelope
// (`{error:"validation", issues:[{path,message,code}]}`) and attach each
// issue to the matching react-hook-form field via `setError`. `fieldMap`
// routes a server-side `path[0]` (e.g. `"password"`) to the form's field
// name (e.g. `"newPassword"` on the change-password form); callers without
// a remap can pass an identity object. Returns true when at least one
// field-level error was attached so the caller can skip a redundant toast.
export function applyAuthIssues<TForm extends FieldValues>(
  body: ValidationEnvelope,
  form: UseFormReturn<TForm>,
  fieldMap: Record<string, Path<TForm>>,
): boolean {
  if (!body || !Array.isArray(body.issues) || body.issues.length === 0) {
    return false;
  }
  let attached = false;
  for (const issue of body.issues) {
    const key = Array.isArray(issue.path) ? String(issue.path[0] ?? "") : "";
    const target = fieldMap[key];
    if (!target) continue;
    const raw = issue.message ?? "Invalid input";
    // Humanise password_* codes when the issue lands on a password-ish
    // field. The server message prefix is the contract; we translate at the
    // UI edge only.
    const isPwField =
      String(target).toLowerCase().includes("password") || key === "password";
    const message = isPwField ? prettyPasswordMessage(raw) : raw;
    form.setError(target, { message });
    attached = true;
  }
  return attached;
}

export type PasswordResetErrorCode =
  | "INVALID_TOKEN"
  | "PASSWORD_TOO_SHORT"
  | "PASSWORD_TOO_LONG"
  | "VALIDATION"
  | "UNKNOWN";

export class PasswordResetError extends Error {
  readonly code: PasswordResetErrorCode;
  readonly status: number;
  // Full parsed envelope (when JSON) so callers can hand it to
  // `applyAuthIssues` for field-level routing. Null on non-JSON bodies.
  readonly envelope: ValidationEnvelope;
  constructor(
    code: PasswordResetErrorCode,
    status: number,
    message: string,
    envelope: ValidationEnvelope = null,
  ) {
    super(message);
    this.code = code;
    this.status = status;
    this.envelope = envelope;
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
// short/long passwords come back as 400 with their own codes, plus zod-
// envelope `{error:"validation", issues:[...]}` from passwordPolicyGuard.
export async function confirmPasswordReset(
  token: string,
  newPassword: string,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${BACKEND_URL}/api/auth/reset-password`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, newPassword }),
    });
  } catch {
    throw new PasswordResetError("UNKNOWN", 0, "Network error — try again.");
  }
  if (res.ok) return;

  let code: PasswordResetErrorCode = "UNKNOWN";
  let message = `Password reset failed (${res.status})`;
  let envelope: ValidationEnvelope = null;
  try {
    const body = (await res.json()) as {
      error?: string;
      code?: string;
      message?: string;
      issues?: { path?: unknown; message?: string; code?: string }[];
    };
    envelope = body;
    if (body.error === "validation" && Array.isArray(body.issues)) {
      code = "VALIDATION";
    } else if (body.code === "INVALID_TOKEN") code = "INVALID_TOKEN";
    else if (body.code === "PASSWORD_TOO_SHORT") code = "PASSWORD_TOO_SHORT";
    else if (body.code === "PASSWORD_TOO_LONG") code = "PASSWORD_TOO_LONG";
    if (body.message) message = body.message;
  } catch {
    // non-JSON error body — keep the default message
  }
  throw new PasswordResetError(code, res.status, message, envelope);
}
