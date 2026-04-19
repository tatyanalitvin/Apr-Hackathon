// REQ-110 R10/R11 — pure reducers feeding RoomClient's socket listeners.
// See reply-reducers.test.ts for the invariants these enforce.
//
// We keep these as standalone functions (rather than inlining them in
// RoomClient's useEffect) for two reasons:
//   1. Unit-testable without mounting RequireSession + Socket + 3-column layout.
//   2. Referential-identity discipline — rows that don't change are returned
//      by reference, so React reconciles only the rows that actually flipped.

import type { MessagePayload } from "@ai-herders/shared/protocol";

export interface MessageEditedInput {
  messageId: string;
  body: string;
  editedAt: string;
}

export interface MessageDeletedInput {
  messageId: string;
  deletedAt: string;
}

// REQ-110 R10 — parent edit. `replyTo.text` is LIVE *on hydration* per spec
// §5 Q1; existing in-memory reply rows keep their snapshot until refetched.
// So this reducer only rewrites the edited row itself — sibling replies are
// returned by reference.
export function applyMessageEditedReducer(
  messages: MessagePayload[],
  evt: MessageEditedInput,
): MessagePayload[] {
  return messages.map((m) =>
    m.id === evt.messageId
      ? { ...m, body: evt.body, editedAt: evt.editedAt }
      : m,
  );
}

// REQ-110 R11 — parent delete. Flip the tombstoned row AND every reply that
// references it. The reply's own row stays visible; only the quoted preview
// changes to `[deleted]` (driven by replyTo.deletedAt in MessageList).
export function applyMessageDeletedReducer(
  messages: MessagePayload[],
  evt: MessageDeletedInput,
): MessagePayload[] {
  return messages.map((m) => {
    if (m.id === evt.messageId) {
      return { ...m, body: "", attachments: [], deletedAt: evt.deletedAt };
    }
    if (m.replyTo && m.replyTo.id === evt.messageId) {
      return {
        ...m,
        replyTo: { ...m.replyTo, text: "", deletedAt: evt.deletedAt },
      };
    }
    return m;
  });
}
