# Spec: <Feature name>

**Status**: draft | approved | in-progress | shipped
**Branch**: `feat/<feature-name>`
**Owner (human)**: <you>
**Owner (agent)**: Claude Code

## 1. Why

Who is the user? What job are they trying to do? Why is this the right next thing to build?

## 2. Non-goals

List 2-5 things this feature will NOT do. This is how scope gets protected.

- …

## 3. User stories

- As a …, I can …, so that …
- As a …, I can …, so that …

## 4. Requirements (testable)

Each requirement has an observable outcome — that's the test.

- [ ] **R1**: When the user does X, the system does Y.
- [ ] **R2**: …
- [ ] **R3**: …

## 5. Design notes

- Data model changes (if any): <describe or "none">
- New API endpoints: `POST /api/...`
- New UI routes: `/app/...`
- External services touched: …
- Security/auth: …

## 6. Tasks (3-8, each <2h)

1. [ ] Write failing test for R1 → implement → commit
2. [ ] Write failing test for R2 → implement → commit
3. [ ] UI wiring (ui-designer subagent)
4. [ ] Playwright e2e for happy path
5. [ ] code-reviewer pass, fix blockers
6. [ ] Update README / env.example if needed

## 7. Out of scope / follow-ups

Anything we decided to defer. Link to future issues.

## 8. Open questions

Things the spec-writer couldn't answer — must be resolved before approval.

- [ ] …
