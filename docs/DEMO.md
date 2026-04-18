# DEMO — the reference demo script

> This is the TECHNICAL version — what will be on screen, which routes, which data. The HUMAN version (what you say, how you present) lives in `.human/DEMO-SCRIPT.md` and `.human/DEMO-DAY.md`.

Fill this in on hour 1, before writing code. Every beat should become a Playwright test in `tests/e2e/demo.spec.ts`.

## Demo URL

- Local: `http://localhost:3000`
- Deployed: <fill in when deployed>
- Backup video: <YouTube unlisted URL>

## Pre-demo setup

Steps to reset the app to a clean demo state:

```bash
# Wipe demo data
pnpm demo:reset

# Seed demo scenario
pnpm demo:seed

# Start server
pnpm dev
```

Create `scripts/demo-reset.ts` and `scripts/demo-seed.ts` by hour 18.

## Beats

### Beat 1 — The hook (10s)

**URL**: <!-- e.g. /demo/before -->
**What happens**: <!-- e.g. show a realistic Jira ticket screen with no test coverage info -->
**Success assertion (Playwright)**: `expect(page.getByTestId("pain-indicator")).toBeVisible()`

### Beat 2 — The turn (15s)

**URL**: <!-- e.g. / -->
**What happens**: <!-- user opens the app, sees clean landing -->
**Success assertion**: `expect(page.getByRole("heading", { name: /<your h1>/i })).toBeVisible()`

### Beat 3 — Core action (30s)

**URL**: <!-- e.g. /app -->
**What happens**: <!-- the wow moment. user pastes X, gets Y in 5 seconds. -->
**Success assertion**: `expect(page.getByTestId("result")).toContainText(/<expected content>/)`

### Beat 4 — Proof (20s)

**URL**: <!-- e.g. /app/inspect -->
**What happens**: <!-- show the real data underneath — not a mock -->
**Success assertion**: <!-- something verifiable -->

### Beat 5 — The close (15s)

**URL**: <!-- back to / or a summary view -->
**What happens**: <!-- recap -->

## Playwright demo test

Create `tests/e2e/demo.spec.ts`:

```ts
import { test, expect } from "@playwright/test";

test.describe("demo script", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  test("beat 1: pain is visible", async ({ page }) => { /* ... */ });
  test("beat 2: app opens cleanly", async ({ page }) => { /* ... */ });
  test("beat 3: core action produces result", async ({ page }) => { /* ... */ });
  test("beat 4: proof is real data", async ({ page }) => { /* ... */ });
});
```

Run `pnpm test:e2e --grep "demo script"` ten minutes before the demo. If any fail, you know EXACTLY which beat is broken.

## Fallback plan

- If deployed URL fails → demo from localhost
- If localhost fails → play backup video
- If Claude API rate-limits → show a pre-recorded API response (have one cached)

## Judge hand-off

After the demo, expect questions. Answers are pre-drafted in `.human/DEMO-DAY.md`.
