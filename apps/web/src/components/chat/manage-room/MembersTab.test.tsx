// REQ-209 — MembersTab role-gated action visibility matrix.
// Member viewer → no action buttons anywhere.
// Admin viewer → [Ban]+[Remove] only on plain-member rows (not admin/owner).
// Owner viewer → [Make admin] on member rows; [Ban]+[Remove] on member+admin
//   rows; no buttons on own owner row.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import type { ChatAPI, RoomMemberEntry } from "@/lib/chat-api";
import { MembersTab } from "./MembersTab";

const listRoomMembersMock = vi.fn<(roomId: string) => Promise<RoomMemberEntry[]>>();
const useSessionMock = vi.fn();

vi.mock("@/lib/socket", () => ({
  createChatApi: (): Partial<ChatAPI> => ({
    listRoomMembers: (...args: [string]) => listRoomMembersMock(...args),
  }),
}));

vi.mock("@/lib/auth-client", () => ({
  useSession: () => useSessionMock(),
}));

vi.mock("@/components/chat/PresencePill", () => ({
  PresencePill: () => <span data-testid="presence-pill" />,
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const ROSTER: RoomMemberEntry[] = [
  { id: "u-alice", username: "alice", displayName: "Alice", role: "owner" },
  { id: "u-bob", username: "bob", displayName: "Bob", role: "admin" },
  { id: "u-carol", username: "carol", displayName: "Carol", role: "member" },
];

beforeEach(() => {
  listRoomMembersMock.mockReset();
  listRoomMembersMock.mockResolvedValue(ROSTER);
});

async function renderAs(viewerRole: "owner" | "admin" | "member", selfId: string) {
  useSessionMock.mockReturnValue({ data: { user: { id: selfId } } });
  render(<MembersTab roomId="r-1" roomName="general" viewerRole={viewerRole} />);
  await waitFor(() => expect(listRoomMembersMock).toHaveBeenCalled());
}

describe("REQ-209 — MembersTab role-gated action buttons", () => {
  it("plain-member viewer sees no action buttons on any row", async () => {
    await renderAs("member", "u-carol");
    expect(screen.queryByTestId("promote-alice")).toBeNull();
    expect(screen.queryByTestId("promote-bob")).toBeNull();
    expect(screen.queryByTestId("promote-carol")).toBeNull();
    expect(screen.queryByTestId("kick-alice")).toBeNull();
    expect(screen.queryByTestId("kick-bob")).toBeNull();
    expect(screen.queryByTestId("kick-carol")).toBeNull();
    expect(screen.queryByTestId("ban-carol")).toBeNull();
  });

  it("admin viewer sees [Ban]+[Remove] only on plain-member rows, never on admin or owner", async () => {
    await renderAs("admin", "u-bob");
    // owner row — no buttons
    expect(screen.queryByTestId("kick-alice")).toBeNull();
    expect(screen.queryByTestId("ban-alice")).toBeNull();
    // other admin row — REQ-203 blocks admin-vs-admin → hide client-side too
    expect(screen.queryByTestId("kick-bob")).toBeNull();
    expect(screen.queryByTestId("ban-bob")).toBeNull();
    // member row — show ban + kick; promote is owner-only
    expect(screen.getByTestId("kick-carol")).toBeInTheDocument();
    expect(screen.getByTestId("ban-carol")).toBeInTheDocument();
    expect(screen.queryByTestId("promote-carol")).toBeNull();
  });

  it("owner viewer sees [Make admin] on member rows and [Ban]+[Remove] on both member and admin rows; own row has none", async () => {
    await renderAs("owner", "u-alice");
    // own owner row — no buttons
    expect(screen.queryByTestId("kick-alice")).toBeNull();
    expect(screen.queryByTestId("ban-alice")).toBeNull();
    expect(screen.queryByTestId("promote-alice")).toBeNull();
    // admin row — ban + kick, no promote (already admin)
    expect(screen.getByTestId("kick-bob")).toBeInTheDocument();
    expect(screen.getByTestId("ban-bob")).toBeInTheDocument();
    expect(screen.queryByTestId("promote-bob")).toBeNull();
    // member row — all three actions
    expect(screen.getByTestId("promote-carol")).toBeInTheDocument();
    expect(screen.getByTestId("ban-carol")).toBeInTheDocument();
    expect(screen.getByTestId("kick-carol")).toBeInTheDocument();
  });
});
