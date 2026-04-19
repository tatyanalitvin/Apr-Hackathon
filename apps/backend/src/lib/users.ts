// Serialization-layer substitution for soft-deleted users (REQ-018).
//
// Per v3.docx §2.2 "messages remain visible after account removal; username
// is replaced with a placeholder." We soft-delete (set `user.deletedAt`) and
// keep the row so message FKs don't break; every public serialization path
// runs names through `formatUserDisplay` so a deleted user's identity turns
// into the literal string "[deleted user]" without mutating history.
//
// Consumed by messages history, friendship list, DM list, room member list.

export const DELETED_USER_DISPLAY = "[deleted user]";

export interface UserDisplayInput {
  username: string | null | undefined;
  name: string | null | undefined;
  deletedAt: Date | string | null | undefined;
}

export interface UserDisplayOutput {
  username: string;
  name: string;
  deleted: boolean;
}

// Single source of truth: if the joined user row has `deletedAt != null`,
// substitute the placeholder for BOTH username and display-name. Callers
// map the output back into their per-endpoint shape.
export function formatUserDisplay(input: UserDisplayInput): UserDisplayOutput {
  const deleted = input.deletedAt != null;
  if (deleted) {
    return { username: DELETED_USER_DISPLAY, name: DELETED_USER_DISPLAY, deleted: true };
  }
  return {
    username: input.username ?? "",
    name: input.name ?? "",
    deleted: false,
  };
}
