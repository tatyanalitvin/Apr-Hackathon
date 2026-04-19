// Request / response contracts — shared between web and backend.
// All boundaries validate via these schemas; never trust raw JSON.

import { z } from "zod";

// §2.1 username: 3–32 chars, [A-Za-z0-9_]
export const usernameSchema = z
  .string()
  .min(3)
  .max(32)
  .regex(/^[a-zA-Z0-9_]+$/, "username must be alphanumeric + underscore only");

// §2.5.2 message body — up to 3 KB UTF-8.
export const messageBodySchema = z.string().min(1).max(3072);

// ──────────────────────────────────────────────────────────────────────────
// Auth (§2.1 / §2.2)
// ──────────────────────────────────────────────────────────────────────────

export const registerSchema = z.object({
  email: z.email(),
  username: usernameSchema,
  password: z.string().min(8).max(256),
  name: z.string().min(1).max(64),
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: z.email(),
  password: z.string().min(1),
  rememberMe: z.boolean().optional(),
});
export type LoginInput = z.infer<typeof loginSchema>;

// ──────────────────────────────────────────────────────────────────────────
// Messages (§2.5)
// ──────────────────────────────────────────────────────────────────────────

export const sendMessageSchema = z.object({
  body: messageBodySchema,
  replyToId: z.string().optional(),
  attachmentIds: z.array(z.string()).max(10).optional(),
  // REQ-033 idempotency key — if present, a duplicate submission returns the
  // original row without a new insert. UUID format to keep it free of ambient
  // meaning; enforced via partial unique index (roomId, clientMessageId).
  clientMessageId: z.uuid().optional(),
});
export type SendMessageInput = z.infer<typeof sendMessageSchema>;

export const editMessageSchema = z.object({
  body: messageBodySchema,
});
export type EditMessageInput = z.infer<typeof editMessageSchema>;

// History endpoint used by client gap-detection.
// GET /api/v1/rooms/:id/messages?fromSeq=<n>&toSeq=<n>
export const historyQuerySchema = z.object({
  fromSeq: z.coerce.bigint().optional(),
  toSeq: z.coerce.bigint().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type HistoryQuery = z.infer<typeof historyQuerySchema>;

// ──────────────────────────────────────────────────────────────────────────
// Friendships (§2.3)
// ──────────────────────────────────────────────────────────────────────────

// REQ-051: target can be specified by username OR userId. The userId branch
// serves REQ-052 (contacts-panel "add friend"), where the caller already has
// the target userId and a username round-trip would be redundant.
export const sendFriendRequestSchema = z.union([
  z.object({
    toUsername: usernameSchema,
    message: z.string().max(500).optional(),
  }),
  z.object({
    toUserId: z.string().min(1),
    message: z.string().max(500).optional(),
  }),
]);
export type SendFriendRequestInput = z.infer<typeof sendFriendRequestSchema>;

// ──────────────────────────────────────────────────────────────────────────
// Direct messages (§2.4 DM = room with kind='dm'; see ADR-0007)
// ──────────────────────────────────────────────────────────────────────────

// REQ-061 find-or-create target. UserId only — REQ-052 analogue (contacts-
// panel "start DM" already has the target userId in session state). REQ-level
// username-based DM creation is not required; DTO stays minimal.
export const createDmSchema = z.object({
  userId: z.string().min(1),
});
export type CreateDmInput = z.infer<typeof createDmSchema>;
