// Tabbed shell replacing the former RoomSettingsModal. The gear-icon trigger
// and Dialog lifecycle stay here; each tab is owned by a different parallel
// agent and lives as its own file in this directory so edits don't collide.
//
// Tabs: Members / Admins / Banned (agent A) | Invitations (agent B) |
//       Settings (existing rename / delete / leave — unchanged).
// Non-owners only see Settings (the Leave affordance); the other tabs are
// creator/admin-gated and hidden for plain members.

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LogOut, Settings2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { createChatApi } from "@/lib/socket";
import { MembersTab } from "./MembersTab";
import { AdminsTab } from "./AdminsTab";
import { BannedTab } from "./BannedTab";
import { InvitationsTab } from "./InvitationsTab";
import { SettingsTab } from "./SettingsTab";

// REQ-209/210/211 open Q2 — Role union widens to include 'admin'. The
// moderation tabs are visible when role !== 'member'; plain members see only
// the Settings (leave-room) body, matching the prior shell behaviour.
type Role = "owner" | "admin" | "member";

interface ManageRoomModalProps {
  roomId: string;
  roomName: string;
  role: Role;
  onRenamed?: (nextName: string) => void;
  onLeftOrDeleted?: () => void;
}

export function ManageRoomModal({
  roomId,
  roomName,
  role,
  onRenamed,
  onLeftOrDeleted,
}: ManageRoomModalProps) {
  const canModerate = role !== "member";

  if (!canModerate) {
    // Plain members used to see a gear icon that opened a dialog whose only
    // action was "Leave room" — the Settings dressing misrepresented what the
    // button actually does. Render a single Leave affordance instead so the
    // icon matches the action. Owners/admins still get the full tabbed shell
    // below.
    return (
      <LeaveRoomButton
        roomId={roomId}
        roomName={roomName}
        onLeft={onLeftOrDeleted}
      />
    );
  }

  return (
    <ManageRoomDialog
      roomId={roomId}
      roomName={roomName}
      role={role}
      onRenamed={onRenamed}
      onLeftOrDeleted={onLeftOrDeleted}
    />
  );
}

function ManageRoomDialog({
  roomId,
  roomName,
  role,
  onRenamed,
  onLeftOrDeleted,
}: ManageRoomModalProps) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          aria-label="Manage room"
        >
          <Settings2 className="h-4 w-4" aria-hidden />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>#{roomName}</DialogTitle>
          <DialogDescription>
            Manage members, invitations, and room settings.
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="members" className="tab-bloom mt-2">
          <TabsList>
            <TabsTrigger value="members">Members</TabsTrigger>
            <TabsTrigger value="admins">Admins</TabsTrigger>
            <TabsTrigger value="banned">Banned</TabsTrigger>
            <TabsTrigger value="invitations">Invitations</TabsTrigger>
            <TabsTrigger value="settings">Settings</TabsTrigger>
          </TabsList>
          <TabsContent value="members" className="mt-4">
            <MembersTab roomId={roomId} roomName={roomName} viewerRole={role} />
          </TabsContent>
          <TabsContent value="admins" className="mt-4">
            <AdminsTab roomId={roomId} viewerRole={role} />
          </TabsContent>
          <TabsContent value="banned" className="mt-4">
            <BannedTab roomId={roomId} roomName={roomName} viewerRole={role} />
          </TabsContent>
          <TabsContent value="invitations" className="mt-4">
            <InvitationsTab roomId={roomId} />
          </TabsContent>
          <TabsContent value="settings" className="mt-4">
            <SettingsTab
              roomId={roomId}
              roomName={roomName}
              role={role}
              open={open}
              onClose={() => setOpen(false)}
              onRenamed={onRenamed}
              onLeftOrDeleted={onLeftOrDeleted}
            />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function LeaveRoomButton({
  roomId,
  roomName,
  onLeft,
}: {
  roomId: string;
  roomName: string;
  onLeft?: () => void;
}) {
  const router = useRouter();
  const [api] = useState(() => createChatApi());
  const [leaving, setLeaving] = useState(false);

  async function handleLeave() {
    const confirmed =
      typeof window !== "undefined" &&
      window.confirm(
        `Leave #${roomName}? You'll stop receiving messages from this room.`,
      );
    if (!confirmed) return;
    setLeaving(true);
    const r = await api.leaveRoom(roomId);
    setLeaving(false);
    if (r.ok) {
      toast.success(`Left #${roomName}.`);
      onLeft?.();
      router.push("/rooms");
      return;
    }
    if (r.error.code === "forbidden" && r.error.message === "owner_cannot_leave") {
      toast.error("Owners can't leave — delete the room instead.");
      return;
    }
    toast.error("Couldn't leave room — try again.");
  }

  return (
    <Button
      size="icon"
      variant="ghost"
      className="h-7 w-7"
      aria-label="Leave room"
      disabled={leaving}
      onClick={() => void handleLeave()}
    >
      <LogOut className="h-4 w-4" aria-hidden />
    </Button>
  );
}
