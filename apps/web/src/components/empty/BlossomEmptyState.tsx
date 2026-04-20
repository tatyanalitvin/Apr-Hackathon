import type { ReactNode } from "react";

interface Props {
  tagline: string;
  children?: ReactNode;
}

export function BlossomEmptyState({ tagline, children }: Props) {
  return (
    <div className="flex flex-col items-center justify-center gap-6 py-20 text-center">
      <svg
        viewBox="0 0 120 120"
        className="h-32 w-32 opacity-20"
        fill="currentColor"
        style={{ color: "var(--blossom)" }}
        aria-hidden="true"
      >
        <path d="M60 10c7 15 20 20 30 20 0 10-5 22-15 30 10 7 15 20 15 30-10 0-22-5-30-15-7 10-20 15-30 15 0-10 5-22 15-30-10-7-15-20-15-30 10 0 22-5 30-20z" />
      </svg>
      <p className="font-display italic text-[22px]" style={{ color: "var(--text-lo)" }}>
        {tagline}
      </p>
      {children}
    </div>
  );
}
