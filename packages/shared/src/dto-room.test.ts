// REQ-021 / REQ-022 Zod validation for POST /api/v1/rooms payloads.
// Binding spec: docs/specs/s1-rooms.md §4 R2, R3, R15.

import { describe, expect, test } from "vitest";
import { createRoomSchema, roomCreateResponseSchema } from "./dto";

describe("REQ-021 createRoomSchema.name validation", () => {
  test("REQ-021 rejects name shorter than 3 chars", () => {
    const res = createRoomSchema.safeParse({ name: "ab" });
    expect(res.success).toBe(false);
  });

  test("REQ-021 rejects name longer than 64 chars", () => {
    const res = createRoomSchema.safeParse({ name: "a".repeat(65) });
    expect(res.success).toBe(false);
  });

  test("REQ-021 rejects name with forbidden characters", () => {
    const res = createRoomSchema.safeParse({ name: "hi$" });
    expect(res.success).toBe(false);
  });

  test("REQ-021 accepts valid name with letters digits space underscore hyphen", () => {
    const res = createRoomSchema.safeParse({ name: "Book Club_42-x" });
    expect(res.success).toBe(true);
    if (res.success) expect(res.data.name).toBe("Book Club_42-x");
  });

  test("REQ-021 trims surrounding whitespace before validating length", () => {
    const res = createRoomSchema.safeParse({ name: "   Book Club   " });
    expect(res.success).toBe(true);
    if (res.success) expect(res.data.name).toBe("Book Club");
  });
});

describe("REQ-022 createRoomSchema.description validation", () => {
  test("REQ-022 accepts omitted description (stored as undefined)", () => {
    const res = createRoomSchema.safeParse({ name: "Test Room" });
    expect(res.success).toBe(true);
    if (res.success) expect(res.data.description).toBeUndefined();
  });

  test("REQ-022 rejects description longer than 500 chars", () => {
    const res = createRoomSchema.safeParse({
      name: "Test Room",
      description: "x".repeat(501),
    });
    expect(res.success).toBe(false);
  });

  test("REQ-022 strips ASCII control characters (e.g. bell \\u0007)", () => {
    const res = createRoomSchema.safeParse({
      name: "Test Room",
      description: "hello\u0007world",
    });
    expect(res.success).toBe(true);
    if (res.success) expect(res.data.description).toBe("helloworld");
  });

  test("REQ-022 NFC-normalizes combining marks in description", () => {
    const res = createRoomSchema.safeParse({
      name: "Test Room",
      description: "Cafe\u0301",
    });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.description).toBe("Café".normalize("NFC"));
    }
  });
});

describe("REQ-015 roomCreateResponseSchema shape", () => {
  test("REQ-015 accepts a valid response shape with all required keys", () => {
    const res = roomCreateResponseSchema.safeParse({
      id: "room-123",
      name: "Book Club",
      description: null,
      visibility: "public",
      ownerId: "user-abc",
      createdAt: "2026-04-19T12:00:00.000Z",
    });
    expect(res.success).toBe(true);
  });

  test("REQ-015 rejects a response with a non-public visibility", () => {
    const res = roomCreateResponseSchema.safeParse({
      id: "room-123",
      name: "Book Club",
      description: null,
      visibility: "private",
      ownerId: "user-abc",
      createdAt: "2026-04-19T12:00:00.000Z",
    });
    expect(res.success).toBe(false);
  });

  test("REQ-015 rejects a response missing ownerId", () => {
    const res = roomCreateResponseSchema.safeParse({
      id: "room-123",
      name: "Book Club",
      description: null,
      visibility: "public",
      createdAt: "2026-04-19T12:00:00.000Z",
    });
    expect(res.success).toBe(false);
  });
});
