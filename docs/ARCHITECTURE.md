# Architecture

_Update this as the system evolves. Keep it to one page._

## High level

```
┌──────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Browser    │ ◄─► │  Next.js (edge)  │ ◄─► │  Anthropic API  │
│ React 19 RSC │     │  App Router      │     │  (Claude)       │
└──────────────┘     │  API routes      │     └─────────────────┘
                     └──────────────────┘
                              │
                              ▼
                     ┌──────────────────┐
                     │  (optional) DB   │
                     │  SQLite / Postgres│
                     └──────────────────┘
```

## Boundaries

- **`src/app/`** — Next.js routes. Server Components by default. Client only when stateful.
- **`src/app/api/`** — HTTP endpoints. Thin — validate input (zod), call `src/lib/`, return.
- **`src/lib/`** — Pure TypeScript. No React imports. 100% unit-testable. This is where the business logic lives.
- **`src/components/`** — React. Dumb by default. Data comes from props or server components.
- **`src/components/ui/`** — shadcn primitives. Do not put business logic here.

## Data flow

1. User action → form or button in a Client Component.
2. Server Action or `fetch('/api/…')` to an API route.
3. API route validates (zod), calls a pure function from `src/lib/`.
4. Response streams back (for chat) or returns JSON (for everything else).

## Dependencies added beyond the starter

_Log them here with a one-line justification._

| Package | Why | Added by |
|---|---|---|
| (none yet) | | |
