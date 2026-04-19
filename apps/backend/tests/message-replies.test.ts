// REQ-110 (parent validation / history hydration / payload shape / DM parity)
// REQ-133 (reply composer)
// Binding spec: docs/specs/s2-replies.md.
//
// This file grows through tasks 1–9 of the spec's §6. Task 1 lands the zod
// R1 assertions + a type-shape sanity check on MessagePayload.replyTo.
// Tasks 3–9 append integration tests for send validation, history hydration,
// truncation, DM parity, edit/delete pass-through, dedup invariants.

import { describe, expect, test } from "vitest";
import { sendMessageSchema } from "@ai-herders/shared/dto";
import {
  REPLY_PREVIEW_ELLIPSIS,
  REPLY_PREVIEW_MAX,
  type MessagePayload,
} from "@ai-herders/shared/protocol";

describe("REQ-133 sendMessageSchema.replyToId — R1 UUID tightening", () => {
  test("REQ-133 R1 accepts omitted replyToId", () => {
    expect(sendMessageSchema.safeParse({ body: "hi" }).success).toBe(true);
  });

  test("REQ-133 R1 accepts a valid v4 UUID", () => {
    const result = sendMessageSchema.safeParse({
      body: "hi",
      replyToId: "123e4567-e89b-12d3-a456-426614174000",
    });
    expect(result.success).toBe(true);
  });

  test("REQ-133 R1 rejects a non-UUID string", () => {
    const result = sendMessageSchema.safeParse({
      body: "hi",
      replyToId: "not-a-uuid",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      // The validation issue must point at `replyToId` so the FE can surface a
      // field-specific error instead of a generic 400.
      const issuePaths = result.error.issues.map((i) => i.path.join("."));
      expect(issuePaths).toContain("replyToId");
    }
  });

  test("REQ-133 R1 rejects empty string replyToId (caught by uuid guard)", () => {
    expect(
      sendMessageSchema.safeParse({ body: "hi", replyToId: "" }).success,
    ).toBe(false);
  });
});

describe("REQ-110 protocol — R5 MessagePayload.replyTo wire shape", () => {
  test("REQ-110 R5 MessagePayload.replyTo is optional-but-present (null when absent)", () => {
    // Type-level compile check + a structural smoke: construct a payload both
    // with and without replyTo and assert the field is part of the shape.
    const withoutReply: MessagePayload = {
      id: "m1",
      roomId: "r1",
      authorId: "u1",
      authorUsername: "alice",
      authorName: "Alice",
      body: "hi",
      seq: "1",
      replyToId: null,
      replyTo: null,
      editedAt: null,
      deletedAt: null,
      createdAt: "2026-04-19T00:00:00.000Z",
    };
    const withReply: MessagePayload = {
      ...withoutReply,
      id: "m2",
      seq: "2",
      replyToId: "m1",
      replyTo: {
        id: "m1",
        text: "hi",
        authorUsername: "alice",
        deletedAt: null,
      },
    };
    expect(withoutReply.replyTo).toBeNull();
    expect(withReply.replyTo?.id).toBe("m1");
    expect(withReply.replyTo?.text).toBe("hi");
    expect(withReply.replyTo?.authorUsername).toBe("alice");
    expect(withReply.replyTo?.deletedAt).toBeNull();
  });

  test("REQ-110 R7 preview truncation constants exported from protocol", () => {
    expect(REPLY_PREVIEW_MAX).toBe(120);
    expect(REPLY_PREVIEW_ELLIPSIS).toBe("\u2026");
  });
});
