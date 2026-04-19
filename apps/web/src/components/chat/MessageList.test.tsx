// REQ-110 R14 — MessageRow renders a quoted block above the body when the
// message is a reply. The block substitutes `[deleted]` when the parent has
// been soft-deleted (replyTo.deletedAt non-null). No quoted block for plain
// messages. Virtuoso's viewport can be finicky in jsdom — we rely on
// Virtuoso rendering visible items; if jsdom scrollHeight yields 0 we fall
// back to the in-test-only code path by overriding `firstItemIndex`.

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { MessagePayload } from "@ai-herders/shared/protocol";

// react-virtuoso doesn't measure in jsdom (no real viewport), so items never
// mount. Swap it for a dumb <div> that renders every item — we only care
// about the row's quoted-block DOM here, not the virtualizer.
vi.mock("react-virtuoso", () => {
  const Virtuoso = ({
    data,
    itemContent,
  }: {
    data: unknown[];
    itemContent: (i: number, item: unknown) => React.ReactNode;
  }) => (
    <div data-testid="virtuoso-mock">
      {data.map((item, i) => (
        <div key={i}>{itemContent(i, item)}</div>
      ))}
    </div>
  );
  return { Virtuoso };
});

import { MessageList } from "./MessageList";

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
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("MessageList MessageRow quoted-block (REQ-110 R14)", () => {
  it("renders the quoted block with {authorUsername}: {text} when replyTo is populated", () => {
    const reply = msg({
      id: "m-2",
      body: "ok",
      replyToId: "p1",
      replyTo: {
        id: "p1",
        text: "original text here",
        authorUsername: "bob",
        deletedAt: null,
      },
    });
    render(
      <MessageList
        messages={[reply]}
        hasMoreOlder={false}
        onLoadOlder={() => {}}
        firstItemIndex={0}
      />,
    );
    const block = screen.getByTestId("reply-quoted-block");
    expect(block).toHaveTextContent(/bob/);
    expect(block).toHaveTextContent(/original text here/);
  });

  it("renders [deleted] when replyTo.deletedAt is non-null (ignores text)", () => {
    const reply = msg({
      id: "m-3",
      body: "re: gone",
      replyToId: "p1",
      replyTo: {
        id: "p1",
        text: "", // server emits empty text for deleted parents
        authorUsername: "bob",
        deletedAt: "2026-04-19T12:00:00.000Z",
      },
    });
    render(
      <MessageList
        messages={[reply]}
        hasMoreOlder={false}
        onLoadOlder={() => {}}
        firstItemIndex={0}
      />,
    );
    const block = screen.getByTestId("reply-quoted-block");
    expect(block).toHaveTextContent("[deleted]");
    expect(block).not.toHaveTextContent("bob");
  });

  it("omits the quoted block when replyTo is null", () => {
    const plain = msg({ id: "m-4", body: "no quote", replyTo: null });
    render(
      <MessageList
        messages={[plain]}
        hasMoreOlder={false}
        onLoadOlder={() => {}}
        firstItemIndex={0}
      />,
    );
    expect(screen.queryByTestId("reply-quoted-block")).toBeNull();
  });
});


// REQ-133 R13 — Reply affordance is author-agnostic: "Reply is visible on
// messages as long as onReply is supplied" (docs/specs/s2-replies.md §4 R13).
// Edit/Delete remain own-scoped (REQ-110/112/114). The parent gate in
// MessageList splits responsibilities: owner-only for Edit/Delete,
// everyone-can-see for Reply. Deleted tombstones and in-flight edits
// suppress every affordance.
describe("MessageList action-row gating (REQ-133 R13 / REQ-110 / REQ-112 / REQ-114)", () => {
  const viewerId = "u-viewer";
  const otherId = "u-other";

  it("renders Reply on a message authored by someone else (no Edit, no Delete)", async () => {
    const user = userEvent.setup();
    const fromOther = msg({
      id: "m-other-1",
      authorId: otherId,
      authorUsername: "bob",
      authorName: "Bob",
      body: "hey alice",
    });
    render(
      <MessageList
        messages={[fromOther]}
        hasMoreOlder={false}
        onLoadOlder={() => {}}
        firstItemIndex={0}
        currentUserId={viewerId}
        onReply={vi.fn()}
        onEditMessage={vi.fn()}
        onDeleteMessage={vi.fn()}
      />,
    );
    await user.click(screen.getByTestId("message-actions-toggle"));
    expect(screen.getByTestId("message-reply")).toBeInTheDocument();
    expect(screen.queryByTestId("message-edit")).toBeNull();
    expect(screen.queryByTestId("message-delete")).toBeNull();
  });

  it("renders no action affordance on a deleted tombstone (non-own)", () => {
    const deleted = msg({
      id: "m-dead",
      authorId: otherId,
      deletedAt: "2026-04-19T12:00:00.000Z",
    });
    render(
      <MessageList
        messages={[deleted]}
        hasMoreOlder={false}
        onLoadOlder={() => {}}
        firstItemIndex={0}
        currentUserId={viewerId}
        onReply={vi.fn()}
        onEditMessage={vi.fn()}
        onDeleteMessage={vi.fn()}
      />,
    );
    expect(screen.getByTestId("message-tombstone")).toBeInTheDocument();
    expect(screen.queryByTestId("message-actions-toggle")).toBeNull();
    expect(screen.queryByTestId("message-reply")).toBeNull();
  });

  it("hides every affordance (Reply included) while the viewer's own message is being edited", async () => {
    const user = userEvent.setup();
    const own = msg({
      id: "m-own-edit",
      authorId: viewerId,
      authorUsername: "me",
      authorName: "Me",
      body: "draft",
    });
    render(
      <MessageList
        messages={[own]}
        hasMoreOlder={false}
        onLoadOlder={() => {}}
        firstItemIndex={0}
        currentUserId={viewerId}
        onReply={vi.fn()}
        onEditMessage={vi.fn()}
        onDeleteMessage={vi.fn()}
      />,
    );
    await user.click(screen.getByTestId("message-actions-toggle"));
    await user.click(screen.getByTestId("message-edit"));
    expect(screen.queryByTestId("message-actions-toggle")).toBeNull();
    expect(screen.queryByTestId("message-reply")).toBeNull();
    expect(screen.queryByTestId("message-edit")).toBeNull();
    expect(screen.queryByTestId("message-delete")).toBeNull();
  });

  it("exposes Reply + Edit + Delete on the viewer's own non-deleted message (regression guard)", async () => {
    const user = userEvent.setup();
    const own = msg({
      id: "m-own-full",
      authorId: viewerId,
      authorUsername: "me",
      authorName: "Me",
      body: "mine",
    });
    render(
      <MessageList
        messages={[own]}
        hasMoreOlder={false}
        onLoadOlder={() => {}}
        firstItemIndex={0}
        currentUserId={viewerId}
        onReply={vi.fn()}
        onEditMessage={vi.fn()}
        onDeleteMessage={vi.fn()}
      />,
    );
    await user.click(screen.getByTestId("message-actions-toggle"));
    expect(screen.getByTestId("message-reply")).toBeInTheDocument();
    expect(screen.getByTestId("message-edit")).toBeInTheDocument();
    expect(screen.getByTestId("message-delete")).toBeInTheDocument();
  });
});

// REQ-212 — v3 §2.5.5 grants admins/owners the right to soft-delete other
// members' messages in group rooms. MessageRow must reveal the ⋯ actions
// button on non-own messages when the caller's role is owner/admin AND
// the room is a group chat. DMs (v3 §2.5.1) have no admin concept, so
// the actions button must stay hidden there even for role='owner'.
describe("MessageList admin-delete gate (REQ-212)", () => {
  it("reveals ⋯ actions on a non-own message when viewer is group admin", () => {
    const other = msg({
      id: "m-admin-1",
      authorId: "u-bob",
      authorUsername: "bob",
      body: "bob speaks",
    });
    render(
      <MessageList
        messages={[other]}
        hasMoreOlder={false}
        onLoadOlder={() => {}}
        firstItemIndex={0}
        currentUserId="u-alice"
        currentUserRole="admin"
        roomKind="group"
        onDeleteMessage={async () => {}}
      />,
    );
    expect(screen.getByTestId("message-actions-toggle")).toBeInTheDocument();
  });

  it("reveals ⋯ actions on a non-own message when viewer is group owner", () => {
    const other = msg({
      id: "m-owner-1",
      authorId: "u-bob",
      authorUsername: "bob",
    });
    render(
      <MessageList
        messages={[other]}
        hasMoreOlder={false}
        onLoadOlder={() => {}}
        firstItemIndex={0}
        currentUserId="u-alice"
        currentUserRole="owner"
        roomKind="group"
        onDeleteMessage={async () => {}}
      />,
    );
    expect(screen.getByTestId("message-actions-toggle")).toBeInTheDocument();
  });

  it("hides ⋯ actions on a non-own message when viewer is a plain member", () => {
    const other = msg({ id: "m-mbr-1", authorId: "u-bob" });
    render(
      <MessageList
        messages={[other]}
        hasMoreOlder={false}
        onLoadOlder={() => {}}
        firstItemIndex={0}
        currentUserId="u-alice"
        currentUserRole="member"
        roomKind="group"
        onDeleteMessage={async () => {}}
      />,
    );
    expect(screen.queryByTestId("message-actions-toggle")).toBeNull();
  });

  it("hides ⋯ actions on a non-own message in a DM even when role=owner (no admin concept)", () => {
    const other = msg({ id: "m-dm-1", authorId: "u-bob" });
    render(
      <MessageList
        messages={[other]}
        hasMoreOlder={false}
        onLoadOlder={() => {}}
        firstItemIndex={0}
        currentUserId="u-alice"
        currentUserRole="owner"
        roomKind="dm"
        onDeleteMessage={async () => {}}
      />,
    );
    expect(screen.queryByTestId("message-actions-toggle")).toBeNull();
  });

  it("hides Edit button for admin on non-own message (admins delete only)", async () => {
    const userEvt = (await import("@testing-library/user-event")).default;
    const ue = userEvt.setup();
    const other = msg({ id: "m-adm-edit", authorId: "u-bob" });
    render(
      <MessageList
        messages={[other]}
        hasMoreOlder={false}
        onLoadOlder={() => {}}
        firstItemIndex={0}
        currentUserId="u-alice"
        currentUserRole="admin"
        roomKind="group"
        onEditMessage={async () => {}}
        onDeleteMessage={async () => {}}
      />,
    );
    await ue.click(screen.getByTestId("message-actions-toggle"));
    expect(screen.queryByTestId("message-edit")).toBeNull();
    expect(screen.getByTestId("message-delete")).toBeInTheDocument();
  });

  it("keeps Edit available on own message for author", async () => {
    const userEvt = (await import("@testing-library/user-event")).default;
    const ue = userEvt.setup();
    const own = msg({ id: "m-own", authorId: "u-alice" });
    render(
      <MessageList
        messages={[own]}
        hasMoreOlder={false}
        onLoadOlder={() => {}}
        firstItemIndex={0}
        currentUserId="u-alice"
        currentUserRole="owner"
        roomKind="group"
        onEditMessage={async () => {}}
        onDeleteMessage={async () => {}}
      />,
    );
    await ue.click(screen.getByTestId("message-actions-toggle"));
    expect(screen.getByTestId("message-edit")).toBeInTheDocument();
    expect(screen.getByTestId("message-delete")).toBeInTheDocument();
  });
});
