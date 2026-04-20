// Thin client helpers for the GDPR export + account-delete endpoints on
// the Fastify backend. Export triggers a browser download (Blob → anchor
// click); delete posts a password and signals success/failure for the
// calling component to route back to /register.
import { BACKEND_URL, csrfHeaders } from "./backend";

export async function downloadAccountExport(): Promise<void> {
  const res = await fetch(`${BACKEND_URL}/api/v1/users/me/export`, {
    method: "POST",
    credentials: "include",
    headers: csrfHeaders(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `Export failed (${res.status})`);
  }
  const disposition = res.headers.get("content-disposition") ?? "";
  const match = disposition.match(/filename="?([^"]+)"?/i);
  // Backend emits `user-data-export-<username>-<ts>.json` via Content-Disposition.
  // When CORS hides that header (see docs/FOLLOWUPS.md "Export download uses
  // client-generated filename"), we fall back to the same prefix without the
  // username — the client doesn't have it cheaply here.
  const filename = match?.[1] ?? `user-data-export-${Date.now()}.json`;
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

// Envelope returned on zod-validation failures. Matches the backend's
// `{error:"validation", issues:[{path,message,code}]}` shape; fields are
// optional because non-validation errors (e.g. 401 wrong-password) come back
// as `{code, message}` instead.
export type DeleteAccountErrorEnvelope = {
  error?: string;
  issues?: { path?: unknown; message?: string; code?: string }[];
  code?: string;
  message?: string;
} | null;

// Typed error so the calling page can route zod issues to the password
// field and keep non-validation failures on a single toast surface.
export class DeleteAccountError extends Error {
  readonly status: number;
  readonly envelope: DeleteAccountErrorEnvelope;
  constructor(
    message: string,
    status: number,
    envelope: DeleteAccountErrorEnvelope,
  ) {
    super(message);
    this.status = status;
    this.envelope = envelope;
  }
}

export async function deleteAccount(password: string): Promise<void> {
  const res = await fetch(`${BACKEND_URL}/api/v1/users/me`, {
    method: "DELETE",
    credentials: "include",
    headers: { "content-type": "application/json", ...csrfHeaders() },
    body: JSON.stringify({ password }),
  });
  if (res.ok) return;

  const text = await res.text().catch(() => "");
  let envelope: DeleteAccountErrorEnvelope = null;
  let message = `Account deletion failed (${res.status})`;
  try {
    envelope = JSON.parse(text) as DeleteAccountErrorEnvelope;
    message = envelope?.message ?? envelope?.error ?? message;
  } catch {
    if (text) message = text;
  }
  throw new DeleteAccountError(message, res.status, envelope);
}
