// Skeleton for agent E (feat/attach-comment-revoke) — v3.docx §2.6.3
// (attachment comment) + §2.6.4 (access-revoke).
//
// Binding: docs/specs/s2-e2e-coverage.md §4 S1/S2. All scenarios are
// test.skip'd until the feature merges. Unskip post-merge:
//   1. Delete the `test.skip(true, "…")` line.
//   2. Replace "REQ-TBD" with the real REQ-ID in the test name and the
//      spec's §10 mapping.
//   3. Fill the body — selectors/flow land when E's UI is visible.
//
// Cross-user sanity: E's flow is observer-side (uploader acts, viewer
// sees the comment + revoke placeholder), so two BrowserContexts are
// required. Pattern matches s2-invitations.spec.ts.

import { test, expect, type Page, type BrowserContext } from "@playwright/test";

const BACKEND_HEALTH = "http://localhost:4000/health";

const stamp = () => Date.now().toString(36);

async function registerAndEnterRooms(
  page: Page,
  user: { email: string; username: string; name: string; password: string },
): Promise<void> {
  await page.goto("/register");
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Username").fill(user.username);
  await page.getByLabel("Display name").fill(user.name);
  await page.getByLabel("Password", { exact: true }).fill(user.password);
  await page.getByLabel("Confirm password").fill(user.password);
  await page.getByRole("button", { name: /create account/i }).click();
  await expect(page).toHaveURL(/\/rooms(\/|$)/, { timeout: 15_000 });
}

test.describe.configure({ mode: "serial" });

test.describe("REQ-TBD §2.6.3 §2.6.4 — attachment comment + access-revoke (agent E)", () => {
  test.beforeAll(async () => {
    const res = await fetch(BACKEND_HEALTH).catch(() => null);
    test.skip(
      !res || !res.ok,
      `Backend not healthy at ${BACKEND_HEALTH}. Boot with: docker compose up --build -d (or pnpm --filter backend dev).`,
    );
  });

  test("REQ-TBD §2.6.3 — attachment comment round-trip (test.skip pending feat/attach-comment-revoke)", async ({
    browser,
  }) => {
    test.skip(
      true,
      "TODO(agent-E): unskip after feat/attach-comment-revoke merges; replace REQ-TBD in the test name + spec §10 with the canonical REQ-ID for §2.6.3 (attachment comment).",
    );

    // Scaffolded shape (fill once E's UI is mergeable):
    //   1. Alice + Bob register, Alice creates a public room, Bob joins.
    //   2. Alice opens the composer's file picker (selector TBD — likely
    //      aria-label /attach/i on the paperclip button), uploads a small
    //      image from fixtures (create `tests/e2e/_fixtures/tiny.png` when
    //      the flow lands).
    //   3. Alice enters a comment via E's comment surface (data-testid
    //      TBD — likely `attachment-comment-input`).
    //   4. Alice sends. Bob's MessageList row for the attachment shows
    //      both the image and Alice's comment text.
    //   5. Bob replies with his own comment on the same attachment (if
    //      E's contract supports cross-user comments — otherwise the test
    //      stops at step 4 and the cross-user half moves to S3 tracking).
    const suffix = stamp();
    const alice = {
      email: `att1-a-${suffix}@herders.local`,
      username: `att1A${suffix}`,
      name: "Att1 Alice",
      password: "playwright-att-1234",
    };
    const bob = {
      email: `att1-b-${suffix}@herders.local`,
      username: `att1B${suffix}`,
      name: "Att1 Bob",
      password: "playwright-att-1234",
    };

    const aliceCtx: BrowserContext = await browser.newContext();
    const bobCtx: BrowserContext = await browser.newContext();
    try {
      const alicePage = await aliceCtx.newPage();
      const bobPage = await bobCtx.newPage();
      await registerAndEnterRooms(alicePage, alice);
      await registerAndEnterRooms(bobPage, bob);
      // …remaining assertions land at unskip time.
    } finally {
      await aliceCtx.close();
      await bobCtx.close();
    }
  });

  test("REQ-TBD §2.6.4 — attachment access-revoke flips placeholder on observer (test.skip pending feat/attach-comment-revoke)", async ({
    browser,
  }) => {
    test.skip(
      true,
      "TODO(agent-E): unskip after feat/attach-comment-revoke merges; replace REQ-TBD in the test name + spec §10 with the canonical REQ-ID for §2.6.4 (access-revoke).",
    );

    // Scaffolded shape:
    //   1. Alice uploads an image in #room; Bob sees it.
    //   2. Alice opens the attachment's action menu and picks "Revoke
    //      access" (selector TBD — likely a menu item within a
    //      data-testid=\"attachment-actions\" surface).
    //   3. Bob's MessageList row for that attachment swaps the image/
    //      download link for the placeholder E ships (probable text
    //      "[file removed]" — confirm on merge).
    //   4. Live-flip assertion: Bob should not have to reload. Poll up
    //      to 10s for the placeholder to appear.
    const suffix = stamp();
    const alice = {
      email: `att2-a-${suffix}@herders.local`,
      username: `att2A${suffix}`,
      name: "Att2 Alice",
      password: "playwright-att-1234",
    };
    const bob = {
      email: `att2-b-${suffix}@herders.local`,
      username: `att2B${suffix}`,
      name: "Att2 Bob",
      password: "playwright-att-1234",
    };

    const aliceCtx: BrowserContext = await browser.newContext();
    const bobCtx: BrowserContext = await browser.newContext();
    try {
      const alicePage = await aliceCtx.newPage();
      const bobPage = await bobCtx.newPage();
      await registerAndEnterRooms(alicePage, alice);
      await registerAndEnterRooms(bobPage, bob);
      // …remaining assertions land at unskip time.
    } finally {
      await aliceCtx.close();
      await bobCtx.close();
    }
  });
});
