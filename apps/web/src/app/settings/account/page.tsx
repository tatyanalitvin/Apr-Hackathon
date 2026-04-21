// REQ-126 (GDPR export) + REQ-017 (account deletion) — user-facing
// controls live here. Export streams a JSON download from the backend;
// delete opens a modal that requires the user to re-enter their
// password and then routes back to /register on success.
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { RequireSession } from "@/components/chat/RequireSession";
import { Header } from "@/components/chat/Header";
import { SettingsNav } from "@/components/settings/SettingsNav";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  deleteAccount,
  DeleteAccountError,
  downloadAccountExport,
} from "@/lib/account-api";
import { applyAuthIssues } from "@/lib/auth-api";

type DeleteFormInput = { password: string };

function AccountContent() {
  const router = useRouter();
  const [exporting, setExporting] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const deleteForm = useForm<DeleteFormInput>({
    defaultValues: { password: "" },
  });

  const onExport = async () => {
    setExporting(true);
    try {
      await downloadAccountExport();
      toast.success("Export downloaded");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Export failed";
      toast.error(message);
    } finally {
      setExporting(false);
    }
  };

  const onDelete = deleteForm.handleSubmit(async (values) => {
    deleteForm.clearErrors();
    try {
      await deleteAccount(values.password);
      // Close the dialog before the redirect-delay so the user doesn't see
      // a "Deleting…" spinner on a confirm modal for an already-deleted
      // account. The Toaster lives on the page (not in the dialog), so the
      // toast still has a 600ms window to paint before router.replace
      // tears the route down — that delay was the original reason for the
      // setTimeout (immediate replace was swallowing the toast because the
      // Toaster unmounts with the route).
      setDeleteOpen(false);
      toast.success("Account deleted");
      window.setTimeout(() => router.replace("/register"), 600);
    } catch (err) {
      if (err instanceof DeleteAccountError) {
        // Walk the zod-envelope issues[] and attach each to the
        // (only) "password" field for this form. Non-password issues
        // fall through to the toast branch below.
        const attached = applyAuthIssues(err.envelope, deleteForm, {
          password: "password",
        });
        if (attached) return;
        toast.error(err.message);
        return;
      }
      const message = err instanceof Error ? err.message : "Deletion failed";
      toast.error(message);
    }
  });

  return (
    <div className="flex min-h-dvh flex-col">
      <Header />
      <main id="main" className="mx-auto w-full max-w-2xl px-6 py-10 space-y-6">
        <div className="hero-stagger space-y-4">
          <h1 className="font-display text-4xl" style={{ color: "var(--text-hi)" }}>
            Account
          </h1>
          <SettingsNav />
        </div>
        <div className="glass-panel panel-reveal p-6 space-y-6">
          <section>
            <h2 className="font-semibold text-lg" style={{ color: "var(--text-hi)" }}>Export account data</h2>
            <div className="mt-4 space-y-4">
              <p className="text-sm text-muted-foreground">
                Download a JSON file containing your profile, rooms, messages,
                DMs, friendships, and sessions.
              </p>
              <Button onClick={onExport} disabled={exporting}>
                {exporting ? "Preparing…" : "Download export"}
              </Button>
            </div>
          </section>

          <section>
            <h2 className="font-semibold text-lg text-destructive">Delete account</h2>
            <div className="mt-4 space-y-4">
              <p className="text-sm text-muted-foreground">
                Removes your profile and sign-in access. Messages you sent stay
                in rooms but show as &quot;[deleted user]&quot;. This cannot be
                undone.
              </p>
              <Button
                variant="destructive"
                onClick={() => {
                  deleteForm.reset({ password: "" });
                  setDeleteOpen(true);
                }}
                // UX(ui-pass P0-4) — dark-theme destructive fill desaturates
                // over the lavender glass card and reads "disabled". Hold
                // full --destructive + light foreground at rest and disabled.
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90 disabled:bg-destructive/70 disabled:text-destructive-foreground disabled:opacity-100"
              >
                Delete my account…
              </Button>
            </div>
          </section>
        </div>
      </main>

      <Dialog
        open={deleteOpen}
        onOpenChange={(open) => {
          if (!deleteForm.formState.isSubmitting) setDeleteOpen(open);
        }}
      >
        <DialogContent>
          <form onSubmit={onDelete} noValidate>
            <DialogHeader>
              <DialogTitle>Delete account?</DialogTitle>
              <DialogDescription>
                Enter your password to confirm. You&apos;ll be signed out on all
                devices and your friendships, DM threads, and room memberships
                will be removed.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2 py-4">
              <Label htmlFor="delete-password">Password</Label>
              <Input
                id="delete-password"
                type="password"
                autoComplete="current-password"
                aria-invalid={Boolean(
                  deleteForm.formState.errors.password,
                )}
                disabled={deleteForm.formState.isSubmitting}
                {...deleteForm.register("password")}
              />
              {deleteForm.formState.errors.password && (
                <p className="text-sm text-destructive">
                  {deleteForm.formState.errors.password.message}
                </p>
              )}
              {deleteForm.formState.errors.root && (
                <p className="text-sm text-destructive">
                  {deleteForm.formState.errors.root.message}
                </p>
              )}
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setDeleteOpen(false)}
                disabled={deleteForm.formState.isSubmitting}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="destructive"
                disabled={
                  deleteForm.formState.isSubmitting ||
                  (deleteForm.watch("password") ?? "").length === 0
                }
                // UX(ui-pass P0-4) — mirror the page-level Delete button; keep
                // the primary confirm readable while disabled (empty password).
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90 disabled:bg-destructive/70 disabled:text-destructive-foreground disabled:opacity-100"
              >
                {deleteForm.formState.isSubmitting
                  ? "Deleting…"
                  : "Delete account"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function AccountSettingsPage() {
  return (
    <RequireSession>
      <AccountContent />
    </RequireSession>
  );
}
