// DmList socket refresh — coalesces bursts of message.new into a debounced
// GET /api/v1/dms and filters non-DM events. Binding fix:
// c8fb3d5 "fix(dm): filter, debounce, and abort DmList socket refresh".
//
// Symptom the fix addresses: the old listener re-fetched the whole DM list
// on every single message.new from every room, so an active DM burst
// blew out the backend with N fetches for N messages (and a chatty group
// room was even worse). The fix:
//   1. filters message.new by membership in the cached DM-roomId set;
//   2. 300ms debounces the refresh so a fast burst collapses to one GET;
//   3. threads an AbortController so out-of-order resolves can't clobber
//      newer state.
//
// This spec exercises (2) end-to-end: Alice rapid-fires 5 DMs to Bob, and
// we assert Bob's browser issues at most 2 GET /api/v1/dms (one initial
// mount fetch, one coalesced refresh) within the 2s observation window.
// Without debounce the same flow would issue 6+ fetches.

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

async function becomeFriends(
  requesterP: Page,
  accepterP: Page,
  requesterUsername: string,
  accepterUsername: string,
): Promise<void> {
  // Requester sends a friend request from /contacts — the "add by username"
  // form takes an exact username (same shape as s3-user-search.spec.ts).
  await requesterP.goto("/contacts");
  await requesterP.getByLabel(/username/i).fill(accepterUsername);
  await requesterP.getByRole("button", { name: /send request/i }).click();
  await expect(
    requesterP.getByText(/request.*sent|pending/i),
  ).toBeVisible({ timeout: 10_000 });

  // Accepter accepts the request — accept button carries
  // aria-label={`Accept request from ${from.username}`}.
  await accepterP.goto("/contacts");
  await accepterP
    .getByRole("button", {
      name: new RegExp(`accept request from ${requesterUsername}`, "i"),
    })
    .click();
  await expect(accepterP.getByText(accepterUsername)).toBeVisible({
    timeout: 10_000,
  });
}

async function openDmWith(aliceP: Page, bobName: string): Promise<string> {
  // "+ New DM" → searchbox → click the friend row → lands on /rooms/:id.
  await aliceP.getByRole("button", { name: /start a new dm/i }).click();
  await aliceP
    .getByRole("searchbox", { name: /search users/i })
    .fill(bobName);
  await aliceP.getByRole("button", { name: /start dm/i }).click();
  await expect(aliceP).toHaveURL(/\/rooms\/[a-f0-9-]+/i, { timeout: 10_000 });
  const url = aliceP.url();
  const match = url.match(/\/rooms\/([a-f0-9-]+)/i);
  if (!match) throw new Error(`failed to parse DM room id from URL ${url}`);
  return match[1];
}

test.describe.configure({ mode: "serial" });

test.describe("DM sidebar — DmList debounces message.new bursts", () => {
  test.beforeAll(async () => {
    const res = await fetch(BACKEND_HEALTH).catch(() => null);
    test.skip(
      !res || !res.ok,
      `Backend not healthy at ${BACKEND_HEALTH}. Boot with: docker compose up --build -d`,
    );
  });

  test("5 rapid DMs from Alice trigger ≤ 2 GET /api/v1/dms on Bob's sidebar", async ({
    browser,
  }) => {
    const suffix = stamp();
    const aliceCtx: BrowserContext = await browser.newContext();
    const bobCtx: BrowserContext = await browser.newContext();
    try {
      const aliceP = await aliceCtx.newPage();
      const bobP = await bobCtx.newPage();

      const alice = {
        email: `dmdeb-a-${suffix}@herders.local`,
        username: `dmdebA${suffix}`,
        name: "Alice",
        password: "Hackaton_Test_Pw_2026!",
      };
      const bob = {
        email: `dmdeb-b-${suffix}@herders.local`,
        username: `dmdebB${suffix}`,
        name: "Bob Bobson",
        password: "Hackaton_Test_Pw_2026!",
      };

      await registerAndEnterRooms(aliceP, alice);
      await registerAndEnterRooms(bobP, bob);
      await becomeFriends(aliceP, bobP, alice.username, bob.username);

      // Alice opens a DM with Bob; Bob moves to /rooms so his DmList is
      // mounted but he's NOT looking at the DM thread (the listener under
      // test is the sidebar's, not the thread's).
      await aliceP.goto("/rooms");
      await openDmWith(aliceP, bob.username.slice(0, 4));
      await bobP.goto("/rooms");
      // Wait for the sidebar's own initial mount fetch to settle so our
      // counter only captures refreshes triggered by the incoming burst.
      await bobP.waitForLoadState("networkidle");

      // Start counting AFTER the mount fetch has settled so the initial GET
      // doesn't pollute the debounce assertion.
      let listFetches = 0;
      bobP.on("request", (req) => {
        if (
          req.method() === "GET" &&
          /\/api\/v1\/dms(\?|$)/.test(req.url())
        ) {
          listFetches += 1;
        }
      });

      // Alice fires 5 messages back-to-back; the composer autosends on
      // Enter (see MessageComposer.tsx send-on-Enter branch).
      const composer = aliceP.getByRole("textbox", { name: /^message$/i });
      for (let i = 0; i < 5; i += 1) {
        await composer.fill(`burst-${suffix}-${i}`);
        await composer.press("Enter");
      }

      // Let the socket events + the 300ms debounce settle. One full beat
      // past the debounce leaves a comfortable margin without being flaky.
      await bobP.waitForTimeout(1500);

      // Expectation: with the fix, the five message.new events collapse to
      // one (or at most two, if one straggles past the trailing-edge timer)
      // GET /api/v1/dms. Without the fix this would be 5+.
      expect(listFetches).toBeLessThanOrEqual(2);
      // And the debounce must not swallow the refresh entirely — Bob's
      // sidebar must reflect at least one refresh after the burst.
      expect(listFetches).toBeGreaterThanOrEqual(1);
    } finally {
      await aliceCtx.close();
      await bobCtx.close();
    }
  });
});
