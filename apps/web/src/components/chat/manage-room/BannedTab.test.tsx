// REQ-211 — BannedTab render + unban click wiring.
// - Admin/owner viewer: list fetched + rows rendered with [Unban] action.
// - Member viewer (defensive — ManageRoomModal already hides the tab): shows
//   placeholder copy, no fetch.
// - Unban click resolves → toast.success + row removed from state.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  BanListItem,
  ChatAPI,
  ModerationMutationResponse,
} from "@/lib/chat-api";
import { BannedTab } from "./BannedTab";

const listRoomBansMock = vi.fn<(roomId: string) => Promise<BanListItem[]>>();
const unbanMemberMock =
  vi.fn<
    (
      roomId: string,
      userId: string,
    ) => Promise<ModerationMutationResponse<{ unbanned: true }>>
  >();
const toastSuccess = vi.fn();
const toastError = vi.fn();

vi.mock("@/lib/socket", () => ({
  createChatApi: (): Partial<ChatAPI> => ({
    listRoomBans: (...args: [string]) => listRoomBansMock(...args),
    unbanMember: (...args: [string, string]) => unbanMemberMock(...args),
  }),
  createChatSocket: () => ({
    on: vi.fn(),
    off: vi.fn(),
    disconnect: vi.fn(),
  }),
}));

vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}));

const BANS: BanListItem[] = [
  {
    userId: "u-bob",
    username: "bob",
    bannedById: "u-alice",
    bannedByUsername: "alice",
    reason: "spam",
    bannedAt: "2026-04-19T12:00:00.000Z",
  },
  {
    userId: "u-carol",
    username: "carol",
    bannedById: "u-alice",
    bannedByUsername: "alice",
    reason: null,
    bannedAt: "2026-04-19T11:00:00.000Z",
  },
];

beforeEach(() => {
  listRoomBansMock.mockReset();
  unbanMemberMock.mockReset();
  toastSuccess.mockReset();
  toastError.mockReset();
  listRoomBansMock.mockResolvedValue(BANS);
  window.confirm = vi.fn().mockReturnValue(true);
});

describe("REQ-211 — BannedTab admin view + unban", () => {
  it("owner viewer sees ban rows with usernames, banned-by, and unban buttons", async () => {
    render(<BannedTab roomId="r-1" viewerRole="owner" />);
    await waitFor(() => expect(listRoomBansMock).toHaveBeenCalled());
    expect(screen.getByText("@bob")).toBeInTheDocument();
    expect(screen.getByText("@carol")).toBeInTheDocument();
    expect(screen.getByTestId("unban-bob")).toBeInTheDocument();
    expect(screen.getByTestId("unban-carol")).toBeInTheDocument();
    expect(screen.getByText("spam")).toBeInTheDocument();
  });

  it("unban click confirms, calls API, removes the row, and shows success toast", async () => {
    // REQ-211 — the row-level [Unban] button now opens a shadcn Dialog
    // (UnbanConfirmDialog) instead of using window.confirm. Click sequence is
    // row-trigger → confirm-button (data-testid="unban-confirm-<username>").
    unbanMemberMock.mockResolvedValueOnce({ ok: true, data: { unbanned: true } });
    const user = userEvent.setup();
    render(<BannedTab roomId="r-1" viewerRole="admin" />);
    await waitFor(() => expect(listRoomBansMock).toHaveBeenCalled());
    await user.click(screen.getByTestId("unban-bob"));
    await user.click(await screen.findByTestId("unban-confirm-bob"));
    await waitFor(() =>
      expect(unbanMemberMock).toHaveBeenCalledWith("r-1", "u-bob"),
    );
    expect(toastSuccess).toHaveBeenCalledWith(expect.stringContaining("@bob"));
    await waitFor(() => expect(screen.queryByTestId("ban-row-bob")).toBeNull());
    // Other row still present.
    expect(screen.getByTestId("ban-row-carol")).toBeInTheDocument();
  });

  it("plain-member viewer sees the admin-only placeholder and never fetches", () => {
    render(<BannedTab roomId="r-1" viewerRole="member" />);
    expect(screen.getByText(/only admins can view/i)).toBeInTheDocument();
    expect(listRoomBansMock).not.toHaveBeenCalled();
  });
});
