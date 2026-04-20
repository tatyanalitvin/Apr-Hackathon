// REQ-042: Account registration (email + username + display name + password).
"use client";

import { Suspense } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { registerSchema, type RegisterInput } from "@ai-herders/shared/dto";
import { BACKEND_URL } from "@/lib/backend";
import { safeNextOr } from "@/lib/safe-next";
import { AuthSplitLayout } from "@/components/auth/AuthSplitLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";

function RegisterForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const nextTarget = safeNextOr(searchParams.get("next"), "/rooms");

  const form = useForm<RegisterInput>({
    resolver: zodResolver(registerSchema),
    defaultValues: {
      email: "",
      username: "",
      name: "",
      password: "",
      passwordConfirm: "",
    },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    // Raw fetch instead of better-auth's signUp.email — the client flattens
    // our zodBodyGuard/passwordPolicyGuard response envelope
    // ({error:"validation", issues:[{path,message,code}]}) into a bare
    // "Registration failed" because better-auth only surfaces a top-level
    // `message`, which our envelope doesn't have. Going direct lets us
    // attach the password_common / username_taken / etc. messages to the
    // offending field. The backend still Set-Cookie's the session; the
    // subsequent router.replace triggers a hard nav that picks it up.
    const res = await fetch(`${BACKEND_URL}/api/auth/sign-up/email`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: values.email,
        password: values.password,
        name: values.name,
        username: values.username,
      }),
    });

    if (res.ok) {
      router.replace(nextTarget);
      return;
    }

    type Issue = { path?: unknown; message?: string; code?: string };
    const body = (await res.json().catch(() => null)) as
      | { error?: string; issues?: Issue[]; code?: string; message?: string }
      | null;

    const fieldMap: Record<string, keyof RegisterInput> = {
      email: "email",
      username: "username",
      name: "name",
      password: "password",
      passwordConfirm: "passwordConfirm",
    };

    const prettyPw = (raw: string): string => {
      if (raw.startsWith("password_common"))
        return "This password is too common — please pick a stronger one.";
      if (raw.startsWith("password_too_short"))
        return "Password is too short (minimum 12 characters).";
      if (raw.startsWith("password_too_long"))
        return "Password is too long (maximum 128 characters).";
      return raw;
    };

    // Shape 1 — our zodBodyGuard/passwordPolicyGuard envelope.
    if (Array.isArray(body?.issues) && body.issues.length > 0) {
      let rootMsg: string | undefined;
      for (const issue of body.issues) {
        const key = Array.isArray(issue.path) ? String(issue.path[0] ?? "") : "";
        const target = fieldMap[key];
        const message =
          target === "password" ? prettyPw(issue.message ?? "") : issue.message ?? "Invalid input";
        if (target) {
          form.setError(target, { message });
        } else {
          rootMsg = rootMsg ?? message;
        }
      }
      const firstVisible = body.issues[0]?.message ?? "Please fix the highlighted fields.";
      const pretty =
        body.issues[0] && Array.isArray(body.issues[0].path) && body.issues[0].path[0] === "password"
          ? prettyPw(firstVisible)
          : firstVisible;
      toast.error(pretty);
      if (rootMsg) form.setError("root", { message: rootMsg });
      return;
    }

    // Shape 2 — better-auth canonical {code, message} (e.g. USER_ALREADY_EXISTS).
    const canonical = body?.message ?? body?.code ?? `Registration failed (${res.status})`;
    toast.error(canonical);
    form.setError("root", { message: canonical });
  });

  return (
    <AuthSplitLayout headline="Start herding ideas." variant="v1">
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
          <Label htmlFor="username">Username</Label>
          <Input
            id="username"
            autoComplete="username"
            aria-invalid={Boolean(form.formState.errors.username)}
            aria-describedby={form.formState.errors.username ? "username-error" : undefined}
            className="dark:border-[rgba(196,181,253,0.22)]"
            {...form.register("username")}
          />
          {form.formState.errors.username && (
            <p id="username-error" className="text-sm text-destructive">{form.formState.errors.username.message}</p>
          )}
        </div>
        <div className="input-glow space-y-2">
          <Label htmlFor="name">Display name</Label>
          <Input
            id="name"
            aria-invalid={Boolean(form.formState.errors.name)}
            aria-describedby={form.formState.errors.name ? "name-error" : undefined}
            className="dark:border-[rgba(196,181,253,0.22)]"
            {...form.register("name")}
          />
          {form.formState.errors.name && (
            <p id="name-error" className="text-sm text-destructive">{form.formState.errors.name.message}</p>
          )}
        </div>
        <div className="input-glow space-y-2">
          <Label htmlFor="password">Password</Label>
          <PasswordInput
            id="password"
            autoComplete="new-password"
            aria-invalid={Boolean(form.formState.errors.password)}
            aria-describedby={form.formState.errors.password ? "password-error" : undefined}
            className="dark:border-[rgba(196,181,253,0.22)]"
            {...form.register("password")}
          />
          {form.formState.errors.password && (
            <p id="password-error" className="text-sm text-destructive">{form.formState.errors.password.message}</p>
          )}
        </div>
        <div className="input-glow space-y-2">
          <Label htmlFor="passwordConfirm">Confirm password</Label>
          <PasswordInput
            id="passwordConfirm"
            autoComplete="new-password"
            aria-invalid={Boolean(form.formState.errors.passwordConfirm)}
            aria-describedby={form.formState.errors.passwordConfirm ? "passwordConfirm-error" : undefined}
            className="dark:border-[rgba(196,181,253,0.22)]"
            {...form.register("passwordConfirm")}
          />
          {form.formState.errors.passwordConfirm && (
            <p id="passwordConfirm-error" className="text-sm text-destructive">
              {form.formState.errors.passwordConfirm.message}
            </p>
          )}
        </div>
        {form.formState.errors.root && (
          <p className="text-sm text-destructive">{form.formState.errors.root.message}</p>
        )}
        <Button type="submit" className="w-full" disabled={form.formState.isSubmitting}>
          {form.formState.isSubmitting ? "Creating…" : "Create account"}
        </Button>
        <p className="text-sm text-center text-muted-foreground">
          Already have an account? <Link className="underline" href={`/login?next=${encodeURIComponent(nextTarget)}`}>Sign in</Link>
        </p>
      </form>
    </AuthSplitLayout>
  );
}

export default function RegisterPage() {
  return (
    <Suspense fallback={null}>
      <RegisterForm />
    </Suspense>
  );
}
