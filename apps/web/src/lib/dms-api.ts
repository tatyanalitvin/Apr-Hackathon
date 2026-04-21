// REST wrappers for the S2 DM endpoints (REQ-060/REQ-061 + R11 listing).
//
// Kept separate from `friendship-api.ts` so the DM-specific error codes
// (`self_dm`, `dm_not_allowed`, `user_not_found`) don't leak into the
// friendship union type.

import type { DmListItem, UserSearchHit } from "@ai-herders/shared/protocol";
import { BACKEND_URL, csrfHeaders } from "./backend";

export type DmErrorCode =
  | "unauthorized"
  | "validation"
  | "invalid_query"
  | "self_dm"
  | "dm_not_allowed"
  | "user_not_found"
  | "rate_limited"
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

export async function listDms(
  signal?: AbortSignal,
): Promise<DmResult<DmListItem[]>> {
  let res: Response;
  try {
    res = await fetch(`${BACKEND_URL}/api/v1/dms`, {
      credentials: "include",
      signal,
    });
  } catch (err) {
    // AbortError is a normal "newer call superseded this one" — surface it
    // as `network` and let the caller drop it; DmList ignores aborted
    // results so the older response can't overwrite a newer one.
    if (err instanceof DOMException && err.name === "AbortError") {
      return { ok: false, error: { code: "network" } };
    }
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

// REQ-UserSearch §2.4 — directory search (docs/specs/s3-user-search.md).
// 2-char minimum is enforced on both sides: UI guards in NewDmDialog,
// backend re-validates in routes/users.ts. Error codes widened to include
// 'rate_limited' (60/min per-user) + 'invalid_query' (network-layer guard
// for the <2-char / >64-char / empty-q edges).
export async function searchUsers(q: string): Promise<DmResult<UserSearchHit[]>> {
  let res: Response;
  try {
    res = await fetch(
      `${BACKEND_URL}/api/v1/users?q=${encodeURIComponent(q)}`,
      { credentials: "include" },
    );
  } catch {
    return { ok: false, error: { code: "network" } };
  }
  if (!res.ok) return { ok: false, error: await parseError(res) };
  try {
    const data = (await res.json()) as { users: UserSearchHit[] };
    return { ok: true, data: data.users };
  } catch {
    return { ok: false, error: { code: "unknown", status: res.status } };
  }
}
