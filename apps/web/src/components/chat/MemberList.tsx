"use client";

import { useMemo, useState } from "react";
import type { UserPresenceState } from "@ai-herders/shared/protocol";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { AddFriendButton } from "@/components/contacts/AddFriendButton";
import { PresencePill, usePresence } from "@/components/chat/PresencePill";
import { useSession } from "@/lib/auth-client";

// PERF-01 — seeded dev state has 2,969 members in #general, which renders
// ~90k DOM nodes and stutters mobile scroll. Render a window and let the
// user expand. Threshold is high enough that small/mid rooms are unaffected;
// if we later adopt react-virtuoso for the sidebar we can drop this gate.
const INITIAL_WINDOW = 50;
const EXPAND_STEP = 200;

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
  const [windowSize, setWindowSize] = useState(INITIAL_WINDOW);
  const visible = useMemo(
    () => (members.length <= INITIAL_WINDOW ? members : members.slice(0, windowSize)),
    [members, windowSize],
  );
  const remaining = Math.max(0, members.length - visible.length);

  return (
    <aside className="h-full overflow-auto p-3" aria-label="Members">
      <div className="px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
        Members · {members.length}
      </div>
      <ul className="space-y-1">
        {visible.map((m) => (
          <MemberRow key={m.id} member={m} isSelf={currentUserId === m.id} />
        ))}
      </ul>
      {remaining > 0 ? (
        <div className="px-1 pt-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="w-full justify-center text-xs text-muted-foreground"
            onClick={() => setWindowSize((n) => n + EXPAND_STEP)}
          >
            Show {Math.min(EXPAND_STEP, remaining)} more ({remaining} hidden)
          </Button>
        </div>
      ) : null}
    </aside>
  );
}
