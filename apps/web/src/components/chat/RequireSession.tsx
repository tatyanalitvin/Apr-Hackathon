"use client";

import { useEffect, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useSession } from "@/lib/auth-client";
import { Skeleton } from "@/components/ui/skeleton";

export function RequireSession({ children }: { children: ReactNode }) {
  const { data, isPending } = useSession();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (!isPending && !data) {
      const next = encodeURIComponent(pathname ?? "/");
      router.replace(`/login?next=${next}`);
    }
  }, [isPending, data, pathname, router]);

  if (isPending) {
    return (
      <div className="p-8 space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (!data) return null;

  return <>{children}</>;
}
