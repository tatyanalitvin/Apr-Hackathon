// REQ-022 / REQ-087 / REQ-088 — owner-view SettingsTab.
// Prefills description + visibility from listMyRooms, then diffs on save so
// the PATCH only carries changed fields (stays under the 10/hr rename bucket
// on no-op resubmits).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ChatAPI, MyRoomSummary } from "@/lib/chat-api";
import { SettingsTab } from "./SettingsTab";

const listMyRoomsMock = vi.fn<() => Promise<MyRoomSummary[]>>();
const updateRoomMock = vi.fn<ChatAPI["updateRoom"]>();
const pushMock = vi.fn();

vi.mock("@/lib/socket", () => ({
  createChatApi: (): Partial<ChatAPI> => ({
    listMyRooms: () => listMyRoomsMock(),
    updateRoom: (...args) => updateRoomMock(...args),
  }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const ROOM_ID = "r-1";

function makeRoom(overrides: Partial<MyRoomSummary> = {}): MyRoomSummary {
  return {
    id: ROOM_ID,
    name: "general",
    kind: "group",
    visibility: "public",
    description: "cozy place",
    lastReadSeq: "0",
    roomHeadSeq: "0",
    mutedUntil: null,
    ...overrides,
  };
}

beforeEach(() => {
  listMyRoomsMock.mockReset();
  updateRoomMock.mockReset();
  pushMock.mockReset();
});

async function renderOwner(initial: MyRoomSummary) {
  listMyRoomsMock.mockResolvedValue([initial]);
  render(
    <SettingsTab
      roomId={ROOM_ID}
      roomName={initial.name}
      role="owner"
      open
      onClose={vi.fn()}
    />,
  );
  await waitFor(() => {
    const ta = screen.getByLabelText(/description/i) as HTMLTextAreaElement;
    expect(ta.value).toBe(initial.description ?? "");
  });
}

describe("REQ-022 SettingsTab description prefill + diff", () => {
  it("prefills the description from listMyRooms", async () => {
    await renderOwner(makeRoom({ description: "cozy place" }));
    const ta = screen.getByLabelText(/description/i) as HTMLTextAreaElement;
    expect(ta.value).toBe("cozy place");
  });

  it("sends only the changed description (name + visibility unchanged)", async () => {
    const user = userEvent.setup();
    await renderOwner(makeRoom({ description: "cozy place" }));
    updateRoomMock.mockResolvedValue({
      ok: true,
      data: {
        id: ROOM_ID,
        name: "general",
        description: "brand new",
        visibility: "public",
        ownerId: "u-1",
        createdAt: "2026-04-20T00:00:00Z",
      },
    });
    const ta = screen.getByLabelText(/description/i);
    await user.clear(ta);
    await user.type(ta, "brand new");
    await user.click(screen.getByRole("button", { name: /save/i }));
    expect(updateRoomMock).toHaveBeenCalledWith(ROOM_ID, {
      description: "brand new",
    });
  });

  it("clearing the description sends description: null", async () => {
    const user = userEvent.setup();
    await renderOwner(makeRoom({ description: "cozy place" }));
    updateRoomMock.mockResolvedValue({
      ok: true,
      data: {
        id: ROOM_ID,
        name: "general",
        description: null,
        visibility: "public",
        ownerId: "u-1",
        createdAt: "2026-04-20T00:00:00Z",
      },
    });
    await user.clear(screen.getByLabelText(/description/i));
    await user.click(screen.getByRole("button", { name: /save/i }));
    expect(updateRoomMock).toHaveBeenCalledWith(ROOM_ID, { description: null });
  });
});

describe("REQ-088 SettingsTab visibility diff", () => {
  it("prefills visibility from listMyRooms", async () => {
    await renderOwner(makeRoom({ visibility: "private" }));
    const privateRadio = screen.getByRole("radio", { name: /private/i }) as HTMLInputElement;
    expect(privateRadio.checked).toBe(true);
  });

  it("sends only visibility when that's all that changed", async () => {
    const user = userEvent.setup();
    await renderOwner(makeRoom({ visibility: "public", description: "cozy place" }));
    updateRoomMock.mockResolvedValue({
      ok: true,
      data: {
        id: ROOM_ID,
        name: "general",
        description: "cozy place",
        visibility: "private",
        ownerId: "u-1",
        createdAt: "2026-04-20T00:00:00Z",
      },
    });
    await user.click(screen.getByRole("radio", { name: /private/i }));
    await user.click(screen.getByRole("button", { name: /save/i }));
    expect(updateRoomMock).toHaveBeenCalledWith(ROOM_ID, { visibility: "private" });
  });
});

describe("REQ-087 SettingsTab no-op save", () => {
  it("does not call updateRoom when nothing changed", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    listMyRoomsMock.mockResolvedValue([makeRoom({ description: "cozy place" })]);
    render(
      <SettingsTab
        roomId={ROOM_ID}
        roomName="general"
        role="owner"
        open
        onClose={onClose}
      />,
    );
    await waitFor(() => {
      const ta = screen.getByLabelText(/description/i) as HTMLTextAreaElement;
      expect(ta.value).toBe("cozy place");
    });
    await user.click(screen.getByRole("button", { name: /save/i }));
    expect(updateRoomMock).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("sends name + description + visibility when all three change", async () => {
    const user = userEvent.setup();
    await renderOwner(makeRoom({ description: "cozy place", visibility: "public" }));
    updateRoomMock.mockResolvedValue({
      ok: true,
      data: {
        id: ROOM_ID,
        name: "general-v2",
        description: "new desc",
        visibility: "private",
        ownerId: "u-1",
        createdAt: "2026-04-20T00:00:00Z",
      },
    });
    const nameInput = screen.getByLabelText(/room name/i);
    await user.clear(nameInput);
    await user.type(nameInput, "general-v2");
    const descArea = screen.getByLabelText(/description/i);
    await user.clear(descArea);
    await user.type(descArea, "new desc");
    await user.click(screen.getByRole("radio", { name: /private/i }));
    await user.click(screen.getByRole("button", { name: /save/i }));
    expect(updateRoomMock).toHaveBeenCalledWith(ROOM_ID, {
      name: "general-v2",
      description: "new desc",
      visibility: "private",
    });
  });
});
