// REST wrappers for the S2 DM endpoints (REQ-060/REQ-061 + R11 listing).
//
// Kept separate from `friendship-api.ts` so the DM-specific error codes
// (`self_dm`, `dm_not_allowed`, `user_not_found`) don't leak into the
// friendship union type.

import type { DmListItem } from "@ai-herders/shared/protocol";
import { BACKEND_URL, csrfHeaders } from "./backend";

export type DmErrorCode =
  | "unauthorized"
  | "validation"
  | "self_dm"
  | "dm_not_allowed"
  | "user_not_found"
  | "network"
  | "unknown";

export interface DmError {
  code: DmErrorCode;
  status?: number;
}

export type DmResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: DmError };

export interface CreateDmResult {
  roomId: string;
  kind: "dm";
  dmPairKey: string;
  // `created` is client-side only — true on 201, false on 200 (raced).
  created: boolean;
}

interface ErrorBodyShape {
  error?: string;
}

async function parseError(res: Response): Promise<DmError> {
  let body: ErrorBodyShape | null = null;
  try {
    body = (await res.json()) as ErrorBodyShape;
  } catch {
    // Non-JSON — fall back to status mapping.
  }
  if (!body?.error && res.status === 401) {
    return { code: "unauthorized", status: 401 };
  }
  const code = (body?.error ?? "unknown") as DmErrorCode;
  return { code, status: res.status };
}

export async function listDms(): Promise<DmResult<DmListItem[]>> {
  let res: Response;
  try {
    res = await fetch(`${BACKEND_URL}/api/v1/dms`, { credentials: "include" });
  } catch {
    return { ok: false, error: { code: "network" } };
  }
  if (!res.ok) return { ok: false, error: await parseError(res) };
  try {
    const data = (await res.json()) as { dms: DmListItem[] };
    return { ok: true, data: data.dms };
  } catch {
    return { ok: false, error: { code: "unknown", status: res.status } };
  }
}

export async function createDm(userId: string): Promise<DmResult<CreateDmResult>> {
  let res: Response;
  try {
    res = await fetch(`${BACKEND_URL}/api/v1/dms`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json", ...csrfHeaders() },
      body: JSON.stringify({ userId }),
    });
  } catch {
    return { ok: false, error: { code: "network" } };
  }
  if (!res.ok) return { ok: false, error: await parseError(res) };
  try {
    const data = (await res.json()) as {
      roomId: string;
      kind: "dm";
      dmPairKey: string;
    };
    return {
      ok: true,
      data: { ...data, created: res.status === 201 },
    };
  } catch {
    return { ok: false, error: { code: "unknown", status: res.status } };
  }
}
