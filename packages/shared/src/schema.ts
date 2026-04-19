// Drizzle schema — single source of truth for the chat server data model.
// Exact import surface verified via Context7 on 2026-04-18.
//
// Watermark: every row in `message` carries a per-room monotonic `seq`, allocated
// atomically by Fastify on INSERT (advisory lock or SELECT ... FOR UPDATE against
// `message_seq`). Broadcasts emit {seq, room_head_seq}; clients gap-detect and
// backfill via history endpoint. See docs/adr/0003-watermark-protocol.md (S1).

import { relations, sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// ──────────────────────────────────────────────────────────────────────────
// Enums
// ──────────────────────────────────────────────────────────────────────────

export const roomKind = pgEnum("room_kind", ["group", "dm"]);
export const roomVisibility = pgEnum("room_visibility", ["public", "private"]);
export const roomRole = pgEnum("room_role", ["owner", "admin", "member"]);
export const friendRequestStatus = pgEnum("friend_request_status", [
  "pending",
  "accepted",
  "rejected",
]);
export const roomInviteStatus = pgEnum("room_invite_status", [
  "pending",
  "accepted",
  "declined",
  "expired",
]);

// ──────────────────────────────────────────────────────────────────────────
// better-auth core tables (v3.docx §2.1, §2.2.4)
// Names/columns follow better-auth defaults so the drizzleAdapter maps 1:1.
// ──────────────────────────────────────────────────────────────────────────

export const user = pgTable(
  "user",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    // REQ-003 — uniqueness is enforced by `user_email_ci_uq` (LOWER(email))
    // below. better-auth already lowercases at sign-up/sign-in; the expression
    // index is defense-in-depth against a rogue direct INSERT.
    email: text("email").notNull(),
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),
    // §2.1.2 NOT NULL, immutable after creation.
    // NOT NULL is enforced atomically with the user-row insert via
    // better-auth's `user.additionalFields.username` (see apps/backend/src/auth.ts
    // and docs/specs/s1-auth.md §5 + §10 decision log).
    // REQ-005 — uniqueness is enforced by `user_username_ci_uq` (LOWER(username))
    // below. The sign-up `databaseHooks.user.create.before` normalizes to
    // lowercase at write time (additionalFields aren't lowercased by better-auth).
    username: text("username").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => ({
    emailCiUq: uniqueIndex("user_email_ci_uq").on(sql`lower(${t.email})`),
    usernameCiUq: uniqueIndex("user_username_ci_uq").on(sql`lower(${t.username})`),
  }),
);

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  password: text("password"),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
  scope: text("scope"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// No index on expires_at: at <1k rows/day and 300 concurrent users,
// a seq scan during cleanup is cheap. Revisit if row count crosses ~100k.
export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ──────────────────────────────────────────────────────────────────────────
// Rooms (§2.4) + per-room seq counter (watermark allocator)
// ──────────────────────────────────────────────────────────────────────────

export const room = pgTable(
  "room",
  {
    id: text("id").primaryKey(),
    // §2.4.2 unique for group rooms. Nullable because DM rooms derive display names.
    // Uniqueness is now enforced by the `nameCiUq` partial index below — case-insensitive,
    // scoped to kind='group' + non-soft-deleted rows. See docs/specs/s1-rooms.md §5.
    name: text("name"),
    description: text("description"),
    kind: roomKind("kind").notNull().default("group"),
    visibility: roomVisibility("visibility").notNull().default("public"),
    ownerId: text("owner_id").references(() => user.id, { onDelete: "set null" }),
    // s2-dms R2 / ADR-0007 — canonical "userALow:userBHigh" key for DM
    // rooms. Populated by `POST /api/v1/dms`; NULL on group rooms (the
    // partial unique index below excludes them). The key is sorted
    // lexicographically by the caller so idempotent creates are an
    // ON CONFLICT at the DB boundary.
    dmPairKey: text("dm_pair_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => ({
    visibilityIdx: index("room_visibility_idx").on(t.visibility, t.deletedAt),
    kindIdx: index("room_kind_idx").on(t.kind),
    // Partial unique index — enforces one-DM-per-pair only when kind='dm'.
    // Group rooms may freely carry NULL dm_pair_key without colliding.
    dmPairUq: uniqueIndex("room_dm_pair_uq")
      .on(t.dmPairKey)
      .where(sql`${t.kind} = 'dm'`),
    // REQ-021 — case-insensitive uniqueness for group-room names. Partial so
    // DM rooms (name=NULL) and soft-deleted rows don't compete in the namespace.
    nameCiUq: uniqueIndex("room_name_ci_uq")
      .on(sql`lower(${t.name})`)
      .where(sql`${t.kind} = 'group' AND ${t.deletedAt} IS NULL`),
  }),
);

// Per-room monotonic seq counter. Fastify mutates with a row-level lock before
// INSERTing into `message`, guaranteeing no gaps within a room.
export const messageSeq = pgTable("message_seq", {
  roomId: text("room_id")
    .primaryKey()
    .references(() => room.id, { onDelete: "cascade" }),
  // SQL literal default avoids drizzle-kit 0.31's BigInt-JSON-serialize bug
  // (see github.com/drizzle-team/drizzle-orm issues around `default(0n)`).
  seq: bigint("seq", { mode: "bigint" }).notNull().default(sql`0`),
});

// §2.4.2 members + admins (role discriminator)
export const roomMember = pgTable(
  "room_member",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    roomId: text("room_id")
      .notNull()
      .references(() => room.id, { onDelete: "cascade" }),
    role: roomRole("role").notNull().default("member"),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
    // §2.7 unread counter pointer — per-room seq watermark the user has read through.
    lastReadSeq: bigint("last_read_seq", { mode: "bigint" }).notNull().default(sql`0`),
    // §2.7.3 mute/unmute per room (S1 legacy boolean; superseded by mutedUntil).
    muted: boolean("muted").notNull().default(false),
    // REQ-123 — timed mute. NULL = unmuted. Future timestamp = muted until that
    // instant; past timestamp is treated as unmuted at read time (no sweeper
    // needed). Additive alongside the S1 `muted` boolean; the unread hook only
    // reads `mutedUntil` so the boolean can retire in a later S3 cleanup.
    mutedUntil: timestamp("muted_until", { withTimezone: true }),
  },
  (t) => ({
    userRoomUq: uniqueIndex("room_member_user_room_uq").on(t.userId, t.roomId),
    roomIdx: index("room_member_room_idx").on(t.roomId),
  }),
);

// §2.4.8 per-room user ban
export const roomBan = pgTable(
  "room_ban",
  {
    id: text("id").primaryKey(),
    roomId: text("room_id")
      .notNull()
      .references(() => room.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    bannedById: text("banned_by_id")
      .notNull()
      .references(() => user.id),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    roomUserUq: uniqueIndex("room_ban_room_user_uq").on(t.roomId, t.userId),
  }),
);

// §2.4.9 invites to private rooms — REQ-089 / REQ-089a.
// Partial UNIQUE on status='pending' means (roomId,inviteeId) can host
// multiple historical rows (declined, accepted, expired) but at most one
// live pending invite. expires_at defaults to now()+14d per REQ-089a.
export const roomInvite = pgTable(
  "room_invite",
  {
    id: text("id").primaryKey(),
    roomId: text("room_id")
      .notNull()
      .references(() => room.id, { onDelete: "cascade" }),
    inviteeId: text("invitee_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    inviterId: text("inviter_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    status: roomInviteStatus("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    respondedAt: timestamp("responded_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true })
      .notNull()
      .default(sql`(now() + interval '14 days')`),
  },
  (t) => ({
    roomInviteePendingUq: uniqueIndex("room_invite_room_invitee_pending_uq")
      .on(t.roomId, t.inviteeId)
      .where(sql`${t.status} = 'pending'`),
    inviteeStatusIdx: index("room_invite_invitee_status_idx").on(t.inviteeId, t.status),
  }),
);

// ──────────────────────────────────────────────────────────────────────────
// Messages (§2.5)
// ──────────────────────────────────────────────────────────────────────────

export const message = pgTable(
  "message",
  {
    id: text("id").primaryKey(),
    roomId: text("room_id")
      .notNull()
      .references(() => room.id, { onDelete: "cascade" }),
    authorId: text("author_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // Snapshot of the author's identity AT SEND TIME. Denormalised so
    // username/display-name changes don't retroactively rewrite chat
    // history (Slack/Discord-style audit semantics). See protocol.ts.
    authorUsername: text("author_username").notNull(),
    authorName: text("author_name").notNull(),
    // Per-room monotonic sequence — the watermark. Unique (roomId, seq).
    seq: bigint("seq", { mode: "bigint" }).notNull(),
    // §2.5.2 up to 3 KB UTF-8, enforced in DTO.
    body: text("body").notNull(),
    // REQ-033 idempotency: client-generated UUID. Partial unique index below
    // keeps NULLs unconstrained so legacy / non-idempotent sends don't collide.
    clientMessageId: text("client_message_id"),
    replyToId: text("reply_to_id"),
    // §2.5.4 "edited" indicator
    editedAt: timestamp("edited_at", { withTimezone: true }),
    // §2.5.5 soft-delete
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    roomSeqUq: uniqueIndex("message_room_seq_uq").on(t.roomId, t.seq),
    // Partial unique index — enforces dedup when clientMessageId is present
    // without forcing NULLs to collide.
    roomClientMsgUq: uniqueIndex("message_room_client_msg_uq")
      .on(t.roomId, t.clientMessageId)
      .where(sql`${t.clientMessageId} IS NOT NULL`),
    roomCreatedIdx: index("message_room_created_idx").on(t.roomId, t.createdAt),
    authorIdx: index("message_author_idx").on(t.authorId),
  }),
);

// ──────────────────────────────────────────────────────────────────────────
// Friendships (§2.3)
// ──────────────────────────────────────────────────────────────────────────

export const friendRequest = pgTable(
  "friend_request",
  {
    id: text("id").primaryKey(),
    fromId: text("from_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    toId: text("to_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // §2.3.2 optional message body
    message: text("message"),
    status: friendRequestStatus("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    respondedAt: timestamp("responded_at", { withTimezone: true }),
  },
  (t) => ({
    fromToUq: uniqueIndex("friend_request_from_to_uq").on(t.fromId, t.toId),
    toStatusIdx: index("friend_request_to_status_idx").on(t.toId, t.status),
  }),
);

// Accepted friendships. Normalize so userAId < userBId for the unique pair.
export const friendship = pgTable(
  "friendship",
  {
    id: text("id").primaryKey(),
    userAId: text("user_a_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    userBId: text("user_b_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pairUq: uniqueIndex("friendship_pair_uq").on(t.userAId, t.userBId),
    userBIdx: index("friendship_user_b_idx").on(t.userBId),
  }),
);

// §2.3.5 user-to-user block (one-way)
export const userBlock = pgTable(
  "user_block",
  {
    id: text("id").primaryKey(),
    byId: text("by_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    targetId: text("target_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byTargetUq: uniqueIndex("user_block_by_target_uq").on(t.byId, t.targetId),
    targetIdx: index("user_block_target_idx").on(t.targetId),
  }),
);

// ──────────────────────────────────────────────────────────────────────────
// Attachments (§2.6) — files on local FS, metadata in DB
// ──────────────────────────────────────────────────────────────────────────

export const attachment = pgTable(
  "attachment",
  {
    id: text("id").primaryKey(),
    // Null during upload (step 1), set on send (step 2).
    // TODO(S3-GC): sweep rows with messageId IS NULL older than 1h + delete
    // the orphaned file under UPLOAD_DIR. Tracked in docs/FOLLOWUPS.md (S3).
    messageId: text("message_id").references(() => message.id, { onDelete: "cascade" }),
    roomId: text("room_id")
      .notNull()
      .references(() => room.id, { onDelete: "cascade" }),
    uploaderId: text("uploader_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // §2.6.3 preserve original filename
    originalName: text("original_name").notNull(),
    // Relative path under UPLOAD_DIR; access-controlled read through Fastify.
    storagePath: text("storage_path").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    // §2.6.3 optional user-entered caption
    comment: text("comment"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    roomIdx: index("attachment_room_idx").on(t.roomId),
    messageIdx: index("attachment_message_idx").on(t.messageId),
  }),
);

// ──────────────────────────────────────────────────────────────────────────
// Relations (extend per feature in S1/S2)
// ──────────────────────────────────────────────────────────────────────────

export const userRelations = relations(user, ({ many }) => ({
  sessions: many(session),
  memberships: many(roomMember),
  messages: many(message),
  ownedRooms: many(room),
}));

export const roomRelations = relations(room, ({ many, one }) => ({
  owner: one(user, { fields: [room.ownerId], references: [user.id] }),
  members: many(roomMember),
  messages: many(message),
  bans: many(roomBan),
  invites: many(roomInvite),
  attachments: many(attachment),
}));

export const roomMemberRelations = relations(roomMember, ({ one }) => ({
  user: one(user, { fields: [roomMember.userId], references: [user.id] }),
  room: one(room, { fields: [roomMember.roomId], references: [room.id] }),
}));

export const messageRelations = relations(message, ({ one, many }) => ({
  room: one(room, { fields: [message.roomId], references: [room.id] }),
  author: one(user, { fields: [message.authorId], references: [user.id] }),
  attachments: many(attachment),
}));

export const attachmentRelations = relations(attachment, ({ one }) => ({
  message: one(message, { fields: [attachment.messageId], references: [message.id] }),
  room: one(room, { fields: [attachment.roomId], references: [room.id] }),
  uploader: one(user, { fields: [attachment.uploaderId], references: [user.id] }),
}));

// ──────────────────────────────────────────────────────────────────────────
// Inferred types — import as `type { User, Message } from "@ai-herders/shared"`
// ──────────────────────────────────────────────────────────────────────────

export type User = typeof user.$inferSelect;
export type NewUser = typeof user.$inferInsert;
export type Room = typeof room.$inferSelect;
export type Message = typeof message.$inferSelect;
export type NewMessage = typeof message.$inferInsert;
export type Attachment = typeof attachment.$inferSelect;
