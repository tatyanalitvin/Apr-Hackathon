"use client";

import { useRouter } from "next/navigation";
import { signOut, useSession } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";

export function Header({ className }: { className?: string }) {
  const { data } = useSession();
  const router = useRouter();
  const username = data?.user && "username" in data.user ? (data.user as { username: string }).username : data?.user?.name;

  const handleSignOut = async () => {
    await signOut();
    router.replace("/login");
  };

  return (
    <header className={`flex items-center justify-between border-b px-4 py-2 ${className ?? ""}`}>
      <div className="font-semibold">AI Herders Chat</div>
      {data && (
        <div className="flex items-center gap-3 text-sm">
          <span className="text-muted-foreground">{username}</span>
          <Button size="sm" variant="outline" onClick={handleSignOut}>Sign out</Button>
        </div>
      )}
    </header>
  );
}
