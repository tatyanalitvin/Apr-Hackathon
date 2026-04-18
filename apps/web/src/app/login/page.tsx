// REQ-043: Sign in (email + password, Remember me, deep-link via ?next).
"use client";

import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { loginSchema, type LoginInput } from "@ai-herders/shared/dto";
import { signIn } from "@/lib/auth-client";
import { safeNextOr } from "@/lib/safe-next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

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
      const msg = describeAuthError(res.error.status);
      toast.error(msg);
      form.setError("root", { message: msg });
      return;
    }
    router.replace(nextTarget);
  });

  return (
    <div className="flex min-h-dvh items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader><CardTitle>Sign in</CardTitle></CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-4" noValidate>
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" autoComplete="email" {...form.register("email")} />
              {form.formState.errors.email && (
                <p className="text-sm text-destructive">{form.formState.errors.email.message}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input id="password" type="password" autoComplete="current-password" {...form.register("password")} />
              {form.formState.errors.password && (
                <p className="text-sm text-destructive">{form.formState.errors.password.message}</p>
              )}
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" {...form.register("rememberMe")} className="h-4 w-4" />
              <span>Keep me signed in</span>
            </label>
            {form.formState.errors.root && (
              <p className="text-sm text-destructive">{form.formState.errors.root.message}</p>
            )}
            <Button type="submit" className="w-full" disabled={form.formState.isSubmitting}>
              {form.formState.isSubmitting ? "Signing in…" : "Sign in"}
            </Button>
            <p className="text-sm text-center text-muted-foreground">
              No account yet? <a className="underline" href={`/register?next=${encodeURIComponent(nextTarget)}`}>Create one</a>
            </p>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
