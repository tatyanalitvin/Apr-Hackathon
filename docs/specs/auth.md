# Spec: auth — registration, login, session, logout

**Status**: draft (awaiting your approval before `/tdd`)
**Branch**: `feat/auth`
**Owner (human)**: Tatianka
**Spec source**: brief §2.1.1–2.1.3, §2.1.4 (partial), §3.5

## 1. Why

Users cannot use any other feature without an account. Auth is the spine of every other requirement in the brief. A classic web chat needs email+password registration, unique immutable username, and login that persists across browser restart.

## 2. Non-goals

1. Email verification (brief §2.1.2 explicitly excludes it)
2. Password reset flow (SHOULD bucket, not MVP)
3. Password change for logged-in users (SHOULD bucket)
4. Session list UI or per-session logout (SHOULD bucket)
5. Account deletion cascade (WON'T)
6. OAuth / SSO / magic link

## 3. User stories

- As Anna, I can register with email + username + password, so I can start using the chat.
- As Anna, I can sign in with email + password, so I can come back later.
- As Anna, my login persists across browser restart, so I'm not forced to log in every morning.
- As Anna, I can sign out on this browser, so my account isn't exposed on a shared machine.

## 4. Requirements (testable)

- [ ] **R1**: POST `/api/auth/register` with `{ email, username, password }` creates a User with a hashed password and returns `{ id, email, username }` with a session cookie set.
- [ ] **R2**: Registering with an existing email returns 409 with `{ error: "email_taken" }`.
- [ ] **R3**: Registering with an existing username returns 409 with `{ error: "username_taken" }`.
- [ ] **R4**: Registering with invalid body (missing fields, bad email, password < 8 chars) returns 400 with zod issues.
- [ ] **R5**: POST `/api/auth/login` with correct credentials returns 200 + session cookie.
- [ ] **R6**: POST `/api/auth/login` with wrong credentials returns 401 (do not reveal whether email or password was wrong).
- [ ] **R7**: GET `/api/auth/me` returns the current user when a valid session cookie is present; returns 401 otherwise.
- [ ] **R8**: POST `/api/auth/logout` clears the cookie and invalidates the session row. Subsequent `/api/auth/me` returns 401.
- [ ] **R9**: Session cookie is `HttpOnly; Secure (prod); SameSite=Lax; Path=/`. Expires 30 days after last use.
- [ ] **R10**: Passwords are stored using Argon2id (`argon2` npm package, default params).

## 5. Design notes

**Data model** (already in `prisma/schema.prisma`):
- `User { id, email (unique), username (unique), passwordHash, createdAt, deletedAt }`
- `Session { id, userId, userAgent, ipAddress, createdAt, lastSeenAt, expiresAt }`

**Routes**:
- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`

**Library choices** (confirmed):
- `argon2` for password hashing
- Homemade session cookie (no library dependency) — random 256-bit token, stored in Sessions table, cookie value is the token

**Security**:
- Rate-limit login attempts by IP (5 per minute) — LATER, not MVP
- Do not reveal whether failed login was due to email or password (R6)
- Hash password **before** database query (prevents timing attacks leaking whether email exists) — LATER

## 6. Tasks (target < 2h total)

1. [ ] Vitest: register creates user + session (R1). Implement handler.
2. [ ] Vitest: register rejects dup email (R2) and username (R3). Implement.
3. [ ] Vitest: register validates body (R4). Wire zod.
4. [ ] Vitest: login happy path (R5) + wrong creds (R6).
5. [ ] Vitest: /me with and without cookie (R7) + logout (R8).
6. [ ] Cookie attributes correct (R9). Argon2 hashing (R10).
7. [ ] Playwright e2e: register → refresh browser → still logged in.
8. [ ] `/review` by code-reviewer subagent.

## 7. Out of scope / follow-ups

- Password reset flow → future spec `auth-reset`
- Session list UI → future spec `sessions`
- Account deletion → future spec `account-deletion`
- Rate limiting → add to `auth` spec v2 post-MVP

## 8. Open questions

- [ ] Do we want to keep users signed in forever, or expire sessions after 30 days? (Assumption: 30 days rolling, refreshed on each request)
- [ ] Username character restrictions? (Assumption: `^[a-z0-9_]{3,24}$`, lowercase only, ASCII)
- [ ] Password min length? (Assumption: 8)
