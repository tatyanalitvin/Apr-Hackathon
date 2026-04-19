// REQ-088 + REQ-089 — private rooms + invitations end-to-end.
//
// Covers the full happy path across two browser contexts so we exercise the
// per-user Socket.IO channel (user:{inviterId} + user:{inviteeId}) that R3
// fanout and R5 accept + R6 decline rely on. Running in one context would
// collapse to a single cookie jar and miss the cross-user event delivery —
// the memory entry "Playwright MCP multi-user needs two browsers" applies
// to non-MCP Playwright too: same cookie jar per BrowserContext.
//
// Scenarios:
//   s1 (happy path): Alice creates a private room, invites Bob, Bob sees
//       the InboxList entry, accepts, lands in the room.
//   s2 (cancel asymmetry): Alice invites Bob, Bob sees the invite, Alice
//       cancels before Bob accepts; Bob's InboxList drops the entry live
//       (fanout asymmetry binding, spec §5).
//
// Binding: docs/specs/s2-invitations.md §4 R2 (create private) + R3 (send)
// + R4 (inbox) + R5 (accept) + R7 (cancel + asymmetric fanout).

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
  // The "+ New room" trigger lives in the sidebar's RoomList.
  await page.getByRole("button", { name: /create a new room/i }).click();
  const dialog = page.getByRole("dialog", { name: /create a new room/i });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Name").fill(roomName);
  // REQ-088 — pick the Private radio. The fieldset exposes each option
  // as an accessible label, so role-based lookup works without a
  // data-testid.
  await dialog.getByLabel(/^Private$/).check();
  await dialog.getByRole("button", { name: /^create room$/i }).click();
  // Alice lands inside the new room.
  await expect(page).toHaveURL(/\/rooms\/[0-9a-f-]+$/, { timeout: 15_000 });
  await expect(page.getByText(`#${roomName}`).first()).toBeVisible();
}

async function sendInviteFromTab(page: Page, inviteeUsername: string): Promise<void> {
  // Open ManageRoomModal via its gear trigger (aria-label="Manage room").
  await page.getByRole("button", { name: /manage room/i }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("tab", { name: /invitations/i }).click();
  await page.getByLabel(/invite by username/i).fill(inviteeUsername);
  await page.getByRole("button", { name: /^send invite$/i }).click();
  // Outgoing list shows the new row.
  await expect(
    page.getByText(new RegExp(`@${inviteeUsername}`, "i")).first(),
  ).toBeVisible({ timeout: 10_000 });
  // Close the modal so it doesn't intercept further clicks.
  await page.keyboard.press("Escape");
}

test.describe.configure({ mode: "serial" });

test.describe("REQ-088 REQ-089 — private rooms + invitations", () => {
  test.beforeAll(async () => {
    const res = await fetch(BACKEND_HEALTH).catch(() => null);
    test.skip(
      !res || !res.ok,
      `Backend not healthy at ${BACKEND_HEALTH}. Boot with: docker compose up --build -d (or pnpm --filter backend dev).`,
    );
  });

  test("happy path — Alice invites, Bob accepts, room appears in Bob's sidebar", async ({
    browser,
  }) => {
    const suffix = stamp();
    const alice = {
      email: `inv-alice-${suffix}@herders.local`,
      username: `invAlice${suffix}`,
      name: "Invite Alice",
      password: "playwright-inv-1234",
    };
    const bob = {
      email: `inv-bob-${suffix}@herders.local`,
      username: `invBob${suffix}`,
      name: "Invite Bob",
      password: "playwright-inv-1234",
    };
    const roomName = `priv-${suffix}`;

    const aliceCtx: BrowserContext = await browser.newContext();
    const bobCtx: BrowserContext = await browser.newContext();
    try {
      const alicePage = await aliceCtx.newPage();
      const bobPage = await bobCtx.newPage();

      await registerAndEnterRooms(alicePage, alice);
      await registerAndEnterRooms(bobPage, bob);

      // Private room is visible only to its members — Bob's sidebar must
      // NOT list `roomName` before invite+accept.
      await expect(
        bobPage.getByRole("link", { name: roomName }),
      ).toHaveCount(0);

      await createPrivateRoom(alicePage, roomName);
      await sendInviteFromTab(alicePage, bob.username);

      // Bob's InboxList should surface the invite in real time via the
      // room.invitation.sent socket event. We wait for the data-testid
      // rather than matching the raw room name (which is also used in the
      // toast on Alice's side, distinct context but the same playground).
      const inbox = bobPage.getByTestId("inbox-list");
      await expect(inbox).toBeVisible({ timeout: 15_000 });
      await expect(inbox.getByText(`#${roomName}`).first()).toBeVisible();
      await inbox.getByRole("button", { name: /^accept$/i }).click();

      // Accept navigates Bob into the freshly-joined room.
      await expect(bobPage).toHaveURL(/\/rooms\/[0-9a-f-]+$/, {
        timeout: 10_000,
      });
      await expect(bobPage.getByText(`#${roomName}`).first()).toBeVisible();
    } finally {
      await aliceCtx.close();
      await bobCtx.close();
    }
  });

  test("cancel asymmetry — Alice cancels, Bob's inbox drops the row without a refresh", async ({
    browser,
  }) => {
    const suffix = stamp();
    const alice = {
      email: `inv2-alice-${suffix}@herders.local`,
      username: `inv2A${suffix}`,
      name: "Cancel Alice",
      password: "playwright-inv-1234",
    };
    const bob = {
      email: `inv2-bob-${suffix}@herders.local`,
      username: `inv2B${suffix}`,
      name: "Cancel Bob",
      password: "playwright-inv-1234",
    };
    const roomName = `cancel-${suffix}`;

    const aliceCtx: BrowserContext = await browser.newContext();
    const bobCtx: BrowserContext = await browser.newContext();
    try {
      const alicePage = await aliceCtx.newPage();
      const bobPage = await bobCtx.newPage();

      await registerAndEnterRooms(alicePage, alice);
      await registerAndEnterRooms(bobPage, bob);
      await createPrivateRoom(alicePage, roomName);
      await sendInviteFromTab(alicePage, bob.username);

      const inbox = bobPage.getByTestId("inbox-list");
      await expect(inbox).toBeVisible({ timeout: 15_000 });
      await expect(inbox.getByText(`#${roomName}`).first()).toBeVisible();

      // Alice cancels from the outgoing list.
      await alicePage.getByRole("button", { name: /manage room/i }).click();
      await alicePage.getByRole("tab", { name: /invitations/i }).click();
      await alicePage.getByRole("button", { name: /^cancel$/i }).click();

      // The inverted-audience fanout (spec §5) means Bob's inbox drops the
      // row live — proving the event routed to user:{inviteeId}, not just
      // that the row disappeared from the DB.
      await expect(inbox.getByText(`#${roomName}`)).toHaveCount(0, {
        timeout: 10_000,
      });
    } finally {
      await aliceCtx.close();
      await bobCtx.close();
    }
  });
});
