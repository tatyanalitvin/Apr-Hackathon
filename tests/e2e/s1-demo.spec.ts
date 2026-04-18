// S1 gate proof — two-browser demo flow.
//
// Covers: REQ-042 register page, REQ-043 login page, REQ-044 rooms list,
// REQ-045 room view, REQ-029 send message, REQ-034 realtime broadcast.
//
// Runs two independent BrowserContexts inside one chromium instance (Alice
// fresh signup; Bob signs in with the seeded password). Captures full-page
// screenshots at three beats so the artefact is also a submission-video aid.
//
// Selector notes (feedback for frontend if flakes show up):
// - Forms use Label+htmlFor so getByLabel works. Good.
// - MessageComposer textarea has aria-label="Message" — stable.
// - Messages render as plain divs with the author + body; we locate by text.
//   If message bodies start colliding across tests, add data-testid="message-row"
//   on the row in MessageList.tsx and data-testid="message-body" on the body div.
// - Rooms list renders shadcn Cards with a "#general" label; we click by text.

import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

const BACKEND_HEALTH = "http://localhost:4000/health";
const SHOT_DIR = path.join("tests", "e2e", "screenshots", "s1-demo");
const SEED_PASSWORD = "hunter2hunter2"; // from scripts/seed.ts

const ALICE = {
  email: `alice-e2e-${Date.now()}@herders.local`,
  username: `aliceE2E${Date.now().toString().slice(-6)}`,
  password: "playwright-hunter2",
  name: "Alice E2E",
};

const BOB = {
  email: "bob@herders.local",
  password: SEED_PASSWORD,
};

test.describe.configure({ mode: "serial" });

test.describe("REQ-042 REQ-043 REQ-044 REQ-045 REQ-029 REQ-034 — S1 two-browser demo", () => {
  test.beforeAll(async () => {
    mkdirSync(SHOT_DIR, { recursive: true });
    const res = await fetch(BACKEND_HEALTH).catch(() => null);
    test.skip(
      !res || !res.ok,
      `Backend not healthy at ${BACKEND_HEALTH}. Boot with: docker compose up --build -d`,
    );
  });

  test("Alice registers, Bob signs in, they exchange live messages", async ({ browser }) => {
    const started = Date.now();

    // Two isolated contexts = two cookie jars = two independent users in one chromium.
    // recordVideo is opt-in per-context when we skip the default `page` fixture.
    const videoDir = path.join("test-results", "s1-demo-videos");
    mkdirSync(videoDir, { recursive: true });
    const aliceCtx: BrowserContext = await browser.newContext({
      recordVideo: { dir: videoDir, size: { width: 1280, height: 720 } },
    });
    const bobCtx: BrowserContext = await browser.newContext({
      recordVideo: { dir: videoDir, size: { width: 1280, height: 720 } },
    });
    const alice: Page = await aliceCtx.newPage();
    const bob: Page = await bobCtx.newPage();

    try {
      // — REQ-042: Alice registers a brand-new account.
      await alice.goto("/register");
      await alice.getByLabel("Email").fill(ALICE.email);
      await alice.getByLabel("Username").fill(ALICE.username);
      await alice.getByLabel("Display name").fill(ALICE.name);
      await alice.getByLabel("Password").fill(ALICE.password);
      await alice.getByRole("button", { name: /create account/i }).click();

      // REQ-044: post-signup lands on /rooms.
      await expect(alice).toHaveURL(/\/rooms$/, { timeout: 15_000 });
      await expect(alice.getByRole("heading", { name: /your rooms/i })).toBeVisible();

      // REQ-045: click the general room, auto-enrolled by the user.create hook.
      await alice.getByText("#general").click();
      await expect(alice).toHaveURL(/\/rooms\/general$/);

      // Seed wrote three messages — at least one should be on screen.
      await expect(
        alice.getByText("Welcome to #general — this is the S1 demo room."),
      ).toBeVisible({ timeout: 10_000 });

      await alice.screenshot({
        path: path.join(SHOT_DIR, "01-alice-in-general.png"),
        fullPage: true,
      });

      // — REQ-043: Bob signs in with seeded credentials.
      await bob.goto("/login");
      await bob.getByLabel("Email").fill(BOB.email);
      await bob.getByLabel("Password").fill(BOB.password);
      await bob.getByRole("button", { name: /^sign in$/i }).click();

      await expect(bob).toHaveURL(/\/rooms$/, { timeout: 15_000 });
      await bob.getByText("#general").click();
      await expect(bob).toHaveURL(/\/rooms\/general$/);
      await expect(
        bob.getByText("Welcome to #general — this is the S1 demo room."),
      ).toBeVisible({ timeout: 10_000 });

      // — REQ-029: Alice sends a message via Enter key.
      const aliceMsg = "hello from alice";
      const aliceComposer = alice.getByRole("textbox", { name: "Message" });
      await aliceComposer.click();
      await aliceComposer.fill(aliceMsg);
      await aliceComposer.press("Enter");

      // REQ-034: Bob sees the message within 3 seconds via Socket.IO broadcast.
      await expect(bob.getByText(aliceMsg).last()).toBeVisible({ timeout: 3_000 });

      await bob.screenshot({
        path: path.join(SHOT_DIR, "02-bob-received-alice.png"),
        fullPage: true,
      });

      // — Bob replies, Alice sees it within 3 seconds.
      const bobMsg = "hi alice";
      const bobComposer = bob.getByRole("textbox", { name: "Message" });
      await bobComposer.click();
      await bobComposer.fill(bobMsg);
      await bobComposer.press("Enter");

      await expect(alice.getByText(bobMsg).last()).toBeVisible({ timeout: 3_000 });

      await alice.screenshot({
        path: path.join(SHOT_DIR, "03-alice-received-bob.png"),
        fullPage: true,
      });

      const elapsedMs = Date.now() - started;
      // eslint-disable-next-line no-console
      console.log(`[s1-demo] full flow wall-clock: ${elapsedMs}ms`);
    } finally {
      await aliceCtx.close();
      await bobCtx.close();
    }
  });
});
