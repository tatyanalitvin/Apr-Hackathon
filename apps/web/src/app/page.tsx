"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useSession } from "@/lib/auth-client";
import { AuthSplitLayout } from "@/components/auth/AuthSplitLayout";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

export default function RootPage() {
  const { data, isPending } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (isPending) return;
    if (data) router.replace("/rooms");
  }, [data, isPending, router]);

  if (isPending) {
    return (
      <div className="p-8">
        <Skeleton className="h-8 w-48" />
      </div>
    );
  }

  if (data) return null;

  return (
    <AuthSplitLayout
      headline="A calmer place to think out loud."
      tagline="Chat rooms, direct messages, and AI delegates — in one quiet canvas."
    >
      <div className="flex flex-col gap-3">
        <Link href="/register" className="w-full">
          <Button className="w-full">Create an account</Button>
        </Link>
        <Link href="/login" className="w-full">
          <Button variant="ghost-glass" className="w-full">Sign in</Button>
        </Link>
      </div>
    </AuthSplitLayout>
  );
}
