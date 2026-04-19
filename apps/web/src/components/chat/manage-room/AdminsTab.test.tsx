// REQ-210 — AdminsTab visibility.
// Owner viewer → [Remove admin] rendered on admin rows; owner row labelled
//   "(cannot lose admin rights)" with no button.
// Admin viewer → no [Remove admin] buttons at all (server REQ-202 gate is
//   owner-only; UI mirrors it).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import type { ChatAPI, RoomMemberEntry } from "@/lib/chat-api";
import { AdminsTab } from "./AdminsTab";

const listRoomMembersMock = vi.fn<(roomId: string) => Promise<RoomMemberEntry[]>>();

vi.mock("@/lib/socket", () => ({
  createChatApi: (): Partial<ChatAPI> => ({
    listRoomMembers: (...args: [string]) => listRoomMembersMock(...args),
  }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const ROSTER: RoomMemberEntry[] = [
  { id: "u-alice", username: "alice", displayName: "Alice", role: "owner" },
  { id: "u-bob", username: "bob", displayName: "Bob", role: "admin" },
  { id: "u-dave", username: "dave", displayName: "Dave", role: "admin" },
  { id: "u-carol", username: "carol", displayName: "Carol", role: "member" },
];

beforeEach(() => {
  listRoomMembersMock.mockReset();
  listRoomMembersMock.mockResolvedValue(ROSTER);
});

describe("REQ-210 — AdminsTab role-gated demote visibility", () => {
  it("owner viewer sees [Remove admin] on admin rows and 'cannot lose admin rights' label on owner row", async () => {
    render(<AdminsTab roomId="r-1" viewerRole="owner" />);
    await waitFor(() => expect(listRoomMembersMock).toHaveBeenCalled());
    // Admin rows both show demote button.
    expect(screen.getByTestId("demote-bob")).toBeInTheDocument();
    expect(screen.getByTestId("demote-dave")).toBeInTheDocument();
    // Owner row has no button and carries the guard label.
    expect(screen.queryByTestId("demote-alice")).toBeNull();
    expect(screen.getByText(/cannot lose admin rights/i)).toBeInTheDocument();
    // Plain members are filtered out of this tab entirely.
    expect(screen.queryByTestId("admin-row-carol")).toBeNull();
  });

  it("admin viewer sees no demote buttons (server REQ-202 is owner-only)", async () => {
    render(<AdminsTab roomId="r-1" viewerRole="admin" />);
    await waitFor(() => expect(listRoomMembersMock).toHaveBeenCalled());
    expect(screen.queryByTestId("demote-bob")).toBeNull();
    expect(screen.queryByTestId("demote-dave")).toBeNull();
    expect(screen.queryByTestId("demote-alice")).toBeNull();
    // Owner label still visible — belt-and-braces reminder.
    expect(screen.getByText(/cannot lose admin rights/i)).toBeInTheDocument();
  });
});
