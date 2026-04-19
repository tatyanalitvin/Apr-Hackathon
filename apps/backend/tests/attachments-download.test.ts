// REQ-078 / REQ-083 / R6 / R11 / R14 / R16 — attachment download endpoint.
// Binding spec: docs/specs/s2-attachments.md §4 R6, R11, R14, R16.
//
//   R11 = Content-Disposition: attachment; filename*=UTF-8''<encoded>,
//         Content-Type + Content-Length mirror the DB row, streamed body.
//   R6 / REQ-083 = per-request membership recomputed on every GET.
//   R14 = uploader-removed-from-room loses access; remaining members retain.
//   R16 = missing session → 401.

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import fs from "node:fs";
import path from "node:path";
import {
  attachment,
  room,
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
    .send({ email, username, password: "password1234", name: username })
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

async function upload(
  agent: request.Agent,
  roomId: string,
  filename: string,
  body: Buffer,
  contentType = "application/octet-stream",
): Promise<string> {
  const res = await agent
    .post("/api/v1/attachments")
    .field("roomId", roomId)
    .attach("file", body, { filename, contentType });
  if (res.status !== 201) {
    throw new Error(`upload failed ${res.status}: ${JSON.stringify(res.body)}`);
  }
  return res.body.attachmentId;
}

// Strip `attachment; filename*=UTF-8''…` back to the raw utf-8 string.
function decodeContentDisposition(header: string): string {
  const match = header.match(/filename\*=UTF-8''([^;]+)/);
  if (!match) throw new Error(`no filename* in: ${header}`);
  return decodeURIComponent(match[1]);
}

describe("REQ-078 GET /api/v1/attachments/:id — Content-Disposition + stream", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  test("REQ-078 member download → 200 + headers + streamed body", async () => {
    const alice = await registerAgent(app, "r078-ok@example.com", "r078_ok");
    await createRoom("r-r078-ok");
    await addMember("r-r078-ok", alice.userId);

    const body = Buffer.from("some bytes content");
    const attId = await upload(
      alice.agent,
      "r-r078-ok",
      "hello.txt",
      body,
      "text/plain",
    );

    const res = await alice.agent
      .get(`/api/v1/attachments/${attId}`)
      .buffer(true)
      .parse((response, cb) => {
        const chunks: Buffer[] = [];
        response.on("data", (c: Buffer) => chunks.push(c));
        response.on("end", () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^text\/plain/);
    expect(res.headers["content-length"]).toBe(String(body.length));
    expect(res.headers["content-disposition"]).toBe(
      `attachment; filename*=UTF-8''hello.txt`,
    );
    expect((res.body as Buffer).equals(body)).toBe(true);
  });

  test("REQ-078 unicode filename round-trips through Content-Disposition", async () => {
    const alice = await registerAgent(app, "r078-uni@example.com", "r078_uni");
    await createRoom("r-r078-uni");
    await addMember("r-r078-uni", alice.userId);

    const body = Buffer.from("ok");
    const filename = "файл 2026.txt";
    const attId = await upload(
      alice.agent,
      "r-r078-uni",
      filename,
      body,
      "text/plain",
    );

    const res = await alice.agent.get(`/api/v1/attachments/${attId}`);
    expect(res.status).toBe(200);
    // Decoded form of the filename* header equals the NFC-normalised original.
    const decoded = decodeContentDisposition(
      res.headers["content-disposition"],
    );
    expect(decoded).toBe(filename.normalize("NFC"));
    // Always `attachment`, never `inline` (R11 — browser never auto-executes).
    expect(res.headers["content-disposition"].startsWith("attachment;")).toBe(
      true,
    );
  });

  test("REQ-078 emoji + special chars percent-encoded per RFC 5987", async () => {
    const alice = await registerAgent(app, "r078-esc@example.com", "r078_esc");
    await createRoom("r-r078-esc");
    await addMember("r-r078-esc", alice.userId);

    // Single-quote, paren, asterisk must all be percent-encoded per RFC 5987
    // attr-char. Space too (not an attr-char). Emoji is multi-byte UTF-8.
    const filename = "📎it's (*weird*).pdf";
    const attId = await upload(
      alice.agent,
      "r-r078-esc",
      filename,
      Buffer.from("pdf"),
      "application/pdf",
    );

    const res = await alice.agent.get(`/api/v1/attachments/${attId}`);
    expect(res.status).toBe(200);
    const header = res.headers["content-disposition"];
    // RFC 5987 attr-char set: extract the encoded value and assert no
    // unencoded paren/quote/star/space leaked into it. The `'` and `*` in
    // `filename*=UTF-8''` are syntax, not value.
    const match = header.match(/filename\*=UTF-8''([^;]+)/);
    expect(match).toBeTruthy();
    const value = match![1];
    expect(value).not.toMatch(/[()'\s*]/);
    // Decodes back to the NFC form.
    expect(decodeURIComponent(value)).toBe(filename.normalize("NFC"));
  });
});

describe("REQ-083 R6 R16 download access control", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  test("R16 no session → 401", async () => {
    const alice = await registerAgent(app, "r16-dl@example.com", "r16_dl");
    await createRoom("r-r16-dl");
    await addMember("r-r16-dl", alice.userId);
    const attId = await upload(
      alice.agent,
      "r-r16-dl",
      "x.txt",
      Buffer.from("x"),
    );

    const res = await request(app.server).get(`/api/v1/attachments/${attId}`);
    expect(res.status).toBe(401);
  });

  test("REQ-083 non-member → 403 (even with a valid session)", async () => {
    const alice = await registerAgent(app, "r083-own@example.com", "r083_own");
    const carol = await registerAgent(
      app,
      "r083-stranger@example.com",
      "r083_stranger",
    );
    void carol.userId;

    await createRoom("r-r083-private");
    await addMember("r-r083-private", alice.userId);
    const attId = await upload(
      alice.agent,
      "r-r083-private",
      "secret.txt",
      Buffer.from("secret"),
    );

    const res = await carol.agent.get(`/api/v1/attachments/${attId}`);
    expect(res.status).toBe(403);
  });

  test("§2.6.4 unknown id → 403 (probe-oracle suppression)", async () => {
    // Defense-in-depth per docs/specs/s2-attachments-enhance.md §2.6.4 —
    // a caller without membership cannot distinguish "wrong id" from
    // "right id, no access." Same 403 shape as the not-a-member branch.
    const alice = await registerAgent(
      app,
      "r083-404@example.com",
      "r083_404",
    );
    void alice.userId;
    const res = await alice.agent.get(
      "/api/v1/attachments/does-not-exist-at-all",
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "forbidden" });
  });

  test("R14 uploader removed from room → 403; remaining member → 200", async () => {
    const alice = await registerAgent(app, "r14-up@example.com", "r14_up");
    const bob = await registerAgent(app, "r14-stay@example.com", "r14_stay");

    await createRoom("r-r14");
    await addMember("r-r14", alice.userId);
    await addMember("r-r14", bob.userId);

    const body = Buffer.from("shared file");
    const attId = await upload(alice.agent, "r-r14", "keep.txt", body);

    // Confirm both can download while both are members.
    expect((await alice.agent.get(`/api/v1/attachments/${attId}`)).status).toBe(
      200,
    );
    expect((await bob.agent.get(`/api/v1/attachments/${attId}`)).status).toBe(
      200,
    );

    // Remove alice. The spec says the removal endpoint is s2-rooms.md-owned;
    // direct DB delete of room_member is an approved stand-in (R14 contract).
    await getTestDb()
      .delete(roomMember)
      .where(
        and(
          eq(roomMember.roomId, "r-r14"),
          eq(roomMember.userId, alice.userId),
        ),
      );

    // Alice (uploader, now ex-member) → 403.
    const aliceRes = await alice.agent.get(`/api/v1/attachments/${attId}`);
    expect(aliceRes.status).toBe(403);

    // Bob (still member) → 200 unchanged.
    const bobRes = await bob.agent.get(`/api/v1/attachments/${attId}`);
    expect(bobRes.status).toBe(200);

    // And the file on disk is untouched (R14 — no delete on member removal).
    const [row] = await getTestDb()
      .select({ storagePath: attachment.storagePath })
      .from(attachment)
      .where(eq(attachment.id, attId));
    expect(fs.existsSync(path.join(env.UPLOAD_DIR, row.storagePath))).toBe(
      true,
    );
  });
});
