// REQ-089 — invitation decline (v3.docx §2.4.9).
//
// Binding: docs/specs/s2-e2e-coverage.md §4 R11. Sibling to
// tests/e2e/s2-invitations.spec.ts (agent B) which already covers R9/R10
// (happy-path accept) and R12 (cancel asymmetry). This file adds the
// decline asymmetry: Bob drops the row from his InboxList and Alice's
// "Pending invitations" row in InvitationsTab disappears live.
//
// Behaviour under test (confirmed against InvitationsTab.tsx:62-79):
// on `room.invitation.declined` the inviter's pending-invitations list
// filters the row client-side (no "declined" status badge — the row is
// simply removed). The spec's §4 R11 description is refined to match.

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

async function createPrivateRoom(page: Page, roomName: string): Promise<void> {
  await page.getByRole("button", { name: /create a new room/i }).click();
  const dialog = page.getByRole("dialog", { name: /create a new room/i });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Name").fill(roomName);
  await dialog.getByLabel(/^Private$/).check();
  await dialog.getByRole("button", { name: /^create room$/i }).click();
  await expect(page).toHaveURL(/\/rooms\/[0-9a-f-]+$/, { timeout: 15_000 });
  await expect(page.getByText(`#${roomName}`).first()).toBeVisible();
}

async function sendInviteFromTab(
  page: Page,
  inviteeUsername: string,
): Promise<void> {
  await page.getByRole("button", { name: /manage room/i }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("tab", { name: /invitations/i }).click();
  await page.getByLabel(/invite by username/i).fill(inviteeUsername);
  await page.getByRole("button", { name: /^send invite$/i }).click();
  await expect(
    page.getByText(new RegExp(`@${inviteeUsername}`, "i")).first(),
  ).toBeVisible({ timeout: 10_000 });
}

test.describe.configure({ mode: "serial" });

test.describe("REQ-089 — invitation decline asymmetry", () => {
  test.beforeAll(async () => {
    const res = await fetch(BACKEND_HEALTH).catch(() => null);
    test.skip(
      !res || !res.ok,
      `Backend not healthy at ${BACKEND_HEALTH}. Boot with: docker compose up --build -d (or pnpm --filter backend dev).`,
    );
  });

  test("REQ-089 — Bob declines; his inbox row disappears and Alice's pending list drops the row live", async ({
    browser,
  }) => {
    const suffix = stamp();
    const alice = {
      email: `decl-a-${suffix}@herders.local`,
      username: `declA${suffix}`,
      name: "Decline Alice",
      password: "playwright-decl-1234",
    };
    const bob = {
      email: `decl-b-${suffix}@herders.local`,
      username: `declB${suffix}`,
      name: "Decline Bob",
      password: "playwright-decl-1234",
    };
    const roomName = `decline-${suffix}`;

    const aliceCtx: BrowserContext = await browser.newContext();
    const bobCtx: BrowserContext = await browser.newContext();
    try {
      const alicePage = await aliceCtx.newPage();
      const bobPage = await bobCtx.newPage();

      await registerAndEnterRooms(alicePage, alice);
      await registerAndEnterRooms(bobPage, bob);

      await createPrivateRoom(alicePage, roomName);
      await sendInviteFromTab(alicePage, bob.username);

      // Alice keeps the InvitationsTab open — this is the surface where
      // the row must vanish on decline. Locate the row BEFORE Bob acts so
      // the subsequent expect(...).toHaveCount(0) is a meaningful drop.
      const alicePendingRow = alicePage
        .getByText(new RegExp(`@${bob.username}`, "i"))
        .first();
      await expect(alicePendingRow).toBeVisible();

      // Bob's InboxList surfaces the invite; he declines.
      const inbox = bobPage.getByTestId("inbox-list");
      await expect(inbox).toBeVisible({ timeout: 15_000 });
      await expect(inbox.getByText(`#${roomName}`).first()).toBeVisible();
      await inbox.getByRole("button", { name: /^decline$/i }).click();

      // Bob's inbox drops the row (the incoming-side filter on
      // room.invitation.declined is local to Bob's InboxList; the row
      // removal is the success signal).
      await expect(inbox.getByText(`#${roomName}`)).toHaveCount(0, {
        timeout: 10_000,
      });

      // Alice's pending list drops the row via the
      // room.invitation.declined fanout that InvitationsTab.tsx:69-71
      // filters client-side.
      await expect(
        alicePage.getByText(new RegExp(`@${bob.username}`, "i")),
      ).toHaveCount(0, { timeout: 10_000 });
    } finally {
      await aliceCtx.close();
      await bobCtx.close();
    }
  });
});
