// REQ-016 — Password change UI.
// Calls POST /api/auth/change-password on the Fastify backend (better-auth
// endpoint; verified in node_modules/better-auth/dist/api/routes/update-user.d.mts).
// Uses plain fetch() with credentials:"include" rather than the
// auth-client path-to-object proxy so the call site is boring and
// explicit about headers and cookies.
"use client";

import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { RequireSession } from "@/components/chat/RequireSession";
import { Header } from "@/components/chat/Header";
import { BACKEND_URL } from "@/lib/backend";
import { applyAuthIssues } from "@/lib/auth-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, "Current password is required"),
    // REQ-006 — match registerSchema's min(12)/max(128). Any future drift
    // would let users bypass the policy via /settings/password.
    newPassword: z
      .string()
      .min(12, "password_too_short: password must be at least 12 characters")
      .max(128, "password_too_long: password must be at most 128 characters"),
    newPasswordConfirm: z.string(),
    revokeOtherSessions: z.boolean(),
  })
  .superRefine((val, ctx) => {
    if (val.newPassword !== val.newPasswordConfirm) {
      ctx.addIssue({
        code: "custom",
        path: ["newPasswordConfirm"],
        // Plain copy for the user — the machine-code prefix
        // `password_mismatch:` was leaking into the UI.
        message: "Passwords do not match.",
      });
    }
  });
type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

function PasswordContent() {
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
    let res: Response;
    try {
      res = await fetch(`${BACKEND_URL}/api/auth/change-password`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          currentPassword: values.currentPassword,
          newPassword: values.newPassword,
          revokeOtherSessions: values.revokeOtherSessions,
        }),
      });
    } catch {
      toast.error("Network error — try again.");
      return;
    }
    if (res.ok) {
      // Stay on page + reset form; sonner's default toast duration survives
      // the re-render. No router.replace — the old code navigated away and
      // swallowed the success toast, and there's no reason to leave /settings
      // after a successful password change.
      form.reset({
        currentPassword: "",
        newPassword: "",
        newPasswordConfirm: "",
        revokeOtherSessions: values.revokeOtherSessions,
      });
      toast.success("Password updated");
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

    // Pass `newPassword` here so `path:["password"]` issues (from the
    // backend passwordPolicyGuard + zod length checks) land on the newPassword
    // input rather than the (currentPassword) field.
    const attached = applyAuthIssues(body, form, {
      password: "newPassword",
      newPassword: "newPassword",
      newPasswordConfirm: "newPasswordConfirm",
      currentPassword: "currentPassword",
    });
    if (attached) return;

    // No field could be blamed → fall back to a single toast.
    const canonical =
      body?.message ?? body?.code ?? `Password change failed (${res.status})`;
    toast.error(canonical);
  });

  return (
    <div className="flex min-h-dvh flex-col">
      <Header />
      <main id="main" className="mx-auto w-full max-w-md px-6 py-10 space-y-6">
        <h1 className="font-display text-4xl" style={{ color: "var(--text-hi)" }}>Password</h1>
        <div
          className="rounded-[var(--radius)] p-6"
          style={{ background: "var(--bg-elevated)", boxShadow: "inset 0 1px 0 var(--glass-border)" }}
        >
          <form onSubmit={onSubmit} className="space-y-4" noValidate>
            <div className="space-y-2">
              <Label htmlFor="currentPassword">Current password</Label>
              <Input
                id="currentPassword"
                type="password"
                autoComplete="current-password"
                aria-invalid={Boolean(form.formState.errors.currentPassword)}
                aria-describedby={form.formState.errors.currentPassword ? "currentPassword-error" : undefined}
                {...form.register("currentPassword")}
              />
              {form.formState.errors.currentPassword && (
                <p id="currentPassword-error" className="text-sm text-destructive">
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
                aria-invalid={Boolean(form.formState.errors.newPassword)}
                aria-describedby={form.formState.errors.newPassword ? "newPassword-error" : undefined}
                {...form.register("newPassword")}
              />
              {form.formState.errors.newPassword && (
                <p id="newPassword-error" className="text-sm text-destructive">
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
                aria-invalid={Boolean(form.formState.errors.newPasswordConfirm)}
                aria-describedby={form.formState.errors.newPasswordConfirm ? "newPasswordConfirm-error" : undefined}
                {...form.register("newPasswordConfirm")}
              />
              {form.formState.errors.newPasswordConfirm && (
                <p id="newPasswordConfirm-error" className="text-sm text-destructive">
                  {form.formState.errors.newPasswordConfirm.message}
                </p>
              )}
            </div>
            <div className="flex items-center gap-2 text-sm">
              <input
                id="revokeOtherSessions"
                type="checkbox"
                className="h-4 w-4"
                {...form.register("revokeOtherSessions")}
              />
              <Label htmlFor="revokeOtherSessions" className="font-normal">
                Sign out other sessions (recommended)
              </Label>
            </div>
            {form.formState.errors.root && (
              <p className="text-sm text-destructive">
                {form.formState.errors.root.message}
              </p>
            )}
            <Button
              type="submit"
              className="w-full disabled:bg-primary/70 disabled:text-primary-foreground disabled:opacity-100"
              disabled={form.formState.isSubmitting}
            >
              {form.formState.isSubmitting ? "Updating…" : "Update password"}
            </Button>
          </form>
        </div>
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
