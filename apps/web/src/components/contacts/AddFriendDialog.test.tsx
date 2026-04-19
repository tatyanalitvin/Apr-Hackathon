import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AddFriendDialog } from "./AddFriendDialog";

const sendFriendRequestMock = vi.fn();
const toastSuccess = vi.fn();
const toastError = vi.fn();
const toastInfo = vi.fn();
const toastWarning = vi.fn();

vi.mock("@/lib/friendship-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/friendship-api")>();
  return {
    ...actual,
    sendFriendRequest: (...args: unknown[]) => sendFriendRequestMock(...args),
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

describe("REQ-051 — AddFriendDialog submit branches", () => {
  it("submits the toUsername branch on valid input and shows success toast", async () => {
    sendFriendRequestMock.mockResolvedValueOnce({
      ok: true,
      data: { id: "req-1", status: "pending" },
    });
    const user = await openDialog();
    await user.type(screen.getByLabelText("Username"), "bob");
    await user.click(screen.getByRole("button", { name: /send request/i }));
    await waitFor(() => {
      expect(sendFriendRequestMock).toHaveBeenCalledWith({ toUsername: "bob" });
    });
    expect(toastSuccess).toHaveBeenCalledWith(
      expect.stringContaining("@bob"),
    );
  });

  it("includes the optional message when provided", async () => {
    sendFriendRequestMock.mockResolvedValueOnce({
      ok: true,
      data: { id: "req-1", status: "pending" },
    });
    const user = await openDialog();
    await user.type(screen.getByLabelText("Username"), "bob");
    await user.type(screen.getByLabelText(/message/i), "hi there");
    await user.click(screen.getByRole("button", { name: /send request/i }));
    await waitFor(() => {
      expect(sendFriendRequestMock).toHaveBeenCalledWith({
        toUsername: "bob",
        message: "hi there",
      });
    });
  });

  it("blocks submit and shows inline error for too-short usernames", async () => {
    const user = await openDialog();
    await user.type(screen.getByLabelText("Username"), "ab");
    await user.click(screen.getByRole("button", { name: /send request/i }));
    expect(sendFriendRequestMock).not.toHaveBeenCalled();
    expect(
      screen.getByText(/username must be 3.*32 characters/i),
    ).toBeInTheDocument();
  });

  it("blocks submit and shows inline error for invalid characters", async () => {
    const user = await openDialog();
    await user.type(screen.getByLabelText("Username"), "bob!");
    await user.click(screen.getByRole("button", { name: /send request/i }));
    expect(sendFriendRequestMock).not.toHaveBeenCalled();
    expect(
      screen.getByText(/letters, digits, and underscore only/i),
    ).toBeInTheDocument();
  });

  it("shows info toast on 409 already_friends branch", async () => {
    sendFriendRequestMock.mockResolvedValueOnce({
      ok: false,
      error: { code: "already_friends", status: 409 },
    });
    const user = await openDialog();
    await user.type(screen.getByLabelText("Username"), "bob");
    await user.click(screen.getByRole("button", { name: /send request/i }));
    await waitFor(() => {
      expect(toastInfo).toHaveBeenCalledWith(
        expect.stringMatching(/already friends/i),
      );
    });
  });

  it("shows warning toast on 409 request_declined branch", async () => {
    sendFriendRequestMock.mockResolvedValueOnce({
      ok: false,
      error: { code: "request_declined", status: 409 },
    });
    const user = await openDialog();
    await user.type(screen.getByLabelText("Username"), "bob");
    await user.click(screen.getByRole("button", { name: /send request/i }));
    await waitFor(() => {
      expect(toastWarning).toHaveBeenCalledWith(
        expect.stringMatching(/declined/i),
      );
    });
  });

  it("surfaces retry-after minutes on 429 rate_limited branch", async () => {
    sendFriendRequestMock.mockResolvedValueOnce({
      ok: false,
      error: { code: "rate_limited", status: 429, retryAfterSec: 600 },
    });
    const user = await openDialog();
    await user.type(screen.getByLabelText("Username"), "bob");
    await user.click(screen.getByRole("button", { name: /send request/i }));
    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith(
        expect.stringMatching(/~10 min/),
      );
    });
  });
});
