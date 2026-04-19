// REQ-017 / REQ-018, v3.docx §2.2.4 — client wrappers for the Fastify
// sessions endpoints. Backend strips `token` from every row, tags the
// caller with `current: true`, and returns 403 for both "not yours" and
// "doesn't exist" so session-id existence isn't a probe oracle.
// See apps/backend/src/routes/sessions.ts and docs/specs/s2-sessions-ui.md.
import { BACKEND_URL } from "./backend";

export type SessionRow = {
  id: string;
  userAgent: string | null;
  ipAddress: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  current: boolean;
};

export async function listSessions(): Promise<SessionRow[]> {
  const res = await fetch(`${BACKEND_URL}/api/v1/sessions`, {
    credentials: "include",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `Failed to load sessions (${res.status})`);
  }
  return (await res.json()) as SessionRow[];
}

export async function revokeSession(id: string): Promise<void> {
  const res = await fetch(
    `${BACKEND_URL}/api/v1/sessions/${encodeURIComponent(id)}`,
    { method: "DELETE", credentials: "include" },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let message = `Couldn't sign that session out (${res.status})`;
    try {
      const parsed = JSON.parse(text) as { message?: string; error?: string };
      message = parsed.message ?? parsed.error ?? message;
    } catch {
      if (text) message = text;
    }
    throw new Error(message);
  }
}
