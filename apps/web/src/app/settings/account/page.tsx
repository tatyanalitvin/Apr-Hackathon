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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
      <main className="flex-1 p-6 space-y-6">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>Export account data</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Download a JSON file containing your profile, rooms, messages,
              DMs, friendships, and sessions.
            </p>
            <Button onClick={onExport} disabled={exporting}>
              {exporting ? "Preparing…" : "Download export"}
            </Button>
          </CardContent>
        </Card>

        <Card className="w-full max-w-md border-destructive/40">
          <CardHeader>
            <CardTitle className="text-destructive">Delete account</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
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
            >
              Delete my account…
            </Button>
          </CardContent>
        </Card>
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
