// REQ-158 — typed fetch for /admin page polling.
// Mirrors the credentials:"include" + 401/403 handling of chat-api.ts but
// stays tiny — one call, one shape. The page component handles the
// auth-gate UX (showing "forbidden" on 403); this layer just surfaces the
// status code as a typed error.

import type { AdminMetricsSnapshot } from "@ai-herders/shared/protocol";
import { BACKEND_URL } from "./backend";

export class AdminFetchError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "AdminFetchError";
  }
}

export async function fetchAdminMetrics(
  signal?: AbortSignal,
): Promise<AdminMetricsSnapshot> {
  const res = await fetch(`${BACKEND_URL}/api/v1/admin/metrics`, {
    credentials: "include",
    signal,
  });
  if (!res.ok) {
    throw new AdminFetchError(res.status, `HTTP ${res.status}`);
  }
  return (await res.json()) as AdminMetricsSnapshot;
}
