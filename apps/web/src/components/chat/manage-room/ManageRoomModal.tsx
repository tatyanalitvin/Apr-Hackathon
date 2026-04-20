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
import { Settings2 } from "lucide-react";
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
  const [open, setOpen] = useState(false);
  const canModerate = role !== "member";

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
            {canModerate
              ? "Manage members, invitations, and room settings."
              : "Leave this room. You can rejoin later from Browse."}
          </DialogDescription>
        </DialogHeader>

        {canModerate ? (
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
        ) : (
          <SettingsTab
            roomId={roomId}
            roomName={roomName}
            role={role}
            open={open}
            onClose={() => setOpen(false)}
            onRenamed={onRenamed}
            onLeftOrDeleted={onLeftOrDeleted}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
