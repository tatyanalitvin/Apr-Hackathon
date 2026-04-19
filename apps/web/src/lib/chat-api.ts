import type { MessagePayload, HistorySliceResponse } from "@ai-herders/shared/protocol";
import { BACKEND_URL } from "./backend";

export interface SendMessageInput {
  body: string;
  clientMessageId?: string;
  attachmentIds?: string[];
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
}

// Mirrors backend GET /api/v1/rooms/me payload. bigints arrive as strings
// per ADR-0003 watermark contract — we keep them as strings at this layer
// and let callers parse when needed.
export interface MyRoomSummary {
  id: string;
  name: string;
  kind: "group" | "dm";
  visibility: "public" | "private";
  lastReadSeq: string;
  roomHeadSeq: string;
  ownerId?: string;
  // REQ-123 — ISO timestamp until which the caller has muted this room.
  // null = unmuted. Past timestamps drift to "effectively unmuted" at
  // read time (see lib/notifications.ts).
  mutedUntil?: string | null;
}

// Mirrors POST /api/v1/rooms → 201 (REQ-023/REQ-015) and PATCH /api/v1/rooms/:id
// → 200 (REQ-087). `visibility` is always "public" for the create endpoint;
// kept non-nullable so callers don't have to null-check in template strings.
export interface RoomMutationResult {
  id: string;
  name: string;
  description: string | null;
  visibility: "public";
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

export interface ChatAPI {
  sendMessage(roomId: string, input: SendMessageInput): Promise<MessagePayload>;
  fetchHistory(roomId: string, input: FetchHistoryInput): Promise<HistorySliceResponse>;
  uploadAttachment(input: UploadAttachmentInput): Promise<UploadAttachmentResult>;
  listMyRooms(): Promise<MyRoomSummary[]>;
  listRoomCatalog(): Promise<RoomCatalogEntry[]>;
  joinRoom(roomId: string): Promise<JoinRoomResult>;
  createRoom(input: CreateRoomInput): Promise<RoomMutationResponse<RoomMutationResult>>;
  updateRoom(roomId: string, input: UpdateRoomInput): Promise<RoomMutationResponse<RoomMutationResult>>;
  deleteRoom(roomId: string): Promise<RoomMutationResponse<null>>;
  leaveRoom(roomId: string): Promise<RoomMutationResponse<null>>;
  markRoomRead(roomId: string, lastReadSeq: bigint): Promise<MarkRoomReadResult>;
  setRoomMute(roomId: string, mutedUntil: string | null): Promise<SetRoomMuteResult>;
  editMessage(roomId: string, messageId: string, body: string): Promise<MessageMutationResponse<MessagePayload>>;
  deleteMessage(roomId: string, messageId: string): Promise<MessageMutationResponse<null>>;
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

  async listRoomCatalog(): Promise<RoomCatalogEntry[]> {
    const { rooms } = await fetchJson<{ rooms: RoomCatalogEntry[] }>(
      `${BACKEND_URL}/api/v1/rooms`,
    );
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
