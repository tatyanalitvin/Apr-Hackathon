// REQ-042: Account registration (email + username + display name + password).
"use client";

import { Suspense } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { registerSchema, type RegisterInput } from "@ai-herders/shared/dto";
import { signUp } from "@/lib/auth-client";
import { safeNextOr } from "@/lib/safe-next";
import { AuthSplitLayout } from "@/components/auth/AuthSplitLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

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
    const res = await signUp.email({
      email: values.email,
      password: values.password,
      name: values.name,
      ...({ username: values.username } as Record<string, string>),
    });
    if (res.error) {
      const msg = res.error.message ?? "Registration failed";
      toast.error(msg);
      form.setError("root", { message: msg });
      return;
    }
    router.replace(nextTarget);
  });

  return (
    <AuthSplitLayout headline="Start herding ideas.">
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
          <Label htmlFor="username">Username</Label>
          <Input
            id="username"
            autoComplete="username"
            aria-invalid={Boolean(form.formState.errors.username)}
            aria-describedby={form.formState.errors.username ? "username-error" : undefined}
            {...form.register("username")}
          />
          {form.formState.errors.username && (
            <p id="username-error" className="text-sm text-destructive">{form.formState.errors.username.message}</p>
          )}
        </div>
        <div className="space-y-2">
          <Label htmlFor="name">Display name</Label>
          <Input
            id="name"
            aria-invalid={Boolean(form.formState.errors.name)}
            aria-describedby={form.formState.errors.name ? "name-error" : undefined}
            {...form.register("name")}
          />
          {form.formState.errors.name && (
            <p id="name-error" className="text-sm text-destructive">{form.formState.errors.name.message}</p>
          )}
        </div>
        <div className="space-y-2">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            aria-invalid={Boolean(form.formState.errors.password)}
            aria-describedby={form.formState.errors.password ? "password-error" : undefined}
            {...form.register("password")}
          />
          {form.formState.errors.password && (
            <p id="password-error" className="text-sm text-destructive">{form.formState.errors.password.message}</p>
          )}
        </div>
        <div className="space-y-2">
          <Label htmlFor="passwordConfirm">Confirm password</Label>
          <Input
            id="passwordConfirm"
            type="password"
            autoComplete="new-password"
            aria-invalid={Boolean(form.formState.errors.passwordConfirm)}
            aria-describedby={form.formState.errors.passwordConfirm ? "passwordConfirm-error" : undefined}
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
