// Thin client helpers for the GDPR export + account-delete endpoints on
// the Fastify backend. Export triggers a browser download (Blob → anchor
// click); delete posts a password and signals success/failure for the
// calling component to route back to /register.
import { BACKEND_URL } from "./backend";

export async function downloadAccountExport(): Promise<void> {
  const res = await fetch(`${BACKEND_URL}/api/v1/users/me/export`, {
    method: "POST",
    credentials: "include",
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

export async function deleteAccount(password: string): Promise<void> {
  const res = await fetch(`${BACKEND_URL}/api/v1/users/me`, {
    method: "DELETE",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let message = `Account deletion failed (${res.status})`;
    try {
      const parsed = JSON.parse(text);
      message = parsed.message ?? parsed.error ?? message;
    } catch {
      if (text) message = text;
    }
    throw new Error(message);
  }
}
