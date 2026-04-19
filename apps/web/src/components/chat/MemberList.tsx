"use client";

import type { UserPresenceState } from "@ai-herders/shared/protocol";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { AddFriendButton } from "@/components/contacts/AddFriendButton";
import { PresencePill, usePresence } from "@/components/chat/PresencePill";
import { useSession } from "@/lib/auth-client";

export interface MemberListItem {
  id: string;
  username: string;
  displayName: string;
}

// REQ-215 — v3 §2.2.1 / Appendix A. Text marker beside the displayName so the
// roster is legible even when the color dot is ambiguous (e.g. reduced-motion
// users or low-contrast themes). Online members show no suffix — the dot's
// presence is enough.
function presenceSuffix(state: UserPresenceState): string | null {
  if (state === "away") return "(AFK)";
  if (state === "offline") return "(offline)";
  return null;
}

function MemberRow({ member, isSelf }: { member: MemberListItem; isSelf: boolean }) {
  const presence = usePresence(member.id);
  const suffix = presenceSuffix(presence);
  return (
    <li className="flex items-center gap-2 rounded px-2 py-1 hover:bg-accent/40">
      <PresencePill userId={member.id} />
      <Avatar className="h-6 w-6">
        <AvatarFallback>{member.displayName.slice(0, 1).toUpperCase()}</AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1 text-sm leading-tight">
        <div className="flex items-center gap-1 truncate">
          <span className="truncate">{member.displayName}</span>
          {suffix ? (
            <span className="text-xs text-muted-foreground">{suffix}</span>
          ) : null}
        </div>
        <div className="truncate text-xs text-muted-foreground">
          @{member.username}
        </div>
      </div>
      {!isSelf ? (
        <AddFriendButton
          targetUserId={member.id}
          targetUsername={member.username}
          size="sm"
        />
      ) : null}
    </li>
  );
}

export function MemberList({ members }: { members: MemberListItem[] }) {
  // REQ-052 light-duty: we show the Add-friend affordance next to every
  // non-self member and let the click react to server 409/429s via toast.
  // The richer cross-reference path (fetch /friends + /friends/requests here
  // and pre-render "Friends"/"Pending" badges) would need lifted state
  // that this seeded member list doesn't justify yet — revisit once presence
  // lands real ids.
  const { data } = useSession();
  const currentUserId = data?.user?.id;

  return (
    <aside className="h-full overflow-auto p-3" aria-label="Members">
      <div className="px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
        Members · {members.length}
      </div>
      <ul className="space-y-1">
        {members.map((m) => (
          <MemberRow key={m.id} member={m} isSelf={currentUserId === m.id} />
        ))}
      </ul>
    </aside>
  );
}
