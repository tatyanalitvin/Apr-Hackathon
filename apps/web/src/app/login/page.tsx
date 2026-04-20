// REQ-043: Sign in (email + password, Remember me, deep-link via ?next).
"use client";

import { Suspense } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { loginSchema, type LoginInput } from "@ai-herders/shared/dto";
import { signIn } from "@/lib/auth-client";
import { safeNextOr } from "@/lib/safe-next";
import { AuthSplitLayout } from "@/components/auth/AuthSplitLayout";
import { Button } from "@/components/ui/button";
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
    const res = await signIn.email({
      email: values.email,
      password: values.password,
      rememberMe: values.rememberMe ?? false,
    });
    if (res.error) {
      // Inline-only — a form-level <p> and a toast with identical copy
      // within 50px of each other is noise, and Playwright strict-mode
      // matchers can't tell them apart either (blocks
      // exploratory/auth: wrong-password copy).
      form.setError("root", { message: describeAuthError(res.error.status) });
      return;
    }
    router.replace(nextTarget);
  });

  return (
    <AuthSplitLayout headline="Welcome back.">
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            aria-invalid={Boolean(form.formState.errors.email)}
            aria-describedby={form.formState.errors.email ? "email-error" : undefined}
            {...form.register("email")}
          />
          {form.formState.errors.email && (
            <p id="email-error" className="text-sm text-destructive">{form.formState.errors.email.message}</p>
          )}
        </div>
        <div className="space-y-2">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            aria-invalid={Boolean(form.formState.errors.password)}
            aria-describedby={form.formState.errors.password ? "password-error" : undefined}
            {...form.register("password")}
          />
          {form.formState.errors.password && (
            <p id="password-error" className="text-sm text-destructive">{form.formState.errors.password.message}</p>
          )}
          <p className="text-sm text-right">
            <Link className="underline text-muted-foreground" href="/forgot-password">Forgot password?</Link>
          </p>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <input id="rememberMe" type="checkbox" {...form.register("rememberMe")} className="h-4 w-4" />
          <Label htmlFor="rememberMe" className="font-normal">Keep me signed in</Label>
        </div>
        {form.formState.errors.root && (
          <p className="text-sm text-destructive">{form.formState.errors.root.message}</p>
        )}
        <Button type="submit" className="w-full" disabled={form.formState.isSubmitting}>
          {form.formState.isSubmitting ? "Signing in…" : "Sign in"}
        </Button>
        <p className="text-sm text-center text-muted-foreground">
          Need an account? <Link className="underline" href={`/register?next=${encodeURIComponent(nextTarget)}`}>Create one</Link>
        </p>
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
