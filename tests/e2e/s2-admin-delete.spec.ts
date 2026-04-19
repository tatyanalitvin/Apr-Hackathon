// REQ-212 — v3 §2.5.5 admin delete, browser-level confirmation.
//
// Binding: docs/specs/s3-chat-surface-polish.md §3 REQ-212, §4 test plan.
// The backend gate + broadcast payload are covered by
// apps/backend/tests/message-delete-admin.test.ts (7 scenarios). This spec
// re-asserts the UI affordance end-to-end so a regression in the role
// plumbing (settingsRole → MessageList → MessageRow → MessageActions) does
// not silently downgrade the admin's menu to author-only.
//
// Cross-user shape (two BrowserContexts — same pattern as
// s2-moderation.spec.ts):
//   1. Alice registers, creates a public room.
//   2. Bob registers, joins the room, sends a message.
//   3. Alice hovers Bob's message → ⋯ menu exposes Delete (not Edit).
//   4. Alice clicks Delete → Confirm. Tombstone "[message deleted]" renders
//      on BOTH pages via the REQ-047/REQ-112 broadcast.

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
}

async function joinFromBrowse(page: Page, roomName: string): Promise<void> {
  // feedback-playwright-rhf-spa-transition: goto the destination instead of
  // a Link click so rhf state on the destination form is primed cleanly.
  await page.goto("/rooms/browse");
  const row = page.getByRole("row", { name: new RegExp(roomName, "i") });
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.getByRole("button", { name: /^join$/i }).click();
  await expect(page).toHaveURL(/\/rooms\/[0-9a-f-]+$/, { timeout: 15_000 });
}

test.describe.configure({ mode: "serial" });

test.describe("REQ-212 §2.5.5 — admin can delete another member's message", () => {
  test.beforeAll(async () => {
    const res = await fetch(BACKEND_HEALTH).catch(() => null);
    test.skip(
      !res || !res.ok,
      `Backend not healthy at ${BACKEND_HEALTH}. Boot with: docker compose up --build -d (or pnpm --filter backend dev).`,
    );
  });

  test("REQ-212 admin delete reveals Delete (no Edit); tombstone renders on both pages", async ({
    browser,
  }) => {
    const suffix = stamp();
    const alice = {
      email: `s3ad-a-${suffix}@herders.local`,
      username: `s3adA${suffix}`,
      name: "S3 Alice",
      password: "playwright-s3ad-1234",
    };
    const bob = {
      email: `s3ad-b-${suffix}@herders.local`,
      username: `s3adB${suffix}`,
      name: "S3 Bob",
      password: "playwright-s3ad-1234",
    };
    const roomName = `s3-admin-del-${suffix}`;
    const bobMsg = `bob-said-${suffix}`;

    const aliceCtx: BrowserContext = await browser.newContext();
    const bobCtx: BrowserContext = await browser.newContext();
    try {
      const alicePage = await aliceCtx.newPage();
      const bobPage = await bobCtx.newPage();

      await registerAndEnterRooms(alicePage, alice);
      await registerAndEnterRooms(bobPage, bob);
      await createPublicRoom(alicePage, roomName);
      await joinFromBrowse(bobPage, roomName);

      // Bob sends a message.
      await bobPage.getByRole("textbox", { name: /message/i }).fill(bobMsg);
      await bobPage.keyboard.press("Enter");
      // Alice must see it before she can act on it.
      const aliceMsg = alicePage.getByText(bobMsg).first();
      await expect(aliceMsg).toBeVisible({ timeout: 10_000 });

      // Open the MessageActions menu on Bob's row. The ⋯ button is opacity-0
      // until the row is hovered; mousemove the message first.
      const aliceRow = alicePage
        .locator("div.group", { hasText: bobMsg })
        .first();
      await aliceRow.hover();
      await aliceRow.getByTestId("message-actions-toggle").click();

      // REQ-212 — on a non-own message the admin sees Delete but NOT Edit.
      await expect(aliceRow.getByTestId("message-delete")).toBeVisible();
      await expect(aliceRow.getByTestId("message-edit")).toHaveCount(0);

      // Delete → Confirm (two-step inline per MessageActions §1d).
      await aliceRow.getByTestId("message-delete").click();
      await aliceRow.getByTestId("message-delete-confirm").click();

      // Tombstone renders on Alice's page (her mutation) AND Bob's page
      // (via the REQ-047/REQ-112 broadcast — confirms deletedByRole='admin'
      // path reached his reducer without a 4xx).
      await expect(
        alicePage.getByTestId("message-tombstone").first(),
      ).toBeVisible({ timeout: 10_000 });
      await expect(
        bobPage.getByTestId("message-tombstone").first(),
      ).toBeVisible({ timeout: 10_000 });

      // The original body text must no longer be present on either side —
      // tombstone replaces it with "[message deleted]".
      await expect(alicePage.getByText(bobMsg)).toHaveCount(0);
      await expect(bobPage.getByText(bobMsg)).toHaveCount(0);
    } finally {
      await aliceCtx.close();
      await bobCtx.close();
    }
  });
});
