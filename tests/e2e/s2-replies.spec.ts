// REQ-110 + REQ-133 — message replies end-to-end (v3.docx §2.5.2 + §2.5.3).
//
// Binding: docs/specs/s2-e2e-coverage.md §4 R13/R14/R15. Feature spec
// docs/specs/s2-replies.md §4 R1–R15 covers the unit + component layers;
// this file is the browser round-trip.
//
// Constraint discovered during scaffolding: MessageList.tsx:166 gates
// MessageActions (Reply, Edit, Delete) behind `isOwn`, so the Reply
// button is only visible on the current user's own messages. That
// contradicts docs/specs/s2-replies.md §4 R13 ("Reply is visible on
// messages as long as onReply is supplied"). Noted in
// s2-e2e-coverage.md §7 as spec drift; e2e exercises the author-
// replies-to-own variant, which is enough to cover the REQ-110 replyTo
// payload, broadcast fanout, and REQ-133 composer chip wiring.
//
// Scenarios:
//   s1 (REQ-110 + REQ-133 round-trip) — Alice sends "hello", replies
//       to it via her own message's ⋯ reveal; Bob (observer) sees the
//       reply with a quoted block "Alice: hello".
//   s2 (REQ-110 parent-delete live-flip) — Alice sends parent, replies
//       to her own parent; Alice deletes the parent; Bob's view of the
//       quoted block flips to [deleted] within 3s (no reload).
//   s3 (REQ-133 composer chip clear) — Alice initiates a reply, clicks
//       the chip's "Cancel reply" button; the next send has no reply
//       chip and no quoted block attached. Single browser context.

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

async function joinFromBrowse(page: Page, roomName: string): Promise<void> {
  await page.goto("/rooms/browse");
  const row = page.getByRole("row", { name: new RegExp(roomName, "i") });
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.getByRole("button", { name: /^join$/i }).click();
  await expect(page).toHaveURL(/\/rooms\/[0-9a-f-]+$/, { timeout: 15_000 });
}

async function sendMessage(page: Page, body: string): Promise<void> {
  const textbox = page.getByRole("textbox", { name: /^message$/i });
  await textbox.fill(body);
  await page.keyboard.press("Enter");
  await expect(page.getByText(body).first()).toBeVisible({ timeout: 10_000 });
}

async function openActionsOn(page: Page, messageBody: string): Promise<void> {
  // MessageActions toggle is group-hover-opacity; focusing/hovering the
  // message row is enough for the toggle to become visible. locator .hover()
  // handles that reliably.
  const row = page.getByText(messageBody).first();
  await row.hover();
  await page
    .getByRole("button", { name: /^message actions$/i })
    .first()
    .click();
}

test.describe.configure({ mode: "serial" });

test.describe("REQ-110 REQ-133 — replies browser flows", () => {
  test.beforeAll(async () => {
    const res = await fetch(BACKEND_HEALTH).catch(() => null);
    test.skip(
      !res || !res.ok,
      `Backend not healthy at ${BACKEND_HEALTH}. Boot with: docker compose up --build -d (or pnpm --filter backend dev).`,
    );
  });

  test("REQ-110 REQ-133 — author replies to own message; observer sees quoted block", async ({
    browser,
  }) => {
    const suffix = stamp();
    const alice = {
      email: `rep1-a-${suffix}@herders.local`,
      username: `rep1A${suffix}`,
      name: "Rep1 Alice",
      password: "playwright-rep-1234",
    };
    const bob = {
      email: `rep1-b-${suffix}@herders.local`,
      username: `rep1B${suffix}`,
      name: "Rep1 Bob",
      password: "playwright-rep-1234",
    };
    const roomName = `rep-r13-${suffix}`;
    const parentBody = `parent-${suffix}`;
    const replyBody = `reply-${suffix}`;

    const aliceCtx: BrowserContext = await browser.newContext();
    const bobCtx: BrowserContext = await browser.newContext();
    try {
      const alicePage = await aliceCtx.newPage();
      const bobPage = await bobCtx.newPage();

      await registerAndEnterRooms(alicePage, alice);
      await registerAndEnterRooms(bobPage, bob);
      await createPublicRoom(alicePage, roomName);
      await joinFromBrowse(bobPage, roomName);

      // Alice sends parent.
      await sendMessage(alicePage, parentBody);

      // Alice replies to her own parent via the ⋯ reveal strip.
      await openActionsOn(alicePage, parentBody);
      await alicePage.getByTestId("message-reply").click();

      // Composer chip present with Alice's username.
      const chip = alicePage.getByTestId("reply-chip");
      await expect(chip).toBeVisible();
      await expect(chip).toContainText(new RegExp(alice.username, "i"));

      await sendMessage(alicePage, replyBody);

      // Bob's MessageList should show Alice's reply with the quoted block.
      const bobReplyRow = bobPage.getByText(replyBody).first();
      await expect(bobReplyRow).toBeVisible({ timeout: 15_000 });
      const bobQuoted = bobPage.getByTestId("reply-quoted-block").first();
      await expect(bobQuoted).toBeVisible();
      await expect(bobQuoted).toContainText(new RegExp(alice.username, "i"));
      await expect(bobQuoted).toContainText(parentBody);
    } finally {
      await aliceCtx.close();
      await bobCtx.close();
    }
  });

  test("REQ-110 — parent-delete live-flips the quoted block to [deleted] on the observer", async ({
    browser,
  }) => {
    const suffix = stamp();
    const alice = {
      email: `rep2-a-${suffix}@herders.local`,
      username: `rep2A${suffix}`,
      name: "Rep2 Alice",
      password: "playwright-rep-1234",
    };
    const bob = {
      email: `rep2-b-${suffix}@herders.local`,
      username: `rep2B${suffix}`,
      name: "Rep2 Bob",
      password: "playwright-rep-1234",
    };
    const roomName = `rep-r14-${suffix}`;
    const parentBody = `p14-${suffix}`;
    const replyBody = `r14-${suffix}`;

    const aliceCtx: BrowserContext = await browser.newContext();
    const bobCtx: BrowserContext = await browser.newContext();
    try {
      const alicePage = await aliceCtx.newPage();
      const bobPage = await bobCtx.newPage();

      await registerAndEnterRooms(alicePage, alice);
      await registerAndEnterRooms(bobPage, bob);
      await createPublicRoom(alicePage, roomName);
      await joinFromBrowse(bobPage, roomName);

      await sendMessage(alicePage, parentBody);

      await openActionsOn(alicePage, parentBody);
      await alicePage.getByTestId("message-reply").click();
      await sendMessage(alicePage, replyBody);

      // Bob sees the quoted block with the parent preview first.
      await expect(bobPage.getByText(replyBody).first()).toBeVisible({
        timeout: 15_000,
      });
      const bobQuoted = bobPage.getByTestId("reply-quoted-block").first();
      await expect(bobQuoted).toContainText(parentBody);

      // Alice deletes her parent via the two-step confirm.
      await openActionsOn(alicePage, parentBody);
      await alicePage.getByTestId("message-delete").click();
      await alicePage.getByTestId("message-delete-confirm").click();

      // Live-flip: Bob's quoted block text becomes "[deleted]" (the reducer
      // in RoomClient sets replyTo.deletedAt + clears text per
      // s2-replies.md §4 R11).
      await expect(bobQuoted).toContainText(/\[deleted\]/, { timeout: 10_000 });
      await expect(bobQuoted).not.toContainText(parentBody);
    } finally {
      await aliceCtx.close();
      await bobCtx.close();
    }
  });

  test("REQ-133 — composer chip × clears the reply target; next send has no quoted block", async ({
    browser,
  }) => {
    const suffix = stamp();
    const alice = {
      email: `rep3-a-${suffix}@herders.local`,
      username: `rep3A${suffix}`,
      name: "Rep3 Alice",
      password: "playwright-rep-1234",
    };
    const roomName = `rep-r15-${suffix}`;
    const parentBody = `p15-${suffix}`;
    const plainBody = `plain-${suffix}`;

    const ctx: BrowserContext = await browser.newContext();
    try {
      const page = await ctx.newPage();

      await registerAndEnterRooms(page, alice);
      await createPublicRoom(page, roomName);

      await sendMessage(page, parentBody);
      await openActionsOn(page, parentBody);
      await page.getByTestId("message-reply").click();

      const chip = page.getByTestId("reply-chip");
      await expect(chip).toBeVisible();

      // Clear via the chip's × button.
      await page.getByTestId("reply-chip-clear").click();
      await expect(chip).toHaveCount(0);

      // The next send should be a plain message — no quoted block attached
      // to its row.
      await sendMessage(page, plainBody);
      const plainRow = page.getByText(plainBody).first();
      await expect(plainRow).toBeVisible();
      // Scope the quoted-block absence to the plain message row's vicinity.
      // If the prior parent row renders its own block somewhere else, the
      // page-wide count would mislead — but the parent was a non-reply, so
      // the only quoted block on the page would be from the plain send.
      // Keep the assertion simple: zero quoted blocks total.
      await expect(page.getByTestId("reply-quoted-block")).toHaveCount(0);
    } finally {
      await ctx.close();
    }
  });
});
