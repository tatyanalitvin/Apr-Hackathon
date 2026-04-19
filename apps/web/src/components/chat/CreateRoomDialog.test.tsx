// REQ-022 + REQ-088 — CreateRoomDialog includes description + visibility.
// Description is optional: blank/whitespace-only is OMITTED from the payload
// (keeps the wire clean for the common "no description" case). A non-empty
// trimmed value is sent. Visibility defaults to "public" and toggles to
// "private" via the radio group.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ChatAPI } from "@/lib/chat-api";
import { CreateRoomDialog } from "./CreateRoomDialog";

const createRoomMock = vi.fn<ChatAPI["createRoom"]>();
const pushMock = vi.fn();

vi.mock("@/lib/socket", () => ({
  createChatApi: (): Partial<ChatAPI> => ({
    createRoom: (...args) => createRoomMock(...args),
  }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

beforeEach(() => {
  createRoomMock.mockReset();
  pushMock.mockReset();
  createRoomMock.mockResolvedValue({
    ok: true,
    data: {
      id: "r-new",
      name: "book-club",
      description: null,
      visibility: "public",
      ownerId: "u-1",
      createdAt: "2026-04-20T00:00:00Z",
    },
  });
});

async function openDialog(user: ReturnType<typeof userEvent.setup>) {
  render(<CreateRoomDialog />);
  await user.click(screen.getByRole("button", { name: /new room/i }));
}

describe("REQ-022 CreateRoomDialog description", () => {
  it("omits description when blank", async () => {
    const user = userEvent.setup();
    await openDialog(user);
    await user.type(screen.getByLabelText(/name/i), "book-club");
    await user.click(screen.getByRole("button", { name: /create room/i }));
    expect(createRoomMock).toHaveBeenCalledTimes(1);
    const payload = createRoomMock.mock.calls[0]![0];
    expect(payload).toEqual({ name: "book-club", visibility: "public" });
    expect(payload).not.toHaveProperty("description");
  });

  it("sends trimmed description when filled", async () => {
    const user = userEvent.setup();
    await openDialog(user);
    await user.type(screen.getByLabelText(/name/i), "book-club");
    await user.type(
      screen.getByLabelText(/description/i),
      "   a cozy place for readers   ",
    );
    await user.click(screen.getByRole("button", { name: /create room/i }));
    expect(createRoomMock).toHaveBeenCalledWith({
      name: "book-club",
      description: "a cozy place for readers",
      visibility: "public",
    });
  });

  it("whitespace-only description is treated as blank (not sent)", async () => {
    const user = userEvent.setup();
    await openDialog(user);
    await user.type(screen.getByLabelText(/name/i), "book-club");
    await user.type(screen.getByLabelText(/description/i), "     ");
    await user.click(screen.getByRole("button", { name: /create room/i }));
    const payload = createRoomMock.mock.calls[0]![0];
    expect(payload).not.toHaveProperty("description");
  });
});

describe("REQ-088 CreateRoomDialog visibility", () => {
  it("defaults to public", async () => {
    const user = userEvent.setup();
    await openDialog(user);
    await user.type(screen.getByLabelText(/name/i), "book-club");
    await user.click(screen.getByRole("button", { name: /create room/i }));
    expect(createRoomMock.mock.calls[0]![0].visibility).toBe("public");
  });

  it("sends private when the private radio is selected", async () => {
    const user = userEvent.setup();
    await openDialog(user);
    await user.type(screen.getByLabelText(/name/i), "inner-circle");
    await user.click(screen.getByRole("radio", { name: /private/i }));
    await user.click(screen.getByRole("button", { name: /create room/i }));
    expect(createRoomMock.mock.calls[0]![0].visibility).toBe("private");
  });
});
