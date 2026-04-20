// REQ-018 — Confirm password reset. Reads `?token=<token>` from the URL
// (better-auth generates and logs it via the sendResetPassword stub in
// apps/backend/src/auth.ts). Password shape matches registerSchema's
// `min(12).max(128)` rule to stay consistent with /register (REQ-006).
"use client";

import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import {
  applyAuthIssues,
  confirmPasswordReset,
  PasswordResetError,
  prettyPasswordMessage,
} from "@/lib/auth-api";
import { AuthSplitLayout } from "@/components/auth/AuthSplitLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const schema = z
  .object({
    password: z
      .string()
      .min(12, "password_too_short: password must be at least 12 characters")
      .max(128, "password_too_long: password must be at most 128 characters"),
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
        // Root-level copy paired with the "Request a new reset link" CTA
        // rendered below. No toast — the inline block is enough and the two
        // surfaces confused users with duplicated copy within 50px.
        form.setError("root", {
          message: "This reset link is invalid or expired.",
        });
        return;
      }

      // Prefer field-level surfacing: walk issues[] → `password` / `passwordConfirm`.
      // Only fall back to a toast when no field can be blamed.
      if (err instanceof PasswordResetError && err.envelope) {
        const attached = applyAuthIssues(err.envelope, form, {
          password: "password",
          newPassword: "password",
          passwordConfirm: "passwordConfirm",
        });
        if (attached) return;
      }

      // better-auth canonical shape — short/long come back as
      // `{code:"PASSWORD_TOO_SHORT"|..., message}`. Prefer attaching to the
      // password field; humanise the prefix just like the zod envelope path.
      if (
        err instanceof PasswordResetError &&
        (err.code === "PASSWORD_TOO_SHORT" || err.code === "PASSWORD_TOO_LONG")
      ) {
        const raw =
          err.code === "PASSWORD_TOO_SHORT"
            ? "password_too_short"
            : "password_too_long";
        form.setError("password", { message: prettyPasswordMessage(raw) });
        return;
      }

      const msg = err instanceof Error ? err.message : "Reset failed";
      toast.error(msg);
    }
  });

  const tokenMissing = !token;

  return (
    <AuthSplitLayout headline="Set a new key." variant="v4">
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
              At least 12 characters.
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
            className="w-full disabled:bg-primary/70 disabled:text-primary-foreground disabled:opacity-100"
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
