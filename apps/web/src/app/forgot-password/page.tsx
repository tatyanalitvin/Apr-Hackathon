// REQ-017 — Request a password reset. The backend endpoint always returns
// 200 regardless of whether the email exists (anti-enumeration), so the UI
// shows the same neutral confirmation either way.
"use client";

import { useState } from "react";
import Link from "next/link";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { requestPasswordReset } from "@/lib/auth-api";
import { AuthSplitLayout } from "@/components/auth/AuthSplitLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const schema = z.object({ email: z.email() });
type FormInput = z.infer<typeof schema>;

export default function ForgotPasswordPage() {
  const [submitted, setSubmitted] = useState(false);
  const form = useForm<FormInput>({
    resolver: zodResolver(schema),
    defaultValues: { email: "" },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      await requestPasswordReset(values.email);
      setSubmitted(true);
    } catch {
      // Treat any transport failure as a generic "try again" — we still
      // must not differentiate existing vs unknown emails client-side.
      toast.error("Could not send reset request. Please try again.");
    }
  });

  return (
    <AuthSplitLayout headline="Recover your space.">
      {submitted ? (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            If an account exists for this email, a reset link has been sent.
          </p>
          <p className="text-sm text-center">
            <Link className="underline" href="/login">Back to sign in</Link>
          </p>
        </div>
      ) : (
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <p className="text-sm text-muted-foreground">
            Enter the email for your account and we&apos;ll send a reset link.
          </p>
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              className="dark:border-[rgba(196,181,253,0.22)]"
              {...form.register("email")}
            />
            {form.formState.errors.email && (
              <p className="text-sm text-destructive">
                {form.formState.errors.email.message}
              </p>
            )}
          </div>
          <Button
            type="submit"
            className="w-full"
            disabled={form.formState.isSubmitting}
          >
            {form.formState.isSubmitting ? "Sending…" : "Send reset link"}
          </Button>
          <p className="text-sm text-center text-muted-foreground">
            Remembered it? <Link className="underline" href="/login">Sign in</Link>
          </p>
        </form>
      )}
    </AuthSplitLayout>
  );
}
