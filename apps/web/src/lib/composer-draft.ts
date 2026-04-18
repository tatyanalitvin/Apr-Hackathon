const PREFIX = "s1-draft:";

export function draftKey(userId: string, roomId: string): string {
  return `${PREFIX}${userId}:${roomId}`;
}

export function readDraft(userId: string, roomId: string): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(draftKey(userId, roomId)) ?? "";
  } catch {
    return "";
  }
}

export function writeDraft(userId: string, roomId: string, body: string): void {
  if (typeof window === "undefined") return;
  try {
    if (body.length === 0) window.localStorage.removeItem(draftKey(userId, roomId));
    else window.localStorage.setItem(draftKey(userId, roomId), body);
  } catch { /* quota or private-mode — fail open */ }
}

export function clearDraft(userId: string, roomId: string): void {
  if (typeof window === "undefined") return;
  try { window.localStorage.removeItem(draftKey(userId, roomId)); } catch { /* noop */ }
}
