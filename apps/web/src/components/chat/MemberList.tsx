"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
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

// Default collapsed state — Offline often dominates large rooms (e.g. 2,834
// of 2,969 in seeded #general). Collapsing it by default keeps the roster
// focused on the people the user can actually message now, and the header
// still surfaces the count so the hidden pool is discoverable. Online/Away
// default expanded because their membership is the point of looking here.
const DEFAULT_COLLAPSED: Record<UserPresenceState, boolean> = {
  online: false,
  away: false,
  offline: true,
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
  collapsed,
  onToggle,
  panelId,
}: {
  state: UserPresenceState;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  panelId: string;
}) {
  return (
    <li className="list-none">
      <button
        type="button"
        className="member-group-header"
        aria-expanded={!collapsed}
        aria-controls={panelId}
        onClick={onToggle}
      >
        <ChevronRight
          className={`chevron h-3 w-3 transition-transform duration-200 ${
            collapsed ? "" : "rotate-90"
          }`}
          aria-hidden
        />
        <span className={`dot ${PRESENCE_DOT[state]}`} />
        <span>{PRESENCE_LABEL[state]}</span>
        <span className="count">· {count}</span>
      </button>
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
  const [collapsed, setCollapsed] =
    useState<Record<UserPresenceState, boolean>>(DEFAULT_COLLAPSED);

  const toggleGroup = (s: UserPresenceState) =>
    setCollapsed((prev) => ({ ...prev, [s]: !prev[s] }));

  // Subscribe to presence for every id in the roster. PERF-01 concern
  // notwithstanding, subscriptions are cheap maps — the render of rows is
  // what we gate via windowSize. The presence map is needed BEFORE slicing
  // so online members rise to the top of the displayed window.
  const allIds = useMemo(() => members.map((m) => m.id), [members]);
  const presenceMap = useVisiblePresenceMap(allIds);

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

  // Partition members into buckets. Stable order within each bucket
  // (original array order) so the list doesn't jitter when presence flips.
  const buckets = useMemo(() => {
    const out: Record<UserPresenceState, MemberListItem[]> = {
      online: [],
      away: [],
      offline: [],
    };
    for (const m of members) {
      const s =
        currentUserId === m.id && selfPresence
          ? selfPresence
          : presenceMap[m.id] ?? "offline";
      out[s].push(m);
    }
    return out;
  }, [members, presenceMap, selfPresence, currentUserId]);

  // Build the flat visible list by walking buckets in priority order,
  // skipping collapsed ones, and honouring the PERF-01 window across the
  // combined expanded pool. Headers for collapsed groups still render
  // (they're cheap and essential for discoverability), but their rows
  // aren't emitted — so a collapsed 2,834-offline bucket costs one header
  // and zero rows.
  const { nodes, remaining } = useMemo(() => {
    const orderedStates: UserPresenceState[] = ["online", "away", "offline"];
    const flatExpanded: Array<{ state: UserPresenceState; member: MemberListItem }> =
      [];
    for (const s of orderedStates) {
      if (collapsed[s]) continue;
      for (const m of buckets[s]) flatExpanded.push({ state: s, member: m });
    }
    const visible =
      flatExpanded.length <= INITIAL_WINDOW
        ? flatExpanded
        : flatExpanded.slice(0, windowSize);

    // Which states have at least one row in the visible slice?
    const visibleStates = new Set<UserPresenceState>();
    for (const v of visible) visibleStates.add(v.state);

    // Emit header for every non-empty bucket (collapsed OR expanded) so
    // users can always click to reveal. Expanded-but-empty buckets are
    // skipped so we don't render headers for presence states that have
    // no members at all.
    const n: Array<
      | { kind: "header"; state: UserPresenceState }
      | { kind: "row"; member: MemberListItem }
    > = [];
    for (const s of orderedStates) {
      if (totalCounts[s] === 0) continue;
      n.push({ kind: "header", state: s });
      if (collapsed[s]) continue;
      for (const v of visible) {
        if (v.state !== s) continue;
        n.push({ kind: "row", member: v.member });
      }
    }
    return { nodes: n, remaining: Math.max(0, flatExpanded.length - visible.length) };
  }, [buckets, collapsed, totalCounts, windowSize]);

  return (
    <aside className="h-full overflow-auto p-3" aria-label="Members">
      <div className="px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
        Members · {members.length}
      </div>
      <ul className="room-list-stagger space-y-1">
        {nodes.map((node, idx) =>
          node.kind === "header" ? (
            <GroupHeader
              key={`h-${node.state}`}
              state={node.state}
              count={totalCounts[node.state]}
              collapsed={collapsed[node.state]}
              onToggle={() => toggleGroup(node.state)}
              panelId={`member-group-${node.state}`}
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
