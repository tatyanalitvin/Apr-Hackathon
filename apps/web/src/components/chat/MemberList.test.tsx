// REQ-215 — v3 §2.2.1 / Appendix A presence affordance on member rows.
// Round-3 UX pass: the per-row "(AFK)"/"(offline)" text suffix was dropped
// in favour of the pill colour dot + glass group headers above each
// presence bucket. The aria-label on <PresencePill> preserves the screen-
// reader affordance REQ-215 requires. These tests pin that contract.
//
// Source of truth for presence state is the `usePresence(userId)` hook
// — the same hook that drives the PresencePill color dot.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { MemberListItem } from "./MemberList";
import { MemberList } from "./MemberList";
import { presenceStore } from "@/lib/presence-store";

// Round-3 — Offline group is collapsed by default (see DEFAULT_COLLAPSED in
// MemberList.tsx) because large rooms are dominated by offline members.
// Tests that need offline rows rendered expand the bucket by clicking its
// group header, which is exactly what a user does.
function expandOfflineGroup() {
  fireEvent.click(screen.getByRole("button", { name: /Offline/i }));
}

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

describe("REQ-215 MemberList presence affordance (dot + group header)", () => {
  it("REQ-215: renders no legacy suffix text for any state", () => {
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
    expandOfflineGroup();

    // Previously the roster rendered "(AFK)" / "(offline)" beside the name.
    // Those are dropped in favour of the group header + pill colour dot.
    expect(screen.queryByText(/\(AFK\)/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/\(offline\)/i)).not.toBeInTheDocument();
    // All three names still render.
    expect(screen.getByText("Online User")).toBeInTheDocument();
    expect(screen.getByText("Away User")).toBeInTheDocument();
    expect(screen.getByText("Offline User")).toBeInTheDocument();
  });

  it("REQ-215: PresencePill aria-label carries the state for each row", () => {
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
    expandOfflineGroup();

    // Screen readers still get the presence state via the pill's aria-label.
    expect(screen.getAllByLabelText("online")).toHaveLength(1);
    expect(screen.getAllByLabelText("away")).toHaveLength(1);
    expect(screen.getAllByLabelText("offline")).toHaveLength(1);
  });

  it("Round-3: renders a group header per non-empty presence bucket", () => {
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

    // Group headers render "Online", "Away", "Offline" above their sections.
    expect(screen.getByText("Online")).toBeInTheDocument();
    expect(screen.getByText("Away")).toBeInTheDocument();
    expect(screen.getByText("Offline")).toBeInTheDocument();
  });

  it("Round-3: Offline group is collapsed by default; clicking toggles rows", () => {
    presenceStore.apply({
      type: "presence.changed",
      userId: "u-online",
      state: "online",
      updatedAt: new Date().toISOString(),
    });

    render(<MemberList members={MEMBERS} />);

    const offlineHeader = screen.getByRole("button", { name: /Offline/i });

    // Default: Offline is collapsed → aria-expanded=false, no offline row rendered.
    expect(offlineHeader).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Offline User")).not.toBeInTheDocument();

    // Click to expand → row now renders; header flips to expanded.
    fireEvent.click(offlineHeader);
    expect(offlineHeader).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Offline User")).toBeInTheDocument();

    // Click again to collapse → row removed again.
    fireEvent.click(offlineHeader);
    expect(offlineHeader).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Offline User")).not.toBeInTheDocument();
  });

  it("Round-3: Online group is expanded by default", () => {
    presenceStore.apply({
      type: "presence.changed",
      userId: "u-online",
      state: "online",
      updatedAt: new Date().toISOString(),
    });

    render(<MemberList members={MEMBERS} />);

    const onlineHeader = screen.getByRole("button", { name: /Online/i });
    expect(onlineHeader).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Online User")).toBeInTheDocument();
  });
});
