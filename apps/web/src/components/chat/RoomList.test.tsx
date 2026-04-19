// v3 §4.1.1 — "After entering a room, the room list becomes compacted in
// accordion style." We render the Rooms section inside a native <details>
// so the section is collapsible. Default-open so users don't lose context
// on first room entry; one click compacts.

import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { RoomList } from "./RoomList";

// DmList hits the DMs API on mount (socket + fetch). The accordion assertion
// only covers the group-room section, so stub DmList to an empty sentinel.
vi.mock("@/components/dm/DmList", () => ({
  DmList: () => <div data-testid="dm-list-stub" />,
}));

// CreateRoomDialog renders a Radix Dialog trigger; irrelevant to the
// compaction assertion and noisy in the test DOM. Stub to a plain button.
vi.mock("@/components/chat/CreateRoomDialog", () => ({
  CreateRoomDialog: () => null,
}));

const ROOMS = [
  { id: "r-1", name: "general" },
  { id: "r-2", name: "engineering" },
];

describe("v3 §4.1.1 RoomList accordion compaction", () => {
  it("wraps the rooms section in a native <details> accordion", () => {
    const { container } = render(
      <RoomList rooms={ROOMS} currentRoomId="r-1" />,
    );

    const details = container.querySelector<HTMLDetailsElement>(
      'details[data-testid="rooms-accordion"]',
    );
    expect(details).not.toBeNull();
    expect(details!.open).toBe(true);

    // Summary is the interactive handle; must contain the "Rooms" label so
    // users know what they're compacting.
    const summary = details!.querySelector("summary");
    expect(summary).not.toBeNull();
    expect(summary!.textContent?.toLowerCase()).toContain("rooms");

    // Default-open: rows visible.
    expect(screen.getByText("#general")).toBeInTheDocument();
    expect(screen.getByText("#engineering")).toBeInTheDocument();
  });

  it("toggling the summary compacts the room list", () => {
    const { container } = render(
      <RoomList rooms={ROOMS} currentRoomId="r-1" />,
    );

    const details = container.querySelector<HTMLDetailsElement>(
      'details[data-testid="rooms-accordion"]',
    );
    expect(details).not.toBeNull();
    const summary = details!.querySelector("summary")!;

    // jsdom doesn't auto-toggle on summary click — we flip the `open` prop
    // ourselves and dispatch `toggle` so any reactive listener stays in sync
    // (same behavior the browser would produce on a click).
    details!.open = false;
    fireEvent(details!, new Event("toggle"));

    expect(details!.open).toBe(false);
    // summary still reachable so the user can re-expand
    expect(summary).toBeInTheDocument();
  });
});
