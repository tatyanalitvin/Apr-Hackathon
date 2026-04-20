# tests/e2e — Playwright browser specs

These are the REQ-traceable browser flows that re-run the submission-gate
smoke cheaply. The manual recipe lives in [`docs/SMOKE.md`](../../docs/SMOKE.md);
these specs automate the parts that have been worth rerunning more than
once.

## Run

```bash
# One-shot: assumes docker compose up --build -d is already healthy.
pnpm test:e2e

# Interactive debugger — traces, video, picker UI:
pnpm test:e2e -- --ui

# Target a single file (serial mode, workers=1 per playwright.config.ts):
pnpm test:e2e tests/e2e/s1-demo.spec.ts
```

Each spec has a `beforeAll` that probes `http://localhost:4000/health` and
`test.skip()`s the whole file if the backend isn't up. Bring the stack up
with `docker compose up --build -d` from the repo root before running.

## Known gotcha — `/24` sign-up rate-limit flood

Most specs call `registerAndEnterRooms(...)` which hits
`POST /api/auth/sign-up/email`. A full-suite run registers ~20 fresh
accounts from one local `/24` in under a minute, which trips the REQ-009
subnet-bucket rate-limiter (see `feat(backend): REQ-009 /24 subnet
rate-limit on /api/auth/sign-up/email`). After the flood, subsequent
sign-ups return `429` and any test whose first step is registration will
fail at the post-signup URL assertion — usually surfacing as:

```
expect(page).toHaveURL(/\/rooms(\/|$)/) — timed out, URL is /register
```

**Workaround:** flush the Redis-backed limiter between runs.

```bash
docker exec hackathon-starter-redis-1 redis-cli FLUSHDB
```

Specs that sign in as a seeded user (`alice@herders.local` /
`bob@herders.local` / `carol@herders.local` — password `hunter2hunter2`)
are unaffected, because sign-in uses the better-auth endpoint and a
different rate bucket.

Running a single spec in isolation usually stays under the threshold;
the flood is strictly a full-suite problem.

## Conventions

- One `test.describe` per feature; REQ-ID(s) in the describe name so
  `pnpm trace` can cross-reference tests back to requirements.
- `test.describe.configure({ mode: "serial" })` everywhere. Cross-user
  specs use two `browser.newContext()` calls (separate cookie jars) rather
  than a second browser project.
- Prefer `getByLabel` / `getByRole` with accessible name. Fall back to
  `getByTestId` only when roles/labels collide. Never CSS/XPath.
- Register-then-act helpers (`registerAndEnterRooms`, `createPublicRoom`,
  `joinFromBrowse`, `openManageRoomTab`) are duplicated per-spec on
  purpose — each file stays self-contained so it can be read and re-run
  without chasing shared helpers.
- Captured screenshots + videos drop into `test-results/`; inspect failures
  with `npx playwright show-report`.
