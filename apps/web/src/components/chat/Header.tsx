"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Users } from "lucide-react";
import { signOut, useSession } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { PendingBadge } from "@/components/contacts/PendingBadge";
import { listIncomingRequests } from "@/lib/friendship-api";

const INCOMING_POLL_MS = 30_000;

export function Header({ className }: { className?: string }) {
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

  return (
    <header
      className={`flex items-center justify-between border-b px-4 py-2 ${className ?? ""}`}
    >
      <div className="flex items-center gap-4">
        <div className="font-semibold">AI Herders Chat</div>
        {data ? (
          <nav className="flex items-center gap-1" aria-label="Primary">
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
        <div className="flex items-center gap-3 text-sm">
          <div
            className="flex items-baseline gap-1.5 leading-tight"
            title={username ? `@${username}` : undefined}
          >
            {displayName && <span className="font-medium">{displayName}</span>}
            {username && (
              <span className="text-xs text-muted-foreground">@{username}</span>
            )}
          </div>
          <Button asChild size="sm" variant="ghost">
            <Link href="/settings/password">Password</Link>
          </Button>
          <Button size="sm" variant="outline" onClick={handleSignOut}>
            Sign out
          </Button>
        </div>
      )}
    </header>
  );
}
