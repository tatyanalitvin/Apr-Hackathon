// REQ-053 — unit tests for the session-scoped blocklist cache used by
// `AddFriendButton` and friends-dialog rows. The module holds three
// module-level `let` bindings (cache, inflight, listeners), so each test
// resets the module registry via `vi.resetModules()` and re-imports to
// start from a clean state. `./friendship-api` is mocked so no network
// call is made.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { BlockedUser, Result } from "./friendship-api";

type ListBlockedUsers = () => Promise<Result<BlockedUser[]>>;

function user(id: string, overrides: Partial<BlockedUser> = {}): BlockedUser {
  return {
    userId: id,
    username: id,
    name: id,
    blockedAt: "2026-04-20T00:00:00.000Z",
    ...overrides,
  };
}

function okResult(users: BlockedUser[]): Result<BlockedUser[]> {
  return { ok: true, data: users };
}

function errResult(): Result<BlockedUser[]> {
  return { ok: false, error: { code: "unknown", status: 500 } };
}

// Defer `listBlockedUsers` via a closure we swap per test. Must be set
// BEFORE the module under test is dynamically imported, because the
// module holds a stale reference otherwise.
let listBlockedUsersImpl: ListBlockedUsers = async () => okResult([]);

vi.mock("./friendship-api", () => ({
  listBlockedUsers: () => listBlockedUsersImpl(),
}));

async function freshImport() {
  vi.resetModules();
  return await import("./use-my-blocks");
}

beforeEach(() => {
  listBlockedUsersImpl = async () => okResult([]);
});

describe("use-my-blocks module-level cache (REQ-053)", () => {
  it("refreshMyBlocks() returns the caller's blocked ids as a Set", async () => {
    listBlockedUsersImpl = async () => okResult([user("u1"), user("u2")]);
    const mod = await freshImport();
    const ids = await mod.refreshMyBlocks();
    expect(ids).toBeInstanceOf(Set);
    expect([...ids].sort()).toEqual(["u1", "u2"]);
  });

  it("populates the cache: a second refresh without invalidation hits cache", async () => {
    const fetcher = vi.fn<ListBlockedUsers>(async () => okResult([user("u1")]));
    listBlockedUsersImpl = fetcher;
    const mod = await freshImport();

    await mod.refreshMyBlocks(); // populates
    // Calling refreshMyBlocks again DOES invalidate + refetch (that's the
    // whole point of the primitive). But the internal fetchOnce path reads
    // from cache on subsequent callers — cover that via the hook.
    const { result } = renderHook(() => mod.useMyBlockedUserIds());
    // After mount, cache is already populated — the hook returns the Set
    // synchronously from the initial useState.
    expect(result.current).toBeInstanceOf(Set);
    expect([...(result.current as Set<string>)]).toEqual(["u1"]);
    // Fetcher was called exactly once (by the explicit refreshMyBlocks).
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("dedups concurrent first-time hook mounts onto a single inflight fetch", async () => {
    // Two hooks mounting in the same tick with no populated cache must
    // share one underlying `listBlockedUsers` call — this is what the
    // internal `fetchOnce` inflight guard exists for (per-row
    // AddFriendButton would otherwise fan out N calls).
    let resolveFetch!: (r: Result<BlockedUser[]>) => void;
    const fetcher = vi.fn<ListBlockedUsers>(
      () =>
        new Promise<Result<BlockedUser[]>>((r) => {
          resolveFetch = r;
        }),
    );
    listBlockedUsersImpl = fetcher;
    const mod = await freshImport();

    const a = renderHook(() => mod.useMyBlockedUserIds());
    const b = renderHook(() => mod.useMyBlockedUserIds());
    expect(a.result.current).toBeNull();
    expect(b.result.current).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFetch(okResult([user("u1")]));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect([...(a.result.current as Set<string>)]).toEqual(["u1"]);
    expect([...(b.result.current as Set<string>)]).toEqual(["u1"]);
  });

  it("maps a non-ok API response to an empty Set (does not throw)", async () => {
    listBlockedUsersImpl = async () => errResult();
    const mod = await freshImport();
    const ids = await mod.refreshMyBlocks();
    expect(ids).toBeInstanceOf(Set);
    expect(ids.size).toBe(0);
  });

  it("refreshMyBlocks() drops both cache and inflight, then refetches", async () => {
    const fetcher = vi
      .fn<ListBlockedUsers>()
      .mockImplementationOnce(async () => okResult([user("u1")]))
      .mockImplementationOnce(async () => okResult([user("u2"), user("u3")]));
    listBlockedUsersImpl = fetcher;
    const mod = await freshImport();

    const first = await mod.refreshMyBlocks();
    expect([...first]).toEqual(["u1"]);

    const second = await mod.refreshMyBlocks();
    expect([...second].sort()).toEqual(["u2", "u3"]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe("use-my-blocks hook fan-out (REQ-053)", () => {
  it("useMyBlockedUserIds returns null before resolution, then the Set", async () => {
    let resolveFetch!: (r: Result<BlockedUser[]>) => void;
    listBlockedUsersImpl = () =>
      new Promise<Result<BlockedUser[]>>((r) => {
        resolveFetch = r;
      });
    const mod = await freshImport();

    const { result } = renderHook(() => mod.useMyBlockedUserIds());
    expect(result.current).toBeNull();

    await act(async () => {
      resolveFetch(okResult([user("u1")]));
      // flush microtasks
      await Promise.resolve();
    });

    expect(result.current).toBeInstanceOf(Set);
    expect([...(result.current as Set<string>)]).toEqual(["u1"]);
  });

  it("listener added mid-flight still receives fan-out when the fetch settles", async () => {
    let resolveFetch!: (r: Result<BlockedUser[]>) => void;
    listBlockedUsersImpl = () =>
      new Promise<Result<BlockedUser[]>>((r) => {
        resolveFetch = r;
      });
    const mod = await freshImport();

    // Kick off the populating fetch.
    const pending = mod.refreshMyBlocks();
    // Mount the hook after the fetch is already inflight. The hook
    // registers its listener and, because cache is still null, awaits
    // `fetchOnce` which returns the same inflight promise.
    const { result } = renderHook(() => mod.useMyBlockedUserIds());
    expect(result.current).toBeNull();

    await act(async () => {
      resolveFetch(okResult([user("u1"), user("u2")]));
      await pending;
    });

    expect(result.current).toBeInstanceOf(Set);
    expect([...(result.current as Set<string>)].sort()).toEqual(["u1", "u2"]);
  });

  it("multiple mounted hooks all receive the fan-out from a refresh", async () => {
    listBlockedUsersImpl = async () => okResult([user("u1")]);
    const mod = await freshImport();

    const a = renderHook(() => mod.useMyBlockedUserIds());
    const b = renderHook(() => mod.useMyBlockedUserIds());

    // Allow the initial populating fetch's microtasks to flush.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect([...(a.result.current as Set<string>)]).toEqual(["u1"]);
    expect([...(b.result.current as Set<string>)]).toEqual(["u1"]);

    // Now a refresh should fan out to BOTH listeners.
    listBlockedUsersImpl = async () => okResult([user("u2"), user("u3")]);
    await act(async () => {
      await mod.refreshMyBlocks();
    });

    expect([...(a.result.current as Set<string>)].sort()).toEqual(["u2", "u3"]);
    expect([...(b.result.current as Set<string>)].sort()).toEqual(["u2", "u3"]);
  });

  it("unmount removes the listener — subsequent refresh does not update it", async () => {
    listBlockedUsersImpl = async () => okResult([user("u1")]);
    const mod = await freshImport();

    const { result, unmount } = renderHook(() => mod.useMyBlockedUserIds());

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const snapshot = result.current;
    expect(snapshot).toBeInstanceOf(Set);

    unmount();

    // A post-unmount refresh must not crash (no setState-on-unmounted
    // warnings — React would throw in strict-react harness otherwise) and
    // must not mutate the already-captured snapshot reference.
    listBlockedUsersImpl = async () => okResult([user("u2")]);
    await act(async () => {
      await mod.refreshMyBlocks();
    });

    // The captured snapshot is still the u1 Set — unmounted hook stopped
    // receiving fan-out.
    expect([...(snapshot as Set<string>)]).toEqual(["u1"]);
  });
});
