// Socket.IO protocol — shared event typing between web client and Fastify backend.
//
// Watermark contract (see docs/adr/0003-watermark-protocol.md in S1):
//   - Every broadcast event in a room carries {seq, roomHeadSeq}.
//   - Client tracks lastSeenSeq per room. If received.seq !== lastSeen + 1,
//     client calls `GET /api/v1/rooms/:id/messages?fromSeq=lastSeen+1&toSeq=received.seq`
//     BEFORE resuming the live stream.
//   - bigints are serialized as strings on the wire to survive JSON.

export const PROTOCOL_VERSION = 1;

export type PresenceState = "online" | "afk" | "offline";

// ──────────────────────────────────────────────────────────────────────────
// Wire-format payload types
// ──────────────────────────────────────────────────────────────────────────

// REQ-075/077/078/081/082 — inline attachment metadata carried on every
// message broadcast. Lets the renderer choose <img> vs filename chip without a
// second round trip. `downloadUrl` is RELATIVE (`/api/v1/attachments/:id`);
// the client composes the absolute URL with NEXT_PUBLIC_BACKEND_URL.
export interface AttachmentPayload {
  id: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  comment: string | null;
  downloadUrl: string;
}

// REQ-110 (s2-replies R5) — quoted-parent preview carried on every reply
// broadcast + history slice. Semi-snapshot: `authorUsername` is naturally
// frozen via message.author_username denormalisation; `text` is LIVE (read
// from parent.body on hydration) per Q1 LIVE decision, so a parent edit
// drifts the preview on the next fetch but in-memory subscribers keep the
// original until they refresh; `deletedAt` is LIVE so the renderer flips
// to "[deleted]" the moment a parent is soft-deleted. See §5 of the spec.
export interface ReplyToPreview {
  id: string;
  text: string;            // truncated server-side to REPLY_PREVIEW_MAX chars
  authorUsername: string;
  deletedAt: string | null;
}

// REQ-110 (s2-replies R7) — server-enforced preview truncation. The
// serializer slices parent.body to REPLY_PREVIEW_MAX code units and appends
// REPLY_PREVIEW_ELLIPSIS when a slice was taken. Lives on protocol.ts (not
// dto.ts) because the constant is a wire-shape invariant, not input
// validation — clients and servers must agree on the truncated value.
export const REPLY_PREVIEW_MAX = 120;
export const REPLY_PREVIEW_ELLIPSIS = "\u2026";

export interface MessagePayload {
  id: string;
  roomId: string;
  authorId: string;
  // Snapshot of the author's identity AT SEND TIME. Denormalised into the
  // message row so username/display-name changes do not retroactively
  // rewrite chat history (Slack/Discord-style audit semantics).
  authorUsername: string;
  authorName: string;
  body: string;
  seq: string;        // bigint as string
  replyToId: string | null;
  // REQ-110 (s2-replies R5) — present on every MessagePayload; `null` when
  // the row is not a reply. Non-null carries the quoted-parent preview.
  replyTo: ReplyToPreview | null;
  editedAt: string | null;
  // REQ-112/113 — set when the author soft-deletes the message. History
  // endpoint filters deletedAt IS NOT NULL out of GETs; live clients that
  // held the row before deletion use this flag + the cleared `body` to
  // render a tombstone. Never populated on GET responses (always null);
  // toggled locally by the client when a `message.deleted` event arrives.
  deletedAt: string | null;
  createdAt: string;
  // Optional for back-compat: messages without attachments omit the field.
  attachments?: AttachmentPayload[];
}

export interface MessageNewEvent {
  type: "message.new";
  roomId: string;
  seq: string;          // bigint as string — same as message.seq
  roomHeadSeq: string;  // current watermark for the room
  message: MessagePayload;
}

export interface MessageEditedEvent {
  type: "message.edited";
  roomId: string;
  seq: string;
  roomHeadSeq: string;
  messageId: string;
  body: string;
  editedAt: string;
}

// REQ-212 — v3 §2.5.5 admin delete. `deletedByRole` lets clients render a
// distinct tombstone ("Removed by moderator") without a second RTT.
// "author"  → message author soft-deleted their own row (v3 §2.5.5 first bullet)
// "admin"   → room owner/admin soft-deleted another user's row (group-only)
export type MessageDeletedByRole = "author" | "admin";

export interface MessageDeletedEvent {
  type: "message.deleted";
  roomId: string;
  seq: string;
  roomHeadSeq: string;
  messageId: string;
  deletedAt: string;
  deletedByRole: MessageDeletedByRole;
}

export interface PresenceStateEvent {
  type: "presence.state";
  userId: string;
  state: PresenceState;
  since: string; // ISO timestamp
}

export interface TypingEvent {
  type: "typing";
  roomId: string;
  userId: string;
}

// REQ-058: when a pending friend request is accepted, the requester (who was
// `fromId` on the request row) receives this event in their per-user Socket.IO
// room `user:{fromId}`. At-most-once best-effort — no watermark, no replay on
// reconnect; ADR-0003's ordering contract is scoped to room messages, not
// friendship notifications. Decline and Block emit nothing (REQ-058 explicit).
export interface FriendRequestAcceptedEvent {
  type: "friend.request.accepted";
  requestId: string;
  friendId: string;       // the user who accepted (was toId on the request)
  friendUsername: string;
  acceptedAt: string;     // ISO timestamp
}

// S2 rooms Q1 — emitted after a successful self-join (REQ-026) so existing
// subscribers of a public group room see the new member arrive in real time.
// Fanout target: `server.to(roomId).emit(...)`, so only sockets already
// subscribed to that room receive it. Emitted ONLY on a new-membership insert;
// the idempotent-repeat path (already a member) is silent, otherwise re-join
// clicks would cause ghost-join toasts. At-most-once best-effort — no
// watermark, no replay; missed emits reconcile on the next `/rooms/me` fetch.
// ADR-0003's ordering contract is scoped to room MESSAGE events, not
// membership, so `seq`/`roomHeadSeq` deliberately don't appear here.
export interface RoomMemberJoinedEvent {
  type: "room.member.joined";
  roomId: string;
  userId: string;
  username: string;
  joinedAt: string;       // ISO timestamp
}

// ──────────────────────────────────────────────────────────────────────────
// room lifecycle (REQ-089) — emitted when a room owner deletes the room.
// Fanout target: `server.to(roomId).emit(...)` before the DB row is deleted,
// so existing subscribers all receive the kick-out signal. Clients navigate
// away from the deleted room and refresh their sidebar membership list.
// At-most-once best-effort: no watermark, no replay; the reconcile path is
// the next GET /rooms/me, which won't include the deleted room.
// ──────────────────────────────────────────────────────────────────────────

export interface RoomDeletedEvent {
  type: "room.deleted";
  roomId: string;
  deletedAt: string;      // ISO timestamp
  deletedBy: string;      // userId of the owner who issued the delete
}

// ──────────────────────────────────────────────────────────────────────────
// room mgmt — reserved event names (wave1 scaffold). Payloads intentionally
// left as `{}` stubs; the owner agents fill them in their feature branches.
// Names are fixed here so parallel agents don't collide on wire schema.
//   agent A: role.changed / member.kicked / member.banned / member.unbanned
//   agent B: invitation.sent / invitation.accepted / invitation.declined
// ──────────────────────────────────────────────────────────────────────────

// REQ-201 / REQ-202 / REQ-207 — broadcast on owner-only role mutations
// (promote member→admin, demote admin→member). Fanout target:
// `server.to(roomId).emit(...)`. At-most-once best-effort — no watermark,
// no replay; reconcile via `/rooms/:id/members` on reconnect.
export interface RoomRoleChangedEvent {
  type: "room.role.changed";
  roomId: string;
  userId: string;
  role: "admin" | "member";
  changedBy: string;       // userId of the owner issuing the change
  changedAt: string;       // ISO timestamp
}

// REQ-203 / REQ-207 — emitted when an admin or owner kicks a member. Kick
// is also a ban per v3.docx §2.4.8, so handlers emit `room.member.kicked`
// (stronger "you must leave" signal) and NOT a parallel `room.member.banned`.
// Fanout: `server.to(roomId).emit(...)`. The target's sockets are force-left
// from the room channel in the same handler (REQ-208) so this event is the
// final broadcast they see with `roomId` context.
export interface RoomMemberKickedEvent {
  type: "room.member.kicked";
  roomId: string;
  userId: string;
  kickedBy: string;          // userId of the owner/admin issuing the kick
  kickedAt: string;          // ISO timestamp
}

// REQ-204 / REQ-207 — pre-emptive ban path ONLY (target was NOT a current
// room_member). If the ban handler also kicks an existing member, the
// handler emits `room.member.kicked` instead — the stronger "leave now"
// signal. Fanout: `server.to(roomId).emit(...)`. Reason is user-supplied
// text ≤ 500 chars or null. At-most-once best-effort.
export interface RoomMemberBannedEvent {
  type: "room.member.banned";
  roomId: string;
  userId: string;
  bannedBy: string;          // userId of the owner/admin issuing the ban
  reason: string | null;
  bannedAt: string;          // ISO timestamp
}

// REQ-205 / REQ-207 — owner/admin removes a user's active ban. Fanout:
// `server.to(roomId).emit(...)`. Does NOT re-add the user as a member;
// they must hit `/rooms/:id/join` again to rejoin (existing S2 flow).
// At-most-once best-effort.
export interface RoomMemberUnbannedEvent {
  type: "room.member.unbanned";
  roomId: string;
  userId: string;
  unbannedBy: string;        // userId of the owner/admin issuing the unban
  unbannedAt: string;        // ISO timestamp
}

// REQ-089 — fanout target `user:{inviteeId}`. At-most-once best-effort (no
// watermark); missed events reconcile on next `GET /invitations`.
// Denorm roomName + inviterUsername so the toast/inbox renders without a
// follow-up fetch. See docs/specs/s2-invitations.md §5 "Protocol payloads".
export interface RoomInvitationSentEvent {
  type: "room.invitation.sent";
  invitationId: string;
  roomId: string;
  roomName: string;
  inviterId: string;
  inviterUsername: string;
  createdAt: string;       // ISO
  expiresAt: string;       // ISO — REQ-089a (14d default)
}

// REQ-089 — fanout target `user:{inviterId}`. Emitted after invitee accepts.
// The `room.member.joined` room-scoped event is ALSO emitted (reuses s2-rooms
// broadcast) so other room members see the arrival; this event is specifically
// for the inviter to close their "outgoing" state.
export interface RoomInvitationAcceptedEvent {
  type: "room.invitation.accepted";
  invitationId: string;
  roomId: string;
  inviteeId: string;
  inviteeUsername: string;
  acceptedAt: string;      // ISO
}

// REQ-089 — fanout target asymmetry (spec §5 "Fanout asymmetry"):
//   - invitee declines (R6) → fanout to `user:{inviterId}` (inviter's outgoing list drops row)
//   - inviter cancels (R7)  → fanout to `user:{inviteeId}` (invitee's inbox drops row)
// Same event name, same payload shape, different routing target. Implementers
// MUST NOT emit to both channels — that double-notifies and races the UI.
export interface RoomInvitationDeclinedEvent {
  type: "room.invitation.declined";
  invitationId: string;
  roomId: string;
  declinedAt: string;      // ISO
}

// Note: `message.reply.added` is intentionally NOT reserved — replies reuse
// the existing `message.new` broadcast with `replyToId` populated.

// ──────────────────────────────────────────────────────────────────────────
// Socket.IO event maps — feed to `new Server<ClientToServerEvents, ServerToClientEvents>`
// ──────────────────────────────────────────────────────────────────────────

export interface ServerToClientEvents {
  "message.new": (evt: MessageNewEvent) => void;
  "message.edited": (evt: MessageEditedEvent) => void;
  "message.deleted": (evt: MessageDeletedEvent) => void;
  "presence.state": (evt: PresenceStateEvent) => void;
  "presence.changed": (evt: PresenceChangedEvent) => void;
  "typing": (evt: TypingEvent) => void;
  "friend.request.accepted": (evt: FriendRequestAcceptedEvent) => void;
  "room.member.joined": (evt: RoomMemberJoinedEvent) => void;
  "room.deleted": (evt: RoomDeletedEvent) => void;
  // reserved — wave1 scaffold (agents A/B fill payloads in feature branches).
  "room.role.changed": (evt: RoomRoleChangedEvent) => void;
  "room.member.kicked": (evt: RoomMemberKickedEvent) => void;
  "room.member.banned": (evt: RoomMemberBannedEvent) => void;
  "room.member.unbanned": (evt: RoomMemberUnbannedEvent) => void;
  "room.invitation.sent": (evt: RoomInvitationSentEvent) => void;
  "room.invitation.accepted": (evt: RoomInvitationAcceptedEvent) => void;
  "room.invitation.declined": (evt: RoomInvitationDeclinedEvent) => void;
}

export interface ClientToServerEvents {
  "room.subscribe": (roomId: string, ack: (res: { ok: boolean; roomHeadSeq: string }) => void) => void;
  "room.unsubscribe": (roomId: string) => void;
  "presence.set": (state: Exclude<PresenceState, "offline">) => void;
  "presence.setState": (payload: PresenceSetStatePayload) => void;
  "typing.start": (roomId: string) => void;
  "typing.stop": (roomId: string) => void;
}

// ──────────────────────────────────────────────────────────────────────────
// REST history response (used by gap-detection)
// ──────────────────────────────────────────────────────────────────────────

export interface HistorySliceResponse {
  roomId: string;
  fromSeq: string;
  toSeq: string;
  roomHeadSeq: string;
  messages: MessagePayload[];
}

// ──────────────────────────────────────────────────────────────────────────
// DM listing (s2-dms R11). DMs reuse `room` rows with kind='dm' — this is
// the wire shape for `GET /api/v1/dms`. `frozen` + `frozenReason` are
// computed server-side at read time from friendship + user_block + counterpart
// deletion state (see ADR-0007).
// ──────────────────────────────────────────────────────────────────────────

export type DmFrozenReason = "not_friends" | "blocked" | "user_deleted";

export interface DmListItem {
  roomId: string;
  other: {
    userId: string;
    username: string;
    name: string;
    deleted: boolean;
  };
  lastMessage: MessagePayload | null;
  unreadCount: number;
  frozen: boolean;
  frozenReason: DmFrozenReason | null;
}

// ──────────────────────────────────────────────────────────────────────────
// REQ-158 — /admin dashboard metrics snapshot (s3-admin).
// Consumed by the web admin page (2s polling, no push — see S3_ADMIN brief).
// `recentSecurityEvents` is fed by `recordSecurityEvent()` in metrics.ts;
// the s3-hardening agent calls it from CSRF / rate-limit / failed-login paths.
// ──────────────────────────────────────────────────────────────────────────

export type AdminSecurityEventType =
  | "csrf_fail"
  | "rate_limited"
  | "login_failed";

export interface AdminSecurityEvent {
  at: string;                           // ISO timestamp
  type: AdminSecurityEventType;
  ip?: string;                          // SHA-256(ip+SESSION_SECRET) slice(0,8)
  route?: string;                       // e.g. "POST /api/v1/dms"
}

export interface AdminMetricsSnapshot {
  generatedAt: string;                  // ISO timestamp
  onlineUsers: number;                  // distinct userIds with ≥1 live socket
  messagesPerMinute: number;            // total count in last 60s
  messagesPerMinuteSeries: number[];    // 12 buckets × 5s, oldest first
  errorCount5min: number;               // Fastify 5xx responses in last 5m
  recentSecurityEvents: AdminSecurityEvent[];
}

// ──────────────────────────────────────────────────────────────────────────
// presence (S2 REQ-099..105) — room-scoped AFK-aware presence model.
//
// Parallel to the pre-existing S1 `presence.state` event (global fanout,
// online/afk/offline). This new model fans out per-room, uses "away" as the
// idle label (matching v3.docx §2.2.3 wording), and derives offline strictly
// from socket refcount — see apps/backend/src/lib/presence.ts.
//
// Kept as a separate event name (`presence.changed`, not `presence.state`) so
// S1 consumers do not silently shift schemas. Both events can coexist until
// the old one is retired. Name `UserPresenceState` avoids a collision with
// the existing `PresenceState` alias above.
// ──────────────────────────────────────────────────────────────────────────

export type UserPresenceState = "online" | "away" | "offline";

export interface PresenceChangedEvent {
  type: "presence.changed";
  userId: string;
  state: UserPresenceState;
  updatedAt: string;                    // ISO timestamp
}

// Clients may only assert online/away; offline derives from connectedSockets === 0.
export interface PresenceSetStatePayload {
  state: Exclude<UserPresenceState, "offline">;
}

// ──────────────────────────────────────────────────────────────────────────
// GDPR export (REQ-126 / REQ-127 — v3.docx §2.2). Returned by
// `POST /api/v1/users/me/export` as a JSON attachment. Shape captures every
// piece of content authored by or tied to the user: profile, rooms joined,
// messages sent (both group rooms and DMs), friendships, and active sessions.
// Attachments are referenced by id + originalName but NOT inlined — the bytes
// stay on disk; the export is a manifest, not an archive, because REQ-126 is
// "user's content" in the portability sense.
// ──────────────────────────────────────────────────────────────────────────

export interface UserDataExportAttachment {
  id: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
}

export interface UserDataExportMessage {
  id: string;
  roomId: string;
  roomName: string;
  seq: string;                          // bigint as string
  body: string;
  createdAt: string;                    // ISO timestamp
  attachments: UserDataExportAttachment[];
}

export interface UserDataExportDm {
  dmId: string;
  peerUsername: string;                 // "[deleted user]" if peer soft-deleted
  messages: UserDataExportMessage[];
}

export interface UserDataExport {
  exportedAt: string;                   // ISO timestamp
  user: {
    id: string;
    email: string;
    username: string;
    createdAt: string;
  };
  rooms: Array<{
    id: string;
    name: string;
    kind: string;                       // 'group' | 'dm' (mirrors room.kind)
    joinedAt: string;                   // room_member.joinedAt ISO
  }>;
  messages: UserDataExportMessage[];    // group-room messages by this user
  directMessages: UserDataExportDm[];   // DM threads, grouped by counterparty
  friendships: Array<{
    friendUsername: string;             // "[deleted user]" if counterparty soft-deleted
    since: string;                      // friendship.createdAt ISO
  }>;
  sessions: Array<{
    id: string;
    createdAt: string;
    lastActiveAt: string;
    userAgent?: string;
  }>;
}
