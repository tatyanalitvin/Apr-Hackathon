// Shared pg-error classifier. drizzle-orm surfaces the original pg error
// sometimes directly, sometimes under `.cause` — the helper unwraps either.
// Use `constraint_name` (pg 12+) rather than parsing `detail` strings.

interface PgLikeError {
  code?: string;
  constraint_name?: string;
  cause?: unknown;
}

export function isUniqueViolation(
  err: unknown,
  constraintName: string,
): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as PgLikeError;
  if (e.code === "23505" && e.constraint_name === constraintName) return true;
  if (e.cause && typeof e.cause === "object") {
    const inner = e.cause as PgLikeError;
    if (inner.code === "23505" && inner.constraint_name === constraintName) {
      return true;
    }
  }
  return false;
}
