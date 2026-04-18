// S1 scroll smoke — demo-visible behaviors the composer tests don't cover.
//
// REQ-047: when Alice is scrolled up (not at bottom) and a new message arrives,
//          the viewport does NOT auto-jump; a "↓ N new message" pill surfaces
//          instead. Clicking the pill returns her to the live tail.
// REQ-048: when Alice scrolls to the top of a room with >1 page of history,
//          the client fetches the older page and prepends it, without shifting
//          the messages currently under her cursor.
//
// Approach: Bob signs in through the UI (so his browser context holds a valid
// cookie for both :3000 and :4000), then issues a tight fetch-loop via
// page.evaluate to bulk-post ~30 messages straight to the backend. This is
// ~10× faster than driving the composer once per message, and it exercises the
// exact same auth + rate-limit paths a real client uses. Alice then logs in,
// enters #general, and we drive Virtuoso via its documented
// `data-testid="virtuoso-scroller"` element (react-virtuoso 4.x).
//
// Self-skips if the backend isn't healthy — the submission gate is
// `docker compose up` so a missing stack is expected on a cold worktree.

import { test, expect, type Page } from "@playwright/test";

const BACKEND = "http://localhost:4000";
const BACKEND_HEALTH = `${BACKEND}/health`;
const SEED_PASSWORD = "hunter2hunter2";
const ALICE = { email: "alice@herders.local", password: SEED_PASSWORD };
const BOB = { email: "bob@herders.local", password: SEED_PASSWORD };
const BULK_COUNT = 30;

async function signInAndEnterGeneral(page: Page, creds: { email: string; password: string }) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(creds.email);
  await page.getByLabel("Password").fill(creds.password);
  await page.getByRole("button", { name: /^sign in$/i }).click();
  await expect(page).toHaveURL(/\/rooms$/, { timeout: 15_000 });
  await page.getByText("#general").click();
  await expect(page).toHaveURL(/\/rooms\/general$/);
}

async function bulkPostAsLoggedInUser(page: Page, count: number, backend: string) {
  const result = await page.evaluate(
    async ({ count, backend }) => {
      const statuses: number[] = [];
      for (let i = 1; i <= count; i++) {
        const res = await fetch(`${backend}/api/v1/rooms/general/messages`, {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            body: `scrollprobe-${String(i).padStart(2, "0")} padding text for scroll test`,
          }),
        });
        statuses.push(res.status);
        if (!res.ok) break;
      }
      return statuses;
    },
    { count, backend },
  );
  const failed = result.filter((s) => s >= 400);
  if (failed.length > 0) {
    throw new Error(
      `bulk-post failed after ${result.length}/${count} (statuses: ${result.slice(-5).join(", ")})`,
    );
  }
}

test.describe.configure({ mode: "serial" });

test.describe("REQ-047 REQ-048 — scroll-pin + lazy older-page", () => {
  test.beforeAll(async () => {
    const res = await fetch(BACKEND_HEALTH).catch(() => null);
    test.skip(
      !res || !res.ok,
      `Backend not healthy at ${BACKEND_HEALTH}. Boot with: docker compose up --build -d && pnpm db:seed`,
    );
  });

  test("REQ-047 pill surfaces when scrolled up; REQ-048 older page loads on scroll-to-top", async ({
    browser,
  }) => {
    // 1. Bob signs in and bulk-posts the backdrop history via same-origin fetch.
    const bobCtx = await browser.newContext();
    const bob = await bobCtx.newPage();
    await signInAndEnterGeneral(bob, BOB);
    await bulkPostAsLoggedInUser(bob, BULK_COUNT, BACKEND);

    // 2. Alice opens #general fresh.
    const aliceCtx = await browser.newContext();
    const alice = await aliceCtx.newPage();
    try {
      await signInAndEnterGeneral(alice, ALICE);

      // Newest bulk message is visible — Alice lands at the live tail.
      await expect(
        alice.getByText(`scrollprobe-${String(BULK_COUNT).padStart(2, "0")} padding text`, {
          exact: false,
        }),
      ).toBeVisible({ timeout: 15_000 });

      const scroller = alice.getByTestId("virtuoso-scroller");
      await expect(scroller).toBeVisible();

      // — REQ-048: each scroll-to-top fires `startReached` → `onLoadOlder`
      // prepends ONE older page. The backdrop is ~30 messages across several
      // pages, so we loop until scrollprobe-01 actually shows up (or bail).
      const probe01 = alice.getByText("scrollprobe-01 padding text", { exact: false });
      for (let i = 0; i < 10; i++) {
        await scroller.evaluate((el) => {
          el.scrollTop = 0;
        });
        if (await probe01.isVisible().catch(() => false)) break;
        await alice.waitForTimeout(400);
      }
      await expect(probe01).toBeVisible({ timeout: 5_000 });

      // Prepended older messages must NOT inflate the unread pill — the pill
      // only counts incoming (appended) messages. If this assertion fires,
      // MessageList.tsx is treating prepends as unread (was a real bug).
      const pill = alice.getByRole("button", { name: /↓ \d+ new message/i });
      await expect(pill).toBeHidden();

      // — REQ-047: Alice is parked near the top. Bob sends one more message
      // via the composer; the viewport must NOT jump — the pill must surface
      // with a count ≥ 1, and clicking it returns Alice to the live tail.
      const sentinel = `📍 live-while-reading-${Date.now()}`;
      const bobComposer = bob.getByRole("textbox", { name: "Message" });
      await bobComposer.click();
      await bobComposer.fill(sentinel);
      await bobComposer.press("Enter");

      await expect(pill).toBeVisible({ timeout: 5_000 });

      await pill.click();
      await expect(pill).toBeHidden({ timeout: 5_000 });
      await expect(alice.getByText(sentinel, { exact: false })).toBeVisible({ timeout: 5_000 });
    } finally {
      await aliceCtx.close();
      await bobCtx.close();
    }
  });
});
