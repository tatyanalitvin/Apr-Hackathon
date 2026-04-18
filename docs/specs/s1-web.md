# Spec: S1 — Web (register, login, rooms, room view)

**Status**: draft (2026-04-18)
**Branch**: `feat/s1-web` (worktree at `../hackaton-s1-web`)
**Owner (human)**: Tatianka
**Owner (agent)**: Claude Code — frontend agent (brief provided by Tatianka at session start)
**Scope**: REQ-042 … REQ-048 (four S1 pages + Socket.IO client + client-side watermark gap-detection). Auth backend (REQ-001…REQ-019) is owned by `feat/s1-auth` and already merged to `main`; chat backend (REQ-029…REQ-041, REQ-049) is owned by `feat/s1-chat` and merges asynchronously — we stub behind `NEXT_PUBLIC_USE_FAKE_BACKEND` so the two streams don't block each other.

**REQ-ID note**: `BRIEF.md` and `task/Chat_Server_Requirements_v4.md` slice REQ-042…REQ-048 differently. The brief is the organizer-side contract (v3 docx is authoritative per `memory: feedback-task-mds-are-prep`); the v4 prep file adds granular UX details (`?next=` deep-link, localStorage draft, 100px autoscroll threshold + pill, 500px infinite-scroll trigger, live byte counter, mobile icon nav). This spec follows BRIEF's REQ slicing **and** pulls in every v4 UX clause that is (a) cheap enough to ship inside the timebox and (b) a genuine UX win. Deferrals are enumerated in §7 and §10 so a reviewer running down v4 can see they're intentional.

## 1. Why

The S1 walking-skeleton gate (BRIEF.md) is "two browsers side-by-side, Alice sends 'hello', Bob sees it in <1s, history survives restart, scroll works". Everything the judges see is UI: there is no value in the backend correctness work unless a human can register, log in, find a room, type a message, and watch the other tab update. This spec is the eyes and hands on that loop.

Correctness on two things is load-bearing: the watermark gap-detection contract (ADR-0003) must be implemented client-side — the server broadcasts `{seq, roomHeadSeq}`, the client gap-detects and calls the history endpoint to backfill. Get that wrong and we ship a chat app that silently loses messages on reconnect, which is the exact problem the whole watermark protocol exists to prevent. And the autoscroll-pin behavior (REQ-047) has to not yank a reading user to the bottom when a new message arrives — standard chat-app hygiene.

## 2. Non-goals

Explicitly NOT in this slice — called out so a reviewer running down `/task/*.md` doesn't flag them:

- **DMs** (REQ-061…REQ-066) — S2.
- **Attachments / drag-drop file upload** (REQ-075…REQ-085) — S2.
- **Friend requests / contacts UI** (REQ-050…REQ-060) — S2.
- **Typing indicator** — S2 soft scope (event exists in `protocol.ts`, no S1 handler).
- **AFK / multi-tab presence coordination** (REQ-099…REQ-105) — S2.
- **Read receipts / unread counts** (REQ-120…REQ-124) — S2.
- **Room creation UI** — S1 has only `general` via seed; no create-room endpoint exists.
- **`/account/sessions` page** — s1-auth spec task #8 defers the e2e to this stream; we defer the UI to S2/S3 and expose sign-out from the app header instead.
- **Edit / delete message UI** (REQ-110…REQ-114) — S2.
- **Admin dashboard `/admin`** — S3.
- **Any visual polish beyond "looks like a chat app at 1024px and doesn't crash below"** — brief constraint.
- **Backend code of any kind.** `packages/shared/` is frozen. If a contract feels insufficient, we STOP and ask.

## 3. User stories

- As Anna (not yet registered), I can visit `/register`, fill email + username + display name + password, submit, and land on `/rooms` with a valid session cookie. (REQ-042)
- As Anna (already registered), I can visit `/login`, fill email + password, tick "remember me", submit, and land on `/rooms`. (REQ-043)
- As Anna (logged in), visiting `/` redirects me to `/rooms`; visiting `/rooms` as an anonymous user redirects me to `/login`. (transverse)
- As Anna, from `/rooms` I see the list of rooms I'm a member of (in S1 just `general`) and clicking one opens `/rooms/general`. (REQ-044)
- As Anna inside `/rooms/general` on a 1440px desktop, I see three columns: rooms on the left, messages center, members on the right. On a 900px tablet the columns collapse to stacked accordions. (REQ-045)
- As Anna typing in the composer, pressing Enter sends, Shift+Enter inserts a newline, Tab does not submit (it moves focus to the Send button). (REQ-046)
- As Anna already scrolled to the bottom of `general`, when Bob sends a message I see it appear and stay pinned at the bottom. As Anna who has scrolled up to read older history, when Bob sends a message the list updates but my viewport does NOT jump — I keep reading where I was. (REQ-047)
- As Anna who has scrolled past the top of what's loaded, the older page of history loads and prepends without shifting the messages currently visible under my cursor. (REQ-048)
- As Bob, whose tab was backgrounded for 10 seconds during which Alice sent 3 messages, when I return and receive the next live `message.new` my client detects the gap (`evt.seq > lastSeenSeq + 1`), fetches the missed range via history REST, renders the backfill in order, then renders the live message — no duplicates, no loss. (ADR-0003)
- As Anna on either of those pages, I can see my username in the header and click "Sign out" to clear my session and land back on `/login`. (transverse)

## 4. Requirements (testable)

Every requirement below carries the REQ-ID(s) the `pnpm trace` script will grep for. Test `describe` / `test` names MUST embed these IDs verbatim. UI is test-after per CLAUDE.md non-negotiable #2; only `watermark.ts` and the composer key-behavior are unit-tested. Everything else is verified manually in two browsers (checklist in §9). The `pnpm trace` script accepts either a test name or a grep-visible page-source reference for visual REQs.

- [ ] **R1 (REQ-042)**: `/register` renders an email + username + display-name + password form. Client-side zod validation via `registerSchema` from `@ai-herders/shared/dto` (same schema the Fastify preHandler enforces — one source of truth, no drift). On submit, calls `authClient.signUp.email({ email, password, name, username })` against `${BACKEND_URL}/api/auth/sign-up/email` (imported from `@/lib/backend`) with credentials. Success → `router.replace(searchParams.get("next") ?? "/rooms")`. Duplicate email / duplicate username / weak password → surface the better-auth error message inline under the offending field via `<FormMessage />` and a `sonner` toast.
- [ ] **R2 (REQ-043)**: `/login` renders email + password + "Keep me signed in" checkbox (label matches v4 REQ-044 wording). Zod validation via `loginSchema`. On submit, `authClient.signIn.email({ email, password, rememberMe })`. Success → `router.replace(searchParams.get("next") ?? "/rooms")`. Wrong-creds → generic error surfaced as a toast + inline message; per s1-auth R9 the server returns an identical shape for wrong-email vs wrong-password, so the UI MUST NOT attempt to differentiate. Rate-limit (429 after 5 attempts/60s per s1-auth task #10) surfaces as "Too many attempts, wait a minute" — explicit string, not raw server error.
- [ ] **R2b (REQ-042 v4 deep-link clause)**: `<RequireSession>` redirects anonymous visitors to `/login?next=${encodeURIComponent(currentPath)}`. `/login` and `/register` both read `searchParams.get("next")` and validate via `isSafeNext(next)` — must start with `/` AND must NOT start with `//` (protocol-relative `//evil.com` is a browser-followable open-redirect bypass) AND must NOT start with `/\` (Windows-style variant). Implementation: `next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\")`. On success `router.replace(next)`; missing/invalid → `/rooms`. Tested inline at the validator level — a 3-case unit on `isSafeNext` is cheap and worth the paranoia.
- [ ] **R3 (REQ-044)**: `/rooms` renders a list of rooms the signed-in user is a member of. S1 has no `GET /api/v1/rooms/me` endpoint in scope (chat spec doesn't define one), so S1 hard-codes the list to `[{ id: "general", name: "general" }]` — every seeded user is a member of `general`. A `TODO(S2)` comment in the page marks where the real endpoint call goes. Clicking the row navigates to `/rooms/general`. An anonymous visitor to `/rooms` is redirected to `/login` via a `useSession()` check; loading state renders a skeleton, not a flash of empty content.
- [ ] **R4 (REQ-045)**: `/rooms/[roomId]` renders a three-column CSS grid `grid-cols-[16rem_1fr_16rem]` at `lg:` (≥1024px) and collapses to a single-column stacked `<details>` accordion (rooms / messages / members) below. No JS resize observer — a pure Tailwind breakpoint. Middle column holds `MessageList` + `MessageComposer`; left column `RoomList`; right column `MemberList`. On mount, the page reads the room membership (S1: static `general`), opens the socket, subscribes to the room, primes `lastSeenSeq` from the subscribe-ack's `roomHeadSeq`, and fetches initial history page (newest 50).
- [ ] **R5 (REQ-046)**: The composer is a `react-textarea-autosize` textarea growing 1-to-6 lines. Unit test (`vitest` + `@testing-library/react` + `user-event` + `jsdom`) fences:
  - Enter without shift → fires `onSend` with the NFC-normalized trimmed body and clears the textarea (body stays NFC because the server also normalizes, but we pre-normalize so server-side rejection is never surprised).
  - Shift+Enter → inserts `\n` into the textarea; `onSend` is NOT called.
  - Tab → `preventDefault` is NOT called; focus advances to the Send button (native behavior — we assert via `document.activeElement` after `tab()`).
  - Empty / whitespace-only body → Send button is `disabled`; pressing Enter is a no-op.
  - Body >3072 bytes (UTF-8, measured via `new TextEncoder().encode(body).byteLength`) → Send button is `disabled` with a "too long" hint (same limit as `messageBodySchema`).
  - Live byte counter (v4 REQ-046 clause): a small "`NN / 3072`" label below the textarea becomes visible once byte-length exceeds 2800 (soft warning zone); turns red at 3072. Tested by typing a ≥2800-byte string and asserting the counter element renders; typing a 3073-byte string and asserting Send is disabled + counter is red.
- [ ] **R5b (REQ-046 v4 draft-persistence clause)**: Composer body is persisted to `localStorage` under `s1-draft:${userId}:${roomId}` on every keystroke (debounced 250ms). On mount, hydrate from storage. On successful send, clear the key. On sign-out, the hook leaves drafts for other users (scoped by userId — signing in as someone else doesn't see your drafts). SSR guard: access `window.localStorage` only inside `useEffect`. Verified in manual two-browser walkthrough (§9).
- [ ] **R6 (REQ-047)**: `MessageList` uses `react-virtuoso`'s `Virtuoso` component with `followOutput={(isAtBottom) => (isAtBottom ? "smooth" : false)}` + `atBottomStateChange={setIsAtBottom}` + `atBottomThreshold={100}` (v4 REQ-047 clause: "within 100 px"). When `isAtBottom === false` and new live messages arrive, the list increments a local `unreadCount` and renders a floating "↓ N new messages" pill above the composer (fixed-position, `absolute`-positioned inside the middle-column flex parent). Clicking the pill calls `virtuoso.scrollToIndex({ index: "LAST", behavior: "smooth", align: "end" })`, sets `unreadCount = 0`, and hides. `unreadCount` also resets to 0 whenever `atBottomStateChange(true)` fires (user scrolls to bottom on their own). Manual verification (§9 checklist) — user-at-bottom auto-pins; user-scrolled-up sees the pill and the list updates without yank.
- [ ] **R7 (REQ-048)**: `MessageList` wires `Virtuoso`'s `startReached` callback to fetch the older page via `chatApi.fetchHistory(roomId, { toSeq: oldestLoadedSeq - 1n, limit: 50 })`, prepends the returned `messages` to local state, and updates `firstItemIndex` so Virtuoso preserves the anchor automatically. `startReached` triggers when the top sentinel is within Virtuoso's default overscan window (≈500px — matches v4 REQ-048 "within 500 px of the top"). A loading sentinel (single-line skeleton) renders above the list during the fetch. If the returned page is empty, further `startReached` fires are ignored (set a `hasMore` flag).
- [ ] **R8 (ADR-0003 watermark)**: `useRoomWatermark(roomId)` hook is the gap-detection brain. Unit-tested in `watermark.test.ts` with a mocked `fetchHistory` function and no React. State: `lastSeenSeq: bigint` (init to `0n` before subscribe-ack; hydrated from `ack.roomHeadSeq` after; advanced after every emission). Contract:
  - On `message.new(evt)`:
    - If `BigInt(evt.seq) === lastSeenSeq + 1n` → emit `evt.message` to the UI, set `lastSeenSeq = BigInt(evt.seq)`.
    - If `BigInt(evt.seq) > lastSeenSeq + 1n` → call `fetchHistory(roomId, fromSeq: lastSeenSeq + 1n, toSeq: BigInt(evt.seq) - 1n)`, emit returned `messages` in ascending `seq` order, then emit `evt.message`, then set `lastSeenSeq = BigInt(evt.seq)`. While the fetch is in flight, further inbound `message.new` events are queued by seq; on resolve they are processed in order and each one re-checks its own contiguity (a queued event may itself be contiguous with the end of the backfill).
    - If `BigInt(evt.seq) <= lastSeenSeq` → drop silently (duplicate or late-arriving).
  - All comparisons use `BigInt(a) < BigInt(b)` — NEVER `Number(seq)`. `evt.seq`, `evt.roomHeadSeq`, `evt.message.seq`, `ack.roomHeadSeq` are strings on the wire per ADR-0003 bigint-as-string.
  - Unit tests cover: in-order, single-gap, multi-gap, concurrent-new-during-backfill, duplicate drop, late-arriving drop, initial hydration from ack.
- [ ] **R9 (transverse)**: `apps/web/src/lib/socket.ts` exports a typed `Socket<ServerToClientEvents, ClientToServerEvents>` factory (types imported from `@ai-herders/shared/protocol`). The factory takes no args — `BACKEND_URL` resolved internally — and returns either (a) a real `socket.io-client` socket configured with `withCredentials: true` so the better-auth cookie rides the handshake, or (b) a fake-backend shim that implements the same surface via `BroadcastChannel` (see §5). Selection is by `NEXT_PUBLIC_USE_FAKE_BACKEND === "true"` at module load; no per-call branching. Real mode: `io(BACKEND_URL, { withCredentials: true, transports: ["websocket"] })`.
- [ ] **R10 (transverse)**: `apps/web/src/lib/auth-client.ts` exports `{ signUp, signIn, signOut, useSession }` from `createAuthClient({ baseURL: BACKEND_URL })` from `better-auth/react`. `useSession()` drives:
  - `/` page — redirects to `/rooms` if session.data, else `/login`.
  - `/rooms` and `/rooms/:id` — redirect to `/login` if session is null post-pending.
  - Header — shows `{session.data.user.username}` + Sign out button. Sign out calls `authClient.signOut()` then `router.replace("/login")`.
- [ ] **R11 (transverse)**: `NEXT_PUBLIC_USE_FAKE_BACKEND`:
  - `"true"` → chat endpoints (`POST/GET /api/v1/rooms/:id/messages`) and the Socket.IO surface are handled by `FakeChatAPI`. Auth is ALWAYS real (never faked).
  - `"false"` or unset → all chat calls go to `BACKEND_URL` just like auth.
  - The flag is read once at module load per file that needs it. `.env.local.example` lists both variables with defaults.
- [ ] **R12 (transverse)**: No runtime use of `Number(seq)`. Enforced by a minimal ESLint rule: `no-restricted-syntax` targeting `CallExpression[callee.name='Number']` inside `apps/web/src/lib/watermark.ts` + `apps/web/src/lib/chat-api.ts` + `apps/web/src/components/chat/*.tsx` — suppressed elsewhere. (If configuring ESLint for this is more than 20 lines of effort, we substitute a `grep`-based CI guard run by the existing `pnpm trace`.)
- [ ] **R13 (transverse)**: Sign-out button visible in the header on `/rooms` and `/rooms/:id`. Clicking triggers `authClient.signOut()` → `router.replace("/login")`. No confirmation dialog (S1 minimal UI).
- [ ] **R14 (transverse)**: Three shadcn primitives beyond the form set — `scroll-area`, `separator`, `skeleton` — are used at the right spots (RoomList scroll, column separators on desktop, loading placeholders on pages before `useSession` resolves).

## 5. Design notes

### Routes (Next.js App Router)

| Path | File | Type | Auth |
| --- | --- | --- | --- |
| `/` | `app/page.tsx` | client (redirect) | reads session |
| `/register` | `app/register/page.tsx` | client | anon; signed-in users are redirected to `/rooms` on mount |
| `/login` | `app/login/page.tsx` | client | anon; signed-in users are redirected to `/rooms` on mount |
| `/rooms` | `app/rooms/page.tsx` | client | required |
| `/rooms/:roomId` | `app/rooms/[roomId]/page.tsx` | server wrapper | — |
| `/rooms/:roomId` (content) | `app/rooms/[roomId]/RoomClient.tsx` | client | required |

Every auth-gated client page has the same pre-render guard: `const { data, isPending } = useSession(); if (isPending) return <Skeleton/>; if (!data) { router.replace("/login"); return null; }`. Extracted to a `<RequireSession>` wrapper so the three call sites share one path.

### File inventory (maps to brief §2)

Created:

```text
apps/web/src/app/register/page.tsx            REQ-042
apps/web/src/app/login/page.tsx               REQ-043
apps/web/src/app/rooms/page.tsx               REQ-044
apps/web/src/app/rooms/[roomId]/page.tsx      REQ-045 (server wrapper)
apps/web/src/app/rooms/[roomId]/RoomClient.tsx REQ-045 (client container)
apps/web/src/components/chat/RoomList.tsx      (left column)
apps/web/src/components/chat/MessageList.tsx   REQ-047, REQ-048
apps/web/src/components/chat/MessageComposer.tsx REQ-046
apps/web/src/components/chat/MemberList.tsx    (right column; presence dots)
apps/web/src/components/chat/Header.tsx        (app header — username + sign-out)
apps/web/src/components/chat/RequireSession.tsx (auth gate wrapper)
apps/web/src/lib/auth-client.ts                R10
apps/web/src/lib/socket.ts                     R9
apps/web/src/lib/chat-api.ts                   ChatAPI interface + RealChatAPI + FakeChatAPI
apps/web/src/lib/watermark.ts                  R8 (ADR-0003)
apps/web/src/lib/watermark.test.ts             R8 unit tests
apps/web/src/lib/fake-backend.ts               FakeChatAPI internals (BroadcastChannel + seed)
apps/web/src/components/chat/MessageComposer.test.tsx  R5 unit tests
apps/web/src/components/ui/{button,input,label,card,form,scroll-area,separator,skeleton,avatar,sonner,textarea}.tsx  — shadcn, install as used
```

Modified:

```text
apps/web/src/app/page.tsx      — redirect to /rooms if signed-in, /login otherwise
apps/web/src/app/layout.tsx    — minimal chrome: html lang + font vars + <Toaster/> from sonner + <RequireSession> children for app pages (but NOT /register, /login)
apps/web/package.json          — add react-hook-form, @hookform/resolvers, react-textarea-autosize, react-virtuoso, sonner, zod (already present via shared)
apps/web/.env.local.example    — NEXT_PUBLIC_BACKEND_URL=http://localhost:4000, NEXT_PUBLIC_USE_FAKE_BACKEND=true
```

Untouched (out of scope):

```text
apps/backend/**                 — chat agent's territory
packages/shared/**              — FROZEN (CLAUDE.md non-negotiable + brief hard constraint #1)
infra/migrations/**             — schema is backend-owned
```

### Data flow

Happy path for a Bob-sees-Alice's-message round trip:

```text
[Alice browser]
  composer.onSend(body)
    ↓
  chatApi.sendMessage(roomId, { body })
    ↓ (real mode) POST /api/v1/rooms/:id/messages → 201 MessagePayload
    ↓ (fake mode) BroadcastChannel "s1-fake-chat" postMessage {type: "message.new", evt}
    ↓
  nothing to do in Alice's UI — the message arrives back via the Socket.IO stream like any
  other, which means Alice's optimistic-UI is OFF by design in S1 (simpler, correct, and
  exercises the watermark path on her tab too).

[Bob browser]
  socket.on("message.new", (evt) => watermark.ingest(evt))
    ↓
  watermark.ingest(evt)
    case contiguous: → onEmit(evt.message); lastSeenSeq = BigInt(evt.seq)
    case gap:        → await chatApi.fetchHistory(roomId, fromSeq, toSeq)
                       onEmit(each message in order); onEmit(evt.message);
                       lastSeenSeq = BigInt(evt.seq)
    case stale:      → drop
    ↓
  MessageList receives the emitted messages and appends (or prepends, on startReached).
```

### Watermark hook details (R8, ADR-0003)

```ts
// Sketch — see apps/web/src/lib/watermark.ts for actual impl.
export interface WatermarkEmit {
  (message: MessagePayload): void;
}

export function useRoomWatermark(
  roomId: string,
  fetchHistory: (roomId: string, fromSeq: bigint, toSeq: bigint) => Promise<HistorySliceResponse>,
  emit: WatermarkEmit,
): {
  primeFromAck(headSeq: string): void;
  ingest(evt: MessageNewEvent): Promise<void>;
  reset(): void;
} {
  const lastSeenSeq = useRef<bigint>(0n);
  // in-flight backfill gate: serialize so two gaps don't race
  const queue = useRef<MessageNewEvent[]>([]);
  const busy = useRef(false);
  // ... see R8 contract bullets
}
```

**Why a hook, not a singleton**: state is per-room; Next.js `StrictMode` runs effects twice in dev; the hook scopes lifecycle to the `RoomClient` mount. Tests live next to it and import the pure function under a React-free unit test harness (`act(() => ...)` only if needed).

### Socket.IO client (R9)

Both real and fake satisfy the structural type of `Socket<ServerToClientEvents, ClientToServerEvents>` — which defines `emit`, `on`, `off`, `disconnect`. `RoomClient.tsx` accepts the socket via a prop (injected by the factory), so component code never sees the real/fake branch.

```ts
export function createChatSocket(): ChatSocket {
  if (process.env.NEXT_PUBLIC_USE_FAKE_BACKEND === "true") {
    return createFakeSocket(); // from fake-backend.ts
  }
  return io(BACKEND_URL, {
    withCredentials: true,      // send better-auth cookie on handshake
    transports: ["websocket"],  // skip the polling dance; backend supports both
  }) as unknown as ChatSocket;
}
```

`withCredentials: true` + the backend's existing `@fastify/cors({ origin: env.WEB_ORIGIN, credentials: true })` = cookies flow on the handshake and the server's `io.use` middleware can read the session. No CORS work here — s1-auth already set it up for `/api/auth/*`.

### Fake backend (§ hard constraint from brief: "stub fetch calls behind a USE_FAKE_BACKEND flag")

**Problem shape**: chat backend tasks 5–8 + 11 aren't merged yet. The frontend needs to build + manually exercise the two-browser path before those land. A BroadcastChannel-backed in-memory fake gives us that.

**Architecture**:

- `apps/web/src/lib/fake-backend.ts` creates a module-level singleton on first access. Seeds `general` with 3 messages at bootstrap. Storage is `Map<roomId, MessagePayload[]>` in memory.
- `FakeChatAPI` implements `sendMessage`, `fetchHistory` against that store.
- `createFakeSocket()` returns an object with `emit(event, ...args)`, `on(event, handler)`, `off(event, handler)`, `disconnect()`. Under the hood it uses a `BroadcastChannel("s1-fake-chat")` so message events fan out across all tabs of the same origin. Cross-tab seq allocation uses the Web Locks API (`navigator.locks.request("s1-fake-seq", async () => { ... })`) — guarantees one allocator across tabs. Cross-tab membership + presence are in-scope only as far as is needed for the two-browser S1 demo.
- On module load, the fake POST handler appends to the store, takes the lock, mints a new seq, and broadcasts `{ type: "message.new", roomId, seq, roomHeadSeq, message }` on the channel. Every fake socket is subscribed to the channel and routes inbound messages through its `on("message.new", ...)` listeners.
- `room.subscribe` ack in fake mode returns the current `roomHeadSeq` read from the in-memory store.
- **Deliberate gap injection for testing**: dev-only, gated behind `NEXT_PUBLIC_FAKE_DROP_PROB` (0..1). On broadcast, with that probability we skip the emit — the client MUST gap-fill on the next live message. Production default: 0.

**What the fake deliberately does NOT simulate**: the server-side zod rejection for 3073+-byte bodies (we rely on the composer's client-side length guard), NFC normalization (we normalize client-side before send, same as real), backend restart persistence (fake is in-memory; closing all tabs clears state). These are flagged in the fake's header doc so a future reader doesn't think the fake is a substitute for the real backend tests.

**Non-goal**: the fake is NOT a test double for automated tests. `MessageList` and `MessageComposer` tests use mock props directly; the watermark hook test mocks its `fetchHistory` argument. The fake is a dev-only manual-testing tool.

### Forms (R1, R2)

`react-hook-form` + `@hookform/resolvers/zod`. Fields wired through shadcn's `<Form>` adapter. `registerSchema` and `loginSchema` from `@ai-herders/shared/dto` are the resolvers — same validation on both sides of the wire, single source of truth. Error surface:

```ts
const form = useForm<LoginInput>({ resolver: zodResolver(loginSchema) });
const onSubmit = form.handleSubmit(async (values) => {
  try {
    await authClient.signIn.email(values);
    router.replace("/rooms");
  } catch (e) {
    const msg = extractAuthErrorMessage(e);
    // 429 → "Too many attempts, wait a minute"
    // 401 → "Invalid email or password"
    // anything else → generic + toast
    toast.error(msg);
    form.setError("root", { message: msg });
  }
});
```

### Layout (REQ-045)

```tsx
// RoomClient.tsx
<div className="h-dvh grid gap-0
                grid-cols-1 grid-rows-[auto_1fr_auto]
                lg:grid-cols-[16rem_1fr_18rem] lg:grid-rows-[auto_1fr]">
  <Header className="lg:col-span-3" />
  <nav className="hidden lg:block border-r">       <RoomList /> </nav>
  <main className="flex flex-col min-h-0 overflow-hidden">
    <MessageList ... />
    <MessageComposer ... />
  </main>
  <aside className="hidden lg:block border-l">    <MemberList /> </aside>
  {/* Below lg: render the three as <details> accordions stacked, same children */}
</div>
```

The `min-h-0 overflow-hidden` on `<main>` is load-bearing: without it, `Virtuoso`'s internal scroller collapses to full-document height and `followOutput` stops working in the grid layout.

### Composer key-behavior (R5, REQ-046)

```tsx
<TextareaAutosize
  minRows={1} maxRows={6}
  onKeyDown={(e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (canSend) void send();
    }
    // Shift+Enter falls through to native newline insertion
    // Tab is untouched → focus advances to Send button
  }}
/>
```

`!e.nativeEvent.isComposing` guards against IME composition (Enter during Japanese/Korean IME commit must NOT submit) — a well-known chat-app gotcha worth getting right on day one.

### Dependencies (brief allows "add if missing")

Runtime:

```jsonc
"react-hook-form": "^7.54",
"@hookform/resolvers": "^3.9",
"react-textarea-autosize": "^8.5",
"react-virtuoso": "^4.12",
"sonner": "^1.7"
```

Test (devDependencies — landed together in Task 1 alongside the vitest.config rewrite):

```jsonc
"@testing-library/react": "^16.1",
"@testing-library/user-event": "^14.5",
"@testing-library/jest-dom": "^6.6",
"jsdom": "^25.0"
```

`socket.io-client`, `better-auth`, `zod`, `clsx`, `tailwind-merge`, `lucide-react`, `@ai-herders/shared`, `vitest` already in `apps/web/package.json`. shadcn primitives (`button`, `input`, `label`, `card`, `form`, `scroll-area`, `separator`, `skeleton`, `avatar`, `sonner`, `textarea`) installed via `pnpm dlx shadcn@latest add …` as each task needs them.

### Security posture

- **Cookies are set by the backend on the auth response**; we never construct a cookie manually.
- **CORS + credentials**: backend already sets `origin: env.WEB_ORIGIN, credentials: true` (s1-auth task #1). We set `credentials: "include"` on `fetch` calls + `withCredentials: true` on the socket.
- **No secrets in `apps/web/`.** Only `NEXT_PUBLIC_BACKEND_URL` and `NEXT_PUBLIC_USE_FAKE_BACKEND` are read from env; both are non-sensitive.
- **XSS**: message bodies are rendered as text via JSX children, never `dangerouslySetInnerHTML`. NFC + control-char strip happens server-side already; we optionally pre-normalize client-side for symmetry but never trust the client normalization.
- **CSRF**: better-auth same-site cookies + origin check cover it. S3 will layer double-submit per REQ-146; out of scope here.

### Manual verification workflow

Per CLAUDE.md non-negotiable #1 and the brief's "workflow per REQ-ID": UI is test-after. For each REQ-ID slice:

1. Implement smallest vertical slice.
2. `pnpm --filter web typecheck && pnpm --filter web lint`.
3. Open `http://localhost:3000/<route>` in Chrome; open a second incognito tab for two-browser scenarios.
4. Walk the gate-criteria checklist §9 for that REQ.
5. Commit: `feat(s1-web): REQ-0NN <description>`.

Only two automated test files: `watermark.test.ts` + `MessageComposer.test.tsx`. No Playwright in S1 (s1-auth task #8 precedent).

## 6. Tasks (each <2h)

Each task is a commit. Task order walks the file dependency graph — auth-client → socket → chat-api → watermark → composer → list → pages — so every commit compiles and lints clean.

1. [ ] **Worktree + deps + env + test rig** — `git worktree add` (done), `pnpm install`, add:
    - **Runtime**: `react-hook-form`, `@hookform/resolvers`, `react-textarea-autosize`, `react-virtuoso`, `sonner`.
    - **Test (devDeps)**: `@testing-library/react`, `@testing-library/user-event`, `@testing-library/jest-dom`, `jsdom`.
    - Rewrite `apps/web/vitest.config.ts`: `environment: "jsdom"`, `include: ["src/**/*.test.{ts,tsx}"]`, add `setupFiles: ["./vitest.setup.ts"]` and create that file with `import "@testing-library/jest-dom/vitest"`.
    - Create `.env.local.example` with `NEXT_PUBLIC_BACKEND_URL=http://localhost:4000` and `NEXT_PUBLIC_USE_FAKE_BACKEND=true`.
    - Land one smoke test (`src/lib/smoke.test.tsx` — render `<div>hi</div>`, assert in DOM) to prove the rig works; delete after the first real test lands.
    - Verify `pnpm --filter web dev`, `pnpm --filter web typecheck`, `pnpm --filter web test:run` all pass.
   Commit: `chore(s1-web): dependencies + test rig + env template`.
2. [ ] **`auth-client.ts` + `<RequireSession>` + header + root redirect (R10)** — `createAuthClient({ baseURL: BACKEND_URL })`; wrap `app/layout.tsx` with a `<Toaster/>` (sonner); `app/page.tsx` becomes a client component that redirects based on `useSession()`. Wire `<Header/>` (username + sign-out). No visible new page — but `/` now routes correctly and the sign-out round-trip works against the real backend. Commit: `feat(s1-web): auth-client + session gate + root redirect`.
3. [ ] **`/register` page (REQ-042, R1)** — form fields (email, username, name, password) + zod resolver + `authClient.signUp.email`. Install shadcn `button`, `input`, `label`, `form`, `card`. Manually verify: happy path creates user + lands on `/rooms` (which will 404 rendering-wise until task 5 — that's fine, we're verifying the auth round-trip). Duplicate email/username → inline error + toast. Commit: `feat(s1-web): REQ-042 register page`.
4. [ ] **`/login` page (REQ-043, R2)** — mirror task 3; add remember-me checkbox. Manually verify: happy path; wrong creds → generic error; rate-limit after 5 tries → "Too many attempts". Commit: `feat(s1-web): REQ-043 login page`.
5. [ ] **`/rooms` page (REQ-044, R3)** — `<RequireSession>` gate; hardcoded `[{ id: "general", name: "general" }]`; clicking navigates. Install shadcn `scroll-area` if needed. Commit: `feat(s1-web): REQ-044 rooms list page`.
6. [ ] **`chat-api.ts` interface + `RealChatAPI`** — `sendMessage(roomId, { body, clientMessageId? })`, `fetchHistory(roomId, { fromSeq?, toSeq?, limit? })`. Strict typing on request/response from `@ai-herders/shared/protocol`. All bigint handling is strings-in-strings-out; the hook converts. No UI change yet — this is just a lib file with a types-only test. Commit: `feat(s1-web): chat-api real implementation`.
7. [ ] **`fake-backend.ts` + `FakeChatAPI` + `createFakeSocket` (supports §5 gap-injection knob)** — BroadcastChannel wiring, Web-Locks-backed seq allocator, seed `general` + 3 messages, seed `alice`/`bob`/`carol` display names (for members panel). Header comment enumerates the non-simulated behaviors (see §5). Commit: `feat(s1-web): fake backend + BroadcastChannel socket`.
8. [ ] **`socket.ts` factory** — branches on `NEXT_PUBLIC_USE_FAKE_BACKEND`. Real path: `io(BACKEND_URL, { withCredentials: true, transports: ["websocket"] })`. Commit: `feat(s1-web): typed socket factory with fake/real branch`.
9. [ ] **`watermark.ts` + `watermark.test.ts` (ADR-0003, R8, R12)** — write tests FIRST per CLAUDE.md non-negotiable #2 (this IS core logic in `src/lib/`, so TDD applies). Cover: in-order, single-gap, multi-gap, concurrent-new-during-backfill, duplicate drop, late-arriving drop, initial hydration from ack. Implementation serializes backfills behind a `busy` flag + a `queue` ref. Commit: `feat(s1-web): REQ-ADR-0003 watermark hook (TDD)`.
10. [ ] **`MessageComposer.tsx` + `MessageComposer.test.tsx` (REQ-046, R5)** — `react-textarea-autosize`; Enter/Shift+Enter/Tab behaviors; IME composition guard; length-cap disable. Install shadcn `textarea` (wraps autosize variant). Commit: `feat(s1-web): REQ-046 composer with Enter/Shift+Enter/Tab (tested)`.
11. [ ] **`MessageList.tsx` (REQ-047, REQ-048, R6, R7)** — Virtuoso integration: `followOutput`, `atBottomStateChange`, `atBottomThreshold={100}` (v4-aligned), `startReached` → prepend older page, `firstItemIndex` anchor preservation, `hasMore` gating, "↓ N new messages" pill with `scrollToIndex({ index: "LAST" })` + `unreadCount` reset. Item renderer is a simple bubble + author + timestamp. Manual verification: §9 rows 1, 2, 3. Commit: `feat(s1-web): REQ-047/048 message list (virtuoso)`.
12. [ ] **`RoomList.tsx` + `MemberList.tsx`** — static data from the S1 hard-coded membership; presence dots are gray in S1 (binary; real backend S2 lights them). Commit: `feat(s1-web): rooms + members columns`.
13. [ ] **`/rooms/[roomId]/page.tsx` + `RoomClient.tsx` (REQ-045, R4)** — assemble: create socket + `useRoomWatermark` + initial history fetch + `room.subscribe` → prime watermark → render the 3-column layout. Mobile collapses to `<details>`. Manual verification: §9 rows 1–8. Commit: `feat(s1-web): REQ-045 room view (3-col layout + live wiring)`.
14. [ ] **Gate dry-run** — Walk the full §9 checklist in real mode (`USE_FAKE_BACKEND=false`) against the backend agent's current state. Expect parts to be red until chat agent lands tasks 5–8+11; walk fake mode (`=true`) with two tabs and verify every checklist row passes in fake mode. Document any spec drift in §10. Commit: `docs(s1-web): gate dry-run results`.

## 7. Out of scope / follow-ups

- **Optimistic send UI** — S1 routes the sender's own message through the same `message.new` stream as everyone else's. Optimistic rendering with client-side `clientMessageId` reconciliation is S2 alongside the backend's idempotency decision (s1-chat §8 Q1). The win-case (instant feel) isn't worth the reconciliation state machine in a 24h demo.
- **Typing indicator UI** — S2. `typing` event + `typing.start/stop` emitters exist in `protocol.ts`; wiring is 30 lines but not in REQ scope.
- **Presence dots lit** — `presence.state` broadcasts are backend task #9; in S1 we render static gray dots. Once backend tasks 9 lands and emits online/offline, we re-home the MemberList to listen.
- **`GET /api/v1/rooms/me` for REQ-044 dynamic list** — S2; S1 hard-codes the general room because the current chat spec doesn't create this endpoint and inventing one violates the brief's hard constraint #5.
- **Playwright e2e** — S1-auth precedent (task #8 deferred); we repeat it here. The manual §9 checklist is the gate, same as s1-chat. If a judge asks for automated browser testing, S3 hardening covers it.
- **Mobile "collapse behind icons" (v4 REQ-045 clause)** — v4 says the sidebars should collapse into icon toggles below 1024px; we ship `<details>` accordions instead. Icon toggles require a tri-state toggle (rooms / messages / members), ~50 LoC of state, and Playwright golden-fixture screenshots for acceptance. `<details>` is native, keyboard-accessible, and meets the BRIEF's "collapses to accordion on narrower viewports" literally. S2 can promote to icon toggles once a golden-fixture test rig exists.
- **"Forgot password?" link → `/password-reset` stub page (v4 REQ-044 clause)** — v4 says S1 shows a "Coming soon" page that still calls REQ-017. The backend REQ-017 endpoint is live (s1-auth task #7, stub) but wiring a UI page to it is ~40 LoC of form + ~20 LoC of page + toast. Deferred to S3 alongside real email delivery (s1-auth §7 "SMTP for password reset"). A password-reset link with no delivery mechanism isn't a UX improvement for S1.
- **"Create room" button (v4 REQ-045 clause)** — left sidebar per v4 has a "Create room" button. S1 has no create-room backend endpoint (chat spec §2 lists it as out-of-scope). Button hidden in S1; `TODO(S2)` marker in `RoomList.tsx`.
- **`/account/sessions` page** — s1-auth defers it to this stream, we defer it to S2. Sign-out from header covers the S1 user need.
- **`authClient.useSession` SSR hydration flash** — on a hard refresh, client-only `useSession` flashes a brief skeleton then the signed-in UI. Acceptable for S1; S3 could layer Next.js middleware that reads the cookie server-side and redirects before render.

## 8. Open questions

**To resolve at spec approval** (none blocking the first 4 tasks):

- [ ] **`NEXT_PUBLIC_USE_FAKE_BACKEND` default value in committed `.env.local.example`.** Options: (a) default `true` so a clone-and-run developer sees the fake demo working immediately; (b) default `false` so fake mode is always opt-in and never ships to prod by accident. Recommendation: **(a) for `.env.local.example`, explicit-false in `docker-compose.yml`.** Rationale: the example file is a dev-onboarding aid; the submission gate (`docker compose up`) overrides to false.
- [ ] **Does the sign-out button stay visible on `/rooms` when there are zero rooms?** In S1 there's always `general` so this is dead-code-path, but the flag affects the 3-col empty state. Recommendation: always render the header. Zero extra code.
- [ ] **`authClient.signUp.email` — does our backend accept `{ username }` in the body?** s1-auth task #2a says yes (`additionalFields.username: { input: true }`). Better-auth's client typing may not reflect the custom field — if we hit a TS error we cast the input at the call site with a `// better-auth: custom additionalField from auth.ts` comment. Recommendation: confirmed by s1-auth spec §5 "Data model" — we proceed with the happy-path type cast.

**Informational (cross-agent)**:

- The sign-out path uses `authClient.signOut()`; s1-auth R11 verified the endpoint returns 200 + null session. No coordination needed.
- `presence.state` fanout scope is `io.emit` global in chat spec §8 Q2 — our MemberList listens to all `presence.state` events and filters to `members.has(evt.userId)` before rendering.

## 9. Gate criteria (self-check before "S1 web done")

Manual, two-browser checklist. Run in order. Flip `NEXT_PUBLIC_USE_FAKE_BACKEND=false` once chat agent's tasks 5–8 + 11 are on `main`.

- [ ] `pnpm --filter web typecheck && pnpm --filter web lint && pnpm --filter web build` all green.
- [ ] REQ-ID coverage (manual grep, since `pnpm trace` is stubbed at repo root `package.json:20`): running `rg "REQ-04[2-8]" apps/web/src tests/` returns at least one hit per REQ-ID from page-source comments or test names. When a real `pnpm trace` script lands in a later stage, this row converts to `pnpm trace` automatically.
- [ ] Chrome window A: `/register` → alice — lands on `/rooms`, sees `general`.
- [ ] Incognito B: `/login` → bob (seeded, password `hunter2hunter2`) — lands on `/rooms`, sees `general`.
- [ ] Both navigate to `/rooms/general`. A types "hello" → Enter. B's list updates within the same second.
- [ ] B reloads. History intact, scrolled to bottom, no duplicate messages.
- [ ] A scrolls up past the visible history — older messages load without jumping the viewport.
- [ ] A scrolls to middle of history. B sends a message. A's list updates but A stays at the same visible anchor (no yank).
- [ ] Disable B's network in DevTools for 5s. A sends 3 messages. Re-enable B's network. B's next live event triggers a backfill fetch; the 3 messages appear in order; no duplicates, no loss.
- [ ] Window width 1023px → the three columns collapse to stacked accordions. 1024px+ → three columns visible.
- [ ] Composer: Enter sends. Shift+Enter inserts newline (no submit). Tab moves focus to Send button (doesn't submit).
- [ ] Composer: body over 3072 chars → Send disabled.
- [ ] Header sign-out on A → routes to `/login`, `useSession()` is null, B remains signed in (independent session).
- [ ] Rate-limit: hit `/login` with wrong password 6 times — 6th attempt shows "Too many attempts".
- [ ] `?next=` deep-link round-trip: sign out, visit `/rooms/general` — URL becomes `/login?next=%2Frooms%2Fgeneral`. Sign in → land directly on `/rooms/general` (not `/rooms`). Try `?next=//evil.com` and `?next=https://evil.com` → both fall back to `/rooms` after sign-in (no redirect to external host). (R2b)
- [ ] "↓ N new messages" pill: A scrolls up ~200 px in `general`. B sends 4 messages. A sees the floating pill read "↓ 4 new messages", list length grows but A's viewport stays put. A clicks the pill → smooth-scrolls to bottom, pill disappears, `unreadCount` returns to 0. Scrolling back up then back down on A's own power also clears `unreadCount`. (R6)
- [ ] localStorage draft survives reload: in A's composer type "half-written message" without sending. Reload the page. Composer hydrates with "half-written message" still inside. Type → send → reload again → composer is empty (key cleared on successful send). Sign out, sign in as bob in the same browser: bob's composer is empty (`s1-draft:${userId}:${roomId}` scoped by userId). (R5b)

Timebox: S1 gate is H+10 from hackathon start (2026-04-18 08:00 UTC) → **2026-04-18 18:00 UTC**. Past H+9, ship fake-mode-green + whatever real-mode paths are unblocked; flag the rest.

## 10. Decision log

Running record of implementation decisions made while executing this spec. Mirrors s1-auth §10 and s1-chat §10. Durable ADRs live in `docs/adr/`; this log captures per-task calls.

- **2026-04-18 (spec draft)** — Picked open-source `Virtuoso` over commercial `VirtuosoMessageList`. The latter covers chat specifics (scrollModifier: "prepend", autoscroll-to-bottom) but requires a license key. Base `Virtuoso` exposes `followOutput`, `atBottomStateChange`, `atBottomThreshold`, `startReached`, `initialTopMostItemIndex`, and `firstItemIndex` — every S1 REQ is reachable, at zero license cost and zero extra dep. Source-read Context7 docs 2026-04-18.
- **2026-04-18 (spec draft)** — Fake backend as interface-swap + BroadcastChannel, NOT MSW. Considered MSW: works, but service-worker boot in Next.js App Router dev has a known-quirky lifecycle (`worker.start` before render, mismatched dev vs prod bundles). Since we own every fetch/socket call site, a plain TS interface with two implementations is smaller, type-safer, and doesn't need Service Worker plumbing. Cross-tab simulation via `BroadcastChannel("s1-fake-chat")` + `navigator.locks.request("s1-fake-seq")` gives us the two-browser demo path without the chat backend. Rejected alternative: `localStorage` + `storage` event for cross-tab — `BroadcastChannel` is the modern API and doesn't serialize round-trip through `localStorage`. Rejected alternative: shared `SharedWorker` — overkill for a dev-only aid.
- **2026-04-18 (spec draft)** — Forms via `react-hook-form` + `zodResolver(registerSchema/loginSchema from @ai-herders/shared/dto)`. Direct consequence: server-side zod guards and client-side form guards are the same schema object. If the backend drifts, TypeScript breaks at the form. This is the reason we import from `shared` even though typechecking would pass with a redefined local schema — drift prevention is the point.
- **2026-04-18 (spec draft)** — Composer IME composition guard (`!e.nativeEvent.isComposing` in the Enter handler) called out in R5. Classic chat-app bug: Enter during Japanese/Korean IME commit triggers a send. Adding it on day one is a 6-char change; retrofitting it after someone reports a demo-day bug is embarrassing. Not a v3.docx REQ, just chat-app hygiene.
- **2026-04-18 (spec draft)** — Sign-out placement: header on `/rooms` + `/rooms/:id`. `/account/sessions` page is deferred per s1-auth task #8 spec note. The simpler path — username + Sign out text-button in the header — covers the user need for S1. S2 can promote the sessions UI if a judge asks for multi-device kill.
- **2026-04-18 (spec draft)** — `followOutput` returning `"smooth" | false` (not `true | false`) because `"smooth"` is the documented behavior for chat apps in Virtuoso docs (smoother animation when we're appending frequently). No perf impact at <200 messages.
- **2026-04-18 (spec draft)** — REQ-044 hardcoded membership. The chat spec doesn't add a `GET /api/v1/rooms/me` endpoint for S1. Per brief hard-constraint #5 ("No backend code. If a page needs a new endpoint, STOP and ask"), we hardcode `general` for S1 and `TODO(S2)` the real endpoint. Alternative considered: call `GET /api/v1/rooms/general/messages` as a side-channel proof-of-membership — rejected, it's a side-effect, not a membership probe, and would confuse future readers.
- **2026-04-18 (spec draft)** — `transports: ["websocket"]` on the real socket. Socket.IO default is polling→websocket upgrade; skipping polling is one less round-trip at connect. Backend supports both (no per-transport config). If this causes flakiness in some network setup during hackathon demo, we drop back to default — not load-bearing.
- **2026-04-18 (spec draft)** — Deliberate gap-injection knob (`NEXT_PUBLIC_FAKE_DROP_PROB`) in the fake socket. Lets us manually exercise the gap-fill path in dev without waiting for real network conditions. Default 0 in `.env.local.example`. This is the ONLY way to unit-test the watermark hook AGAINST the fake backend integration path before the real backend lands — a nice-to-have, not a must-have (the watermark hook unit tests in `watermark.test.ts` use a pure-JS mocked fetcher and cover all the state-machine branches without any fake-backend dependency).
- **2026-04-18 (spec draft)** — No Playwright in S1. s1-auth task #8 set the precedent: UI is test-after, manual gate checklist is the backbone, and adding Playwright now would push past the timebox. If S3 hardening requires a smoke e2e, we add one there.
- **2026-04-18 (review — v4 drift reconciliation)** — BRIEF.md and `/task/Chat_Server_Requirements_v4.md` slice REQ-042…REQ-048 at different granularities. Per `memory: feedback-task-mds-are-prep`, v4 is AI-prep, not binding; BRIEF.md is the organizer-side contract. First spec draft followed BRIEF only; review correctly flagged that the cited REQ-IDs carry v4 UX clauses a reviewer could expect. Reconciliation policy: pull in every v4 clause that is (a) cheap and (b) a genuine UX win; defer expensive or dependency-blocked clauses with explicit §7 entries. Implemented from v4: `?next=` deep-link (REQ-042, R2b), "Keep me signed in" label wording (REQ-044 → our R2), localStorage draft persistence (REQ-046, R5b), live byte counter (REQ-046, R5), 100px autoscroll threshold + "↓ N new messages" pill (REQ-047, R6), 500px infinite-scroll trigger (REQ-048, R7 — reached via Virtuoso's default overscan). Deferred with §7 entries: mobile icon nav (→ `<details>`), "Forgot password?" link page, "Create room" button.
- **2026-04-18 (review — test tooling)** — First draft's R5 assumed `@testing-library/react` + `user-event` + `jsdom` were available; they weren't. `apps/web/vitest.config.ts` was `environment: "node"` + `src/**/*.test.ts` only. Task 1 expanded to add all four testing devDeps, flip the environment to jsdom, widen the glob to `.{ts,tsx}`, and land a smoke test so the rig is proven before any composer test is written. Miss caught by review; documented so future-me doesn't repeat on s2-web.
- **2026-04-18 (review — broken cross-ref)** — Dropped the `.human/FRONTEND_AGENT_BRIEF.md` pointer from the header. The brief is an untracked file in the primary worktree; on the `feat/s1-web` branch (which was created from committed `main`) it does not exist. Replaced with "brief provided by Tatianka at session start" so a reviewer on a fresh clone doesn't chase a missing file. Session-specific runbooks belong in `.human/` not `docs/specs/` anyway.
- **2026-04-18 (review — pnpm trace gate)** — `pnpm trace` at repo-root `package.json:20` falls back to `echo 'trace script not implemented yet (S1)'`, so the §9 "counts REQ-IDs as covered" row was unenforceable. Weakened to an explicit `rg "REQ-04[2-8]" apps/web/src tests/` grep with a note that the row auto-reverts to `pnpm trace` when the script lands. Tagging every test name and page-source REQ comment is still a MUST; only the automation is stubbed.
- **2026-04-18 (review — byte counter threshold)** — v4 REQ-046 quotes thresholds of 3000 bytes (soft) and 4096 bytes (block). Our backend's `messageBodySchema.max(3072)` sets the real block at 3072 bytes. R5 pins the soft zone at 2800 (just below 3000) and the block at 3072 (not 4096). Rationale: client-side UX must align with the actual server rejection point to avoid a "send failed silently" surprise. v4's 4096 is a stale constant from a pre-v3 draft; v3.docx §2.5.2 is 3 KB. Flagged in §5 R5 with the byte-count pathway.
- **2026-04-18 (review — `?next=` open-redirect guard)** — Accepting `searchParams.get("next")` without validation is an open-redirect vector (attacker crafts `https://app.example.com/login?next=https://evil.com`, victim signs in, is redirected to evil.com). First-pass draft validated only `next.startsWith("/")`, which is still leaky: `//evil.com` is protocol-relative and browsers happily follow it to `https://evil.com`; `/\evil.com` is a documented Windows-path variant. Round-2 review caught both. R2b now requires `startsWith("/") && !startsWith("//") && !startsWith("/\\")`, verified by a 3-case unit test. Anything else collapses to `/rooms` default. One line of code, but a real S3-hardening concern if we forget. Documented here so a reviewer sees it.
