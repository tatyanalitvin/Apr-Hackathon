# Hackathon Playbook — running this day with Claude Code

> Read this once the night before. Skim it on the morning of the event. This is the operating manual.

## Before the event (night before, 30 min)

- [ ] Clone this repo into a fresh directory, not the starter itself: `gh repo create <your-name>/<event-name> --private --clone`
- [ ] Copy the starter contents in, commit as "chore: initial scaffold".
- [ ] `pnpm install` — confirm clean install.
- [ ] `cp .env.example .env.local`, paste `ANTHROPIC_API_KEY`.
- [ ] `pnpm dev` → open http://localhost:3000 — verify it boots.
- [ ] `pnpm test:run` → green.
- [ ] `pnpm test:e2e` → green.
- [ ] `pnpm build` → succeeds.
- [ ] Install Claude Code: `npm i -g @anthropic-ai/claude-code` (or use the VS Code extension).
- [ ] `claude` in the repo root — run `/catchup` — confirm Claude reads the setup.
- [ ] Charge laptop. Back up phone. Water bottle. Snacks.

## Day 0 — when the prompt drops

### Hour 0 (first 30 min) — don't code, think

Problem framing is the highest-leverage 30 minutes of the whole day.

1. **Read the prompt 3 times.** Write the literal problem statement at the top of a fresh `docs/specs/_brief.md`.
2. **Name the user.** One person, specific. "A Polish Playwright test engineer evaluating AI tools" beats "developers".
3. **Name the pain.** One sentence. "Spends 40min per PR manually reviewing test coverage".
4. **Write the 60-second pitch.** If you can't pitch it in 60s, the scope is wrong.
5. **Commit to a demo moment.** What's the single "wow" the judges see? Work backwards from there.
6. **Write a risk list.** Top 3 things that can kill the project. For each: mitigation + kill-switch (if this happens by hour N, cut scope).

### Hour 0.5 — kick off Claude

```
/catchup
```

Then:

```
/spec <feature-name> <your one-line pitch>
```

The `spec-writer` subagent will interview you. Answer fully — this is the most important conversation of the day. Don't rush it.

Approve the spec only when every requirement has an observable outcome.

### Hour 1-6 — build the demo spine

Strategy: **happy-path first, polish later**. Get a full end-to-end flow working even if ugly. Then iterate.

```
/tdd <feature-name>
```

During `/tdd`:
- Stay at the keyboard. Don't leave Claude unattended for more than ~5 min on core business logic.
- `shift+tab` once → plan mode. `shift+tab` twice → auto-accept (only for peripheral features).
- After every commit, glance at `git diff HEAD~1` to catch drift early.

### Hour 6-12 — second feature + polish

- Use `git worktree add ../<project>-feat2 feat/<feature2>` to work on two streams in parallel (one Claude per worktree).
- Delegate UI polish to the `ui-designer` subagent. Give it a screenshot to react to — not a blank canvas.
- Run `/review` after every feature branch merges.

### Hour 12-18 — sleep

Yes, really. 4-6 hours. A tired QA misses the bug that kills the demo.

### Hour 18-22 — hardening

- `/ship` → green must.
- Run the full demo end-to-end 3 times. Time it. Judges notice when you fumble.
- Record a 90-second screencast as backup in case the live demo fails.
- Prepare ONE slide: problem, solution, demo, stack, team. No more.

### Hour 22-24 — submit + present

- Push to GitHub. Tag `v1.0.0`.
- Deploy (Vercel one-shot). Check the deployed URL from a different browser.
- Close 100 tabs before screen-sharing. Stage terminal and browser windows in advance.

---

## Prompts I actually use

### To start a session

```
/catchup
```

### To scope a feature (before coding)

```
/spec auth "Users sign in with magic link and see a personalized dashboard."
```

### To implement an approved spec

```
/tdd auth
```

### To review before merging

```
/review
```

### To steer when Claude is off-track

- Interrupt with `ESC`. Don't wait.
- Rewind with `double-ESC` to go back a few turns.
- "That's wrong because X. Try approach Y." — specific > vague.
- If context is confused, `/clear` and `/catchup`.

### To delegate one-off tasks without polluting main context

```
Use a subagent to [research X / summarize Y / refactor Z] and return a concise result.
```

This spawns a clone with its own context window — your main chat stays focused.

---

## Task classification (when to watch, when to walk away)

| Task type | Mode | Why |
|---|---|---|
| Add a shadcn component to a page | auto-accept | Low risk, pattern-matchable |
| Wire a form to an API | synchronous | Data flow bugs are costly |
| Write a zod schema | auto-accept | Deterministic |
| Refactor a core utility in `src/lib/` | synchronous + TDD | Breakage cascades |
| Write Playwright tests | delegate to test-writer subagent | Isolated |
| Design a new page layout | delegate to ui-designer + review screenshots | Visual judgment needed |
| Debug a production bug | synchronous | Claude needs your runtime context |

---

## If things go wrong

**Claude produces garbage code** → `/clear`, re-run `/catchup`, rewrite the prompt with more specifics and references.

**Tests are mysteriously failing** → delete `node_modules` and `.next/`, reinstall. If still failing, `git bisect` — don't debug blind.

**You're running out of time** → cut scope, not quality. Drop features. Never ship broken.

**Claude keeps making the same mistake** → add a line to `CLAUDE.md` under "Things Claude has gotten wrong". Problem solved for this session and future ones.

**You're stuck on a hard bug for >30 min** → stop. Walk for 5 min. Come back and explain the bug to Claude from scratch in one paragraph. The act of explaining usually finds it.

---

## After the hackathon

- Write a retro in `docs/RETRO.md`: what worked, what didn't, what to add to `CLAUDE.md` next time.
- Promote the best patterns back into this starter repo.
