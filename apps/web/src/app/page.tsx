"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "@/lib/auth-client";
import { Skeleton } from "@/components/ui/skeleton";

export default function RootPage() {
  const { data, isPending } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (isPending) return;
    router.replace(data ? "/rooms" : "/login");
  }, [data, isPending, router]);

  return (
    <div className="p-8">
      <Skeleton className="h-8 w-48" />
    </div>
  );
}
