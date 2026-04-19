// REQ-110 R10/R11 — client reducers for parent-edit and parent-delete.
//
// These are extracted as pure functions so RoomClient can invoke them from a
// socket listener while the behavior stays unit-testable without mounting the
// whole 3-column chat page.
//
// Invariants exercised below:
//   R10: message.edited on a parent must NOT mutate any reply row's
//        replyTo.text. Per spec §5 "text is LIVE" means *on hydration* — an
//        in-memory reply keeps the original preview until it's refetched.
//   R11: message.deleted on a parent must flip matching replies' replyTo to
//        `{ ...prev, text: "", deletedAt }` so the MessageRow quoted-block
//        renders `[deleted]` without a refetch. The delete event itself also
//        flips the deleted row's own body/deletedAt (existing S1 behavior).
//
// The reducers are shape-preserving — unrelated rows are returned by
// reference identity so React re-renders only the rows that actually changed.
import { describe, it, expect } from "vitest";
import type { MessagePayload } from "@ai-herders/shared/protocol";
import {
  applyMessageEditedReducer,
  applyMessageDeletedReducer,
} from "./reply-reducers";

function msg(overrides: Partial<MessagePayload> = {}): MessagePayload {
  return {
    id: "m-1",
    roomId: "general",
    authorId: "u1",
    authorUsername: "alice",
    authorName: "Alice",
    body: "hello",
    seq: "1",
    replyToId: null,
    replyTo: null,
    editedAt: null,
    deletedAt: null,
    createdAt: "2026-04-19T00:00:00.000Z",
    ...overrides,
  };
}

describe("applyMessageEditedReducer (REQ-110 R10)", () => {
  it("patches the edited message's body + editedAt", () => {
    const messages = [msg({ id: "m-1", body: "old" })];
    const [patched] = applyMessageEditedReducer(messages, {
      messageId: "m-1",
      body: "new",
      editedAt: "2026-04-19T01:00:00.000Z",
    });
    expect(patched?.body).toBe("new");
    expect(patched?.editedAt).toBe("2026-04-19T01:00:00.000Z");
  });

  it("does NOT mutate replyTo.text on sibling replies when the parent is edited (R10: text is LIVE on hydration, not in-memory)", () => {
    const parent = msg({ id: "p1", body: "original" });
    const reply = msg({
      id: "r1",
      body: "re",
      replyToId: "p1",
      replyTo: {
        id: "p1",
        text: "original",
        authorUsername: "alice",
        deletedAt: null,
      },
    });
    const [patchedParent, patchedReply] = applyMessageEditedReducer(
      [parent, reply],
      {
        messageId: "p1",
        body: "edited",
        editedAt: "2026-04-19T01:00:00.000Z",
      },
    );
    // Parent's own body patched.
    expect(patchedParent?.body).toBe("edited");
    // Reply's quoted preview is unchanged — R10 invariant.
    expect(patchedReply?.replyTo?.text).toBe("original");
    // Reply row's identity is preserved (no no-op re-render).
    expect(patchedReply).toBe(reply);
  });
});

describe("applyMessageDeletedReducer (REQ-110 R11)", () => {
  const DELETED_AT = "2026-04-19T02:00:00.000Z";

  it("tombstones the deleted message (S1 behavior — body cleared, deletedAt set)", () => {
    const messages = [msg({ id: "m-1", body: "visible" })];
    const [patched] = applyMessageDeletedReducer(messages, {
      messageId: "m-1",
      deletedAt: DELETED_AT,
    });
    expect(patched?.body).toBe("");
    expect(patched?.attachments).toEqual([]);
    expect(patched?.deletedAt).toBe(DELETED_AT);
  });

  it("flips replyTo.text to empty + replyTo.deletedAt on every reply whose parent is deleted", () => {
    const parent = msg({ id: "p1", body: "parent" });
    const reply1 = msg({
      id: "r1",
      body: "first reply",
      replyToId: "p1",
      replyTo: {
        id: "p1",
        text: "parent",
        authorUsername: "alice",
        deletedAt: null,
      },
    });
    const reply2 = msg({
      id: "r2",
      body: "second reply",
      replyToId: "p1",
      replyTo: {
        id: "p1",
        text: "parent",
        authorUsername: "alice",
        deletedAt: null,
      },
    });
    const unrelated = msg({ id: "u1", body: "not a reply" });
    const [patchedParent, patchedReply1, patchedReply2, patchedUnrelated] =
      applyMessageDeletedReducer([parent, reply1, reply2, unrelated], {
        messageId: "p1",
        deletedAt: DELETED_AT,
      });

    // Parent tombstoned.
    expect(patchedParent?.body).toBe("");
    expect(patchedParent?.deletedAt).toBe(DELETED_AT);

    // Both replies' previews flip to deleted state — the MessageRow renders
    // `[deleted]` when replyTo.deletedAt is non-null.
    expect(patchedReply1?.replyTo).toEqual({
      id: "p1",
      text: "",
      authorUsername: "alice",
      deletedAt: DELETED_AT,
    });
    expect(patchedReply2?.replyTo).toEqual({
      id: "p1",
      text: "",
      authorUsername: "alice",
      deletedAt: DELETED_AT,
    });

    // The reply rows' own body/deletedAt are untouched — only the quoted
    // preview changes. A reply to a deleted parent is itself still visible.
    expect(patchedReply1?.body).toBe("first reply");
    expect(patchedReply1?.deletedAt).toBeNull();
    expect(patchedReply2?.body).toBe("second reply");
    expect(patchedReply2?.deletedAt).toBeNull();

    // The unrelated row is returned by identity (no spurious re-render).
    expect(patchedUnrelated).toBe(unrelated);
  });

  it("is a no-op when no row matches (idempotent under duplicate events)", () => {
    const original = msg({ id: "m-1" });
    const messages = [original];
    const next = applyMessageDeletedReducer(messages, {
      messageId: "does-not-exist",
      deletedAt: DELETED_AT,
    });
    expect(next).toEqual(messages);
    expect(next[0]).toBe(original);
  });
});
