// REQ-UserSearch §2.4 R25 — Alice + Bob are friends; Alice opens "+ New"
// on the DM list, types "bob", clicks "Start DM", lands on the DM room.
// Binding spec: docs/specs/s3-user-search.md §4 R25.

import { test, expect, type Page, type BrowserContext } from "@playwright/test";

const BACKEND_HEALTH = "http://localhost:4000/health";

const stamp = () => Date.now().toString(36);

async function register(
  page: Page,
  u: { email: string; username: string; name: string; password: string },
): Promise<void> {
  await page.goto("/register");
  await page.getByLabel("Email").fill(u.email);
  await page.getByLabel("Username").fill(u.username);
  await page.getByLabel("Display name").fill(u.name);
  await page.getByLabel("Password", { exact: true }).fill(u.password);
  await page.getByLabel("Confirm password").fill(u.password);
  await page.getByRole("button", { name: /create account/i }).click();
  await expect(page).toHaveURL(/\/rooms(\/|$)/, { timeout: 15_000 });
}

test.describe.configure({ mode: "serial" });

test.describe("REQ-UserSearch §2.4 R25 — user-search DM happy path", () => {
  test.beforeAll(async () => {
    const res = await fetch(BACKEND_HEALTH).catch(() => null);
    test.skip(
      !res || !res.ok,
      `Backend not healthy at ${BACKEND_HEALTH}. Boot with: docker compose up --build -d`,
    );
  });

  test("REQ-UserSearch §2.4 — Alice searches 'bob', clicks Start DM, lands on DM", async ({
    browser,
  }) => {
    const suffix = stamp();
    const aliceCtx: BrowserContext = await browser.newContext();
    const bobCtx: BrowserContext = await browser.newContext();
    try {
      const aliceP = await aliceCtx.newPage();
      const bobP = await bobCtx.newPage();

      const alice = {
        email: `us-${suffix}-a@herders.local`,
        username: `usa${suffix}`,
        name: "Alice",
        password: "Hackaton_Test_Pw_2026!",
      };
      const bob = {
        email: `us-${suffix}-b@herders.local`,
        username: `usb${suffix}`,
        name: "Bob Bobson",
        password: "Hackaton_Test_Pw_2026!",
      };

      await register(aliceP, alice);
      await register(bobP, bob);

      // Alice sends a friend request to Bob via the UI (friend-requests page
      // expects exact username — unchanged by this feature).
      await aliceP.goto("/friends");
      await aliceP.getByLabel(/username/i).fill(bob.username);
      await aliceP.getByRole("button", { name: /send request/i }).click();
      await expect(aliceP.getByText(/request.*sent|pending/i)).toBeVisible({
        timeout: 10_000,
      });

      // Bob accepts.
      await bobP.goto("/friends");
      await bobP.getByRole("button", { name: /accept/i }).first().click();
      await expect(bobP.getByText(alice.username)).toBeVisible({ timeout: 10_000 });

      // Alice opens "+ New" and searches Bob by partial username.
      await aliceP.goto("/rooms");
      await aliceP.getByRole("button", { name: /start a new dm/i }).click();
      await aliceP
        .getByRole("searchbox", { name: /search/i })
        .fill(bob.username.slice(0, 3));
      const startBtn = aliceP.getByRole("button", { name: /start dm/i });
      await expect(startBtn).toBeVisible({ timeout: 5_000 });
      await startBtn.click();

      // Alice lands on the DM room.
      await expect(aliceP).toHaveURL(/\/rooms\/[a-f0-9-]+/i, { timeout: 10_000 });
    } finally {
      await aliceCtx.close();
      await bobCtx.close();
    }
  });
});
