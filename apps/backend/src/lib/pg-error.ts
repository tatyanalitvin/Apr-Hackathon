// Shared pg-error classifier. drizzle-orm surfaces the original pg error
// sometimes directly, sometimes under `.cause` — the helper unwraps either.
// Use the DatabaseError.constraint field (pg wire error field 'n') rather than regex-parsing detail.

interface PgLikeError {
  code?: string;
  constraint?: string;
  cause?: unknown;
}

export function isUniqueViolation(
  err: unknown,
  constraintName: string,
): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as PgLikeError;
  if (e.code === "23505" && e.constraint === constraintName) return true;
  if (e.cause && typeof e.cause === "object") {
    const inner = e.cause as PgLikeError;
    if (inner.code === "23505" && inner.constraint === constraintName) {
      return true;
    }
  }
  return false;
}
