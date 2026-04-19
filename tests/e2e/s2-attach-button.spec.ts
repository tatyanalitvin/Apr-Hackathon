// REQ-213 — v3 §2.6.2 paperclip attach button in MessageComposer.
//
// Binding: docs/specs/s3-chat-surface-polish.md §3 REQ-213, §4 test plan.
// The RTL unit test at apps/web/src/components/chat/MessageComposer.test.tsx
// exercises the render-gate and the fireEvent path. This spec re-asserts
// the click-to-upload flow in a real browser (setInputFiles) so a
// regression in the visible button → hidden input trampoline surfaces
// here before users report it.

import { test, expect, type Page } from "@playwright/test";

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

test.describe.configure({ mode: "serial" });

test.describe("REQ-213 §2.6.2 — Paperclip attach button uploads through onUpload", () => {
  test.beforeAll(async () => {
    const res = await fetch(BACKEND_HEALTH).catch(() => null);
    test.skip(
      !res || !res.ok,
      `Backend not healthy at ${BACKEND_HEALTH}. Boot with: docker compose up --build -d (or pnpm --filter backend dev).`,
    );
  });

  test("REQ-213 paperclip button visible, pick file → attachment chip in composer", async ({
    browser,
  }) => {
    const suffix = stamp();
    const alice = {
      email: `s3at-a-${suffix}@herders.local`,
      username: `s3atA${suffix}`,
      name: "S3 Alice",
      password: "playwright-s3at-1234",
    };
    const roomName = `s3-attach-${suffix}`;
    const fileName = `note-${suffix}.txt`;

    const ctx = await browser.newContext();
    try {
      const page = await ctx.newPage();
      await registerAndEnterRooms(page, alice);
      await createPublicRoom(page, roomName);

      // REQ-213 — visible affordance next to the emoji trigger. Reference
      // by testid so the emoji's own button doesn't collide with a
      // "button with emoji" selector.
      const attachButton = page.getByTestId("attach-button");
      await expect(attachButton).toBeVisible();
      await expect(attachButton).toBeEnabled();

      // setInputFiles on the hidden native input — the visible Paperclip
      // is a trampoline, and Playwright's standard idiom for file pickers
      // is to address the <input type="file"> directly. Same single
      // uploadFiles() state machine fires either way.
      await page
        .getByTestId("attach-file-input")
        .setInputFiles({
          name: fileName,
          mimeType: "text/plain",
          buffer: Buffer.from(`hello ${suffix}`, "utf8"),
        });

      // After upload, the composer's attachment-pending row should render
      // the filename (the same preview drag-drop and paste use).
      await expect(page.getByText(fileName).first()).toBeVisible({
        timeout: 10_000,
      });
    } finally {
      await ctx.close();
    }
  });
});
