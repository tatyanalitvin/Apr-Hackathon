// REQ-UserSearch §2.4 — GET /api/v1/users?q=<term>
// Binding spec: docs/specs/s3-user-search.md §4 R1–R18.

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";
import { and, eq, inArray } from "drizzle-orm";
import { user } from "@ai-herders/shared/schema";

import { buildApp } from "../src/app";
import { getTestDb } from "./db-helpers";
import { TEST_PASSWORD_OK } from "./helpers/fixtures";

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
  name = username,
): Promise<SignedUpAgent> {
  const agent = request.agent(app.server);
  await agent
    .post("/api/auth/sign-up/email")
    .send({ email, username, password: TEST_PASSWORD_OK, name })
    .expect(200);
  return { agent, userId: await userIdByEmail(email) };
}

describe("REQ-UserSearch §2.4 query-shape + auth", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  test("REQ-UserSearch §2.4 R3 — unauthenticated → 401", async () => {
    const res = await request(app.server).get("/api/v1/users?q=bob");
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: "unauthorized" });
  });

  test("REQ-UserSearch §2.4 R1 — missing q → 400 invalid_query", async () => {
    const alice = await registerAgent(app, "usrch-r1a@example.com", "usrch_r1a");
    const res = await alice.agent.get("/api/v1/users");
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "invalid_query" });
  });

  test("REQ-UserSearch §2.4 R1 — q.length < 2 → 400 invalid_query", async () => {
    const alice = await registerAgent(app, "usrch-r1b@example.com", "usrch_r1b");
    const res = await alice.agent.get("/api/v1/users?q=a");
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "invalid_query" });
  });

  test("REQ-UserSearch §2.4 R1 — whitespace-only q → 400 invalid_query", async () => {
    const alice = await registerAgent(app, "usrch-r1c@example.com", "usrch_r1c");
    const res = await alice.agent.get("/api/v1/users?q=%20%20");
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "invalid_query" });
  });

  test("REQ-UserSearch §2.4 R2 — q.length > 64 → 400 invalid_query", async () => {
    const alice = await registerAgent(app, "usrch-r2@example.com", "usrch_r2");
    const res = await alice.agent.get(`/api/v1/users?q=${"a".repeat(65)}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "invalid_query" });
  });
});

describe("REQ-UserSearch §2.4 ranking + self + soft-delete", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  test("REQ-UserSearch §2.4 R4/R5/R6/R7/R8 — tier order + tiebreak", async () => {
    // Caller
    const me = await registerAgent(app, "usrch-rank-me@example.com", "rank_me");

    // Fixtures chosen so one hit lands in each tier for query 'rank'.
    // Tier 0 exact username: username === 'rank'
    await registerAgent(app, "usrch-rank-exact@example.com", "rank", "Exact User");
    // Tier 1 exact name: name === 'rank', username different
    await registerAgent(app, "usrch-rank-exactname@example.com", "rank_b", "rank");
    // Tier 2 prefix username: 'ranker'
    await registerAgent(app, "usrch-rank-pfx-u@example.com", "ranker", "Prefix U");
    // Tier 3 prefix name: username 'zz_pn', name 'ranked Person'
    await registerAgent(app, "usrch-rank-pfx-n@example.com", "zz_pn", "ranked Person");
    // Tier 4 substring username: 'rrank_sub' (contains 'rank' but no prefix)
    await registerAgent(app, "usrch-rank-sub-u@example.com", "rrank_sub", "Sub U");
    // Tier 5 substring name only: username 'zz_sn', name 'Contains rank here'
    await registerAgent(app, "usrch-rank-sub-n@example.com", "zz_sn", "Contains rank here");

    const res = await me.agent.get("/api/v1/users?q=rank");
    expect(res.status).toBe(200);
    const usernames = (res.body.users as Array<{ username: string }>).map(
      (u) => u.username,
    );
    // Expected strict order — tie on tiebreak is alphabetical ASC.
    expect(usernames).toEqual([
      "rank",        // tier 0
      "rank_b",      // tier 1
      "ranker",      // tier 2
      "zz_pn",       // tier 3
      "rrank_sub",   // tier 4
      "zz_sn",       // tier 5
    ]);
  });

  test("REQ-UserSearch §2.4 R8 — tiebreak alphabetical within a tier", async () => {
    const me = await registerAgent(app, "usrch-tie-me@example.com", "tie_me");
    // Two hits both in tier 4 (substring username, no prefix). 'arank_a'
    // and 'brank_a' both match '%rank%' on username but neither prefixes.
    await registerAgent(app, "usrch-tie-b@example.com", "brank_a", "B User");
    await registerAgent(app, "usrch-tie-a@example.com", "arank_a", "A User");

    const res = await me.agent.get("/api/v1/users?q=rank");
    expect(res.status).toBe(200);
    const usernames = (res.body.users as Array<{ username: string }>).map(
      (u) => u.username,
    );
    const aIdx = usernames.indexOf("arank_a");
    const bIdx = usernames.indexOf("brank_a");
    expect(aIdx).toBeGreaterThanOrEqual(0);
    expect(bIdx).toBeGreaterThan(aIdx);
  });

  test("REQ-UserSearch §2.4 R9 — caller never appears in own results", async () => {
    const me = await registerAgent(app, "usrch-self@example.com", "selfmatch");
    const res = await me.agent.get("/api/v1/users?q=selfmatch");
    expect(res.status).toBe(200);
    const ids = (res.body.users as Array<{ userId: string }>).map((u) => u.userId);
    expect(ids).not.toContain(me.userId);
  });

  test("REQ-UserSearch §2.4 R10 — soft-deleted users never appear", async () => {
    const me = await registerAgent(app, "usrch-sd-me@example.com", "sd_me");
    const ghost = await registerAgent(app, "usrch-sd-ghost@example.com", "sd_ghost");

    // Soft-delete directly via DB (matches existing tombstone shape —
    // deleted_at + email/username rewrite in account.ts).
    await getTestDb()
      .update(user)
      .set({ deletedAt: new Date() })
      .where(eq(user.id, ghost.userId));

    const res = await me.agent.get("/api/v1/users?q=sd_ghost");
    expect(res.status).toBe(200);
    const ids = (res.body.users as Array<{ userId: string }>).map((u) => u.userId);
    expect(ids).not.toContain(ghost.userId);
  });
});
