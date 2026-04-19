// Skeleton for agent F (feat/catalog-emoji-dm-unread) — v3.docx §2.7
// (DM unread badge).
//
// Binding: docs/specs/s2-e2e-coverage.md §4 S5. test.skip until merge.
// Unskip steps: delete test.skip line, swap REQ-TBD for F's canonical
// REQ-ID, fill selectors from F's UI.
//
// Cross-user shape: Alice DMs Bob; Bob's DM tab/badge surfaces the
// unread count; opening the thread clears it. Two BrowserContexts are
// required — pattern matches s2-invitations.spec.ts.

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

test.describe("REQ-TBD §2.7 — DM unread badge (agent F)", () => {
  test.beforeAll(async () => {
    const res = await fetch(BACKEND_HEALTH).catch(() => null);
    test.skip(
      !res || !res.ok,
      `Backend not healthy at ${BACKEND_HEALTH}. Boot with: docker compose up --build -d (or pnpm --filter backend dev).`,
    );
  });

  test("REQ-TBD §2.7 — Bob sees unread=1 on DM tab; opening thread clears it (test.skip pending feat/catalog-emoji-dm-unread)", async ({
    browser,
  }) => {
    test.skip(
      true,
      "TODO(agent-F): unskip after feat/catalog-emoji-dm-unread merges; replace REQ-TBD in the test name + spec §10 with the canonical REQ-ID for §2.7 (DM unread).",
    );

    // Scaffolded shape:
    //   1. Alice + Bob register.
    //   2. Alice opens a DM with Bob (entry point TBD — likely the DM
    //      tab on /rooms or a "Message" button on Bob's profile / member
    //      row). Selector candidates: getByRole("tab", { name: /dm/i }),
    //      getByTestId("dm-new"), getByRole("button", { name: /message @bob/i }).
    //   3. Alice sends "ping-<suffix>" in the thread.
    //   4. On Bob's page (currently NOT inside the DM thread — keep him
    //      on /rooms or a non-DM surface), his DM tab/list surfaces an
    //      unread marker. Selector TBD — likely:
    //        - getByTestId("dm-unread-badge") with text "1", OR
    //        - a superscript/count badge on the DM tab
    //          (e.g. getByRole("tab", { name: /dm/i })
    //             .getByText("1")).
    //   5. Bob clicks the thread row; the badge disappears on next
    //      paint (assert toHaveCount(0) with a small timeout — NOT
    //      waitForTimeout; Playwright auto-waits).
    //   6. Optional: Alice sends a second DM; Bob still has the thread
    //      open, so the badge stays at 0 (live-read assertion). If F's
    //      implementation uses a "focus" signal rather than "thread
    //      open", confirm on merge.
    const suffix = stamp();
    const alice = {
      email: `dm-a-${suffix}@herders.local`,
      username: `dmA${suffix}`,
      name: "DM Alice",
      password: "playwright-dm-1234",
    };
    const bob = {
      email: `dm-b-${suffix}@herders.local`,
      username: `dmB${suffix}`,
      name: "DM Bob",
      password: "playwright-dm-1234",
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
