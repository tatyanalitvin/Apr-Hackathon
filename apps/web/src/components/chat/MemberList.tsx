"use client";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";

export interface MemberListItem {
  id: string;
  username: string;
  displayName: string;
  online?: boolean;
}

export function MemberList({ members }: { members: MemberListItem[] }) {
  return (
    <aside className="h-full overflow-auto p-3" aria-label="Members">
      <div className="px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
        Members · {members.length}
      </div>
      <ul className="space-y-1">
        {members.map((m) => (
          <li key={m.id} className="flex items-center gap-2 rounded px-2 py-1">
            <span className={`inline-block h-2 w-2 rounded-full ${m.online ? "bg-green-500" : "bg-muted-foreground/40"}`} aria-label={m.online ? "online" : "offline"} />
            <Avatar className="h-6 w-6">
              <AvatarFallback>{m.displayName.slice(0, 1).toUpperCase()}</AvatarFallback>
            </Avatar>
            <div className="text-sm">
              <div>{m.displayName}</div>
              <div className="text-xs text-muted-foreground">@{m.username}</div>
            </div>
          </li>
        ))}
      </ul>
    </aside>
  );
}
