// Typed REST wrappers for the 10 friendship endpoints (REQ-050..059, REQ-073,
// REQ-074, plus the read-side blocked listing added in the hotfix).
//
// Why one module: the UI wants to distinguish success shapes (201/200 pending,
// 409 already_friends, 409 request_declined, 429 rate_limited) without each
// call site re-parsing status codes. Consumers get typed `{ ok: true, data }`
// vs `{ ok: false, error }` unions and render the right toast.
//
// Sentinel success (REQ-053): a 201/200 `{ status: 'pending' }` is what the UI
// sees for both a real insert and a block-masked one. This module does NOT
// cross-reference the outgoing list — brief rule #2.

import type { SendFriendRequestInput } from "@ai-herders/shared/dto";
import { BACKEND_URL } from "./backend";

export interface FriendSummary {
  userId: string;
  username: string;
  name: string;
  friendedAt: string;
}

export interface PendingRequestCounterparty {
  userId: string;
  username: string;
  name: string;
}

export interface IncomingFriendRequest {
  id: string;
  message: string | null;
  createdAt: string;
  from: PendingRequestCounterparty;
}

export interface OutgoingFriendRequest {
  id: string;
  message: string | null;
  createdAt: string;
  to: PendingRequestCounterparty;
}

export interface BlockedUser {
  userId: string;
  username: string;
  name: string;
  blockedAt: string;
}

export type FriendRequestErrorCode =
  | "unauthorized"
  | "validation"
  | "user_not_found"
  | "self_request"
  | "self_block"
  | "not_found"
  | "already_friends"
  | "request_declined"
  | "rate_limited"
  | "network"
  | "unknown";

export interface FriendRequestError {
  code: FriendRequestErrorCode;
  // retryAfterSec is only present for rate_limited.
  retryAfterSec?: number;
  // Server-provided detail for validation branch; opaque otherwise.
  detail?: unknown;
  // HTTP status if the error came from the server.
  status?: number;
}

export type Result<T> =
  | { ok: true; data: T }
  | { ok: false; error: FriendRequestError };

interface ErrorBodyShape {
  error?: string;
  retryAfterSec?: number;
  issues?: unknown;
}

async function parseErrorBody(res: Response): Promise<FriendRequestError> {
  let body: ErrorBodyShape | null = null;
  try {
    body = (await res.json()) as ErrorBodyShape;
  } catch {
    // Non-JSON error — fall through to status-based mapping.
  }
  const code = (body?.error ?? "unknown") as FriendRequestErrorCode;
  if (!body?.error && res.status === 401) {
    return { code: "unauthorized", status: 401 };
  }
  return {
    code,
    status: res.status,
    retryAfterSec: body?.retryAfterSec,
    detail: body?.issues,
  };
}

async function request<T>(
  input: string,
  init?: RequestInit,
): Promise<Result<T>> {
  let res: Response;
  try {
    res = await fetch(`${BACKEND_URL}${input}`, {
      credentials: "include",
      ...init,
      headers: {
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...init?.headers,
      },
    });
  } catch {
    return { ok: false, error: { code: "network" } };
  }
  if (res.status === 204) {
    return { ok: true, data: undefined as T };
  }
  if (!res.ok) {
    return { ok: false, error: await parseErrorBody(res) };
  }
  try {
    const data = (await res.json()) as T;
    return { ok: true, data };
  } catch {
    return { ok: false, error: { code: "unknown", status: res.status } };
  }
}

// REQ-050 — GET /api/v1/friends
export async function listFriends(): Promise<Result<FriendSummary[]>> {
  const r = await request<{ friends: FriendSummary[] }>("/api/v1/friends");
  return r.ok ? { ok: true, data: r.data.friends } : r;
}

// REQ-051..055 — POST /api/v1/friends/requests. Both DTO branches (toUsername
// for the dialog, toUserId for MemberList REQ-052) route here.
export interface SendRequestResult {
  id: string;
  status: "pending";
}
export async function sendFriendRequest(
  body: SendFriendRequestInput,
): Promise<Result<SendRequestResult>> {
  return request<SendRequestResult>("/api/v1/friends/requests", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// R14 — GET /api/v1/friends/requests?direction=incoming
export async function listIncomingRequests(): Promise<Result<IncomingFriendRequest[]>> {
  const r = await request<{ requests: IncomingFriendRequest[] }>(
    "/api/v1/friends/requests?direction=incoming",
  );
  return r.ok ? { ok: true, data: r.data.requests } : r;
}

// R15 — GET /api/v1/friends/requests?direction=outgoing
export async function listOutgoingRequests(): Promise<Result<OutgoingFriendRequest[]>> {
  const r = await request<{ requests: OutgoingFriendRequest[] }>(
    "/api/v1/friends/requests?direction=outgoing",
  );
  return r.ok ? { ok: true, data: r.data.requests } : r;
}

// REQ-057 — accept. Returns 409 already_friends on replay (spec §4 R8).
export interface AcceptResult {
  status: "accepted";
  friendshipId: string;
}
export async function acceptFriendRequest(id: string): Promise<Result<AcceptResult>> {
  return request<AcceptResult>(
    `/api/v1/friends/requests/${encodeURIComponent(id)}/accept`,
    { method: "POST" },
  );
}

// REQ-057 — decline.
export async function declineFriendRequest(id: string): Promise<Result<{ status: "rejected" }>> {
  return request<{ status: "rejected" }>(
    `/api/v1/friends/requests/${encodeURIComponent(id)}/decline`,
    { method: "POST" },
  );
}

// REQ-057 — block-from-request (multi-effect, see spec R10).
export async function blockFromRequest(id: string): Promise<Result<{ status: "blocked" }>> {
  return request<{ status: "blocked" }>(
    `/api/v1/friends/requests/${encodeURIComponent(id)}/block`,
    { method: "POST" },
  );
}

// REQ-059 — DELETE /api/v1/friends/:userId (either side; 204 idempotent).
export async function removeFriend(userId: string): Promise<Result<void>> {
  return request<void>(`/api/v1/friends/${encodeURIComponent(userId)}`, {
    method: "DELETE",
  });
}

// REQ-073 — POST /api/v1/users/:id/block.
export async function blockUser(userId: string): Promise<Result<void>> {
  return request<void>(`/api/v1/users/${encodeURIComponent(userId)}/block`, {
    method: "POST",
  });
}

// REQ-074 — DELETE /api/v1/users/:id/ban. Idempotent; does NOT restore friendship.
export async function unblockUser(userId: string): Promise<Result<void>> {
  return request<void>(`/api/v1/users/${encodeURIComponent(userId)}/ban`, {
    method: "DELETE",
  });
}

// REQ-074 read-side — GET /api/v1/users/blocked.
export async function listBlockedUsers(): Promise<Result<BlockedUser[]>> {
  const r = await request<{ blocked: BlockedUser[] }>("/api/v1/users/blocked");
  return r.ok ? { ok: true, data: r.data.blocked } : r;
}
