// S3 submission-gate smoke — a cheap re-run of the manual checklist in
// `.human/SMOKE_FINAL_AGENT_BRIEF.md`. Written after the final manual smoke
// exposed CSP + CSRF gaps that had no regression coverage.
//
// Binding: SMOKE_FINAL_AGENT_BRIEF §1b (headers / CSRF / rate-limit) + §1c
// (browser flow) + v3.docx §2.5.3 (edit marker) + §2.2.1 (presence markers).
//
// Scope — four small tests, each covering one thing the manual smoke proved
// is worth re-asserting after any header / CORS / CSRF / CSP change:
//   t1: REQ-149 CSP connect-src allows the backend sidecar origin.
//   t2: CSRF double-submit — browser POST with Origin header and no csrf
//       cookie gets 403 csrf_token_missing (not 400, not 500).
//   t3: REQ-111 — author edits own message, (edited) indicator renders AND
//       survives a hard reload (editedAt persists server-side).
//   t4: REQ-215 — offline suffix "(offline)" appears on the member list
//       after the observed user's tab closes.
//
// Why these four (and not the whole smoke): the rest already has coverage —
//   - broadcast on seeded #general → s1-demo.spec.ts
//   - admin delete tombstone      → s2-admin-delete.spec.ts
//   - attach picker               → s2-attach-button.spec.ts
//   - forgot/reset password       → s2-forgot-password.spec.ts
//   - moderation kick/ban tabs    → s2-moderation.spec.ts

import { test, expect, type Page, type BrowserContext } from "@playwright/test";

const BACKEND_HEALTH = "http://localhost:4000/health";
const BACKEND_URL = "http://localhost:4000";
const SEED_PASSWORD = "hunter2hunter2"; // from scripts/seed.ts

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

async function signInSeeded(
  page: Page,
  user: { email: string; password: string },
): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: /^sign in$/i }).click();
  await expect(page).toHaveURL(/\/rooms(\/|$)/, { timeout: 15_000 });
}

test.describe.configure({ mode: "serial" });

test.describe("S3 submission-gate smoke — CSP / CSRF / edit marker / presence", () => {
  test.beforeAll(async () => {
    const res = await fetch(BACKEND_HEALTH).catch(() => null);
    test.skip(
      !res || !res.ok,
      `Backend not healthy at ${BACKEND_HEALTH}. Boot with: docker compose up --build -d (or pnpm --filter backend dev).`,
    );
  });

  test("REQ-149 — / response carries CSP header that allows the backend origin in connect-src", async ({
    page,
  }) => {
    // The fix in commit 7051175 added http://localhost:4000 to connect-src +
    // img-src so the Next.js frontend can reach the Fastify sidecar from the
    // browser. Regression: if a future helmet/CSP edit drops the backend
    // origin, the entire app breaks at runtime (rooms list fetch fails, ws
    // handshake rejected). This test is a 1-response-headers check that
    // catches it without a full browser flow.
    const response = await page.goto("/");
    expect(response, "Next.js /").not.toBeNull();
    const csp =
      response!.headers()["content-security-policy"] ??
      response!.headers()["content-security-policy-report-only"];
    expect(csp, "CSP header must be present on the Next.js root").toBeTruthy();
    // connect-src is the directive that governs fetch/ws/EventSource.
    // Match the exact token we shipped, 'self' is not enough in a
    // split-origin web+backend layout.
    expect(csp).toMatch(/connect-src[^;]*localhost:4000/);
  });

  test("CSRF double-submit oracle — browser POST with Origin, no csrf cookie → 403 csrf_token_missing", async ({
    page,
  }) => {
    // Emulate a real cross-origin browser caller: navigate to / first so the
    // page has an Origin of http://localhost:3000, then fire a same-shape
    // fetch to the backend from inside page.evaluate. The browser will
    // populate Origin automatically; we deliberately do NOT carry a csrf
    // cookie (the app sets one on first session, we haven't signed in).
    await page.goto("/");
    const result = await page.evaluate(async (backendUrl) => {
      const res = await fetch(`${backendUrl}/api/v1/rooms`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "csrf-oracle", visibility: "public" }),
      });
      const text = await res.text();
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
      return { status: res.status, body: parsed };
    }, BACKEND_URL);

    expect(result.status).toBe(403);
    expect(result.body).toMatchObject({ error: "csrf_token_missing" });
  });

  test("REQ-111 — author edits own message; (edited) marker renders and persists after reload", async ({
    browser,
  }) => {
    const suffix = stamp();
    const alice = {
      email: `s3edit-a-${suffix}@herders.local`,
      username: `s3editA${suffix}`,
      name: "S3 Edit Alice",
      password: "playwright-s3edit-1234",
    };
    const original = `edit-orig-${suffix}`;
    const edited = `edit-new-${suffix}`;

    const ctx: BrowserContext = await browser.newContext();
    try {
      const page = await ctx.newPage();
      await registerAndEnterRooms(page, alice);

      // Auto-enrolled in #general on signup — go there directly rather than
      // creating a new room (the "+ New room" button lives in the per-room
      // sidebar, not on the /rooms index). Unique suffix on the message body
      // keeps the assertion isolated from any other author's noise.
      await page.goto("/rooms/general");
      await expect(page).toHaveURL(/\/rooms\/general$/);

      // Send original.
      const composer = page.getByRole("textbox", { name: /message/i });
      await composer.fill(original);
      await composer.press("Enter");
      const row = page.locator("div.group", { hasText: original }).first();
      await expect(row).toBeVisible({ timeout: 10_000 });

      // Open MessageActions, click Edit, replace body, save. Once the row
      // enters edit mode its body text flips from `original` to the textarea
      // contents, so any selector scoped `hasText: original` stops matching
      // mid-flow — address the save affordance from `page` directly (only
      // one inline editor can be open at a time).
      await row.hover();
      await row.getByTestId("message-actions-toggle").click();
      await row.getByTestId("message-edit").click();
      const editInput = page.getByTestId("message-edit-input");
      await expect(editInput).toBeVisible();
      await editInput.fill(edited);
      // Enter submits per EditMessageForm keydown handler; equivalent to
      // clicking the Save button but avoids the stale-row lookup.
      await editInput.press("Enter");

      // The new body is visible, and the (edited) marker renders.
      const editedRow = page
        .locator("div.group", { hasText: edited })
        .first();
      await expect(editedRow.getByTestId("message-edited-indicator")).toBeVisible(
        { timeout: 10_000 },
      );

      // REQ-111 persistence: editedAt survives server-side. Hard reload and
      // check the marker is still there.
      await page.reload();
      const persistedRow = page
        .locator("div.group", { hasText: edited })
        .first();
      await expect(
        persistedRow.getByTestId("message-edited-indicator"),
      ).toBeVisible({ timeout: 10_000 });
      // Original body is gone.
      await expect(page.getByText(original)).toHaveCount(0);
    } finally {
      await ctx.close();
    }
  });

  test("REQ-215 — member's presence flips to (offline) after their tab closes", async ({
    browser,
  }) => {
    // Cross-user observable: Alice watches the MembersTab in a seeded public
    // room; Bob signs in (seeded), lands on the same room, closes the tab.
    // Alice's member row for Bob must flip from no-suffix (online) to
    // "(offline)" within the presence-heartbeat window (PresencePill reads
    // from the same usePresence store as MemberList.presenceSuffix — the
    // bug we watch for is a store that doesn't emit the offline transition
    // when the last socket of a user disconnects).
    const aliceCtx: BrowserContext = await browser.newContext();
    const bobCtx: BrowserContext = await browser.newContext();
    try {
      const alicePage = await aliceCtx.newPage();
      const bobPage = await bobCtx.newPage();

      await signInSeeded(alicePage, {
        email: "alice@herders.local",
        password: SEED_PASSWORD,
      });
      await signInSeeded(bobPage, {
        email: "bob@herders.local",
        password: SEED_PASSWORD,
      });

      // Both head into seeded #general.
      await alicePage.getByText("#general").click();
      await expect(alicePage).toHaveURL(/\/rooms\/general$/);
      await bobPage.getByText("#general").click();
      await expect(bobPage).toHaveURL(/\/rooms\/general$/);

      // Alice should see Bob's row without an offline suffix while Bob is
      // actively connected. Match on the MemberList row containing Bob's
      // display name (seed sets display = username-capitalized = "Bob").
      const aside = alicePage.getByRole("complementary", { name: /^members$/i });
      const bobRow = aside
        .locator("li", { hasText: /bob/i })
        .first();
      await expect(bobRow).toBeVisible({ timeout: 15_000 });
      await expect(bobRow).not.toContainText("(offline)");

      // Close Bob's browser context — drops his socket. Alice's observer
      // should flip within the presence window.
      await bobCtx.close();
      await expect(bobRow).toContainText("(offline)", { timeout: 20_000 });
    } finally {
      // bobCtx may already be closed; guard against double-close.
      if (!bobCtx.pages().every((p) => p.isClosed())) {
        await bobCtx.close().catch(() => {});
      }
      await aliceCtx.close();
    }
  });
});
