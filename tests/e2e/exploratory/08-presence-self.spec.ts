// Observed during exploratory browsing: Alice is signed in and actively
// on /rooms — her header badge next to "@alice" reads "offline". If
// presence is supposed to reflect Socket.IO connection state (S2), the
// user's own status should never be "offline" while they're the one
// reading the page. This spec pins that expectation.
//
// If it fails, triage options:
//   - Presence feed isn't subscribing to your own user id on the client.
//   - Presence ticks are server-pushed and the initial snapshot comes
//     back stale from Redis (no self-heartbeat primed yet).
//   - The badge is purely cosmetic and defaults to "offline" until the
//     first heartbeat. In that case we want the badge hidden or
//     "connecting" during that gap, not "offline".

import { test, expect } from "@playwright/test";
import { signInSeeded, skipIfBackendDown } from "./helpers";

test.describe.configure({ mode: "default" });

test.describe("exploratory/presence — signed-in user's own status", () => {
  test.beforeAll(skipIfBackendDown);

  test("Alice never sees her own status as 'offline' while active", async ({ page }) => {
    await signInSeeded(page, "alice");
    // Give the socket a chance to connect.
    await page.waitForTimeout(2_500);

    // The header badge sits inside the user chip; we grab the status
    // text that lives near the @alice handle.
    const selfChip = page.locator('[aria-label*="alice" i], :has-text("@alice")').first();
    const statusText = await page.evaluate(() => {
      const chip = Array.from(document.querySelectorAll("*")).find((el) =>
        el.textContent?.includes("@alice") && el.textContent.length < 200,
      );
      if (!chip) return null;
      return chip.textContent?.trim();
    });

    expect(
      statusText?.toLowerCase().includes("offline"),
      `Alice's own chip shows '${statusText}' — expected 'online' or no status badge.`,
    ).toBe(false);
    await selfChip.waitFor().catch(() => undefined);
  });
});
