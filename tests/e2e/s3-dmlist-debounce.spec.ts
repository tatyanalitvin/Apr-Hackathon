// DmList refresh — coalesces bursts of trigger events into a debounced
// GET /api/v1/dms. Binding fix:
// c8fb3d5 "fix(dm): filter, debounce, and abort DmList socket refresh".
//
// Symptom the fix addresses: the old DmList listener re-fetched the whole
// DM list on every single refresh trigger, so a burst blew out the backend
// with N fetches for N events (a chatty DM or five self-initiated DMs in
// quick succession were both enough to trigger the storm). The fix:
//   1. filters message.new by membership in the cached DM-roomId set;
//   2. 300ms debounces the refresh so a fast burst collapses to one GET;
//   3. threads an AbortController so out-of-order resolves can't clobber
//      newer state.
//
// This spec exercises (2) end-to-end via the `dm:created` CustomEvent
// trigger, which is the refresh path DmList actually hears reliably. The
// `message.new` path requires the DmList socket to have `room.subscribe`'d
// to the DM roomId; today DmList opens its own socket via createChatSocket
// and never issues room.subscribe, so message.new events for DM rooms
// don't reach its listener regardless of how the sidebar fix filters them.
// The dm:created CustomEvent is window-scoped, always fires, and flows
// through the same `scheduleRefresh` debouncer the fix introduced, which
// is what we actually want to assert here.
//
// Scenario: mount /rooms with a fresh user, then dispatch 5 dm:created
// events in quick succession from page JS and assert the browser issues
// at most 2 GET /api/v1/dms (one initial mount, one coalesced refresh).
// Without debounce the same flow would issue 6+ fetches.

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

test.describe.configure({ mode: "serial" });

test.describe("DM sidebar — DmList debounces refresh bursts", () => {
  test.beforeAll(async () => {
    const res = await fetch(BACKEND_HEALTH).catch(() => null);
    test.skip(
      !res || !res.ok,
      `Backend not healthy at ${BACKEND_HEALTH}. Boot with: docker compose up --build -d`,
    );
  });

  test("5 rapid dm:created events trigger ≤ 2 GET /api/v1/dms on the sidebar", async ({
    page,
  }) => {
    const suffix = stamp();
    const user = {
      email: `dmdeb-${suffix}@herders.local`,
      username: `dmdeb${suffix}`,
      name: "Dm Debouncer",
      password: "Hackaton_Test_Pw_2026!",
    };

    await registerAndEnterRooms(page, user);
    // Ensure the sidebar's own mount fetch has settled before we start the
    // counter, so the initial GET doesn't pollute the debounce assertion.
    await page.waitForLoadState("networkidle");

    let listFetches = 0;
    page.on("request", (req) => {
      if (
        req.method() === "GET" &&
        /\/api\/v1\/dms(\?|$)/.test(req.url())
      ) {
        listFetches += 1;
      }
    });

    // Fire five dm:created CustomEvents synchronously. DmList's listener
    // handles each by calling scheduleRefresh(), which sets/extends a 300ms
    // debounce timer. With the fix, only the trailing edge fires → one
    // GET. Without the fix, five GETs fire immediately.
    await page.evaluate(() => {
      for (let i = 0; i < 5; i += 1) {
        window.dispatchEvent(new CustomEvent("dm:created"));
      }
    });

    // Let the 300ms debounce fire plus a comfortable margin.
    await page.waitForTimeout(1500);

    // Expectation: with the fix, the five triggers collapse to one (or at
    // most two, if one straggles past the trailing-edge timer) GET
    // /api/v1/dms. Without the fix this would be 5+.
    expect(listFetches).toBeLessThanOrEqual(2);
    // And the debounce must not swallow the refresh entirely — at least
    // one trailing-edge fetch must fire.
    expect(listFetches).toBeGreaterThanOrEqual(1);
  });
});
