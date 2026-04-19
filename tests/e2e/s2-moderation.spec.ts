// REQ-201 + REQ-202 + REQ-203 + REQ-205 + REQ-206 + REQ-207 + REQ-208 + REQ-211
// — room moderation end-to-end (v3.docx §2.4.7 + §2.4.8).
//
// Binding: docs/specs/s2-e2e-coverage.md §4 R4–R8; feature spec
// docs/specs/s2-moderation.md §4 REQ-200..REQ-211 (backend + UI).
//
// Scenarios:
//   s1 (promote/demote) — Alice (owner) promotes Bob to admin, then
//       demotes him. Bob's role badge flips live via room.role.changed.
//       Also asserts the owner row in AdminsTab has no "Remove admin"
//       button (belt-and-braces for REQ-202 owner-demote block).
//   s2 (kick + REQ-208 force-leave, REQ-206/211 ban list) — Alice kicks
//       Bob via "Remove from room"; a subsequent message Alice sends
//       does NOT land in Bob's MessageList (observable browser-level
//       re-assertion of the REQ-208 socket-leave invariant backend
//       tests at apps/backend/tests/room-moderation-kick.test.ts nail
//       at the socket layer). Alice's Banned tab then lists Bob.
//   s3 (unban → rejoin) — Alice unbans Bob; Bob visits /rooms/browse
//       and rejoins the public room, lands inside it.
//   s4 (REQ-211 member empty-state) — Carol (plain member) opens Manage
//       Room → Banned tab; sees the "Only admins can view the ban list"
//       empty-state placeholder.
//
// window.confirm: Remove-from-room / Remove-admin / Unban all use
// window.confirm(). Playwright auto-dismisses dialogs unless a handler
// is attached — we attach page.on("dialog", d => d.accept()) before the
// action so the flow proceeds.

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
  // Public is the default radio per CreateRoomDialog.tsx; explicit click
  // keeps the test honest if the default ever flips.
  await dialog.getByLabel(/^Public$/).check();
  await dialog.getByRole("button", { name: /^create room$/i }).click();
  await expect(page).toHaveURL(/\/rooms\/[0-9a-f-]+$/, { timeout: 15_000 });
  await expect(page.getByText(`#${roomName}`).first()).toBeVisible();
}

async function joinFromBrowse(page: Page, roomName: string): Promise<void> {
  // feedback-playwright-rhf-spa-transition: goto destination rather than
  // clicking a Link to avoid rhf/SPA races on the destination form.
  await page.goto("/rooms/browse");
  const row = page.getByRole("row", { name: new RegExp(roomName, "i") });
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.getByRole("button", { name: /^join$/i }).click();
  await expect(page).toHaveURL(/\/rooms\/[0-9a-f-]+$/, { timeout: 15_000 });
}

async function openManageRoomTab(page: Page, tabName: RegExp): Promise<void> {
  await page.getByRole("button", { name: /manage room/i }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("tab", { name: tabName }).click();
}

async function closeModal(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
}

test.describe.configure({ mode: "serial" });

test.describe("REQ-201..REQ-211 — room moderation browser flows", () => {
  test.beforeAll(async () => {
    const res = await fetch(BACKEND_HEALTH).catch(() => null);
    test.skip(
      !res || !res.ok,
      `Backend not healthy at ${BACKEND_HEALTH}. Boot with: docker compose up --build -d (or pnpm --filter backend dev).`,
    );
  });

  test("REQ-201 REQ-202 REQ-207 — promote then demote; owner row has no Remove-admin button", async ({
    browser,
  }) => {
    const suffix = stamp();
    const alice = {
      email: `mod1-a-${suffix}@herders.local`,
      username: `mod1A${suffix}`,
      name: "Mod1 Alice",
      password: "playwright-mod-1234",
    };
    const bob = {
      email: `mod1-b-${suffix}@herders.local`,
      username: `mod1B${suffix}`,
      name: "Mod1 Bob",
      password: "playwright-mod-1234",
    };
    const roomName = `mod-promote-${suffix}`;

    const aliceCtx: BrowserContext = await browser.newContext();
    const bobCtx: BrowserContext = await browser.newContext();
    try {
      const alicePage = await aliceCtx.newPage();
      const bobPage = await bobCtx.newPage();

      await registerAndEnterRooms(alicePage, alice);
      await registerAndEnterRooms(bobPage, bob);
      await createPublicRoom(alicePage, roomName);
      await joinFromBrowse(bobPage, roomName);

      // Bob's own role from his vantage: MembersTab should show his role
      // as "member" initially. We drive all moderation actions from Alice.
      await openManageRoomTab(alicePage, /^members$/i);
      const bobRow = alicePage
        .getByRole("row", { name: new RegExp(bob.username, "i") });
      await expect(bobRow).toBeVisible({ timeout: 10_000 });
      await bobRow.getByRole("button", { name: /^make admin$/i }).click();

      // Bob's MembersTab role badge should flip to admin live via the
      // room.role.changed event (REQ-207). Close Alice's modal and look
      // from Bob's side.
      await closeModal(alicePage);
      await openManageRoomTab(bobPage, /^members$/i);
      const bobSelfRow = bobPage
        .getByRole("row", { name: new RegExp(bob.username, "i") });
      await expect(bobSelfRow.getByText(/^admin$/i)).toBeVisible({
        timeout: 10_000,
      });
      await closeModal(bobPage);

      // REQ-202 demote — via AdminsTab → "Remove admin". window.confirm.
      await openManageRoomTab(alicePage, /^admins$/i);
      const adminsBobRow = alicePage
        .getByRole("row", { name: new RegExp(bob.username, "i") });
      // Owner row (Alice) has no Remove-admin button.
      const ownerRow = alicePage
        .getByRole("row", { name: new RegExp(alice.username, "i") });
      await expect(
        ownerRow.getByRole("button", { name: /^remove admin$/i }),
      ).toHaveCount(0);

      alicePage.once("dialog", (d) => void d.accept());
      await adminsBobRow.getByRole("button", { name: /^remove admin$/i }).click();
      await closeModal(alicePage);

      // Verify from Bob's side — role flips back to "member".
      await openManageRoomTab(bobPage, /^members$/i);
      await expect(bobSelfRow.getByText(/^member$/i)).toBeVisible({
        timeout: 10_000,
      });
    } finally {
      await aliceCtx.close();
      await bobCtx.close();
    }
  });

  test("REQ-203 REQ-206 REQ-208 REQ-211 — kick force-leaves Bob's socket; Banned tab lists him", async ({
    browser,
  }) => {
    const suffix = stamp();
    const alice = {
      email: `mod2-a-${suffix}@herders.local`,
      username: `mod2A${suffix}`,
      name: "Mod2 Alice",
      password: "playwright-mod-1234",
    };
    const bob = {
      email: `mod2-b-${suffix}@herders.local`,
      username: `mod2B${suffix}`,
      name: "Mod2 Bob",
      password: "playwright-mod-1234",
    };
    const roomName = `mod-kick-${suffix}`;
    const postKickMarker = `post-kick-${suffix}`;

    const aliceCtx: BrowserContext = await browser.newContext();
    const bobCtx: BrowserContext = await browser.newContext();
    try {
      const alicePage = await aliceCtx.newPage();
      const bobPage = await bobCtx.newPage();

      await registerAndEnterRooms(alicePage, alice);
      await registerAndEnterRooms(bobPage, bob);
      await createPublicRoom(alicePage, roomName);
      await joinFromBrowse(bobPage, roomName);

      // Both Alice and Bob are inside the room. Alice kicks Bob.
      await openManageRoomTab(alicePage, /^members$/i);
      const bobRow = alicePage
        .getByRole("row", { name: new RegExp(bob.username, "i") });
      alicePage.once("dialog", (d) => void d.accept());
      await bobRow.getByRole("button", { name: /^remove from room$/i }).click();
      await expect(bobRow).toHaveCount(0, { timeout: 10_000 });
      await closeModal(alicePage);

      // REQ-208 — Alice sends a message; Bob (now kicked) must NOT receive
      // it on the socket channel, so the string should not appear in Bob's
      // MessageList. Allow 3s of socket latency budget.
      await alicePage
        .getByRole("textbox", { name: /message/i })
        .fill(postKickMarker);
      await alicePage.keyboard.press("Enter");
      // Wait for Alice's own message to render so the send completed server-side.
      await expect(alicePage.getByText(postKickMarker).first()).toBeVisible({
        timeout: 10_000,
      });

      // Bob stayed on the room page; his message list should NOT contain
      // the marker. Poll for 3s.
      await expect(bobPage.getByText(postKickMarker)).toHaveCount(0, {
        timeout: 3_000,
      });

      // REQ-206 / REQ-211 — Alice's Banned tab now lists Bob.
      await openManageRoomTab(alicePage, /^banned$/i);
      await expect(
        alicePage.getByRole("row", { name: new RegExp(bob.username, "i") }),
      ).toBeVisible({ timeout: 10_000 });
    } finally {
      await aliceCtx.close();
      await bobCtx.close();
    }
  });

  test("REQ-205 — unban then target rejoins the public room from the catalog", async ({
    browser,
  }) => {
    const suffix = stamp();
    const alice = {
      email: `mod3-a-${suffix}@herders.local`,
      username: `mod3A${suffix}`,
      name: "Mod3 Alice",
      password: "playwright-mod-1234",
    };
    const bob = {
      email: `mod3-b-${suffix}@herders.local`,
      username: `mod3B${suffix}`,
      name: "Mod3 Bob",
      password: "playwright-mod-1234",
    };
    const roomName = `mod-unban-${suffix}`;

    const aliceCtx: BrowserContext = await browser.newContext();
    const bobCtx: BrowserContext = await browser.newContext();
    try {
      const alicePage = await aliceCtx.newPage();
      const bobPage = await bobCtx.newPage();

      await registerAndEnterRooms(alicePage, alice);
      await registerAndEnterRooms(bobPage, bob);
      await createPublicRoom(alicePage, roomName);
      await joinFromBrowse(bobPage, roomName);

      // Kick Bob (creates a ban row).
      await openManageRoomTab(alicePage, /^members$/i);
      alicePage.once("dialog", (d) => void d.accept());
      await alicePage
        .getByRole("row", { name: new RegExp(bob.username, "i") })
        .getByRole("button", { name: /^remove from room$/i })
        .click();
      await closeModal(alicePage);

      // Unban via BannedTab.
      await openManageRoomTab(alicePage, /^banned$/i);
      alicePage.once("dialog", (d) => void d.accept());
      await alicePage
        .getByRole("row", { name: new RegExp(bob.username, "i") })
        .getByRole("button", { name: /^unban$/i })
        .click();
      await expect(
        alicePage.getByRole("row", { name: new RegExp(bob.username, "i") }),
      ).toHaveCount(0, { timeout: 10_000 });
      await closeModal(alicePage);

      // Bob rejoins from the catalog.
      await joinFromBrowse(bobPage, roomName);
      await expect(bobPage.getByText(`#${roomName}`).first()).toBeVisible();
    } finally {
      await aliceCtx.close();
      await bobCtx.close();
    }
  });

  test("REQ-211 — plain member sees the empty-state placeholder on the Banned tab", async ({
    browser,
  }) => {
    const suffix = stamp();
    const alice = {
      email: `mod4-a-${suffix}@herders.local`,
      username: `mod4A${suffix}`,
      name: "Mod4 Alice",
      password: "playwright-mod-1234",
    };
    const carol = {
      email: `mod4-c-${suffix}@herders.local`,
      username: `mod4C${suffix}`,
      name: "Mod4 Carol",
      password: "playwright-mod-1234",
    };
    const roomName = `mod-empty-${suffix}`;

    const aliceCtx: BrowserContext = await browser.newContext();
    const carolCtx: BrowserContext = await browser.newContext();
    try {
      const alicePage = await aliceCtx.newPage();
      const carolPage = await carolCtx.newPage();

      await registerAndEnterRooms(alicePage, alice);
      await registerAndEnterRooms(carolPage, carol);
      await createPublicRoom(alicePage, roomName);
      await joinFromBrowse(carolPage, roomName);

      await openManageRoomTab(carolPage, /^banned$/i);
      // Per s2-moderation.md §4 REQ-211 — "Only admins can view the ban list."
      await expect(
        carolPage.getByText(/only admins can view the ban list/i),
      ).toBeVisible({ timeout: 10_000 });
    } finally {
      await aliceCtx.close();
      await carolCtx.close();
    }
  });
});
