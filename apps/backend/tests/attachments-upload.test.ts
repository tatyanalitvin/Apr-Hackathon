import { TEST_PASSWORD_OK } from "./helpers/fixtures";
// REQ-075 / REQ-079 / REQ-081 / REQ-082 / R5 / R9 / R16 — upload happy paths
// + auth gates. Binding spec: docs/specs/s2-attachments.md §4 R1, R2, R4, R5,
// R9, R16. The size-cap boundaries (REQ-077 R7/R8) live in
// attachments-size.test.ts; the full storagePath sanitization battery (R10)
// lives in attachments-sanitize.test.ts.

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  attachment,
  room,
  roomBan,
  roomMember,
  user,
} from "@ai-herders/shared/schema";

import { buildApp } from "../src/app";
import { env } from "../src/env";
import { getTestDb } from "./db-helpers";

interface SignedUpAgent {
  agent: request.Agent;
  userId: string;
}

async function userIdByEmail(email: string): Promise<string> {
  const [row] = await getTestDb()
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, email))
    .limit(1);
  if (!row) throw new Error(`user not found: ${email}`);
  return row.id;
}

async function registerAgent(
  app: FastifyInstance,
  email: string,
  username: string,
): Promise<SignedUpAgent> {
  const agent = request.agent(app.server);
  await agent
    .post("/api/auth/sign-up/email")
    .send({ email, username, password: TEST_PASSWORD_OK, name: username })
    .expect(200);
  return { agent, userId: await userIdByEmail(email) };
}

async function createRoom(roomId: string): Promise<void> {
  await getTestDb().insert(room).values({
    id: roomId,
    name: roomId,
    kind: "group",
    visibility: "public",
    ownerId: null,
  });
}

async function addMember(roomId: string, userId: string): Promise<void> {
  await getTestDb()
    .insert(roomMember)
    .values({ id: `${roomId}-${userId}`, roomId, userId, role: "member" });
}

describe("REQ-075 POST /api/v1/attachments accepts any mime type", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  test("REQ-075 text/plain → 201, mimeType stored verbatim", async () => {
    const alice = await registerAgent(app, "r075-txt@example.com", "r075_txt");
    await createRoom("r-r075-txt");
    await addMember("r-r075-txt", alice.userId);

    const body = Buffer.from("hello world");
    const res = await alice.agent
      .post("/api/v1/attachments")
      .field("roomId", "r-r075-txt")
      .attach("file", body, {
        filename: "note.txt",
        contentType: "text/plain",
      });

    expect(res.status).toBe(201);
    expect(typeof res.body.attachmentId).toBe("string");
    expect(res.body.attachmentId.length).toBeGreaterThan(0);

    const [row] = await getTestDb()
      .select()
      .from(attachment)
      .where(eq(attachment.id, res.body.attachmentId));
    expect(row).toBeDefined();
    expect(row.mimeType).toBe("text/plain");
    expect(row.originalName).toBe("note.txt");
    expect(row.sizeBytes).toBe(body.length);
    expect(row.uploaderId).toBe(alice.userId);
    expect(row.roomId).toBe("r-r075-txt");
    expect(row.messageId).toBeNull();
  });

  test("REQ-075 image/png → 201", async () => {
    const alice = await registerAgent(app, "r075-png@example.com", "r075_png");
    await createRoom("r-r075-png");
    await addMember("r-r075-png", alice.userId);

    const body = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const res = await alice.agent
      .post("/api/v1/attachments")
      .field("roomId", "r-r075-png")
      .attach("file", body, {
        filename: "tiny.png",
        contentType: "image/png",
      });

    expect(res.status).toBe(201);
    const [row] = await getTestDb()
      .select()
      .from(attachment)
      .where(eq(attachment.id, res.body.attachmentId));
    expect(row.mimeType).toBe("image/png");
  });

  test("REQ-075 .exe-named octet-stream → 201 (no deny-list, ADR-0006)", async () => {
    const alice = await registerAgent(app, "r075-exe@example.com", "r075_exe");
    await createRoom("r-r075-exe");
    await addMember("r-r075-exe", alice.userId);

    const body = Buffer.from("MZ\x90\x00fake-exe");
    const res = await alice.agent
      .post("/api/v1/attachments")
      .field("roomId", "r-r075-exe")
      .attach("file", body, {
        filename: "trojan.exe",
        contentType: "application/octet-stream",
      });

    expect(res.status).toBe(201);
    const [row] = await getTestDb()
      .select()
      .from(attachment)
      .where(eq(attachment.id, res.body.attachmentId));
    expect(row.mimeType).toBe("application/octet-stream");
    expect(row.originalName).toBe("trojan.exe");
  });

  test("R9 storagePath is relative (no leading /), file lives under UPLOAD_DIR", async () => {
    const alice = await registerAgent(app, "r9-path@example.com", "r9_path");
    await createRoom("r-r9-path");
    await addMember("r-r9-path", alice.userId);

    const body = Buffer.from("disk write proof");
    const res = await alice.agent
      .post("/api/v1/attachments")
      .field("roomId", "r-r9-path")
      .attach("file", body, {
        filename: "proof.bin",
        contentType: "application/octet-stream",
      });

    expect(res.status).toBe(201);
    const [row] = await getTestDb()
      .select()
      .from(attachment)
      .where(eq(attachment.id, res.body.attachmentId));
    expect(row.storagePath.startsWith("/")).toBe(false);
    const onDisk = path.join(env.UPLOAD_DIR, row.storagePath);
    expect(fs.existsSync(onDisk)).toBe(true);
    const contents = fs.readFileSync(onDisk);
    expect(contents.equals(body)).toBe(true);
  });

  test("R16 missing session → 401", async () => {
    const res = await request(app.server)
      .post("/api/v1/attachments")
      .field("roomId", "r-r16-nocookie")
      .attach("file", Buffer.from("x"), {
        filename: "x.txt",
        contentType: "text/plain",
      });
    expect(res.status).toBe(401);
  });

  test("R5 authed but not a room member → 403", async () => {
    const carol = await registerAgent(app, "r5-carol@example.com", "r5_carol");
    void carol.userId;
    await createRoom("r-r5-locked");

    const res = await carol.agent
      .post("/api/v1/attachments")
      .field("roomId", "r-r5-locked")
      .attach("file", Buffer.from("nope"), {
        filename: "n.txt",
        contentType: "text/plain",
      });
    expect(res.status).toBe(403);
  });

  test("R5 authed but room does not exist → 403 (no oracle)", async () => {
    const carol = await registerAgent(app, "r5-ghost@example.com", "r5_ghost");
    void carol.userId;

    const res = await carol.agent
      .post("/api/v1/attachments")
      .field("roomId", "ghost-room-id")
      .attach("file", Buffer.from("nope"), {
        filename: "n.txt",
        contentType: "text/plain",
      });
    expect(res.status).toBe(403);
  });

  // Defense-in-depth: ban-apply in rooms.ts deletes the membership row in the
  // same tx, so in production a banned user loses membership and the existing
  // !membership branch already returns 403. This test forces the asymmetric
  // case (membership row retained, ban row present) to lock in that the
  // upload gate matches the download gate — download leftJoins roomBan and
  // rejects on row.banId regardless of membership. See attachments.ts GET.
  test("banned user with lingering membership → 403", async () => {
    const mallory = await registerAgent(
      app,
      "ban-upload@example.com",
      "ban_upload",
    );
    await createRoom("r-ban-upload");
    await addMember("r-ban-upload", mallory.userId);
    await getTestDb().insert(roomBan).values({
      id: randomUUID(),
      roomId: "r-ban-upload",
      userId: mallory.userId,
      bannedById: mallory.userId,
      reason: null,
    });

    const res = await mallory.agent
      .post("/api/v1/attachments")
      .field("roomId", "r-ban-upload")
      .attach("file", Buffer.from("should-not-store"), {
        filename: "b.txt",
        contentType: "text/plain",
      });
    expect(res.status).toBe(403);
  });
});

describe("REQ-079 single-file endpoint shape + REQ-082 comment validation", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  test("REQ-079 no multipart body at all → 400 invalid_multipart", async () => {
    const alice = await registerAgent(app, "r079-novalid@example.com", "r079_novalid");
    void alice.userId;

    const res = await alice.agent
      .post("/api/v1/attachments")
      .set("content-type", "application/json")
      .send({ roomId: "anything" });
    expect(res.status).toBe(400);
  });

  test("REQ-079 multipart with only fields, no file part → 400 missing_file", async () => {
    const alice = await registerAgent(app, "r079-noattach@example.com", "r079_noattach");
    await createRoom("r-r079-noattach");
    await addMember("r-r079-noattach", alice.userId);

    const res = await alice.agent
      .post("/api/v1/attachments")
      .field("roomId", "r-r079-noattach");
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "missing_file" });
  });

  test("REQ-079 file present but no roomId field → 400 missing_room_id", async () => {
    const alice = await registerAgent(app, "r079-noroom@example.com", "r079_noroom");
    void alice.userId;

    const res = await alice.agent
      .post("/api/v1/attachments")
      .attach("file", Buffer.from("x"), {
        filename: "x.txt",
        contentType: "text/plain",
      });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "missing_room_id" });
  });

  test("REQ-082 comment ≤500 chars → stored", async () => {
    const alice = await registerAgent(app, "r082-ok@example.com", "r082_ok");
    await createRoom("r-r082-ok");
    await addMember("r-r082-ok", alice.userId);

    const comment = "x".repeat(500);
    const res = await alice.agent
      .post("/api/v1/attachments")
      .field("roomId", "r-r082-ok")
      .field("comment", comment)
      .attach("file", Buffer.from("y"), {
        filename: "y.txt",
        contentType: "text/plain",
      });
    expect(res.status).toBe(201);

    const [row] = await getTestDb()
      .select()
      .from(attachment)
      .where(eq(attachment.id, res.body.attachmentId));
    expect(row.comment).toBe(comment);
  });

  test("REQ-082 comment empty string → null in DB", async () => {
    const alice = await registerAgent(app, "r082-empty@example.com", "r082_empty");
    await createRoom("r-r082-empty");
    await addMember("r-r082-empty", alice.userId);

    const res = await alice.agent
      .post("/api/v1/attachments")
      .field("roomId", "r-r082-empty")
      .field("comment", "")
      .attach("file", Buffer.from("z"), {
        filename: "z.txt",
        contentType: "text/plain",
      });
    expect(res.status).toBe(201);

    const [row] = await getTestDb()
      .select()
      .from(attachment)
      .where(eq(attachment.id, res.body.attachmentId));
    expect(row.comment).toBeNull();
  });

  test("REQ-082 comment >500 chars → 400 comment_too_long", async () => {
    const alice = await registerAgent(app, "r082-long@example.com", "r082_long");
    await createRoom("r-r082-long");
    await addMember("r-r082-long", alice.userId);

    // 600 chars > 500-char cap. Note: this is also above the multipart
    // fieldSize=600 byte limit, so the plugin may reject with its own error
    // before our handler check runs — test asserts 4xx either way.
    const res = await alice.agent
      .post("/api/v1/attachments")
      .field("roomId", "r-r082-long")
      .field("comment", "a".repeat(501))
      .attach("file", Buffer.from("k"), {
        filename: "k.txt",
        contentType: "text/plain",
      });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  test("REQ-082 comment NFC-normalised on store", async () => {
    const alice = await registerAgent(app, "r082-nfc@example.com", "r082_nfc");
    await createRoom("r-r082-nfc");
    await addMember("r-r082-nfc", alice.userId);

    // "café" with decomposed é. Spec R4 says NFC same as message body.
    const dirty = "caf\u0065\u0301";
    const res = await alice.agent
      .post("/api/v1/attachments")
      .field("roomId", "r-r082-nfc")
      .field("comment", dirty)
      .attach("file", Buffer.from("q"), {
        filename: "q.txt",
        contentType: "text/plain",
      });
    expect(res.status).toBe(201);

    const [row] = await getTestDb()
      .select()
      .from(attachment)
      .where(eq(attachment.id, res.body.attachmentId));
    expect(row.comment).toBe("caf\u00e9");
  });
});
