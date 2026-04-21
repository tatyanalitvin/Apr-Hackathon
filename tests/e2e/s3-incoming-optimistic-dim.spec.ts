// Incoming friend-request row — optimistic dim during mutation. Binding fix:
// 3f1c09c "fix(contacts): wire optimistic-removal visual to IncomingRow".
//
// Symptom the fix addresses: IncomingRow was plumbed with isRemoving but
// never consumed it, so the "row dims the moment you click Accept / Decline
// / Block" feedback documented at the top of IncomingRequestsTab was a
// silent regression — the row did nothing visible until the parent's
// refetch finally dropped it.
//
// The fix toggles `opacity-60 pointer-events-none` and aria-busy=true the
// instant markRemoving(id, true) fires. To observe that transient state
// reliably we route-stall the accept endpoint for ~800ms so the optimistic
// flip has a window to exist before the refetch drops the row.

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

test.describe("REQ-057 — IncomingRow optimistic dim during accept", () => {
  test.beforeAll(async () => {
    const res = await fetch(BACKEND_HEALTH).catch(() => null);
    test.skip(
      !res || !res.ok,
      `Backend not healthy at ${BACKEND_HEALTH}. Boot with: docker compose up --build -d`,
    );
  });

  test("Accept click flips the row to aria-busy+opacity-60 while the request is in flight", async ({
    browser,
  }) => {
    const suffix = stamp();
    const aliceCtx: BrowserContext = await browser.newContext();
    const bobCtx: BrowserContext = await browser.newContext();
    try {
      const aliceP = await aliceCtx.newPage();
      const bobP = await bobCtx.newPage();

      const alice = {
        email: `incd-a-${suffix}@herders.local`,
        username: `incdA${suffix}`,
        name: "Alice",
        password: "Hackaton_Test_Pw_2026!",
      };
      const bob = {
        email: `incd-b-${suffix}@herders.local`,
        username: `incdB${suffix}`,
        name: "Bob",
        password: "Hackaton_Test_Pw_2026!",
      };

      await registerAndEnterRooms(aliceP, alice);
      await registerAndEnterRooms(bobP, bob);

      // Alice sends Bob a friend request via the AddFriend dialog. Wait for
      // the dialog to confirm "Request sent" so the POST resolves before we
      // Escape — otherwise the request can lose the race and Bob sees no row.
      await aliceP.goto("/contacts");
      await aliceP.getByRole("button", { name: /^add friend$/i }).click();
      await aliceP
        .getByRole("searchbox", { name: /search users/i })
        .fill(bob.username);
      await aliceP
        .getByRole("button", { name: /^send request$/i })
        .first()
        .click();
      await expect(
        aliceP.getByRole("button", { name: /^request sent$/i }).first(),
      ).toBeVisible({ timeout: 10_000 });
      await aliceP.keyboard.press("Escape");

      // Bob opens /contacts; /contacts defaults to the "Friends" tab, so we
      // click the "Incoming" tab trigger to mount IncomingRequestsTab before
      // looking for the row. The incoming request row is rendered inside the
      // "Incoming friend requests" list.
      await bobP.goto("/contacts");
      await bobP.getByRole("tab", { name: /^incoming/i }).click();
      const requestsList = bobP.getByRole("list", {
        name: /incoming friend requests/i,
      });
      await expect(
        requestsList.getByText(alice.username),
      ).toBeVisible({ timeout: 10_000 });

      // Route-stall the accept endpoint so the optimistic-dim state stays
      // on screen long enough to observe. 800ms is comfortably above
      // Playwright's default polling interval but well below test timeout.
      await bobP.route(
        /\/api\/v1\/friends\/requests\/.+\/accept$/,
        async (route) => {
          await new Promise((r) => setTimeout(r, 800));
          await route.continue();
        },
      );

      // The accepted row lives inside this <li> — locate it by the "Accept
      // request from <alice.username>" button's ancestor list item. Grabbing
      // the <li> rather than the button lets us assert aria-busy on the row
      // itself (where the fix attaches it).
      const acceptBtn = bobP.getByRole("button", {
        name: new RegExp(`accept request from ${alice.username}`, "i"),
      });
      const row = bobP.locator("li").filter({ has: acceptBtn });
      await expect(row).toHaveAttribute("aria-busy", "false");

      await acceptBtn.click();

      // With the fix: the row immediately flips to aria-busy=true and the
      // row <li> has opacity-60 + pointer-events-none class tokens. The
      // 800ms route stall gives us headroom to catch it.
      await expect(row).toHaveAttribute("aria-busy", "true", {
        timeout: 1_000,
      });
      const className = (await row.getAttribute("class")) ?? "";
      expect(className).toMatch(/opacity-60/);
      expect(className).toMatch(/pointer-events-none/);

      // And after the stalled accept resolves + the parent refetches, the
      // row disappears entirely.
      await expect(row).toHaveCount(0, { timeout: 5_000 });
    } finally {
      await aliceCtx.close();
      await bobCtx.close();
    }
  });
});
