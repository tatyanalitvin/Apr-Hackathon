// REQ-110 (s2-replies R4, R5, R7) — turns a parent message row into a
// wire-shaped `ReplyToPreview` for the `replyTo` field on MessagePayload.
//
// Three callers: send handler (R5), history LEFT-JOIN path (R6), DM listing
// lastMessage path (R8). Keeping the shape-shaping in one pure helper means
// truncation + ISO conversion + `[deleted]` substitution stay consistent.

import {
  REPLY_PREVIEW_ELLIPSIS,
  REPLY_PREVIEW_MAX,
  type ReplyToPreview,
} from "@ai-herders/shared/protocol";

export interface ParentRow {
  id: string;
  body: string;
  authorUsername: string;
  deletedAt: Date | null;
}

export function previewFromParent(
  parent: ParentRow | null | undefined,
): ReplyToPreview | null {
  if (parent == null) return null;
  const deleted = parent.deletedAt !== null;
  const text = deleted
    ? ""
    : parent.body.length > REPLY_PREVIEW_MAX
      ? parent.body.slice(0, REPLY_PREVIEW_MAX) + REPLY_PREVIEW_ELLIPSIS
      : parent.body;
  return {
    id: parent.id,
    text,
    authorUsername: parent.authorUsername,
    deletedAt: parent.deletedAt ? parent.deletedAt.toISOString() : null,
  };
}
