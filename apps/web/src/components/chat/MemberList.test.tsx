// REQ-215 — v3 §2.2.1 / Appendix A presence suffix on member rows.
// MemberList appends a small "(AFK)" marker for away users and "(offline)"
// for offline users beside the displayName. Online members show no suffix.
// Source of truth is the `usePresence(userId)` hook — the same hook that
// drives the PresencePill color dot.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { MemberListItem } from "./MemberList";
import { MemberList } from "./MemberList";
import { presenceStore } from "@/lib/presence-store";

// useSession() → current-user id; irrelevant here beyond "not any of the
// test ids" so Add-friend renders. Returning a stable id keeps the tree.
vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({ data: { user: { id: "u-self" } } }),
}));

// AddFriendButton fetches friendship state on mount — stub it so presence
// suffix assertions don't race with friendship-api network activity.
vi.mock("@/components/contacts/AddFriendButton", () => ({
  AddFriendButton: () => null,
}));

const ONLINE_MEMBER: MemberListItem = {
  id: "u-online",
  username: "online_user",
  displayName: "Online User",
};
const AWAY_MEMBER: MemberListItem = {
  id: "u-away",
  username: "away_user",
  displayName: "Away User",
};
const OFFLINE_MEMBER: MemberListItem = {
  id: "u-offline",
  username: "offline_user",
  displayName: "Offline User",
};
const MEMBERS: MemberListItem[] = [ONLINE_MEMBER, AWAY_MEMBER, OFFLINE_MEMBER];

beforeEach(() => {
  // Reset the module-level store between tests so a stale state from a
  // previous test doesn't bleed through via presenceStore.apply below.
  presenceStore.apply({
    type: "presence.changed",
    userId: "u-online",
    state: "offline",
    updatedAt: new Date().toISOString(),
  });
  presenceStore.apply({
    type: "presence.changed",
    userId: "u-away",
    state: "offline",
    updatedAt: new Date().toISOString(),
  });
  presenceStore.apply({
    type: "presence.changed",
    userId: "u-offline",
    state: "offline",
    updatedAt: new Date().toISOString(),
  });
});

describe("REQ-215 MemberList presence suffix", () => {
  it("REQ-215: renders no suffix for online members", () => {
    presenceStore.apply({
      type: "presence.changed",
      userId: "u-online",
      state: "online",
      updatedAt: new Date().toISOString(),
    });

    render(<MemberList members={[ONLINE_MEMBER]} />);

    expect(screen.getByText("Online User")).toBeInTheDocument();
    expect(screen.queryByText(/\(AFK\)/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/\(offline\)/i)).not.toBeInTheDocument();
  });

  it("REQ-215: renders '(AFK)' suffix for away members", () => {
    presenceStore.apply({
      type: "presence.changed",
      userId: "u-away",
      state: "away",
      updatedAt: new Date().toISOString(),
    });

    render(<MemberList members={[AWAY_MEMBER]} />);

    expect(screen.getByText("Away User")).toBeInTheDocument();
    expect(screen.getByText(/\(AFK\)/)).toBeInTheDocument();
  });

  it("REQ-215: renders '(offline)' suffix for offline members", () => {
    // presenceStore default is "offline", no apply needed.
    render(<MemberList members={[OFFLINE_MEMBER]} />);

    expect(screen.getByText("Offline User")).toBeInTheDocument();
    expect(screen.getByText(/\(offline\)/)).toBeInTheDocument();
  });

  it("REQ-215: mixed presence — each row gets its own suffix", () => {
    presenceStore.apply({
      type: "presence.changed",
      userId: "u-online",
      state: "online",
      updatedAt: new Date().toISOString(),
    });
    presenceStore.apply({
      type: "presence.changed",
      userId: "u-away",
      state: "away",
      updatedAt: new Date().toISOString(),
    });

    render(<MemberList members={MEMBERS} />);

    // One AFK, one offline, zero suffixes for the online row.
    expect(screen.getAllByText(/\(AFK\)/)).toHaveLength(1);
    expect(screen.getAllByText(/\(offline\)/)).toHaveLength(1);
  });
});
