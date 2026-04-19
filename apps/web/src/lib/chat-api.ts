import type { MessagePayload, HistorySliceResponse } from "@ai-herders/shared/protocol";
import { BACKEND_URL } from "./backend";

export interface SendMessageInput {
  body: string;
  clientMessageId?: string;
  attachmentIds?: string[];
  // REQ-110 R2 — parent message id when this send is a reply. Backend
  // validates same-room + not-deleted and returns `reply_parent_invalid`
  // on a miss. Omitted on plain sends so the wire stays byte-for-byte
  // compatible with S1 callers.
  replyToId?: string;
}

export interface FetchHistoryInput {
  fromSeq?: bigint;
  toSeq?: bigint;
  limit?: number;
}

export interface UploadAttachmentInput {
  roomId: string;
  file: File;
  comment?: string;
}

export interface UploadAttachmentResult {
  attachmentId: string;
  // REQ-E-UPLOAD-RESP — echoes the persisted comment (post-NFC, `null`
  // when the client didn't send one or sent an empty string).
  comment: string | null;
}

// Mirrors backend GET /api/v1/rooms/me payload. bigints arrive as strings
// per ADR-0003 watermark contract — we keep them as strings at this layer
// and let callers parse when needed.
export type RoomRole = "owner" | "admin" | "member";

export interface MyRoomSummary {
  id: string;
  name: string;
  kind: "group" | "dm";
  visibility: "public" | "private";
  lastReadSeq: string;
  roomHeadSeq: string;
  ownerId?: string;
  // REQ-209 — caller's role in this room. `undefined` kept tolerant for older
  // backends; treat missing as "member".
  role?: RoomRole;
  // REQ-123 — ISO timestamp until which the caller has muted this room.
  // null = unmuted. Past timestamps drift to "effectively unmuted" at
  // read time (see lib/notifications.ts).
  mutedUntil?: string | null;
}

// Mirrors POST /api/v1/rooms → 201 (REQ-023/REQ-015) and PATCH /api/v1/rooms/:id
// → 200 (REQ-087). Visibility is now caller-supplied (REQ-088 private rooms);
// the server-side clamp-to-public was superseded on feat/invitations.
export interface RoomMutationResult {
  id: string;
  name: string;
  description: string | null;
  visibility: "public" | "private";
  ownerId: string;
  createdAt: string;
}

// Mirrors backend GET /api/v1/rooms public-group catalog payload.
export interface RoomCatalogEntry {
  id: string;
  name: string;
  kind: "group";
  visibility: "public";
  memberCount: number;
  isMember: boolean;
}

export interface JoinRoomResult {
  joined: boolean;
}

export interface CreateRoomInput {
  name: string;
  description?: string;
  // REQ-088 — default "public". Omitted = server default; "private" creates
  // an invite-only room whose only entry path is a REQ-089 invitation.
  visibility?: "public" | "private";
}

export interface UpdateRoomInput {
  name?: string;
}

export type RoomMutationError =
  | { code: "validation"; message: string }
  | { code: "name_taken" }
  | { code: "rate_limited"; retryAfterSec?: number }
  | { code: "not_room_owner" }
  | { code: "room_not_found" }
  | { code: "forbidden"; message: string }
  | { code: "unauthorized" }
  | { code: "network"; message: string }
  | { code: "unknown"; message: string };

export type RoomMutationResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: RoomMutationError };

export interface MarkRoomReadResult {
  roomId: string;
  lastReadSeq: string;
}

export interface SetRoomMuteResult {
  roomId: string;
  mutedUntil: string | null;
}

// REQ-110/112/113/114 — edit/delete error shapes lifted to a narrow union so
// UI code switches on `code` instead of re-parsing HTTP semantics per site.
export type MessageMutationError =
  | { code: "validation"; message: string }
  | { code: "unauthorized" }
  | { code: "not_message_author" }      // 403 when author mismatch (REQ-114)
  | { code: "forbidden"; message: string } // 403 non-member-of-room etc.
  | { code: "not_found" }               // 404 wrong room id
  | { code: "gone" }                    // 410 editing a deleted message (REQ-113)
  | { code: "rate_limited"; retryAfterSec?: number }
  | { code: "network"; message: string }
  | { code: "unknown"; message: string };

export type MessageMutationResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: MessageMutationError };

// Mirrors backend GET /api/v1/rooms/:id/members — real user ids so
// PresencePill can subscribe to the correct per-user presence slot.
export interface RoomMemberEntry {
  id: string;
  username: string;
  displayName: string;
  // REQ-209 — role is additive; MembersTab renders badges + gates actions.
  role: RoomRole;
}

// REQ-206 — one row of GET /api/v1/rooms/:id/bans.
export interface BanListItem {
  userId: string;
  username: string;
  bannedById: string;
  bannedByUsername: string;
  reason: string | null;
  bannedAt: string;
}

// Narrow error shape for moderation write endpoints. Superset of the existing
// RoomMutationError domain plus the 409 codes specific to role changes.
export type ModerationMutationError =
  | { code: "validation"; message: string }
  | { code: "unauthorized" }
  | { code: "not_admin" }
  | { code: "not_owner" }
  | { code: "room_not_found" }
  | { code: "user_not_found" }
  | { code: "user_not_member" }
  | { code: "already_owner" }
  | { code: "already_banned" }
  | { code: "ban_not_found" }
  | { code: "cannot_demote_owner" }
  | { code: "cannot_kick_owner" }
  | { code: "admin_cannot_kick_admin" }
  | { code: "rate_limited"; retryAfterSec?: number }
  | { code: "network"; message: string }
  | { code: "unknown"; message: string };

export type ModerationMutationResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: ModerationMutationError };


// REQ-089 invitations.
export interface InboxInvitation {
  id: string;
  roomId: string;
  roomName: string;
  inviterUsername: string;
  createdAt: string;
  expiresAt: string;
}

export interface OutgoingInvitation {
  id: string;
  inviterUsername: string;
  inviteeUsername: string;
  createdAt: string;
  expiresAt: string;
}

export interface SendInvitationResult {
  invitationId: string;
  expiresAt: string;
}

// Narrow union for the R3 error surface — maps 1:1 to backend `error` codes
// so InvitationsTab can switch on code instead of re-parsing HTTP semantics.
export type InvitationError =
  | { code: "unauthorized" }
  | { code: "room_not_found" }
  | { code: "not_a_member" }
  | { code: "forbidden_role" }         // 403 R3 — non-owner/admin on private room
  | { code: "invitee_not_found" }
  | { code: "invitee_already_member" }
  | { code: "invitee_banned" }
  | { code: "invite_pending" }
  | { code: "invitation_not_found" }   // R5/R6/R7
  | { code: "not_invitee" }            // R5/R6
  | { code: "not_inviter" }            // R7
  | { code: "invitation_not_pending" } // R5/R6/R7 terminal/expired
  | { code: "validation"; message?: string }
  | { code: "network"; message: string }
  | { code: "unknown"; message: string };

export type InvitationResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: InvitationError };

export interface ChatAPI {
  sendMessage(roomId: string, input: SendMessageInput): Promise<MessagePayload>;
  fetchHistory(roomId: string, input: FetchHistoryInput): Promise<HistorySliceResponse>;
  uploadAttachment(input: UploadAttachmentInput): Promise<UploadAttachmentResult>;
  listMyRooms(): Promise<MyRoomSummary[]>;
  // §2.4.3 — optional `q` narrows the public-room catalog by name (ILIKE
  // '%q%' server-side). Omitted / empty / whitespace-only degrades to the
  // unfiltered path, matching the backend contract.
  listRoomCatalog(input?: { q?: string }): Promise<RoomCatalogEntry[]>;
  joinRoom(roomId: string): Promise<JoinRoomResult>;
  createRoom(input: CreateRoomInput): Promise<RoomMutationResponse<RoomMutationResult>>;
  updateRoom(roomId: string, input: UpdateRoomInput): Promise<RoomMutationResponse<RoomMutationResult>>;
  deleteRoom(roomId: string): Promise<RoomMutationResponse<null>>;
  leaveRoom(roomId: string): Promise<RoomMutationResponse<null>>;
  markRoomRead(roomId: string, lastReadSeq: bigint): Promise<MarkRoomReadResult>;
  setRoomMute(roomId: string, mutedUntil: string | null): Promise<SetRoomMuteResult>;
  editMessage(roomId: string, messageId: string, body: string): Promise<MessageMutationResponse<MessagePayload>>;
  deleteMessage(roomId: string, messageId: string): Promise<MessageMutationResponse<null>>;
  listRoomMembers(roomId: string): Promise<RoomMemberEntry[]>;
  // REQ-089 invitations.
  listInbox(): Promise<InboxInvitation[]>;
  listRoomInvitations(roomId: string): Promise<OutgoingInvitation[]>;
  sendInvitation(roomId: string, inviteeUsername: string): Promise<InvitationResponse<SendInvitationResult>>;
  acceptInvitation(invitationId: string): Promise<InvitationResponse<{ joined: true; roomId: string }>>;
  declineInvitation(invitationId: string): Promise<InvitationResponse<{ declined: true }>>;
  cancelInvitation(invitationId: string): Promise<InvitationResponse<{ cancelled: true }>>;
  // REQ-201/202/203/204/205/206 — Manage Room moderation surface.
  promoteAdmin(
    roomId: string,
    userId: string,
  ): Promise<ModerationMutationResponse<{ promoted: boolean; role: "admin" }>>;
  demoteAdmin(
    roomId: string,
    userId: string,
  ): Promise<ModerationMutationResponse<{ demoted: boolean; role: "member" }>>;
  kickMember(
    roomId: string,
    userId: string,
  ): Promise<ModerationMutationResponse<{ kicked: true; banned: true }>>;
  banMember(
    roomId: string,
    userId: string,
    reason?: string,
  ): Promise<ModerationMutationResponse<{ banned: true; kicked: boolean }>>;
  unbanMember(
    roomId: string,
    userId: string,
  ): Promise<ModerationMutationResponse<{ unbanned: true }>>;
  listRoomBans(roomId: string): Promise<BanListItem[]>;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: "include", ...init });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${text || res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export class RealChatAPI implements ChatAPI {
  async sendMessage(roomId: string, input: SendMessageInput): Promise<MessagePayload> {
    return fetchJson<MessagePayload>(`${BACKEND_URL}/api/v1/rooms/${encodeURIComponent(roomId)}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  }

  async fetchHistory(roomId: string, { fromSeq, toSeq, limit }: FetchHistoryInput): Promise<HistorySliceResponse> {
    const params = new URLSearchParams();
    if (fromSeq !== undefined) params.set("fromSeq", fromSeq.toString());
    if (toSeq !== undefined) params.set("toSeq", toSeq.toString());
    if (limit !== undefined) params.set("limit", String(limit));
    const qs = params.toString();
    const url = `${BACKEND_URL}/api/v1/rooms/${encodeURIComponent(roomId)}/messages${qs ? `?${qs}` : ""}`;
    return fetchJson<HistorySliceResponse>(url);
  }

  async uploadAttachment({ roomId, file, comment }: UploadAttachmentInput): Promise<UploadAttachmentResult> {
    const form = new FormData();
    form.append("roomId", roomId);
    if (comment && comment.length > 0) form.append("comment", comment);
    form.append("file", file, file.name);
    return fetchJson<UploadAttachmentResult>(`${BACKEND_URL}/api/v1/attachments`, {
      method: "POST",
      body: form,
    });
  }

  async listMyRooms(): Promise<MyRoomSummary[]> {
    const { rooms } = await fetchJson<{ rooms: MyRoomSummary[] }>(
      `${BACKEND_URL}/api/v1/rooms/me`,
    );
    return rooms;
  }

  async listRoomCatalog(input?: { q?: string }): Promise<RoomCatalogEntry[]> {
    const trimmed = input?.q?.trim() ?? "";
    const url =
      trimmed.length > 0
        ? `${BACKEND_URL}/api/v1/rooms?q=${encodeURIComponent(trimmed)}`
        : `${BACKEND_URL}/api/v1/rooms`;
    const { rooms } = await fetchJson<{ rooms: RoomCatalogEntry[] }>(url);
    return rooms;
  }

  async joinRoom(roomId: string): Promise<JoinRoomResult> {
    return fetchJson<JoinRoomResult>(
      `${BACKEND_URL}/api/v1/rooms/${encodeURIComponent(roomId)}/join`,
      { method: "POST" },
    );
  }

  async createRoom(
    input: CreateRoomInput,
  ): Promise<RoomMutationResponse<RoomMutationResult>> {
    return roomMutation<RoomMutationResult>(
      `${BACKEND_URL}/api/v1/rooms`,
      "POST",
      input,
    );
  }

  async updateRoom(
    roomId: string,
    input: UpdateRoomInput,
  ): Promise<RoomMutationResponse<RoomMutationResult>> {
    return roomMutation<RoomMutationResult>(
      `${BACKEND_URL}/api/v1/rooms/${encodeURIComponent(roomId)}`,
      "PATCH",
      input,
    );
  }

  async deleteRoom(roomId: string): Promise<RoomMutationResponse<null>> {
    return roomMutation<null>(
      `${BACKEND_URL}/api/v1/rooms/${encodeURIComponent(roomId)}`,
      "DELETE",
    );
  }

  async leaveRoom(roomId: string): Promise<RoomMutationResponse<null>> {
    return roomMutation<null>(
      `${BACKEND_URL}/api/v1/rooms/${encodeURIComponent(roomId)}/members/me`,
      "DELETE",
    );
  }

  async markRoomRead(roomId: string, lastReadSeq: bigint): Promise<MarkRoomReadResult> {
    return fetchJson<MarkRoomReadResult>(
      `${BACKEND_URL}/api/v1/rooms/${encodeURIComponent(roomId)}/read`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ lastReadSeq: lastReadSeq.toString() }),
      },
    );
  }

  async setRoomMute(
    roomId: string,
    mutedUntil: string | null,
  ): Promise<SetRoomMuteResult> {
    return fetchJson<SetRoomMuteResult>(
      `${BACKEND_URL}/api/v1/rooms/${encodeURIComponent(roomId)}/mute`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mutedUntil }),
      },
    );
  }

  async editMessage(
    roomId: string,
    messageId: string,
    body: string,
  ): Promise<MessageMutationResponse<MessagePayload>> {
    return messageMutation<MessagePayload>(
      `${BACKEND_URL}/api/v1/rooms/${encodeURIComponent(roomId)}/messages/${encodeURIComponent(messageId)}`,
      "PATCH",
      { body },
    );
  }

  async deleteMessage(
    roomId: string,
    messageId: string,
  ): Promise<MessageMutationResponse<null>> {
    return messageMutation<null>(
      `${BACKEND_URL}/api/v1/rooms/${encodeURIComponent(roomId)}/messages/${encodeURIComponent(messageId)}`,
      "DELETE",
    );
  }

  async listRoomMembers(roomId: string): Promise<RoomMemberEntry[]> {
    const { members } = await fetchJson<{ members: RoomMemberEntry[] }>(
      `${BACKEND_URL}/api/v1/rooms/${encodeURIComponent(roomId)}/members`,
    );
    return members;
  }

  async listInbox(): Promise<InboxInvitation[]> {
    const { invitations } = await fetchJson<{ invitations: InboxInvitation[] }>(
      `${BACKEND_URL}/api/v1/invitations`,
    );
    return invitations;
  }

  async listRoomInvitations(roomId: string): Promise<OutgoingInvitation[]> {
    const { invitations } = await fetchJson<{
      invitations: OutgoingInvitation[];
    }>(`${BACKEND_URL}/api/v1/rooms/${encodeURIComponent(roomId)}/invitations`);
    return invitations;
  }

  async sendInvitation(
    roomId: string,
    inviteeUsername: string,
  ): Promise<InvitationResponse<SendInvitationResult>> {
    return invitationMutation<SendInvitationResult>(
      `${BACKEND_URL}/api/v1/rooms/${encodeURIComponent(roomId)}/invitations`,
      "POST",
      { inviteeUsername },
    );
  }

  async acceptInvitation(
    invitationId: string,
  ): Promise<InvitationResponse<{ joined: true; roomId: string }>> {
    return invitationMutation<{ joined: true; roomId: string }>(
      `${BACKEND_URL}/api/v1/invitations/${encodeURIComponent(invitationId)}/accept`,
      "POST",
    );
  }

  async declineInvitation(
    invitationId: string,
  ): Promise<InvitationResponse<{ declined: true }>> {
    return invitationMutation<{ declined: true }>(
      `${BACKEND_URL}/api/v1/invitations/${encodeURIComponent(invitationId)}/decline`,
      "POST",
    );
  }

  async cancelInvitation(
    invitationId: string,
  ): Promise<InvitationResponse<{ cancelled: true }>> {
    return invitationMutation<{ cancelled: true }>(
      `${BACKEND_URL}/api/v1/invitations/${encodeURIComponent(invitationId)}`,
      "DELETE",
    );
  }

  async promoteAdmin(
    roomId: string,
    userId: string,
  ): Promise<ModerationMutationResponse<{ promoted: boolean; role: "admin" }>> {
    return moderationMutation<{ promoted: boolean; role: "admin" }>(
      `${BACKEND_URL}/api/v1/rooms/${encodeURIComponent(roomId)}/admins/${encodeURIComponent(userId)}`,
      "POST",
    );
  }

  async demoteAdmin(
    roomId: string,
    userId: string,
  ): Promise<ModerationMutationResponse<{ demoted: boolean; role: "member" }>> {
    return moderationMutation<{ demoted: boolean; role: "member" }>(
      `${BACKEND_URL}/api/v1/rooms/${encodeURIComponent(roomId)}/admins/${encodeURIComponent(userId)}`,
      "DELETE",
    );
  }

  async kickMember(
    roomId: string,
    userId: string,
  ): Promise<ModerationMutationResponse<{ kicked: true; banned: true }>> {
    return moderationMutation<{ kicked: true; banned: true }>(
      `${BACKEND_URL}/api/v1/rooms/${encodeURIComponent(roomId)}/members/${encodeURIComponent(userId)}`,
      "DELETE",
    );
  }

  async banMember(
    roomId: string,
    userId: string,
    reason?: string,
  ): Promise<ModerationMutationResponse<{ banned: true; kicked: boolean }>> {
    return moderationMutation<{ banned: true; kicked: boolean }>(
      `${BACKEND_URL}/api/v1/rooms/${encodeURIComponent(roomId)}/bans`,
      "POST",
      reason && reason.length > 0 ? { userId, reason } : { userId },
    );
  }

  async unbanMember(
    roomId: string,
    userId: string,
  ): Promise<ModerationMutationResponse<{ unbanned: true }>> {
    return moderationMutation<{ unbanned: true }>(
      `${BACKEND_URL}/api/v1/rooms/${encodeURIComponent(roomId)}/bans/${encodeURIComponent(userId)}`,
      "DELETE",
    );
  }

  async listRoomBans(roomId: string): Promise<BanListItem[]> {
    const { bans } = await fetchJson<{ bans: BanListItem[] }>(
      `${BACKEND_URL}/api/v1/rooms/${encodeURIComponent(roomId)}/bans`,
    );
    return bans;
  }
}

// REQ-089 — maps backend `{ error: <code>, ... }` onto the InvitationError
// union so the UI doesn't re-parse HTTP. Mirrors roomMutation's shape.
async function invitationMutation<T>(
  url: string,
  method: "POST" | "DELETE",
  body?: unknown,
): Promise<InvitationResponse<T>> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      credentials: "include",
      headers:
        body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "network",
        message: err instanceof Error ? err.message : "network error",
      },
    };
  }

  if (res.status === 200 || res.status === 201) {
    const data = (await res.json().catch(() => null)) as T | null;
    if (data === null) {
      return { ok: false, error: { code: "unknown", message: "empty body" } };
    }
    return { ok: true, data };
  }

  const payload = (await res.json().catch(() => ({}))) as {
    error?: string;
    message?: string;
  };
  if (res.status === 401) return { ok: false, error: { code: "unauthorized" } };
  if (res.status === 400) {
    return {
      ok: false,
      error: { code: "validation", message: payload.message ?? payload.error },
    };
  }
  const known = [
    "room_not_found",
    "not_a_member",
    "forbidden_role",
    "invitee_not_found",
    "invitee_already_member",
    "invitee_banned",
    "invite_pending",
    "invitation_not_found",
    "not_invitee",
    "not_inviter",
    "invitation_not_pending",
  ] as const;
  if (typeof payload.error === "string" && (known as readonly string[]).includes(payload.error)) {
    return {
      ok: false,
      error: { code: payload.error as (typeof known)[number] },
    };
  }
  return {
    ok: false,
    error: {
      code: "unknown",
      message:
        typeof payload.error === "string"
          ? payload.error
          : `HTTP ${res.status}`,
    },
  };
}

// Shared adapter for POST/PATCH/DELETE /rooms routes. Normalises backend
// `{ error, ... }` shapes into the RoomMutationError union so UI code can
// switch on code without re-parsing HTTP semantics at every call site.
// `null` is returned for 204 (DELETE) so the caller can ignore data.
async function roomMutation<T>(
  url: string,
  method: "POST" | "PATCH" | "DELETE",
  body?: unknown,
): Promise<RoomMutationResponse<T>> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      credentials: "include",
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "network",
        message: err instanceof Error ? err.message : "network error",
      },
    };
  }

  if (res.status === 204) return { ok: true, data: null as T };
  if (res.status === 201 || res.status === 200) {
    const data = (await res.json().catch(() => null)) as T | null;
    if (data === null) {
      return { ok: false, error: { code: "unknown", message: "empty body" } };
    }
    return { ok: true, data };
  }

  const payload = (await res.json().catch(() => ({}))) as {
    error?: string;
    details?: unknown;
    retryAfterSec?: number;
  };

  if (res.status === 401) return { ok: false, error: { code: "unauthorized" } };
  if (res.status === 400)
    return {
      ok: false,
      error: {
        code: "validation",
        message: typeof payload.error === "string" ? payload.error : "invalid request",
      },
    };
  if (res.status === 409 && payload.error === "name_taken")
    return { ok: false, error: { code: "name_taken" } };
  if (res.status === 429)
    return {
      ok: false,
      error: { code: "rate_limited", retryAfterSec: payload.retryAfterSec },
    };
  if (res.status === 404 && payload.error === "room_not_found")
    return { ok: false, error: { code: "room_not_found" } };
  if (res.status === 403 && payload.error === "not_room_owner")
    return { ok: false, error: { code: "not_room_owner" } };
  if (res.status === 403)
    return {
      ok: false,
      error: {
        code: "forbidden",
        message: typeof payload.error === "string" ? payload.error : "forbidden",
      },
    };
  return {
    ok: false,
    error: {
      code: "unknown",
      message: `HTTP ${res.status}${payload.error ? `: ${payload.error}` : ""}`,
    },
  };
}

// Shared adapter for the five moderation endpoints (REQ-201..REQ-206). Maps
// status codes + `{error}` payloads into ModerationMutationError so the tabs
// can surface precise toasts (already_banned vs ban_not_found etc.) without
// re-parsing HTTP at every call site.
async function moderationMutation<T>(
  url: string,
  method: "POST" | "DELETE",
  body?: unknown,
): Promise<ModerationMutationResponse<T>> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      credentials: "include",
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "network",
        message: err instanceof Error ? err.message : "network error",
      },
    };
  }

  if (res.status === 204) return { ok: true, data: null as T };
  if (res.status === 200 || res.status === 201) {
    const data = (await res.json().catch(() => null)) as T | null;
    if (data === null) {
      return { ok: false, error: { code: "unknown", message: "empty body" } };
    }
    return { ok: true, data };
  }

  const payload = (await res.json().catch(() => ({}))) as {
    error?: string;
    retryAfterSec?: number;
  };
  const err = typeof payload.error === "string" ? payload.error : "";

  if (res.status === 401) return { ok: false, error: { code: "unauthorized" } };
  if (res.status === 400)
    return {
      ok: false,
      error: { code: "validation", message: err || "invalid request" },
    };
  if (res.status === 429)
    return {
      ok: false,
      error: { code: "rate_limited", retryAfterSec: payload.retryAfterSec },
    };
  if (res.status === 404 && err === "room_not_found")
    return { ok: false, error: { code: "room_not_found" } };
  if (res.status === 404 && err === "user_not_found")
    return { ok: false, error: { code: "user_not_found" } };
  if (res.status === 404 && err === "user_not_member")
    return { ok: false, error: { code: "user_not_member" } };
  if (res.status === 404 && err === "ban_not_found")
    return { ok: false, error: { code: "ban_not_found" } };
  if (res.status === 403 && err === "not_owner")
    return { ok: false, error: { code: "not_owner" } };
  if (res.status === 403 && err === "not_admin")
    return { ok: false, error: { code: "not_admin" } };
  if (res.status === 403 && err === "admin_cannot_kick_admin")
    return { ok: false, error: { code: "admin_cannot_kick_admin" } };
  if (res.status === 409 && err === "already_owner")
    return { ok: false, error: { code: "already_owner" } };
  if (res.status === 409 && err === "already_banned")
    return { ok: false, error: { code: "already_banned" } };
  if (res.status === 409 && err === "cannot_demote_owner")
    return { ok: false, error: { code: "cannot_demote_owner" } };
  if (res.status === 409 && err === "cannot_kick_owner")
    return { ok: false, error: { code: "cannot_kick_owner" } };
  return {
    ok: false,
    error: {
      code: "unknown",
      message: `HTTP ${res.status}${err ? `: ${err}` : ""}`,
    },
  };
}

// Shared adapter for PATCH/DELETE /rooms/:roomId/messages/:messageId (REQ-110/112).
// Maps backend `{ error }` shapes into MessageMutationError so call sites can
// branch on `not_message_author` (author check), `gone` (editing deleted), etc.
async function messageMutation<T>(
  url: string,
  method: "PATCH" | "DELETE",
  body?: unknown,
): Promise<MessageMutationResponse<T>> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      credentials: "include",
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "network",
        message: err instanceof Error ? err.message : "network error",
      },
    };
  }

  if (res.status === 204) return { ok: true, data: null as T };
  if (res.status === 200) {
    const data = (await res.json().catch(() => null)) as T | null;
    if (data === null) {
      return { ok: false, error: { code: "unknown", message: "empty body" } };
    }
    return { ok: true, data };
  }

  const payload = (await res.json().catch(() => ({}))) as {
    error?: string;
    retryAfterSec?: number;
  };

  if (res.status === 401) return { ok: false, error: { code: "unauthorized" } };
  if (res.status === 400)
    return {
      ok: false,
      error: {
        code: "validation",
        message: typeof payload.error === "string" ? payload.error : "invalid request",
      },
    };
  if (res.status === 404) return { ok: false, error: { code: "not_found" } };
  if (res.status === 410) return { ok: false, error: { code: "gone" } };
  if (res.status === 429)
    return {
      ok: false,
      error: { code: "rate_limited", retryAfterSec: payload.retryAfterSec },
    };
  if (res.status === 403 && payload.error === "not_message_author")
    return { ok: false, error: { code: "not_message_author" } };
  if (res.status === 403)
    return {
      ok: false,
      error: {
        code: "forbidden",
        message: typeof payload.error === "string" ? payload.error : "forbidden",
      },
    };
  return {
    ok: false,
    error: {
      code: "unknown",
      message: `HTTP ${res.status}${payload.error ? `: ${payload.error}` : ""}`,
    },
  };
}
