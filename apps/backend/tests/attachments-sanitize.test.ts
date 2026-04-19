// REQ-081 / R10 — originalName preservation vs storagePath sanitisation.
// Binding spec: docs/specs/s2-attachments.md §4 R10, §5 storage layout.
//
// Two-column rule: originalName keeps the verbatim (NFC-normalised) display
// name; storagePath is derived purely from a generated UUID + a sanitised
// extension. User-controlled bytes never reach the filesystem path.

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
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
import {
  buildStoragePath,
  sanitizeExtension,
} from "../src/lib/attachment-storage";

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

describe("R10 sanitizeExtension — unit", () => {
  test("accepts 1–8 alphanumeric extensions", () => {
    expect(sanitizeExtension(".png")).toBe(".png");
    expect(sanitizeExtension(".PNG")).toBe(".PNG");
    expect(sanitizeExtension(".tar")).toBe(".tar");
    expect(sanitizeExtension(".a")).toBe(".a");
    expect(sanitizeExtension(".abcdefgh")).toBe(".abcdefgh");
  });

  test("rejects >8 char extensions", () => {
    expect(sanitizeExtension(".abcdefghi")).toBe("");
  });

  test("rejects non-alphanumeric chars", () => {
    expect(sanitizeExtension(".p-ng")).toBe("");
    expect(sanitizeExtension(".p ng")).toBe("");
    expect(sanitizeExtension(".p/ng")).toBe("");
    expect(sanitizeExtension(".p\\ng")).toBe("");
    expect(sanitizeExtension(".p.ng")).toBe("");
    expect(sanitizeExtension(".p\u0000ng")).toBe("");
  });

  test("rejects unicode extensions", () => {
    expect(sanitizeExtension(".тхт")).toBe("");
    expect(sanitizeExtension(".日本")).toBe("");
  });

  test("empty / no-ext returns empty string", () => {
    expect(sanitizeExtension("")).toBe("");
    expect(sanitizeExtension(".")).toBe("");
  });
});

describe("R10 buildStoragePath — unit", () => {
  test("relativePath layout: YYYY/MM/<uuid><ext> (POSIX separators)", () => {
    const frozen = new Date(Date.UTC(2026, 3, 18, 12, 0, 0)); // 2026-04-18
    const { relativePath } = buildStoragePath(
      "00000000-0000-0000-0000-000000000001",
      "doc.pdf",
      frozen,
    );
    expect(relativePath).toBe(
      "2026/04/00000000-0000-0000-0000-000000000001.pdf",
    );
  });

  test("no path traversal even if originalName contains ../", () => {
    const { relativePath } = buildStoragePath(
      "abc-def",
      "../../etc/passwd",
      new Date(Date.UTC(2026, 0, 1)),
    );
    // path.extname("../../etc/passwd") is "" — no extension, no traversal.
    expect(relativePath).toBe("2026/01/abc-def");
    expect(relativePath.includes("..")).toBe(false);
  });

  test("no extension when originalName extension has unsafe chars", () => {
    const { relativePath } = buildStoragePath(
      "xyz",
      "evil.sh;rm",
      new Date(Date.UTC(2026, 0, 1)),
    );
    // ";" is not alphanumeric; ext dropped.
    expect(relativePath).toBe("2026/01/xyz");
  });

  test("absolutePath is UPLOAD_DIR-joined and contains no '..'", () => {
    const { absolutePath, relativePath } = buildStoragePath(
      "safe-id",
      "note.txt",
      new Date(Date.UTC(2026, 5, 15)),
    );
    expect(absolutePath.startsWith(env.UPLOAD_DIR)).toBe(true);
    expect(absolutePath).toBe(path.join(env.UPLOAD_DIR, relativePath));
  });
});

describe("REQ-081 originalName verbatim (unicode) + storagePath sanitised", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  test("REQ-081 cyrillic filename round-trips verbatim in DB", async () => {
    const alice = await registerAgent(
      app,
      "r081-cyr@example.com",
      "r081_cyr",
    );
    await createRoom("r-r081-cyr");
    await addMember("r-r081-cyr", alice.userId);

    const body = Buffer.from("hello");
    const res = await alice.agent
      .post("/api/v1/attachments")
      .field("roomId", "r-r081-cyr")
      .attach("file", body, {
        filename: "файл.txt",
        contentType: "text/plain",
      });
    expect(res.status).toBe(201);

    const [row] = await getTestDb()
      .select()
      .from(attachment)
      .where(eq(attachment.id, res.body.attachmentId));
    // originalName preserved character-for-character (+ NFC).
    expect(row.originalName).toBe("файл.txt".normalize("NFC"));
  });

  test("REQ-081 emoji filename round-trips verbatim in DB", async () => {
    const alice = await registerAgent(
      app,
      "r081-emoji@example.com",
      "r081_emoji",
    );
    await createRoom("r-r081-emoji");
    await addMember("r-r081-emoji", alice.userId);

    const res = await alice.agent
      .post("/api/v1/attachments")
      .field("roomId", "r-r081-emoji")
      .attach("file", Buffer.from("x"), {
        filename: "📎report 2026.pdf",
        contentType: "application/pdf",
      });
    expect(res.status).toBe(201);

    const [row] = await getTestDb()
      .select()
      .from(attachment)
      .where(eq(attachment.id, res.body.attachmentId));
    expect(row.originalName).toBe("📎report 2026.pdf".normalize("NFC"));
  });

  test("R10 storagePath never contains unicode from originalName", async () => {
    const alice = await registerAgent(
      app,
      "r10-storage@example.com",
      "r10_storage",
    );
    await createRoom("r-r10-storage");
    await addMember("r-r10-storage", alice.userId);

    const res = await alice.agent
      .post("/api/v1/attachments")
      .field("roomId", "r-r10-storage")
      .attach("file", Buffer.from("y"), {
        filename: "файл.png",
        contentType: "image/png",
      });
    expect(res.status).toBe(201);

    const [row] = await getTestDb()
      .select()
      .from(attachment)
      .where(eq(attachment.id, res.body.attachmentId));
    // Only ASCII alphanumerics + "-" (uuid) + "/" (separator) + "." (extension)
    expect(/^[A-Za-z0-9/.\-]+$/.test(row.storagePath)).toBe(true);
    // Extension sanitised to ASCII (png), not cyrillic.
    expect(row.storagePath.endsWith(".png")).toBe(true);
    // The raw cyrillic must not leak onto disk.
    expect(row.storagePath.includes("файл")).toBe(false);

    const onDisk = path.join(env.UPLOAD_DIR, row.storagePath);
    expect(fs.existsSync(onDisk)).toBe(true);
  });

  test("R10 filename with unsafe extension → storagePath has no extension", async () => {
    const alice = await registerAgent(
      app,
      "r10-badext@example.com",
      "r10_badext",
    );
    await createRoom("r-r10-badext");
    await addMember("r-r10-badext", alice.userId);

    const res = await alice.agent
      .post("/api/v1/attachments")
      .field("roomId", "r-r10-badext")
      .attach("file", Buffer.from("z"), {
        filename: "weird.тхт",
        contentType: "text/plain",
      });
    expect(res.status).toBe(201);

    const [row] = await getTestDb()
      .select()
      .from(attachment)
      .where(eq(attachment.id, res.body.attachmentId));
    // Extension dropped entirely; storagePath ends at the uuid.
    expect(/\/[A-Za-z0-9\-]+$/.test(row.storagePath)).toBe(true);
    expect(row.originalName).toBe("weird.тхт".normalize("NFC"));
  });

  test("R10 path traversal attempt in filename is neutralised", async () => {
    const alice = await registerAgent(
      app,
      "r10-trav@example.com",
      "r10_trav",
    );
    await createRoom("r-r10-trav");
    await addMember("r-r10-trav", alice.userId);

    const res = await alice.agent
      .post("/api/v1/attachments")
      .field("roomId", "r-r10-trav")
      .attach("file", Buffer.from("pwn"), {
        filename: "../../etc/passwd",
        contentType: "application/octet-stream",
      });
    expect(res.status).toBe(201);

    const [row] = await getTestDb()
      .select()
      .from(attachment)
      .where(eq(attachment.id, res.body.attachmentId));
    expect(row.storagePath.includes("..")).toBe(false);
    expect(row.storagePath.includes("etc")).toBe(false);
    // And the file is still under UPLOAD_DIR, not at /etc/passwd.
    const onDisk = path.join(env.UPLOAD_DIR, row.storagePath);
    expect(onDisk.startsWith(env.UPLOAD_DIR)).toBe(true);
    expect(fs.existsSync(onDisk)).toBe(true);
  });
});
