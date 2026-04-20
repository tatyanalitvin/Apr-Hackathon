// Seed-regression — alice's role on the seeded #general room must be
// 'owner', not the schema default 'member'. Without this, the admin gates
// in apps/backend/src/routes/rooms.ts (REQ-201/203/204/209) and the
// MessageActions ⋯ menu (REQ-212) silently downgrade the demo owner to a
// plain member: the kick/ban/promote buttons never render, the admin-delete
// menu item is hidden, and the entire S2 moderation flow is broken on the
// seed room even though it works on a freshly-created room.
//
// This test asserts the owner affordances exist when seeded alice opens the
// seeded #general Members tab. Non-destructive — it only checks button
// visibility; no actual kick/ban is performed, so re-running is safe and
// doesn't corrupt the seed state for other tests in the suite.
//
// Binding: v3.docx §2.4.7 / §2.4.8 admin model; scripts/seed.ts REQ-212
// comment block documenting the stale-role hazard. Pairs with the backend
// unit test at apps/backend/tests/seed.test.ts that asserts role='owner'
// at the DB layer — this spec is the browser-level equivalent.

import { test, expect } from "@playwright/test";

const BACKEND_HEALTH = "http://localhost:4000/health";
const SEED_PASSWORD = "hunter2hunter2"; // from scripts/seed.ts

test.describe.configure({ mode: "serial" });

test.describe("Seed regression — alice is owner of seeded #general", () => {
  test.beforeAll(async () => {
    const res = await fetch(BACKEND_HEALTH).catch(() => null);
    test.skip(
      !res || !res.ok,
      `Backend not healthy at ${BACKEND_HEALTH}. Boot with: docker compose up --build -d (or pnpm --filter backend dev).`,
    );
  });

  test("seeded alice sees owner affordances in #general Members tab", async ({
    page,
  }) => {
    // Sign in as the seeded owner.
    await page.goto("/login");
    await page.getByLabel("Email").fill("alice@herders.local");
    await page.getByLabel("Password").fill(SEED_PASSWORD);
    await page.getByRole("button", { name: /^sign in$/i }).click();
    await expect(page).toHaveURL(/\/rooms(\/|$)/, { timeout: 15_000 });

    // Enter the seeded #general room.
    await page.getByText("#general").click();
    await expect(page).toHaveURL(/\/rooms\/general$/);
    await expect(
      page.getByText("Welcome to #general — this is the S1 demo room."),
    ).toBeVisible({ timeout: 10_000 });

    // Open Manage Room → Members. The Manage Room button itself is only
    // rendered for members with admin/owner role (RoomClient settingsRole);
    // if the seed regression returns, the button is hidden and the test
    // fails here with a clear selector miss.
    await page.getByRole("button", { name: /manage room/i }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("tab", { name: /^members$/i }).click();

    // Bob's row should render owner-only action buttons. Seeded display
    // names are "Alice", "Bob", "Carol" (USERS table in scripts/seed.ts).
    const bobRow = page
      .getByRole("row", { name: /bob/i })
      .first();
    await expect(bobRow).toBeVisible({ timeout: 10_000 });

    // Owner-only buttons: [Make admin], [Ban], [Remove from room].
    // Plain members see none; admins see [Ban]+[Remove] but not [Make admin].
    // We assert all three so this test catches BOTH "no role" (plain member)
    // and "downgraded to admin" regressions.
    await expect(
      bobRow.getByRole("button", { name: /^make admin$/i }),
    ).toBeVisible();
    await expect(
      bobRow.getByRole("button", { name: /^ban$/i }),
    ).toBeVisible();
    await expect(
      bobRow.getByRole("button", { name: /^remove from room$/i }),
    ).toBeVisible();
  });
});
