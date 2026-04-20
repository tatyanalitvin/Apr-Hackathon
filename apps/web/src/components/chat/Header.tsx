"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Hash, Users } from "lucide-react";
import { signOut, useSession } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { PendingBadge } from "@/components/contacts/PendingBadge";
import { PresencePill } from "@/components/chat/PresencePill";
import { ThemeToggle } from "@/components/theme-toggle";
import type { UserPresenceState } from "@ai-herders/shared/protocol";
import { listIncomingRequests } from "@/lib/friendship-api";

const INCOMING_POLL_MS = 30_000;

export function Header({
  className,
  selfPresence,
}: {
  className?: string;
  // REQ-105 — optional override for the self-pill so the room view can drive
  // it from the local idle detector (instant feedback) rather than waiting
  // for the server round-trip of `presence.changed`.
  selfPresence?: UserPresenceState;
}) {
  const { data } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const displayName = data?.user?.name;
  const username =
    data?.user && "username" in data.user
      ? (data.user as { username: string }).username
      : undefined;

  // REQ-136 — poll incoming pending count for the PendingBadge. No socket
  // event exists for "new request incoming" (REQ-058 only fires on accept),
  // so polling is the only path. 30s cadence per brief.
  const [pendingCount, setPendingCount] = useState(0);
  useEffect(() => {
    if (!data) return;
    let cancelled = false;
    const poll = async () => {
      const r = await listIncomingRequests();
      if (cancelled) return;
      if (r.ok) setPendingCount(r.data.length);
    };
    void poll();
    const interval = setInterval(poll, INCOMING_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [data]);

  const handleSignOut = async () => {
    await signOut();
    router.replace("/login");
  };

  const onContactsRoute = pathname?.startsWith("/contacts") ?? false;
  const onRoomsRoute = pathname?.startsWith("/rooms") ?? false;

  return (
    <header
      className={`flex flex-wrap items-center justify-between gap-y-2 border-b px-4 py-2 ${className ?? ""}`}
    >
      <div className="flex items-center gap-4">
        <Link
          href={data ? "/rooms" : "/login"}
          className="font-semibold hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
        >
          AI Herders Chat
        </Link>
        {data ? (
          <nav className="flex items-center gap-1" aria-label="Primary">
            <Button
              asChild
              size="sm"
              variant={onRoomsRoute ? "secondary" : "ghost"}
              className="gap-2"
            >
              <Link href="/rooms">
                <Hash className="h-4 w-4" aria-hidden />
                Rooms
              </Link>
            </Button>
            <Button
              asChild
              size="sm"
              variant={onContactsRoute ? "secondary" : "ghost"}
              className="gap-2"
            >
              <Link href="/contacts">
                <Users className="h-4 w-4" aria-hidden />
                Contacts
                <PendingBadge count={pendingCount} />
              </Link>
            </Button>
          </nav>
        ) : null}
      </div>
      {data && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
          <div
            className="flex items-baseline gap-1.5 leading-tight"
            title={username ? `@${username}` : undefined}
          >
            {data.user?.id ? (
              // UX-03 — our own pill must never read "offline" while we're
              // actively on the page. RoomClient passes a live idle-state;
              // elsewhere, default to "online" (we rendered, therefore the
              // socket layer will tick a heartbeat in the next few hundred
              // ms) rather than showing the presence-store fallback.
              <PresencePill
                userId={data.user.id}
                state={selfPresence ?? "online"}
                className="self-center"
              />
            ) : null}
            {displayName && <span className="font-medium">{displayName}</span>}
            {username && (
              <span className="text-xs text-muted-foreground">@{username}</span>
            )}
          </div>
          <Button asChild size="sm" variant="ghost">
            <Link href="/settings/password">Password</Link>
          </Button>
          <Button asChild size="sm" variant="ghost">
            <Link href="/settings/sessions">Sessions</Link>
          </Button>
          <Button asChild size="sm" variant="ghost">
            <Link href="/settings/account">Account</Link>
          </Button>
          <ThemeToggle />
          <Button size="sm" variant="outline" onClick={handleSignOut}>
            Sign out
          </Button>
        </div>
      )}
    </header>
  );
}
