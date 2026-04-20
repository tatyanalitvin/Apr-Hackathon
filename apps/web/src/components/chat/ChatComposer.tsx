import type { ReactNode } from "react";

interface ChatComposerProps {
  children: ReactNode;
}

export function ChatComposer({ children }: ChatComposerProps) {
  return (
    <div className="pointer-events-none relative px-3 pb-3 pt-10">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 -top-4 h-10"
        style={{
          background: "linear-gradient(to top, var(--bg-base), transparent)",
        }}
      />
      <div className="pointer-events-auto glass-panel p-3">
        {children}
      </div>
    </div>
  );
}
