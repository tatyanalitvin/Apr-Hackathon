export function StreamingShimmer() {
  return (
    <span className="pointer-events-none absolute inset-x-0 bottom-0 h-px overflow-hidden rounded-b-[var(--radius)]" aria-hidden="true">
      <span
        className="shimmer-sweep block h-full w-1/3"
        style={{
          background: "linear-gradient(90deg, transparent, var(--accent), var(--blossom), transparent)",
          animation: "shimmer-sweep 1.4s linear infinite",
        }}
      />
    </span>
  );
}
