// Skeleton for agent F (feat/catalog-emoji-dm-unread) — v3.docx §2.4.3
// (catalog search).
//
// Binding: docs/specs/s2-e2e-coverage.md §4 S3. test.skip until merge.
// Unskip steps: delete test.skip line, swap REQ-TBD for F's canonical
// REQ-ID, fill selectors from F's UI.

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

test.describe("REQ-TBD §2.4.3 — catalog search (agent F)", () => {
  test.beforeAll(async () => {
    const res = await fetch(BACKEND_HEALTH).catch(() => null);
    test.skip(
      !res || !res.ok,
      `Backend not healthy at ${BACKEND_HEALTH}. Boot with: docker compose up --build -d (or pnpm --filter backend dev).`,
    );
  });

  test("REQ-TBD §2.4.3 — catalog search filters rooms as you type + empty-state (test.skip pending feat/catalog-emoji-dm-unread)", async ({
    browser,
  }) => {
    test.skip(
      true,
      "TODO(agent-F): unskip after feat/catalog-emoji-dm-unread merges; replace REQ-TBD in the test name + spec §10 with the canonical REQ-ID for §2.4.3 (catalog search).",
    );

    // Scaffolded shape:
    //   1. Alice registers, creates three public rooms with distinct
    //      names ({alpha-xxx, beta-xxx, gamma-xxx}).
    //   2. Alice visits /rooms/browse; all three rooms appear.
    //   3. Alice types "alpha" into the search box (selector TBD — likely
    //      getByRole("textbox", { name: /search rooms/i })); only the
    //      alpha room row remains.
    //   4. Alice clears + types "nomatch-zzz"; the list renders an
    //      empty state ("No rooms match" or equivalent — confirm on F's
    //      merge).
    const suffix = stamp();
    const alice = {
      email: `cat-${suffix}@herders.local`,
      username: `cat${suffix}`,
      name: "Cat Alice",
      password: "playwright-cat-1234",
    };

    const ctx: BrowserContext = await browser.newContext();
    try {
      const page = await ctx.newPage();
      await registerAndEnterRooms(page, alice);
      // …remaining assertions land at unskip time.
    } finally {
      await ctx.close();
    }
  });
});
