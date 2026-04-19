// Skeleton for agent F (feat/catalog-emoji-dm-unread) — v3.docx §2.5.2
// (emoji picker in composer).
//
// Binding: docs/specs/s2-e2e-coverage.md §4 S4. test.skip until merge.
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

async function createPublicRoom(page: Page, roomName: string): Promise<void> {
  await page.getByRole("button", { name: /create a new room/i }).click();
  const dialog = page.getByRole("dialog", { name: /create a new room/i });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Name").fill(roomName);
  await dialog.getByLabel(/^Public$/).check();
  await dialog.getByRole("button", { name: /^create room$/i }).click();
  await expect(page).toHaveURL(/\/rooms\/[0-9a-f-]+$/, { timeout: 15_000 });
  await expect(page.getByText(`#${roomName}`).first()).toBeVisible();
}

test.describe.configure({ mode: "serial" });

test.describe("REQ-TBD §2.5.2 — emoji picker in composer (agent F)", () => {
  test.beforeAll(async () => {
    const res = await fetch(BACKEND_HEALTH).catch(() => null);
    test.skip(
      !res || !res.ok,
      `Backend not healthy at ${BACKEND_HEALTH}. Boot with: docker compose up --build -d (or pnpm --filter backend dev).`,
    );
  });

  test("REQ-TBD §2.5.2 — emoji picker inserts emoji at cursor and keeps composer focus (test.skip pending feat/catalog-emoji-dm-unread)", async ({
    browser,
  }) => {
    test.skip(
      true,
      "TODO(agent-F): unskip after feat/catalog-emoji-dm-unread merges; replace REQ-TBD in the test name + spec §10 with the canonical REQ-ID for §2.5.2 (emoji picker).",
    );

    // Scaffolded shape:
    //   1. Alice registers, creates a public room.
    //   2. Alice types "hi " into the composer textbox
    //      (page.getByRole("textbox", { name: /^message$/i })).
    //   3. Alice clicks the emoji-picker trigger (selector TBD — likely
    //      getByRole("button", { name: /emoji/i }) or a data-testid
    //      like `emoji-picker-trigger`).
    //   4. The picker opens (role=dialog or data-testid=`emoji-picker`);
    //      Alice clicks a specific emoji button (e.g. 😀).
    //   5. The composer value now ends with the chosen emoji appended
    //      after "hi ". Confirm via await expect(textbox).toHaveValue(...)
    //      — do NOT assert on the final message row because this test
    //      only exercises composer insertion, not send.
    //   6. The composer still has focus after the picker closes (assert
    //      via expect(textbox).toBeFocused()).
    const suffix = stamp();
    const alice = {
      email: `emoji-${suffix}@herders.local`,
      username: `emoji${suffix}`,
      name: "Emoji Alice",
      password: "playwright-emoji-1234",
    };
    const roomName = `emoji-${suffix}`;

    const ctx: BrowserContext = await browser.newContext();
    try {
      const page = await ctx.newPage();
      await registerAndEnterRooms(page, alice);
      await createPublicRoom(page, roomName);
      // …remaining assertions land at unskip time.
    } finally {
      await ctx.close();
    }
  });
});
