// REQ-UserSearch §2.4 — NewDmDialog rewrite.
// Binding spec: docs/specs/s3-user-search.md §4 R19–R24.
// Previous userId-input tests are obsolete; the dialog is now a typeahead.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { UserSearchHit } from "@ai-herders/shared/protocol";
import type { DmResult, CreateDmResult } from "@/lib/dms-api";
import { NewDmDialog } from "./NewDmDialog";

const searchUsersMock = vi.fn<(q: string) => Promise<DmResult<UserSearchHit[]>>>();
const createDmMock = vi.fn<(id: string) => Promise<DmResult<CreateDmResult>>>();
const pushMock = vi.fn<(path: string) => void>();

vi.mock("@/lib/dms-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/dms-api")>(
    "@/lib/dms-api",
  );
  return {
    ...actual,
    searchUsers: (q: string) => searchUsersMock(q),
    createDm: (id: string) => createDmMock(id),
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

async function openDialog() {
  const user = userEvent.setup();
  render(<NewDmDialog />);
  await user.click(screen.getByRole("button", { name: /new/i }));
  return user;
}

function hit(overrides: Partial<UserSearchHit> = {}): UserSearchHit {
  return {
    userId: overrides.userId ?? "usr-bob",
    username: overrides.username ?? "bob",
    name: overrides.name ?? "Bob Bobson",
    relationship: overrides.relationship ?? "friend",
  };
}

beforeEach(() => {
  searchUsersMock.mockReset();
  createDmMock.mockReset();
  pushMock.mockReset();
});

describe("REQ-UserSearch §2.4 NewDmDialog R19 — mount + search input", () => {
  it("renders search input with placeholder + empty region", async () => {
    await openDialog();
    const input = screen.getByRole("searchbox", {
      name: /search/i,
    });
    expect(input).toHaveAttribute("placeholder", "Search by name or username");
  });
});

describe("REQ-UserSearch §2.4 NewDmDialog R20 — debounce", () => {
  it("does not fire when q.length < 2", async () => {
    const user = await openDialog();
    const input = screen.getByRole("searchbox", { name: /search/i });
    await user.type(input, "b");
    // No request fires for a single char — give the debounce a full window
    // plus buffer, then assert zero calls.
    await new Promise((r) => setTimeout(r, 400));
    expect(searchUsersMock).not.toHaveBeenCalled();
  });

  it("fires 300ms after last keystroke once q.length ≥ 2", async () => {
    searchUsersMock.mockResolvedValue({ ok: true, data: [hit()] });
    const user = await openDialog();
    const input = screen.getByRole("searchbox", { name: /search/i });
    await user.type(input, "bo");
    // Before 300ms elapse — no call yet.
    expect(searchUsersMock).not.toHaveBeenCalled();
    // After 300ms — exactly one call.
    await waitFor(
      () => {
        expect(searchUsersMock).toHaveBeenCalledTimes(1);
        expect(searchUsersMock).toHaveBeenCalledWith("bo");
      },
      { timeout: 700 },
    );
  });
});

describe("REQ-UserSearch §2.4 NewDmDialog R21 — friend row", () => {
  it("friend → 'Start DM' button creates DM and navigates", async () => {
    searchUsersMock.mockResolvedValue({
      ok: true,
      data: [hit({ relationship: "friend", userId: "usr-bob" })],
    });
    createDmMock.mockResolvedValue({
      ok: true,
      data: {
        roomId: "room-xyz",
        kind: "dm",
        dmPairKey: "pair",
        created: true,
      },
    });
    const user = await openDialog();
    const input = screen.getByRole("searchbox", { name: /search/i });
    await user.type(input, "bob");
    const startBtn = await screen.findByRole("button", { name: /start dm/i });
    await user.click(startBtn);
    await waitFor(() => {
      expect(createDmMock).toHaveBeenCalledWith("usr-bob");
      expect(pushMock).toHaveBeenCalledWith("/rooms/room-xyz");
    });
  });
});

describe("REQ-UserSearch §2.4 NewDmDialog R22 — none row", () => {
  it("none → 'Send friend request' swaps to 'Request sent' on success", async () => {
    searchUsersMock.mockResolvedValue({
      ok: true,
      data: [hit({ relationship: "none", userId: "usr-carol", username: "carol" })],
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "frq-1", status: "pending" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    );
    const user = await openDialog();
    const input = screen.getByRole("searchbox", { name: /search/i });
    await user.type(input, "carol");
    const sendBtn = await screen.findByRole("button", {
      name: /send friend request/i,
    });
    await user.click(sendBtn);
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalled();
      expect(
        screen.getByRole("button", { name: /request sent/i }),
      ).toBeInTheDocument();
    });
    fetchSpy.mockRestore();
  });
});

describe("REQ-UserSearch §2.4 NewDmDialog R23 — outgoing row", () => {
  it("request_outgoing → disabled 'Request sent' button", async () => {
    searchUsersMock.mockResolvedValue({
      ok: true,
      data: [hit({ relationship: "request_outgoing" })],
    });
    const user = await openDialog();
    const input = screen.getByRole("searchbox", { name: /search/i });
    await user.type(input, "bob");
    const btn = await screen.findByRole("button", { name: /request sent/i });
    expect(btn).toBeDisabled();
  });
});

describe("REQ-UserSearch §2.4 NewDmDialog R24 — incoming row", () => {
  it("request_incoming → 'Accept' button routes to /contacts", async () => {
    searchUsersMock.mockResolvedValue({
      ok: true,
      data: [hit({ relationship: "request_incoming" })],
    });
    const user = await openDialog();
    const input = screen.getByRole("searchbox", { name: /search/i });
    await user.type(input, "bob");
    const accept = await screen.findByRole("button", { name: /accept/i });
    await user.click(accept);
    expect(pushMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/contacts/),
    );
  });
});
