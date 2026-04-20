// REQ-018 — Confirm password reset. Reads `?token=<token>` from the URL
// (better-auth generates and logs it via the sendResetPassword stub in
// apps/backend/src/auth.ts). Password shape matches registerSchema's
// `min(8).max(256)` rule to stay consistent with /register.
"use client";

import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { confirmPasswordReset, PasswordResetError } from "@/lib/auth-api";
import { AuthSplitLayout } from "@/components/auth/AuthSplitLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const schema = z
  .object({
    password: z.string().min(8, "At least 8 characters").max(256),
    passwordConfirm: z.string(),
  })
  .superRefine((val, ctx) => {
    if (val.passwordConfirm !== val.password) {
      ctx.addIssue({
        code: "custom",
        path: ["passwordConfirm"],
        message: "Passwords do not match",
      });
    }
  });
type FormInput = z.infer<typeof schema>;

function ResetPasswordForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";

  const form = useForm<FormInput>({
    resolver: zodResolver(schema),
    defaultValues: { password: "", passwordConfirm: "" },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    if (!token) {
      form.setError("root", { message: "Missing reset token" });
      return;
    }
    try {
      await confirmPasswordReset(token, values.password);
      toast.success("Password updated. Please sign in.");
      router.replace("/login");
    } catch (err) {
      if (err instanceof PasswordResetError && err.code === "INVALID_TOKEN") {
        form.setError("root", {
          message: "This reset link is invalid or expired.",
        });
        return;
      }
      const msg = err instanceof Error ? err.message : "Reset failed";
      toast.error(msg);
      form.setError("root", { message: msg });
    }
  });

  const tokenMissing = !token;

  return (
    <AuthSplitLayout headline="Set a new key.">
      {tokenMissing ? (
        <div className="space-y-4">
          <p className="text-sm text-destructive">
            This reset link is missing its token.
          </p>
          <p className="text-sm">
            <a className="underline" href="/forgot-password">
              Request a new reset link
            </a>
          </p>
        </div>
      ) : (
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <div className="space-y-2">
            <Label htmlFor="password">New password</Label>
            <Input
              id="password"
              type="password"
              autoComplete="new-password"
              className="dark:border-[rgba(196,181,253,0.22)]"
              {...form.register("password")}
            />
            {form.formState.errors.password && (
              <p className="text-sm text-destructive">
                {form.formState.errors.password.message}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              At least 8 characters.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="passwordConfirm">Confirm new password</Label>
            <Input
              id="passwordConfirm"
              type="password"
              autoComplete="new-password"
              className="dark:border-[rgba(196,181,253,0.22)]"
              {...form.register("passwordConfirm")}
            />
            {form.formState.errors.passwordConfirm && (
              <p className="text-sm text-destructive">
                {form.formState.errors.passwordConfirm.message}
              </p>
            )}
          </div>
          {form.formState.errors.root && (
            <div className="space-y-2">
              <p className="text-sm text-destructive">
                {form.formState.errors.root.message}
              </p>
              <p className="text-sm">
                <a className="underline" href="/forgot-password">
                  Request a new reset link
                </a>
              </p>
            </div>
          )}
          <Button
            type="submit"
            className="w-full"
            disabled={form.formState.isSubmitting}
          >
            {form.formState.isSubmitting ? "Updating…" : "Update password"}
          </Button>
        </form>
      )}
    </AuthSplitLayout>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={null}>
      <ResetPasswordForm />
    </Suspense>
  );
}
