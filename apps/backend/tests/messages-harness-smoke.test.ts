// Task 1 (s1-chat §6) — confirms the Testcontainers + truncateAll harness
// handles room / room_member / message_seq / message alongside the user table
// already covered by harness-smoke. Rig-only: no REQ tag (spec §6).
//
// If this file goes red, fix the harness before implementing chat routes.

import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  message,
  messageSeq,
  room,
  roomMember,
  user,
} from "@ai-herders/shared/schema";
import { getTestDb } from "./db-helpers";

describe("chat rig smoke", () => {
  it("inserts user/room/roomMember/messageSeq/message and reads them back", async () => {
    const db = getTestDb();

    await db.insert(user).values({
      id: "u-rig-1",
      name: "Rig User",
      email: "rig@example.com",
      username: "rig_user",
    });

    await db.insert(room).values({
      id: "r-rig-1",
      name: "rig-room",
      kind: "group",
      visibility: "public",
      ownerId: "u-rig-1",
    });

    await db.insert(roomMember).values({
      id: "rm-rig-1",
      userId: "u-rig-1",
      roomId: "r-rig-1",
      role: "owner",
    });

    await db.insert(messageSeq).values({
      roomId: "r-rig-1",
      seq: 1n,
    });

    await db.insert(message).values({
      id: "m-rig-1",
      roomId: "r-rig-1",
      authorId: "u-rig-1",
      seq: 1n,
      body: "hello rig",
    });

    const rows = await db
      .select()
      .from(message)
      .where(eq(message.roomId, "r-rig-1"));

    expect(rows).toHaveLength(1);
    expect(rows[0].body).toBe("hello rig");
    // bigint mode — the value comes back as bigint, not number/string.
    expect(rows[0].seq).toBe(1n);
  });

  it("sees zero rows after TRUNCATE — chat tables reset between tests", async () => {
    const db = getTestDb();
    expect(await db.select().from(message)).toHaveLength(0);
    expect(await db.select().from(messageSeq)).toHaveLength(0);
    expect(await db.select().from(roomMember)).toHaveLength(0);
    expect(await db.select().from(room)).toHaveLength(0);
  });
});
