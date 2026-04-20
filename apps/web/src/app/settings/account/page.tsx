// REQ-126 (GDPR export) + REQ-017 (account deletion) — user-facing
// controls live here. Export streams a JSON download from the backend;
// delete opens a modal that requires the user to re-enter their
// password and then routes back to /register on success.
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { RequireSession } from "@/components/chat/RequireSession";
import { Header } from "@/components/chat/Header";
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
import { deleteAccount, downloadAccountExport } from "@/lib/account-api";

function AccountContent() {
  const router = useRouter();
  const [exporting, setExporting] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletePassword, setDeletePassword] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

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

  const onDelete = async () => {
    setDeleteError(null);
    setDeleting(true);
    try {
      await deleteAccount(deletePassword);
      toast.success("Account deleted");
      router.replace("/register");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Deletion failed";
      setDeleteError(message);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="flex min-h-dvh flex-col">
      <Header />
      <main id="main" className="mx-auto w-full max-w-2xl px-6 py-10 space-y-6">
        <h1 className="font-display text-4xl" style={{ color: "var(--text-hi)" }}>Account</h1>
        <div
          className="rounded-[var(--radius)] p-6 space-y-6"
          style={{ background: "var(--bg-elevated)", boxShadow: "inset 0 1px 0 var(--glass-border)" }}
        >
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
                  setDeletePassword("");
                  setDeleteError(null);
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
          if (!deleting) setDeleteOpen(open);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete account?</DialogTitle>
            <DialogDescription>
              Enter your password to confirm. You&apos;ll be signed out on all
              devices and your friendships, DM threads, and room memberships
              will be removed.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="delete-password">Password</Label>
            <Input
              id="delete-password"
              type="password"
              autoComplete="current-password"
              value={deletePassword}
              onChange={(e) => setDeletePassword(e.target.value)}
              disabled={deleting}
            />
            {deleteError && (
              <p className="text-sm text-destructive">{deleteError}</p>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteOpen(false)}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={onDelete}
              disabled={deleting || deletePassword.length === 0}
              // UX(ui-pass P0-4) — mirror the page-level Delete button; keep
              // the primary confirm readable while disabled (empty password).
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90 disabled:bg-destructive/70 disabled:text-destructive-foreground disabled:opacity-100"
            >
              {deleting ? "Deleting…" : "Delete account"}
            </Button>
          </DialogFooter>
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
