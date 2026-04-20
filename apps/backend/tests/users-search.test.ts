// REQ-UserSearch §2.4 — GET /api/v1/users?q=<term>
// Binding spec: docs/specs/s3-user-search.md §4 R1–R18.

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";
import { and, eq, inArray } from "drizzle-orm";
import { friendship, friendRequest, user, userBlock } from "@ai-herders/shared/schema";

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

// One shared buildApp() per file — parallel describe-scoped buildApp() calls
// race better-auth init and can silently drop sign-ups (200, no user row).
// See docs/specs/s3-gc-and-moderation-rl.md R10.
let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("REQ-UserSearch §2.4 query-shape + auth", () => {
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

  test("REQ-UserSearch §2.4 R4 — exact-username match is case-insensitive (rank 0 beats rank 1)", async () => {
    // Regression: the CASE arm `WHEN u.username = q` used Postgres default
    // (case-sensitive) collation, so a mixed-case query missed rank 0
    // and fell through to the ILIKE-prefix arm (rank 2). The target hit
    // still appeared but the "exact wins" intent broke whenever another
    // hit sat in a cheaper rank (e.g. a user whose exact NAME matches
    // lands rank 1 and wrongly outranks the true username-exact hit).
    // Fix: compare case-insensitively (lower(username) = lower(q)).
    const me = await registerAgent(app, "usrch-ci-me@example.com", "usrch_ci_me");

    // Target: exact-username hit (stored lowercase 'usrch_ci_alice').
    // Query uses upper-case so the case-sensitive `=` branch MISSES.
    await registerAgent(
      app,
      "usrch-ci-alice@example.com",
      "usrch_ci_alice",
      "Alpha Example",
    );
    // Decoy: exact-NAME hit — stored name equals the query verbatim.
    // Pre-fix: decoy lands rank 1 (name = q); target falls to rank 2
    // (username ILIKE q||'%'). Decoy wrongly sorts first.
    // Post-fix: target lands rank 0; decoy stays at rank 1. Target wins.
    await registerAgent(
      app,
      "usrch-ci-decoy@example.com",
      "zz_ci_decoy",
      "USRCH_CI_ALICE",
    );

    const res = await me.agent.get("/api/v1/users?q=USRCH_CI_ALICE");
    expect(res.status).toBe(200);
    const usernames = (res.body.users as Array<{ username: string }>)
      .map((u) => u.username);
    // Exact-username hit must rank first even though the query case does
    // not match the stored username case.
    expect(usernames[0]).toBe("usrch_ci_alice");

    // Upper-case and lower-case queries must produce the same ordering.
    const resLower = await me.agent.get("/api/v1/users?q=usrch_ci_alice");
    const lowerUsernames = (resLower.body.users as Array<{ username: string }>)
      .map((u) => u.username);
    expect(lowerUsernames[0]).toBe("usrch_ci_alice");
    expect(lowerUsernames).toEqual(usernames);
  });

  test("REQ-UserSearch §2.4 R5 — exact-name match is case-insensitive (rank 1 beats rank 3)", async () => {
    // Same regression as R4 but on the `name` arm. A query with case that
    // doesn't match the stored `name` value misses rank 1 and falls to
    // rank 3 (name ILIKE q||'%'). A second hit with a NAME prefix but
    // without exact equality would wrongly tie at rank 3 and sort ahead
    // of the intended exact-name hit on the alphabetical tiebreak.
    const me = await registerAgent(app, "usrch-cin-me@example.com", "usrch_cin_me");

    // Target: exact-name hit. Username is disjoint so the username arms
    // don't fire at all; ranking is driven entirely by the name arms.
    await registerAgent(
      app,
      "usrch-cin-exact@example.com",
      "zz_cin_exact",
      "Bob Exact",
    );
    // Decoy: name prefix-match — stored name 'Bob Exact Plus' satisfies
    // ILIKE 'Bob Exact%' (rank 3). Username 'aa_cin_pfx' sorts BEFORE
    // 'zz_cin_exact' so pre-fix, when both rows tie at rank 3 (because
    // the case-sensitive `=` on the target's name misses), the tiebreak
    // (username ASC) orders decoy first — and the test catches that.
    await registerAgent(
      app,
      "usrch-cin-pfx@example.com",
      "aa_cin_pfx",
      "Bob Exact Plus",
    );

    // Mixed-case query. Pre-fix: target misses rank 1, lands rank 3
    // alongside decoy; tiebreak on username → decoy 'aa_cin_pfx' first.
    // Post-fix: target lands rank 1; decoy stays rank 3 → target first.
    const res = await me.agent.get("/api/v1/users?q=BOB%20EXACT");
    expect(res.status).toBe(200);
    const names = (res.body.users as Array<{ name: string }>).map((u) => u.name);
    expect(names[0]).toBe("Bob Exact");
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

describe("REQ-UserSearch §2.4 block symmetry", () => {
  test("REQ-UserSearch §2.4 R11 — hits blocked BY caller are excluded", async () => {
    const me = await registerAgent(app, "usrch-blk-me@example.com", "blk_me");
    const blockedTarget = await registerAgent(
      app,
      "usrch-blk-target@example.com",
      "blk_target",
    );
    await getTestDb().insert(userBlock).values({
      id: "ub-r11",
      byId: me.userId,
      targetId: blockedTarget.userId,
    });

    const res = await me.agent.get("/api/v1/users?q=blk_target");
    expect(res.status).toBe(200);
    const ids = (res.body.users as Array<{ userId: string }>).map((u) => u.userId);
    expect(ids).not.toContain(blockedTarget.userId);
  });

  test("REQ-UserSearch §2.4 R12 — hits who have blocked caller are excluded", async () => {
    const me = await registerAgent(app, "usrch-blk2-me@example.com", "blk2_me");
    const blocker = await registerAgent(
      app,
      "usrch-blk2-blocker@example.com",
      "blk2_blocker",
    );
    await getTestDb().insert(userBlock).values({
      id: "ub-r12",
      byId: blocker.userId,
      targetId: me.userId,
    });

    const res = await me.agent.get("/api/v1/users?q=blk2_blocker");
    expect(res.status).toBe(200);
    const ids = (res.body.users as Array<{ userId: string }>).map((u) => u.userId);
    expect(ids).not.toContain(blocker.userId);
  });
});

describe("REQ-UserSearch §2.4 relationship enrichment + cap", () => {
  test("REQ-UserSearch §2.4 R13 — friend row → relationship: 'friend'", async () => {
    const me = await registerAgent(app, "usrch-fr13-me@example.com", "fr13_me");
    const buddy = await registerAgent(app, "usrch-fr13-buddy@example.com", "fr13_buddy");
    const [a, b] = me.userId < buddy.userId
      ? [me.userId, buddy.userId]
      : [buddy.userId, me.userId];
    await getTestDb().insert(friendship).values({
      id: "fs-r13",
      userAId: a,
      userBId: b,
    });

    const res = await me.agent.get("/api/v1/users?q=fr13_buddy");
    expect(res.status).toBe(200);
    const hit = (res.body.users as Array<{ userId: string; relationship: string }>)
      .find((u) => u.userId === buddy.userId);
    expect(hit?.relationship).toBe("friend");
  });

  test("REQ-UserSearch §2.4 R14 — pending outgoing request → 'request_outgoing'", async () => {
    const me = await registerAgent(app, "usrch-fr14-me@example.com", "fr14_me");
    const target = await registerAgent(app, "usrch-fr14-t@example.com", "fr14_t");
    await getTestDb().insert(friendRequest).values({
      id: "frq-r14",
      fromId: me.userId,
      toId: target.userId,
      status: "pending",
    });

    const res = await me.agent.get("/api/v1/users?q=fr14_t");
    const hit = (res.body.users as Array<{ userId: string; relationship: string }>)
      .find((u) => u.userId === target.userId);
    expect(hit?.relationship).toBe("request_outgoing");
  });

  test("REQ-UserSearch §2.4 R15 — pending incoming request → 'request_incoming'", async () => {
    const me = await registerAgent(app, "usrch-fr15-me@example.com", "fr15_me");
    const sender = await registerAgent(app, "usrch-fr15-s@example.com", "fr15_s");
    await getTestDb().insert(friendRequest).values({
      id: "frq-r15",
      fromId: sender.userId,
      toId: me.userId,
      status: "pending",
    });

    const res = await me.agent.get("/api/v1/users?q=fr15_s");
    const hit = (res.body.users as Array<{ userId: string; relationship: string }>)
      .find((u) => u.userId === sender.userId);
    expect(hit?.relationship).toBe("request_incoming");
  });

  test("REQ-UserSearch §2.4 R16 — no relationship → 'none'; friend beats stale request", async () => {
    // Case A: stranger — relationship 'none'.
    const me = await registerAgent(app, "usrch-fr16a-me@example.com", "fr16a_me");
    const stranger = await registerAgent(
      app,
      "usrch-fr16a-x@example.com",
      "fr16a_x",
    );
    const resA = await me.agent.get("/api/v1/users?q=fr16a_x");
    const hitA = (resA.body.users as Array<{ userId: string; relationship: string }>)
      .find((u) => u.userId === stranger.userId);
    expect(hitA?.relationship).toBe("none");

    // Case B: friendship + lingering accepted friend_request — friend wins.
    const me2 = await registerAgent(app, "usrch-fr16b-me@example.com", "fr16b_me");
    const buddy2 = await registerAgent(
      app,
      "usrch-fr16b-buddy@example.com",
      "fr16b_buddy",
    );
    const [aa, bb] = me2.userId < buddy2.userId
      ? [me2.userId, buddy2.userId]
      : [buddy2.userId, me2.userId];
    await getTestDb().insert(friendship).values({
      id: "fs-r16b",
      userAId: aa,
      userBId: bb,
    });
    // Stale pending request in either direction — friendship still wins.
    await getTestDb().insert(friendRequest).values({
      id: "frq-r16b",
      fromId: me2.userId,
      toId: buddy2.userId,
      status: "pending",
    });
    const resB = await me2.agent.get("/api/v1/users?q=fr16b_buddy");
    const hitB = (resB.body.users as Array<{ userId: string; relationship: string }>)
      .find((u) => u.userId === buddy2.userId);
    expect(hitB?.relationship).toBe("friend");
  });

  test("REQ-UserSearch §2.4 R17 — hard cap 20 regardless of matches", async () => {
    const me = await registerAgent(app, "usrch-cap-me@example.com", "cap_me");
    // 21 candidates all matching the same query.
    for (let i = 0; i < 21; i++) {
      const padded = String(i).padStart(2, "0");
      await registerAgent(
        app,
        `usrch-cap-${padded}@example.com`,
        `capuser${padded}`,
      );
    }

    const res = await me.agent.get("/api/v1/users?q=capuser");
    expect(res.status).toBe(200);
    const hits = res.body.users as Array<unknown>;
    expect(hits).toHaveLength(20);
  });
});

describe("REQ-UserSearch §2.4 rate limit", () => {
  test("REQ-UserSearch §2.4 R18 — 61st request in 60s → 429 rate_limited", async () => {
    const alice = await registerAgent(app, "usrch-rl@example.com", "usrch_rl");

    // Fire 60 sequential requests — all should succeed (200).
    for (let i = 0; i < 60; i++) {
      const res = await alice.agent.get("/api/v1/users?q=nobody_matches_this");
      expect(res.status).toBe(200);
    }
    // The 61st should trip the bucket.
    const res = await alice.agent.get("/api/v1/users?q=nobody_matches_this");
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ error: "rate_limited" });
  }, 30_000);
});
