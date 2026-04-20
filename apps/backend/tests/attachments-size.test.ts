import { TEST_PASSWORD_OK } from "./helpers/fixtures";
// REQ-077 / R7 / R8 — size-cap boundaries.
// Binding spec: docs/specs/s2-attachments.md §4 R7 (20MB file ceiling) and R8
// (3MB image ceiling). Two-layer enforcement:
//   R7: @fastify/multipart fileSize limit marks data.file.truncated. The
//   handler unlinks the partial file and returns 413 file_too_large.
//   R8: post-write byte count (bytesWritten) + mime.startsWith("image/"). Same
//   rollback: unlink + 413 image_too_large. Row never inserts.

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import {
  attachment,
  room,
  roomMember,
  user,
} from "@ai-herders/shared/schema";

import { buildApp } from "../src/app";
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

describe("REQ-077 R7 file ceiling — 20 MB", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  test("R7 file at exactly 20MB → 201", async () => {
    const alice = await registerAgent(app, "r7-at20@example.com", "r7_at20");
    await createRoom("r-r7-at20");
    await addMember("r-r7-at20", alice.userId);

    const body = Buffer.alloc(20 * 1024 * 1024, 0x41); // 20 MiB of 'A'
    const res = await alice.agent
      .post("/api/v1/attachments")
      .field("roomId", "r-r7-at20")
      .attach("file", body, {
        filename: "big.bin",
        contentType: "application/octet-stream",
      });

    expect(res.status).toBe(201);
    const [row] = await getTestDb()
      .select()
      .from(attachment)
      .where(eq(attachment.id, res.body.attachmentId));
    expect(row.sizeBytes).toBe(20 * 1024 * 1024);
  }, 30_000);

  test("R7 file 1 byte over 20MB → 413 file_too_large, no row", async () => {
    const alice = await registerAgent(app, "r7-over@example.com", "r7_over");
    await createRoom("r-r7-over");
    await addMember("r-r7-over", alice.userId);

    const body = Buffer.alloc(20 * 1024 * 1024 + 1, 0x42);
    const res = await alice.agent
      .post("/api/v1/attachments")
      .field("roomId", "r-r7-over")
      .attach("file", body, {
        filename: "toobig.bin",
        contentType: "application/octet-stream",
      });

    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({ error: "file_too_large" });

    // No rows landed for this uploader on this room.
    const rows = await getTestDb()
      .select()
      .from(attachment)
      .where(eq(attachment.roomId, "r-r7-over"));
    expect(rows.length).toBe(0);
  }, 30_000);
});

describe("REQ-077 R8 image ceiling — 3 MB (conditional on mime)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  test("R8 image at exactly 3MB → 201", async () => {
    const alice = await registerAgent(app, "r8-at3@example.com", "r8_at3");
    await createRoom("r-r8-at3");
    await addMember("r-r8-at3", alice.userId);

    const body = Buffer.alloc(3 * 1024 * 1024, 0x00);
    const res = await alice.agent
      .post("/api/v1/attachments")
      .field("roomId", "r-r8-at3")
      .attach("file", body, {
        filename: "pic.png",
        contentType: "image/png",
      });

    expect(res.status).toBe(201);
    const [row] = await getTestDb()
      .select()
      .from(attachment)
      .where(eq(attachment.id, res.body.attachmentId));
    expect(row.sizeBytes).toBe(3 * 1024 * 1024);
    expect(row.mimeType).toBe("image/png");
  });

  test("R8 image 1 byte over 3MB → 413 image_too_large, no row", async () => {
    const alice = await registerAgent(app, "r8-over@example.com", "r8_over");
    await createRoom("r-r8-over");
    await addMember("r-r8-over", alice.userId);

    const body = Buffer.alloc(3 * 1024 * 1024 + 1, 0x00);
    const res = await alice.agent
      .post("/api/v1/attachments")
      .field("roomId", "r-r8-over")
      .attach("file", body, {
        filename: "big.png",
        contentType: "image/png",
      });

    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({ error: "image_too_large" });

    const rows = await getTestDb()
      .select()
      .from(attachment)
      .where(eq(attachment.roomId, "r-r8-over"));
    expect(rows.length).toBe(0);
  });

  test("R8 NON-image 4MB (> image cap, < file cap) → 201", async () => {
    // Explicit regression: the 3MB cap must NOT apply to non-image mimes.
    // image/gif is the image prefix check; application/pdf is not.
    const alice = await registerAgent(app, "r8-pdf@example.com", "r8_pdf");
    await createRoom("r-r8-pdf");
    await addMember("r-r8-pdf", alice.userId);

    const body = Buffer.alloc(4 * 1024 * 1024, 0x25);
    const res = await alice.agent
      .post("/api/v1/attachments")
      .field("roomId", "r-r8-pdf")
      .attach("file", body, {
        filename: "big.pdf",
        contentType: "application/pdf",
      });

    expect(res.status).toBe(201);
    const [row] = await getTestDb()
      .select()
      .from(attachment)
      .where(eq(attachment.id, res.body.attachmentId));
    expect(row.sizeBytes).toBe(4 * 1024 * 1024);
  });

  test("R8 image/jpeg also subject to 3MB cap", async () => {
    // Guards against a regression where only image/png is caught.
    const alice = await registerAgent(app, "r8-jpeg@example.com", "r8_jpeg");
    await createRoom("r-r8-jpeg");
    await addMember("r-r8-jpeg", alice.userId);

    const body = Buffer.alloc(3 * 1024 * 1024 + 1024, 0x00);
    const res = await alice.agent
      .post("/api/v1/attachments")
      .field("roomId", "r-r8-jpeg")
      .attach("file", body, {
        filename: "pic.jpg",
        contentType: "image/jpeg",
      });

    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({ error: "image_too_large" });
  });
});
