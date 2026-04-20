export type ConfidenceTier = "high" | "med" | "low";

export function tierForConfidence(
  confidence: number | undefined,
): { label: "High" | "Med" | "Low"; tier: ConfidenceTier } | null {
  if (confidence === undefined) return null;
  if (confidence >= 0.8) return { label: "High", tier: "high" };
  if (confidence >= 0.5) return { label: "Med", tier: "med" };
  return { label: "Low", tier: "low" };
}

const TIER_STYLE: Record<ConfidenceTier, { bg: string; text: string }> = {
  high: { bg: "var(--success)", text: "var(--bg-base)" },
  med: { bg: "var(--accent)", text: "var(--on-accent)" },
  low: { bg: "var(--warn)", text: "var(--bg-base)" },
};

interface Props {
  confidence: number | undefined;
}

export function ConfidenceChip({ confidence }: Props) {
  const result = tierForConfidence(confidence);
  if (!result) return null;
  const style = TIER_STYLE[result.tier];
  return (
    <span
      className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums"
      style={{ background: style.bg, color: style.text }}
    >
      {result.label}
    </span>
  );
}
