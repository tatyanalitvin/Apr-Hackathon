// REQ-214 — v3 §2.7.1 / §4.4 DM unread badges.
// DmList rows render <UnreadBadge count={dm.unreadCount ?? 0} /> when the
// backend-computed unreadCount > 0. Zero or missing hides the badge per
// UnreadBadge's own `count <= 0 → null` contract.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import type { DmListItem } from "@ai-herders/shared/protocol";
import type { DmResult } from "@/lib/dms-api";
import { DmList } from "./DmList";

type ListDmsResult = DmResult<DmListItem[]>;

const listDmsMock = vi.fn<() => Promise<ListDmsResult>>();

vi.mock("@/lib/dms-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/dms-api")>(
    "@/lib/dms-api",
  );
  return {
    ...actual,
    listDms: () => listDmsMock(),
  };
});

vi.mock("@/lib/socket", () => ({
  createChatSocket: () => ({
    on: vi.fn(),
    off: vi.fn(),
    disconnect: vi.fn(),
  }),
}));

// NewDmDialog does its own fetches on mount; stub it away so the
// component tree for DmList under test has no extraneous network calls.
vi.mock("@/components/dm/NewDmDialog", () => ({
  NewDmDialog: () => null,
}));

function buildDm(overrides: Partial<DmListItem>): DmListItem {
  return {
    roomId: overrides.roomId ?? "room-1",
    other: overrides.other ?? {
      userId: "u-bob",
      username: "bob",
      name: "Bob",
      deleted: false,
    },
    lastMessage: overrides.lastMessage ?? null,
    unreadCount: overrides.unreadCount ?? 0,
    frozen: overrides.frozen ?? false,
    frozenReason: overrides.frozenReason ?? null,
  };
}

beforeEach(() => {
  listDmsMock.mockReset();
});

describe("REQ-214 DmList unread badge", () => {
  it("REQ-214: renders UnreadBadge with count when unreadCount > 0", async () => {
    listDmsMock.mockResolvedValue({
      ok: true,
      data: [buildDm({ roomId: "r-ab", unreadCount: 3 })],
    });

    render(<DmList />);

    const badge = await screen.findByLabelText("3 unread");
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent("3");
  });

  it("REQ-214: hides UnreadBadge when unreadCount === 0", async () => {
    listDmsMock.mockResolvedValue({
      ok: true,
      data: [buildDm({ roomId: "r-zero", unreadCount: 0 })],
    });

    render(<DmList />);

    await waitFor(() => {
      expect(screen.getByText("@bob")).toBeInTheDocument();
    });
    expect(screen.queryByLabelText(/unread/i)).not.toBeInTheDocument();
  });

  it("REQ-214: clamps >99 to '99+' (reuses UnreadBadge display rule)", async () => {
    listDmsMock.mockResolvedValue({
      ok: true,
      data: [buildDm({ roomId: "r-huge", unreadCount: 250 })],
    });

    render(<DmList />);

    const badge = await screen.findByLabelText("250 unread");
    expect(badge).toHaveTextContent("99+");
  });

  it("REQ-214: renders per-row badges independently across multiple DMs", async () => {
    listDmsMock.mockResolvedValue({
      ok: true,
      data: [
        buildDm({
          roomId: "r-ab",
          unreadCount: 2,
          other: {
            userId: "u-bob",
            username: "bob",
            name: "Bob",
            deleted: false,
          },
        }),
        buildDm({
          roomId: "r-ac",
          unreadCount: 0,
          other: {
            userId: "u-carol",
            username: "carol",
            name: "Carol",
            deleted: false,
          },
        }),
      ],
    });

    render(<DmList />);

    await waitFor(() => {
      expect(screen.getByText("@bob")).toBeInTheDocument();
      expect(screen.getByText("@carol")).toBeInTheDocument();
    });
    // Only bob's row should have a badge.
    const badges = screen.queryAllByLabelText(/unread/i);
    expect(badges).toHaveLength(1);
    expect(badges[0]).toHaveTextContent("2");
  });
});
