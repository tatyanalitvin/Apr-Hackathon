// REQ-017 / REQ-018, v3.docx §2.2.4 — Active Sessions UI.
// Spec: docs/specs/s2-sessions-ui.md. Pattern mirrors settings/account/page.tsx.
"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { RequireSession } from "@/components/chat/RequireSession";
import { Header } from "@/components/chat/Header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  listSessions,
  revokeSession,
  type SessionRow,
} from "@/lib/sessions-api";

// Tiny UA → label helper. 10-line cap per spec §5 kill-switch; extract to
// lib/ua-parse.ts + unit test only when this grows past ~15 lines.
function uaLabel(ua: string | null | undefined): string {
  if (!ua) return "Unknown browser";
  const os = /Windows/i.test(ua)
    ? "Windows"
    : /Mac OS X|Macintosh/i.test(ua)
      ? "macOS"
      : /Android/i.test(ua)
        ? "Android"
        : /iPhone|iPad|iOS/i.test(ua)
          ? "iOS"
          : /Linux/i.test(ua)
            ? "Linux"
            : "Unknown OS";
  const browser = /Edg\//i.test(ua)
    ? "Edge"
    : /Firefox\//i.test(ua)
      ? "Firefox"
      : /Chrome\//i.test(ua)
        ? "Chrome"
        : /Safari\//i.test(ua)
          ? "Safari"
          : "Browser";
  return `${browser} on ${os}`;
}

// Relative time for "Last active" — inline helper, no new dep (see
// CLAUDE.md: ask before adding deps). Truncates to coarse buckets; exact
// timestamp is available on the adjacent `Created` cell if needed.
function relativeTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  return `${Math.floor(diff / 86400)} d ago`;
}

// Absolute short date for "Created" — locale-aware via Intl, no new dep.
function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(d);
}

// Sort `current` first, then most-recently-active first. Matches the
// Google/GitHub pattern approved in spec §8 Q1.
function sortSessions(rows: SessionRow[]): SessionRow[] {
  return [...rows].sort((a, b) => {
    if (a.current !== b.current) return a.current ? -1 : 1;
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}

function SessionsContent() {
  const router = useRouter();
  const [rows, setRows] = useState<SessionRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    try {
      const data = await listSessions();
      setRows(sortSessions(data));
      setLoadError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Load failed";
      setLoadError(message);
    }
  }, []);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  const onRevoke = async (row: SessionRow) => {
    setRevoking(row.id);
    try {
      await revokeSession(row.id);
      if (row.current) {
        // Cookie is gone; the next render wouldn't even get past RequireSession,
        // but we replace() anyway to leave no stale /settings/sessions in history.
        router.replace("/login");
        return;
      }
      // Optimistic remove, then refetch to reconcile (e.g. if another tab also revoked).
      setRows((prev) => (prev ? prev.filter((r) => r.id !== row.id) : prev));
      toast.success("Session signed out");
      void refetch();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Couldn't sign that session out";
      toast.error(message);
    } finally {
      setRevoking(null);
    }
  };

  return (
    <div className="flex min-h-dvh flex-col">
      <Header />
      <main id="main" className="mx-auto w-full max-w-3xl px-6 py-10 space-y-6">
        <h1 className="font-display text-4xl" style={{ color: "var(--text-hi)" }}>Active sessions</h1>
        <div
          className="rounded-[var(--radius)] p-6 space-y-4"
          style={{ background: "var(--bg-elevated)", boxShadow: "inset 0 1px 0 var(--glass-border)" }}
        >
          <p className="text-sm text-muted-foreground">
            Each row is a browser currently signed in to your account. Sign
            out any you don&apos;t recognise. Signing out this browser sends
            you back to the login page.
          </p>

          {rows === null && loadError === null && (
            <div className="space-y-2" aria-live="polite" aria-busy="true">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          )}

          {loadError !== null && (
            <div className="flex flex-col gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
              <p className="text-destructive">{loadError}</p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setRows(null);
                  void refetch();
                }}
              >
                Try again
              </Button>
            </div>
          )}

          {rows !== null && rows.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No other active sessions.
            </p>
          )}

          {rows !== null && rows.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Browser</TableHead>
                  <TableHead>IP</TableHead>
                  <TableHead>Last active</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => {
                  const busy = revoking === row.id;
                  return (
                    <TableRow key={row.id}>
                      <TableCell className="font-medium">
                        {uaLabel(row.userAgent)}
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {row.ipAddress ?? "Unknown"}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {relativeTime(row.updatedAt)}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {shortDate(row.createdAt)}
                      </TableCell>
                      <TableCell>
                        {row.current && (
                          <Badge variant="secondary">This browser</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant={row.current ? "outline" : "ghost"}
                          size="sm"
                          disabled={busy || revoking !== null}
                          onClick={() => void onRevoke(row)}
                        >
                          {busy
                            ? "Signing out…"
                            : row.current
                              ? "Sign out this browser"
                              : "Sign out"}
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </div>
      </main>
    </div>
  );
}

export default function SessionsSettingsPage() {
  return (
    <RequireSession>
      <SessionsContent />
    </RequireSession>
  );
}
