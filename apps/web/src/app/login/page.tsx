// REQ-043: Sign in (email + password, Remember me, deep-link via ?next).
"use client";

import { Suspense } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { loginSchema, type LoginInput } from "@ai-herders/shared/dto";
import { BACKEND_URL } from "@/lib/backend";
import { applyAuthIssues } from "@/lib/auth-api";
import { safeNextOr } from "@/lib/safe-next";
import { AuthSplitLayout } from "@/components/auth/AuthSplitLayout";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

function describeAuthError(status: number | undefined): string {
  if (status === 429) return "Too many attempts, wait a minute";
  if (status === 401) return "Invalid email or password";
  return "Sign-in failed. Please try again.";
}

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const nextTarget = safeNextOr(searchParams.get("next"), "/rooms");

  const form = useForm<LoginInput>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: "", password: "", rememberMe: false },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    // Raw fetch — mirror /register: better-auth's signIn.email flattens our
    // zodBodyGuard envelope (`{error:"validation", issues:[...]}`) into a
    // bare top-level message, stripping field targeting. Going direct lets
    // us route email/password zod issues to their own inputs.
    let res: Response;
    try {
      res = await fetch(`${BACKEND_URL}/api/auth/sign-in/email`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: values.email,
          password: values.password,
          rememberMe: values.rememberMe ?? false,
        }),
      });
    } catch {
      toast.error("Network error — try again.");
      return;
    }

    if (res.ok) {
      router.replace(nextTarget);
      return;
    }

    const body = (await res.json().catch(() => null)) as
      | {
          error?: string;
          issues?: { path?: unknown; message?: string; code?: string }[];
          code?: string;
          message?: string;
        }
      | null;

    // Zod-envelope path → attach each issue to its field.
    const attached = applyAuthIssues(body, form, {
      email: "email",
      password: "password",
    });
    if (attached) return;

    // Non-validation failure (401 wrong password, 429 rate-limited, etc.) —
    // single inline root surface; no toast dup (Playwright strict matchers
    // can't tell duplicated copy apart).
    form.setError("root", { message: describeAuthError(res.status) });
  });

  return (
    <AuthSplitLayout headline="Welcome back." variant="v2">
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <div className="input-glow space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            aria-invalid={Boolean(form.formState.errors.email)}
            aria-describedby={form.formState.errors.email ? "email-error" : undefined}
            className="dark:border-[rgba(196,181,253,0.22)]"
            {...form.register("email")}
          />
          {form.formState.errors.email && (
            <p id="email-error" className="text-sm text-destructive">{form.formState.errors.email.message}</p>
          )}
        </div>
        <div className="input-glow space-y-2">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            aria-invalid={Boolean(form.formState.errors.password)}
            aria-describedby={form.formState.errors.password ? "password-error" : undefined}
            className="dark:border-[rgba(196,181,253,0.22)]"
            {...form.register("password")}
          />
          {form.formState.errors.password && (
            <p id="password-error" className="text-sm text-destructive">{form.formState.errors.password.message}</p>
          )}
        </div>
        <div className="flex items-center gap-2 text-sm">
          <Checkbox
            id="rememberMe"
            checked={form.watch("rememberMe") ?? false}
            onCheckedChange={(checked) =>
              form.setValue("rememberMe", checked === true)
            }
          />
          <Label htmlFor="rememberMe" className="font-normal">Keep me signed in</Label>
        </div>
        {form.formState.errors.root && (
          <p className="text-sm text-destructive">{form.formState.errors.root.message}</p>
        )}
        <Button
          type="submit"
          className="w-full disabled:bg-primary/70 disabled:text-primary-foreground disabled:opacity-100"
          disabled={form.formState.isSubmitting}
        >
          {form.formState.isSubmitting ? "Signing in…" : "Sign in"}
        </Button>
        <div className="flex items-center justify-between text-sm text-muted-foreground pt-2">
          <Link className="hover:text-foreground" href={`/register?next=${encodeURIComponent(nextTarget)}`}>Create an account</Link>
          <Link className="hover:text-foreground" href="/forgot-password">Forgot password?</Link>
        </div>
      </form>
    </AuthSplitLayout>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
