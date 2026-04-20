"use client";

// REQ-158 — admin dashboard. Four widgets, 2s polling, plain HTML.
// The judge-visible surface for "live metrics" in the hackathon demo.
//
// We deliberately avoid chart libs (Recharts/D3): they add 100+KB for
// what a 12-bar row of <div>s already conveys, and the hackathon spec
// explicitly scopes this down to numbers + bars. The coexisting
// /admin/federation page is the S4 agent's and remains untouched.

import Link from "next/link";
import { useEffect, useState } from "react";
import type { AdminMetricsSnapshot } from "@ai-herders/shared/protocol";
import {
  AdminFetchError,
  fetchAdminMetrics,
} from "@/lib/admin-api";

const POLL_MS = 2000;

type LoadState =
  | { kind: "loading" }
  | { kind: "forbidden" }
  | { kind: "unauthorized" }
  | { kind: "error"; message: string }
  | { kind: "ok"; snapshot: AdminMetricsSnapshot };

export default function AdminPage() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    let active = true;
    const controller = new AbortController();

    async function tick(): Promise<void> {
      try {
        const snapshot = await fetchAdminMetrics(controller.signal);
        if (!active) return;
        setState({ kind: "ok", snapshot });
      } catch (err) {
        if (!active) return;
        if (err instanceof AdminFetchError) {
          if (err.status === 401) setState({ kind: "unauthorized" });
          else if (err.status === 403) setState({ kind: "forbidden" });
          else setState({ kind: "error", message: err.message });
          return;
        }
        if ((err as { name?: string } | undefined)?.name === "AbortError") return;
        setState({
          kind: "error",
          message: (err as Error).message ?? "unknown error",
        });
      }
    }

    // Prime immediately then poll. Interval stays stable across re-renders
    // because the effect has no deps.
    void tick();
    const handle = window.setInterval(tick, POLL_MS);
    return () => {
      active = false;
      controller.abort();
      window.clearInterval(handle);
    };
  }, []);

  if (state.kind === "loading") {
    return (
      <main id="main" className="mx-auto max-w-[880px] px-6 py-10 space-y-6">
        <h1 className="font-display text-4xl" style={{ color: "var(--text-hi)" }}>Admin</h1>
        <div
          className="rounded-[var(--radius)] p-6"
          style={{ background: "var(--bg-elevated)", boxShadow: "inset 0 1px 0 var(--glass-border)" }}
        >
          <p className="text-muted-foreground">Loading metrics…</p>
        </div>
      </main>
    );
  }

  if (state.kind === "unauthorized") {
    return (
      <main id="main" className="mx-auto max-w-[880px] px-6 py-10 space-y-6">
        <h1 className="font-display text-4xl" style={{ color: "var(--text-hi)" }}>Admin</h1>
        <div
          className="rounded-[var(--radius)] p-6"
          style={{ background: "var(--bg-elevated)", boxShadow: "inset 0 1px 0 var(--glass-border)" }}
        >
          <p>You must sign in to view this page.</p>
        </div>
      </main>
    );
  }

  if (state.kind === "forbidden") {
    return (
      <main id="main" className="mx-auto max-w-[880px] px-6 py-10 space-y-6">
        <h1 className="font-display text-4xl" style={{ color: "var(--text-hi)" }}>Admin</h1>
        <div
          className="rounded-[var(--radius)] p-6"
          style={{ background: "var(--bg-elevated)", boxShadow: "inset 0 1px 0 var(--glass-border)" }}
        >
          <p className="text-red-600">
            Forbidden. Your account is not in the admin allow-list.
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            Ask an operator to add your user id to <code>ADMIN_USER_IDS</code>.
          </p>
        </div>
      </main>
    );
  }

  if (state.kind === "error") {
    return (
      <main id="main" className="mx-auto max-w-[880px] px-6 py-10 space-y-6">
        <h1 className="font-display text-4xl" style={{ color: "var(--text-hi)" }}>Admin</h1>
        <div
          className="rounded-[var(--radius)] p-6"
          style={{ background: "var(--bg-elevated)", boxShadow: "inset 0 1px 0 var(--glass-border)" }}
        >
          <p className="text-red-600">Failed to load metrics: {state.message}</p>
        </div>
      </main>
    );
  }

  const { snapshot } = state;
  const errorClass = snapshot.errorCount5min > 0 ? "text-red-600" : "";
  const maxBar = Math.max(1, ...snapshot.messagesPerMinuteSeries);

  return (
    <main id="main" className="mx-auto max-w-[880px] px-6 py-10 space-y-6">
      <div className="flex items-baseline justify-between">
        <h1 className="font-display text-4xl" style={{ color: "var(--text-hi)" }}>Admin</h1>
        <span className="text-xs text-muted-foreground">
          updated {new Date(snapshot.generatedAt).toLocaleTimeString()}
        </span>
      </div>

      <div
        className="rounded-[var(--radius)] p-6"
        style={{ background: "var(--bg-elevated)", boxShadow: "inset 0 1px 0 var(--glass-border)" }}
      >
        <div className="grid gap-4 md:grid-cols-2">
          <Card title="Online users">
            <div className="text-4xl font-semibold">{snapshot.onlineUsers}</div>
            <div className="text-sm text-muted-foreground">
              distinct signed-in users with an active socket
            </div>
          </Card>

          <Card title="Messages / minute">
            <div className="text-4xl font-semibold">
              {snapshot.messagesPerMinute}
            </div>
            <div className="mt-3 flex h-12 items-end gap-1" aria-label="messages per 5s bucket">
              {snapshot.messagesPerMinuteSeries.map((n, i) => (
                <div
                  key={i}
                  className="w-4 rounded-sm bg-primary/70"
                  style={{ height: `${(n / maxBar) * 100}%` }}
                  title={`${n} messages`}
                />
              ))}
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              12 buckets × 5s, oldest → newest
            </div>
          </Card>

          <Card title="Error count (5 min)">
            <div className={`text-4xl font-semibold ${errorClass}`}>
              {snapshot.errorCount5min}
            </div>
            <div className="text-sm text-muted-foreground">
              Fastify responses with status ≥ 500 in the last 5 minutes
            </div>
          </Card>

          <Card title="Recent security events">
            {snapshot.recentSecurityEvents.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No events recorded yet. Populated by the CSRF / rate-limit /
                failed-login paths once the hardening layer is wired.
              </p>
            ) : (
              <ul className="max-h-48 overflow-y-auto space-y-1 text-sm">
                {snapshot.recentSecurityEvents.map((ev, i) => (
                  <li key={i} className="font-mono">
                    <span className="text-muted-foreground">
                      {new Date(ev.at).toLocaleTimeString()}{" "}
                    </span>
                    <span className="font-semibold">{ev.type}</span>
                    {ev.route ? ` · ${ev.route}` : ""}
                    {ev.ip ? ` · ip:${ev.ip}` : ""}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>

      <nav className="text-sm">
        <Link
          href="/admin/federation"
          className="text-muted-foreground underline-offset-4 hover:underline"
        >
          Federation status →
        </Link>
      </nav>
    </main>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section
      className="rounded-[var(--radius)] p-4"
      style={{
        background: "var(--bg-base)",
        boxShadow: "inset 0 0 0 1px var(--glass-border)",
      }}
    >
      <h2 className="mb-2 text-sm font-medium uppercase tracking-wide" style={{ color: "var(--text-lo)" }}>
        {title}
      </h2>
      {children}
    </section>
  );
}
