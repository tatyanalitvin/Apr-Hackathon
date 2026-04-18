import { describe, expect, test } from "vitest";
import { sendFriendRequestSchema } from "@ai-herders/shared/dto";

// Unit coverage for the zod delta landed as the first S2 friendship commit.
// REQ-051 allows targeting by username OR by userId so the contacts-panel
// "add friend" flow (REQ-052) can call the API with the userId it already has
// without a username round-trip.

describe("REQ-051 sendFriendRequestSchema accepts toUsername OR toUserId variant", () => {
  test("REQ-051 accepts { toUsername }", () => {
    expect(sendFriendRequestSchema.safeParse({ toUsername: "alice" }).success).toBe(true);
  });

  test("REQ-051 accepts { toUserId }", () => {
    expect(
      sendFriendRequestSchema.safeParse({ toUserId: "usr_01abc" }).success,
    ).toBe(true);
  });

  test("REQ-051 accepts { toUsername, message }", () => {
    expect(
      sendFriendRequestSchema.safeParse({ toUsername: "alice", message: "hey" }).success,
    ).toBe(true);
  });

  test("REQ-051 accepts { toUserId, message }", () => {
    expect(
      sendFriendRequestSchema.safeParse({ toUserId: "usr_01abc", message: "hey" }).success,
    ).toBe(true);
  });

  test("REQ-051 rejects neither toUsername nor toUserId", () => {
    expect(sendFriendRequestSchema.safeParse({ message: "hi" }).success).toBe(false);
  });

  test("REQ-051 rejects message over 500 chars", () => {
    expect(
      sendFriendRequestSchema.safeParse({
        toUsername: "alice",
        message: "a".repeat(501),
      }).success,
    ).toBe(false);
  });

  test("REQ-051 rejects bad username (regex guard still applies on toUsername branch)", () => {
    expect(
      sendFriendRequestSchema.safeParse({ toUsername: "bad name" }).success,
    ).toBe(false);
  });
});
