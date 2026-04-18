"use client";

import { useRouter } from "next/navigation";
import { signOut, useSession } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";

export function Header({ className }: { className?: string }) {
  const { data } = useSession();
  const router = useRouter();
  const displayName = data?.user?.name;
  const username =
    data?.user && "username" in data.user
      ? (data.user as { username: string }).username
      : undefined;

  const handleSignOut = async () => {
    await signOut();
    router.replace("/login");
  };

  return (
    <header className={`flex items-center justify-between border-b px-4 py-2 ${className ?? ""}`}>
      <div className="font-semibold">AI Herders Chat</div>
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
          <Button size="sm" variant="outline" onClick={handleSignOut}>Sign out</Button>
        </div>
      )}
    </header>
  );
}
