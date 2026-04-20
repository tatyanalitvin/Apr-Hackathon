export const AVATAR_BG_PALETTE = [
  "#7C3AED", // violet-600
  "#4C1D95", // violet-900
  "#BE185D", // pink-700
  "#047857", // emerald-700
  "#B45309", // amber-700
  "#6D28D9", // violet-700
  "#831843", // rose-900
  "#0F766E", // teal-700
] as const;

export function hashUserIdToPalette(userId: string): number {
  let h = 5381;
  for (let i = 0; i < userId.length; i++) {
    h = ((h << 5) + h + userId.charCodeAt(i)) & 0xffffffff;
  }
  return Math.abs(h) % AVATAR_BG_PALETTE.length;
}

export function getInitials(name?: string, userId?: string): string {
  const source = (name ?? userId ?? "").trim();
  if (!source) return "?";
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0]!;
  if (parts.length >= 2) {
    const last = parts[parts.length - 1]!;
    return (first[0]! + last[0]!).toUpperCase();
  }
  return first[0]!.toUpperCase();
}

interface Props {
  userId: string;
  name?: string;
  size?: number;
  className?: string;
}

export function Avatar({ userId, name, size = 32, className }: Props) {
  const idx = hashUserIdToPalette(userId);
  const bg = AVATAR_BG_PALETTE[idx];
  const initials = getInitials(name, userId);
  return (
    <div
      className={`inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold ${className ?? ""}`}
      style={{
        width: size,
        height: size,
        background: bg,
        color: "var(--accent-soft)",
        fontSize: Math.round(size * 0.4),
        lineHeight: 1,
      }}
      aria-label={name ? `${name}'s avatar` : "User avatar"}
      role="img"
    >
      {initials}
    </div>
  );
}
