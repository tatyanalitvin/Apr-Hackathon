"use client";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { AddFriendButton } from "@/components/contacts/AddFriendButton";
import { useSession } from "@/lib/auth-client";

export interface MemberListItem {
  id: string;
  username: string;
  displayName: string;
  online?: boolean;
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
        {members.map((m) => {
          const isSelf = currentUserId === m.id;
          return (
            <li
              key={m.id}
              className="flex items-center gap-2 rounded px-2 py-1 hover:bg-accent/40"
            >
              <span
                className={`inline-block h-2 w-2 rounded-full ${m.online ? "bg-green-500" : "bg-muted-foreground/40"}`}
                aria-label={m.online ? "online" : "offline"}
              />
              <Avatar className="h-6 w-6">
                <AvatarFallback>{m.displayName.slice(0, 1).toUpperCase()}</AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1 text-sm leading-tight">
                <div className="truncate">{m.displayName}</div>
                <div className="truncate text-xs text-muted-foreground">
                  @{m.username}
                </div>
              </div>
              {!isSelf ? (
                <AddFriendButton
                  targetUserId={m.id}
                  targetUsername={m.username}
                  size="sm"
                />
              ) : null}
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
