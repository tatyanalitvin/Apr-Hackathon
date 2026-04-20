"use client";

// REQ-180 — federation status façade. No XMPP peers exist; the page
// hardcodes "No peers connected" and links to ADR-0002 + FEDERATION.md.
// The gate matches /admin (see apps/backend/src/routes/admin.ts):
// one fetch to the backend's admin endpoint purely to surface a
// 401/403 signal to the UI. No federation backend to call.

import Link from "next/link";
import { useEffect, useState } from "react";
import { AdminFetchError, fetchAdminMetrics } from "@/lib/admin-api";

type GateState =
  | { kind: "loading" }
  | { kind: "forbidden" }
  | { kind: "unauthorized" }
  | { kind: "error"; message: string }
  | { kind: "ok" };

export default function FederationAdminPage() {
  const [state, setState] = useState<GateState>({ kind: "loading" });

  useEffect(() => {
    let active = true;
    const controller = new AbortController();

    (async () => {
      try {
        await fetchAdminMetrics(controller.signal);
        if (active) setState({ kind: "ok" });
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
    })();

    return () => {
      active = false;
      controller.abort();
    };
  }, []);

  if (state.kind === "loading") {
    return (
      <main id="main" className="mx-auto max-w-[880px] px-6 py-10 space-y-6">
        <h1 className="font-display text-4xl" style={{ color: "var(--text-hi)" }}>Federation status</h1>
        <div
          className="rounded-[var(--radius)] p-6"
          style={{ background: "var(--bg-elevated)", boxShadow: "inset 0 1px 0 var(--glass-border)" }}
        >
          <p className="text-muted-foreground">Loading…</p>
        </div>
      </main>
    );
  }

  if (state.kind === "unauthorized") {
    return (
      <main id="main" className="mx-auto max-w-[880px] px-6 py-10 space-y-6">
        <h1 className="font-display text-4xl" style={{ color: "var(--text-hi)" }}>Federation status</h1>
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
        <h1 className="font-display text-4xl" style={{ color: "var(--text-hi)" }}>Federation status</h1>
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
        <h1 className="font-display text-4xl" style={{ color: "var(--text-hi)" }}>Federation status</h1>
        <div
          className="rounded-[var(--radius)] p-6"
          style={{ background: "var(--bg-elevated)", boxShadow: "inset 0 1px 0 var(--glass-border)" }}
        >
          <p className="text-red-600">Failed to load: {state.message}</p>
        </div>
      </main>
    );
  }

  return (
    <main id="main" className="mx-auto max-w-[880px] px-6 py-10 space-y-6">
      <div className="flex items-baseline justify-between">
        <h1 className="font-display text-4xl" style={{ color: "var(--text-hi)" }}>Federation status</h1>
        <Link
          href="/admin"
          className="text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          ← Admin
        </Link>
      </div>

      <div
        className="rounded-[var(--radius)] p-6 space-y-4"
        style={{ background: "var(--bg-elevated)", boxShadow: "inset 0 1px 0 var(--glass-border)" }}
      >
        <Card title="Current state">
          <div className="flex items-center gap-3">
            <span
              className="inline-block h-2.5 w-2.5 rounded-full bg-muted-foreground/50"
              aria-hidden
            />
            <span className="text-lg font-medium">No peers connected</span>
          </div>
          <p className="mt-3 text-sm text-muted-foreground">
            To enable XMPP federation, configure <code>XMPP_DOMAIN</code> and
            restart the federation service. See{" "}
            <code>docs/FEDERATION.md</code> for the full enable procedure.
          </p>
        </Card>

        <div aria-disabled className="mt-4 opacity-60">
          <Card title="Session counters">
            <dl className="grid grid-cols-3 gap-4 text-sm">
              <div>
                <dt className="text-muted-foreground">Inbound s2s</dt>
                <dd className="mt-1 text-2xl font-semibold text-foreground">0</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Outbound s2s</dt>
                <dd className="mt-1 text-2xl font-semibold text-foreground">0</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Last handshake</dt>
                {/* Absence ≠ a loud zero. The inbound/outbound 0 counters
                    intentionally keep text-2xl font-semibold because they're
                    real numeric metrics; "never" is the lack of any event, so
                    demote it to a muted text-lg so it reads as absence at a
                    glance. */}
                <dd className="mt-1 text-lg text-muted-foreground">never</dd>
              </div>
            </dl>
            <p className="mt-3 text-xs text-muted-foreground">
              Placeholder metrics. A live counter ships alongside the
              federation bridge (see <code>docs/FEDERATION.md</code>).
            </p>
          </Card>
        </div>

        <p className="mt-6 text-sm text-muted-foreground">
          Federation is out-of-scope for the hackathon MVP per{" "}
          <code>docs/adr/0002-no-xmpp.md</code>. The architecture is designed
          to accept an XMPP s2s module without code changes; see the ADR for
          the plan.
        </p>
      </div>
    </main>
  );
}

function Card({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
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
