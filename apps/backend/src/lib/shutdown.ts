// S4-hardening — graceful shutdown factory.
//
// Factored out of server.ts so signal handling stays unit-testable: the
// caller injects `exit` (usually `process.exit`) and the app is treated as
// an interface (just `close()` + `log`). Tests pass a spy for `exit` and a
// mocked app; no real process ever terminates under Vitest.
//
// Budget: `docker stop` sends SIGTERM then SIGKILLs after its grace window
// (default 10s). Exit well before that so onClose hooks (socket.io teardown,
// @fastify/rate-limit redis.quit, shared redis client) finish cleanly rather
// than being severed mid-await. The hard-exit fallback covers the case
// where app.close() itself hangs (e.g. a route handler stuck awaiting a
// dead Redis) — better to exit non-zero than be reaped.

type ShutdownLogger = {
  info: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
};

type ShutdownApp = {
  close: () => Promise<void>;
  log: ShutdownLogger;
};

export type ShutdownHandlerDeps = {
  app: ShutdownApp;
  budgetMs: number;
  exit: (code: number) => void;
};

export function createShutdownHandler(
  deps: ShutdownHandlerDeps,
): (signal: NodeJS.Signals) => void {
  const { app, budgetMs, exit } = deps;
  let shuttingDown = false;

  return (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;

    app.log.info({ signal }, "received shutdown signal — closing backend");

    const timer = setTimeout(() => {
      app.log.error(
        { signal, timeoutMs: budgetMs },
        "shutdown exceeded budget — forcing exit",
      );
      exit(1);
    }, budgetMs);
    timer.unref();

    app
      .close()
      .then(() => {
        clearTimeout(timer);
        exit(0);
      })
      .catch((err: unknown) => {
        clearTimeout(timer);
        app.log.error({ err }, "app.close() rejected");
        exit(1);
      });
  };
}
