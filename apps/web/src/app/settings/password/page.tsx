// REQ-016 — Password change UI.
// Calls POST /api/auth/change-password on the Fastify backend (better-auth
// endpoint; verified in node_modules/better-auth/dist/api/routes/update-user.d.mts).
// Uses plain fetch() with credentials:"include" rather than the
// auth-client path-to-object proxy so the call site is boring and
// explicit about headers and cookies.
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { RequireSession } from "@/components/chat/RequireSession";
import { Header } from "@/components/chat/Header";
import { BACKEND_URL } from "@/lib/backend";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, "Current password is required"),
    newPassword: z.string().min(8, "At least 8 characters").max(256),
    newPasswordConfirm: z.string(),
    revokeOtherSessions: z.boolean(),
  })
  .superRefine((val, ctx) => {
    if (val.newPassword !== val.newPasswordConfirm) {
      ctx.addIssue({
        code: "custom",
        path: ["newPasswordConfirm"],
        message: "password_mismatch: passwords do not match",
      });
    }
  });
type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

function PasswordContent() {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const form = useForm<ChangePasswordInput>({
    resolver: zodResolver(changePasswordSchema),
    defaultValues: {
      currentPassword: "",
      newPassword: "",
      newPasswordConfirm: "",
      revokeOtherSessions: true,
    },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    setSubmitting(true);
    try {
      const res = await fetch(`${BACKEND_URL}/api/auth/change-password`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          currentPassword: values.currentPassword,
          newPassword: values.newPassword,
          revokeOtherSessions: values.revokeOtherSessions,
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        let msg = "Password change failed";
        try {
          const parsed = JSON.parse(text);
          msg = parsed.message ?? parsed.error ?? msg;
        } catch {
          if (text) msg = text;
        }
        toast.error(msg);
        form.setError("root", { message: msg });
        return;
      }
      toast.success("Password updated");
      router.replace("/rooms");
    } finally {
      setSubmitting(false);
    }
  });

  return (
    <div className="flex min-h-dvh flex-col">
      <Header />
      <main className="flex-1 p-6">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>Change password</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={onSubmit} className="space-y-4" noValidate>
              <div className="space-y-2">
                <Label htmlFor="currentPassword">Current password</Label>
                <Input
                  id="currentPassword"
                  type="password"
                  autoComplete="current-password"
                  {...form.register("currentPassword")}
                />
                {form.formState.errors.currentPassword && (
                  <p className="text-sm text-destructive">
                    {form.formState.errors.currentPassword.message}
                  </p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="newPassword">New password</Label>
                <Input
                  id="newPassword"
                  type="password"
                  autoComplete="new-password"
                  {...form.register("newPassword")}
                />
                {form.formState.errors.newPassword && (
                  <p className="text-sm text-destructive">
                    {form.formState.errors.newPassword.message}
                  </p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="newPasswordConfirm">Confirm new password</Label>
                <Input
                  id="newPasswordConfirm"
                  type="password"
                  autoComplete="new-password"
                  {...form.register("newPasswordConfirm")}
                />
                {form.formState.errors.newPasswordConfirm && (
                  <p className="text-sm text-destructive">
                    {form.formState.errors.newPasswordConfirm.message}
                  </p>
                )}
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="h-4 w-4"
                  {...form.register("revokeOtherSessions")}
                />
                Sign out other sessions (recommended)
              </label>
              {form.formState.errors.root && (
                <p className="text-sm text-destructive">
                  {form.formState.errors.root.message}
                </p>
              )}
              <Button type="submit" className="w-full" disabled={submitting}>
                {submitting ? "Updating…" : "Update password"}
              </Button>
            </form>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}

export default function PasswordSettingsPage() {
  return (
    <RequireSession>
      <PasswordContent />
    </RequireSession>
  );
}
