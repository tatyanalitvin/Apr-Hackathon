"use client";

import { useEffect, useMemo, useState } from "react";
import type { UserPresenceState } from "@ai-herders/shared/protocol";
import { Avatar } from "@/components/avatar/Avatar";
import { Button } from "@/components/ui/button";
import { AddFriendButton } from "@/components/contacts/AddFriendButton";
import { PresencePill, usePresence } from "@/components/chat/PresencePill";
import { presenceStore } from "@/lib/presence-store";
import { useSession } from "@/lib/auth-client";

// PERF-01 — seeded dev state has 2,969 members in #general, which renders
// ~90k DOM nodes and stutters mobile scroll. Render a window and let the
// user expand. Threshold is high enough that small/mid rooms are unaffected;
// if we later adopt react-virtuoso for the sidebar we can drop this gate.
const INITIAL_WINDOW = 50;
const EXPAND_STEP = 200;

// Round-3 — display sort by presence so Online rises to the top, Away next,
// Offline last. The windowing runs AFTER this sort so the visible 50 rows
// foreground the people the user can actually talk to right now.
const PRESENCE_ORDER: Record<UserPresenceState, number> = {
  online: 0,
  away: 1,
  offline: 2,
};

const PRESENCE_LABEL: Record<UserPresenceState, string> = {
  online: "Online",
  away: "Away",
  offline: "Offline",
};

const PRESENCE_DOT: Record<UserPresenceState, string> = {
  online: "bg-green-500",
  away: "bg-amber-400",
  offline: "bg-muted-foreground/40",
};

export interface MemberListItem {
  id: string;
  username: string;
  displayName: string;
}

// Subscribe to the visible window's presence states so the list can
// re-group when a single user transitions. Scoped to the rendered slice —
// a 2,969-member room never subscribes past INITIAL_WINDOW ids at a time.
function useVisiblePresenceMap(
  ids: string[],
): Record<string, UserPresenceState> {
  const [, setTick] = useState(0);
  const key = ids.join("|");
  useEffect(() => {
    const unsubs = ids.map((id) =>
      presenceStore.subscribe(id, () => setTick((t) => t + 1)),
    );
    return () => {
      for (const u of unsubs) u();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return useMemo(() => {
    const out: Record<string, UserPresenceState> = {};
    for (const id of ids) out[id] = presenceStore.getState(id);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}

function MemberRow({
  member,
  isSelf,
  selfPresence,
}: {
  member: MemberListItem;
  isSelf: boolean;
  // UX-03 / round-2 P2-10 — the self-row pulls presence from the same live
  // idle-state RoomClient feeds to the Header pill. The presenceStore never
  // receives a `presence.changed` for the caller's own id (the server only
  // fans out transitions for *other* users), so without this override the
  // self-row would read "Alice (offline)" while the Header says "online".
  // Non-self rows keep using the presenceStore, identical to before.
  selfPresence?: UserPresenceState;
}) {
  const storePresence = usePresence(member.id);
  const presence = isSelf && selfPresence ? selfPresence : storePresence;
  // Round-3 — previously we appended "(AFK)" / "(offline)" beside the name
  // so the roster was legible without relying on the pill colour. With glass
  // group headers ("Online · N / Away · N / Offline · N") introduced in the
  // same pass, the suffix became duplicated copy in three places (dot +
  // header + text). Discord/Slack/Teams pattern: dim non-online rows so the
  // bucket is legible at a glance, keep the state text as a native hover
  // tooltip on the row, and preserve REQ-215's a11y via PresencePill's
  // aria-label. Online stays fully saturated; away/offline dim gently so
  // the roster reads as a gradient of availability.
  const hoverTitle =
    presence === "online"
      ? `${member.displayName} — online`
      : presence === "away"
        ? `${member.displayName} — away (AFK)`
        : `${member.displayName} — offline`;
  return (
    <li
      className="member-row flex items-center gap-2 rounded px-2 py-1 hover:bg-accent/40"
      data-presence={presence}
      title={hoverTitle}
    >
      <PresencePill
        userId={member.id}
        state={isSelf && selfPresence ? selfPresence : undefined}
      />
      <Avatar
        userId={member.id}
        name={member.displayName}
        size={24}
        presence={presence}
      />
      <div className="min-w-0 flex-1 text-sm leading-tight">
        <div className="truncate">{member.displayName}</div>
        <div className="truncate text-xs text-muted-foreground">
          @{member.username}
        </div>
      </div>
      {!isSelf ? (
        <AddFriendButton
          targetUserId={member.id}
          targetUsername={member.username}
          size="sm"
          // UX(ui-pass P1-5) — icon-only in the roster so five non-friend rows
          // don't outweigh five 24px avatars. Full label still used on the
          // Contacts page where the affordance is the primary CTA.
          compact
        />
      ) : null}
    </li>
  );
}

function GroupHeader({
  state,
  count,
}: {
  state: UserPresenceState;
  count: number;
}) {
  return (
    <li aria-hidden className="list-none">
      <div className="member-group-header" role="presentation">
        <span className={`dot ${PRESENCE_DOT[state]}`} />
        <span>{PRESENCE_LABEL[state]}</span>
        <span className="count">· {count}</span>
      </div>
    </li>
  );
}

export function MemberList({
  members,
  selfPresence,
}: {
  members: MemberListItem[];
  // Optional — when provided (and a row matches the current user's id) this
  // state drives that row's pill + suffix instead of the presence-store.
  // Mirrors the Header's `selfPresence` override so both surfaces stay in
  // lockstep. Callers outside the room view can omit it and rows behave as
  // they did before.
  selfPresence?: UserPresenceState;
}) {
  // REQ-052 light-duty: we show the Add-friend affordance next to every
  // non-self member and let the click react to server 409/429s via toast.
  // The richer cross-reference path (fetch /friends + /friends/requests here
  // and pre-render "Friends"/"Pending" badges) would need lifted state
  // that this seeded member list doesn't justify yet — revisit once presence
  // lands real ids.
  const { data } = useSession();
  const currentUserId = data?.user?.id;
  const [windowSize, setWindowSize] = useState(INITIAL_WINDOW);

  // Subscribe to presence for every id in the roster. PERF-01 concern
  // notwithstanding, subscriptions are cheap maps — the render of rows is
  // what we gate via windowSize. The presence map is needed BEFORE slicing
  // so online members rise to the top of the displayed window.
  const allIds = useMemo(() => members.map((m) => m.id), [members]);
  const presenceMap = useVisiblePresenceMap(allIds);

  // Sort by presence priority, keeping ties stable by original order.
  const sorted = useMemo(() => {
    const effectiveState = (m: MemberListItem): UserPresenceState => {
      if (currentUserId === m.id && selfPresence) return selfPresence;
      return presenceMap[m.id] ?? "offline";
    };
    return [...members]
      .map((m, i) => ({ m, i, s: effectiveState(m) }))
      .sort((a, b) => {
        const d = PRESENCE_ORDER[a.s] - PRESENCE_ORDER[b.s];
        return d !== 0 ? d : a.i - b.i;
      })
      .map((x) => x.m);
  }, [members, presenceMap, selfPresence, currentUserId]);

  const visible = useMemo(
    () => (sorted.length <= INITIAL_WINDOW ? sorted : sorted.slice(0, windowSize)),
    [sorted, windowSize],
  );
  const remaining = Math.max(0, sorted.length - visible.length);

  // Section counts from the FULL roster, not just the window — users want
  // to know there are 2,834 offline members even when only 50 are rendered.
  const totalCounts = useMemo(() => {
    const counts: Record<UserPresenceState, number> = {
      online: 0,
      away: 0,
      offline: 0,
    };
    for (const m of members) {
      const s =
        currentUserId === m.id && selfPresence
          ? selfPresence
          : presenceMap[m.id] ?? "offline";
      counts[s] += 1;
    }
    return counts;
  }, [members, presenceMap, selfPresence, currentUserId]);

  // Walk the visible slice and drop group markers on state transitions so
  // headers only appear for states that have at least one visible row.
  const rendered = useMemo(() => {
    const nodes: Array<
      | { kind: "header"; state: UserPresenceState }
      | { kind: "row"; member: MemberListItem }
    > = [];
    let last: UserPresenceState | null = null;
    for (const m of visible) {
      const s =
        currentUserId === m.id && selfPresence
          ? selfPresence
          : presenceMap[m.id] ?? "offline";
      if (s !== last) {
        nodes.push({ kind: "header", state: s });
        last = s;
      }
      nodes.push({ kind: "row", member: m });
    }
    return nodes;
  }, [visible, presenceMap, selfPresence, currentUserId]);

  return (
    <aside className="h-full overflow-auto p-3" aria-label="Members">
      <div className="px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
        Members · {members.length}
      </div>
      <ul className="room-list-stagger space-y-1">
        {rendered.map((node, idx) =>
          node.kind === "header" ? (
            <GroupHeader
              key={`h-${node.state}-${idx}`}
              state={node.state}
              count={totalCounts[node.state]}
            />
          ) : (
            <MemberRow
              key={node.member.id}
              member={node.member}
              isSelf={currentUserId === node.member.id}
              selfPresence={selfPresence}
            />
          ),
        )}
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
