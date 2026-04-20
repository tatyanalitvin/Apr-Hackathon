import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AddFriendDialog } from "./AddFriendDialog";

const sendFriendRequestMock = vi.fn();
const searchUsersMock = vi.fn();
const listIncomingMock = vi.fn();
const acceptFriendRequestMock = vi.fn();
const toastSuccess = vi.fn();
const toastError = vi.fn();
const toastInfo = vi.fn();
const toastWarning = vi.fn();

vi.mock("@/lib/friendship-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/friendship-api")>();
  return {
    ...actual,
    sendFriendRequest: (...args: unknown[]) => sendFriendRequestMock(...args),
    listIncomingRequests: (...args: unknown[]) => listIncomingMock(...args),
    acceptFriendRequest: (...args: unknown[]) => acceptFriendRequestMock(...args),
  };
});

vi.mock("@/lib/dms-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/dms-api")>();
  return {
    ...actual,
    searchUsers: (...args: unknown[]) => searchUsersMock(...args),
  };
});

vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
    info: (...args: unknown[]) => toastInfo(...args),
    warning: (...args: unknown[]) => toastWarning(...args),
  },
}));

beforeEach(() => {
  sendFriendRequestMock.mockReset();
  searchUsersMock.mockReset();
  listIncomingMock.mockReset();
  acceptFriendRequestMock.mockReset();
  toastSuccess.mockReset();
  toastError.mockReset();
  toastInfo.mockReset();
  toastWarning.mockReset();
});

async function openDialog() {
  const user = userEvent.setup();
  render(<AddFriendDialog />);
  await user.click(screen.getByRole("button", { name: /^add friend$/i }));
  return user;
}

describe("REQ-051 — AddFriendDialog (directory-search UX)", () => {
  it("searches by query and sends a request on the `none` relationship row", async () => {
    searchUsersMock.mockResolvedValue({
      ok: true,
      data: [{ userId: "u-bob", username: "bob", name: "Bob", relationship: "none" }],
    });
    sendFriendRequestMock.mockResolvedValueOnce({
      ok: true,
      data: { id: "req-1", status: "pending" },
    });

    const user = await openDialog();
    await user.type(screen.getByRole("searchbox", { name: /search users/i }), "bo");

    const sendBtn = await screen.findByRole("button", { name: /send request/i });
    await user.click(sendBtn);

    await waitFor(() => {
      expect(sendFriendRequestMock).toHaveBeenCalledWith({ toUserId: "u-bob" });
    });
    expect(toastSuccess).toHaveBeenCalledWith(expect.stringContaining("@bob"));
  });

  it("renders a disabled 'Already friends' row for friend relationships", async () => {
    searchUsersMock.mockResolvedValue({
      ok: true,
      data: [
        { userId: "u-carol", username: "carol", name: "Carol", relationship: "friend" },
      ],
    });

    const user = await openDialog();
    await user.type(screen.getByRole("searchbox", { name: /search users/i }), "ca");

    const alreadyFriends = await screen.findByRole("button", {
      name: /already friends/i,
    });
    expect(alreadyFriends).toBeDisabled();
    expect(sendFriendRequestMock).not.toHaveBeenCalled();
  });

  it("renders a disabled 'Request sent' row for request_outgoing", async () => {
    searchUsersMock.mockResolvedValue({
      ok: true,
      data: [
        { userId: "u-dan", username: "dan", name: "Dan", relationship: "request_outgoing" },
      ],
    });

    const user = await openDialog();
    await user.type(screen.getByRole("searchbox", { name: /search users/i }), "da");

    const sent = await screen.findByRole("button", { name: /request sent/i });
    expect(sent).toBeDisabled();
  });

  it("shows 'No users match' when the search returns an empty array", async () => {
    searchUsersMock.mockResolvedValue({ ok: true, data: [] });

    const user = await openDialog();
    await user.type(screen.getByRole("searchbox", { name: /search users/i }), "xxx");

    expect(await screen.findByText(/no users match/i)).toBeInTheDocument();
  });

  it("surfaces retry-after minutes on 429 rate_limited branch", async () => {
    searchUsersMock.mockResolvedValue({
      ok: true,
      data: [{ userId: "u-bob", username: "bob", name: "Bob", relationship: "none" }],
    });
    sendFriendRequestMock.mockResolvedValueOnce({
      ok: false,
      error: { code: "rate_limited", status: 429, retryAfterSec: 600 },
    });

    const user = await openDialog();
    await user.type(screen.getByRole("searchbox", { name: /search users/i }), "bo");
    const sendBtn = await screen.findByRole("button", { name: /send request/i });
    await user.click(sendBtn);

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/~10 min/));
    });
  });
});
