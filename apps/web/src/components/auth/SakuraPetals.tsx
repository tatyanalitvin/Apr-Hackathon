const PETALS = [
  { left: "8%", delay: "0s", duration: "48s", size: 18 },
  { left: "22%", delay: "6s", duration: "52s", size: 14 },
  { left: "38%", delay: "12s", duration: "44s", size: 22 },
  { left: "55%", delay: "18s", duration: "58s", size: 16 },
  { left: "70%", delay: "4s", duration: "50s", size: 20 },
  { left: "85%", delay: "22s", duration: "46s", size: 15 },
  { left: "93%", delay: "10s", duration: "56s", size: 18 },
];

export function SakuraPetals() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      {PETALS.map((p, i) => (
        <svg
          key={i}
          className="sakura-drift absolute"
          style={{
            left: p.left,
            width: p.size,
            height: p.size,
            animation: `sakura-drift ${p.duration} linear infinite`,
            animationDelay: p.delay,
            color: "var(--blossom)",
          }}
          viewBox="0 0 24 24"
          fill="currentColor"
        >
          <path d="M12 2c1.5 3 4 4 6 4 0 2-1 4.5-3 6 2 1.5 3 4 3 6-2 0-4.5-1-6-3-1.5 2-4 3-6 3 0-2 1-4.5 3-6-2-1.5-3-4-3-6 2 0 4.5-1 6-4z" />
        </svg>
      ))}
    </div>
  );
}
