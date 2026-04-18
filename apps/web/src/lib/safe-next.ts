/**
 * R2b open-redirect guard. Only accepts same-origin absolute paths.
 *
 * Rejects: protocol-relative `//evil.com`, Windows variant `/\evil.com`,
 * absolute URLs (`http://`, `https://`, any scheme), null/undefined/empty.
 */
export function isSafeNext(next: string | null | undefined): next is string {
  if (!next) return false;
  if (!next.startsWith("/")) return false;
  if (next.startsWith("//")) return false;
  if (next.startsWith("/\\")) return false;
  return true;
}

export function safeNextOr(next: string | null | undefined, fallback: string): string {
  return isSafeNext(next) ? next : fallback;
}
