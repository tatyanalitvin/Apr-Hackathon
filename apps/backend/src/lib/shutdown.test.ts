import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";

import { createShutdownHandler } from "./shutdown";

// S4-hardening — graceful shutdown. The Fastify app binds socket.io, the
// @fastify/rate-limit Redis client, a shared ioredis, and a Postgres pool;
// all are torn down by `onClose` hooks that need a few hundred ms of async
// work. A SIGTERM without a handler severs these mid-await, leaving open
// sockets / half-written Redis state. `docker stop` follows SIGTERM with a
// SIGKILL after its grace window (default 10s), so we also need a hard-exit
// fallback if `app.close()` itself hangs — better to exit cleanly with
// non-zero than be reaped.
//
// The handler under test is a pure factory: it takes the app + a logger +
// an `exit` spy, so the tests never actually terminate the Vitest worker.

type FakeLogger = {
  info: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
};

type FakeApp = {
  close: ReturnType<typeof vi.fn>;
  log: FakeLogger;
};

function makeApp(close: () => Promise<void>): FakeApp {
  return {
    close: vi.fn(close),
    log: {
      info: vi.fn(),
      error: vi.fn(),
    },
  };
}

describe("createShutdownHandler", () => {
  let exit: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    exit = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("calls app.close on invocation", async () => {
    const app = makeApp(() => Promise.resolve());
    const handler = createShutdownHandler({ app, budgetMs: 8_000, exit });

    handler("SIGTERM");
    await vi.waitFor(() => expect(app.close).toHaveBeenCalledTimes(1));
  });

  test("exits 0 when app.close resolves", async () => {
    const app = makeApp(() => Promise.resolve());
    const handler = createShutdownHandler({ app, budgetMs: 8_000, exit });

    handler("SIGTERM");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(exit).toHaveBeenCalledTimes(1);
  });

  test("exits 1 and logs when app.close rejects", async () => {
    const boom = new Error("close failed");
    const app = makeApp(() => Promise.reject(boom));
    const handler = createShutdownHandler({ app, budgetMs: 8_000, exit });

    handler("SIGTERM");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(app.log.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: boom }),
      expect.stringContaining("app.close"),
    );
  });

  test("exits 1 when app.close hangs past budget", async () => {
    vi.useFakeTimers();
    // Pending promise — never resolves. The budget timer must fire and exit.
    const app = makeApp(() => new Promise<void>(() => {}));
    const handler = createShutdownHandler({ app, budgetMs: 8_000, exit });

    handler("SIGTERM");
    expect(exit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(8_000);
    expect(exit).toHaveBeenCalledWith(1);
    expect(app.log.error).toHaveBeenCalledWith(
      expect.objectContaining({ signal: "SIGTERM", timeoutMs: 8_000 }),
      expect.stringContaining("exceeded budget"),
    );
  });

  test("second invocation is a no-op (idempotent)", async () => {
    const app = makeApp(() => Promise.resolve());
    const handler = createShutdownHandler({ app, budgetMs: 8_000, exit });

    handler("SIGTERM");
    handler("SIGINT");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    // Only the first signal ran the pipeline.
    expect(app.close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });
});
