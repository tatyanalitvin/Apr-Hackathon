import type { ReactNode } from "react";
import { SakuraPetals } from "./SakuraPetals";

interface AuthSplitLayoutProps {
  headline: string;
  tagline?: string;
  children: ReactNode;
}

export function AuthSplitLayout({ headline, tagline, children }: AuthSplitLayoutProps) {
  return (
    <main id="main" className="min-h-dvh flex flex-col md:flex-row">
      <section className="relative flex flex-1 items-center justify-center overflow-hidden px-8 py-16 md:py-0 md:min-h-dvh">
        <SakuraPetals />
        <div className="relative z-10 max-w-md">
          <h1 className="font-display text-5xl leading-[0.95] tracking-[-0.03em] text-text-hi md:text-7xl" style={{ color: "var(--text-hi)" }}>
            AI Herders Jam
          </h1>
          <p className="mt-4 font-display italic text-2xl" style={{ color: "var(--text-lo)" }}>
            {headline}
          </p>
          {tagline ? (
            <p className="mt-6 text-sm" style={{ color: "var(--text-lo)" }}>{tagline}</p>
          ) : null}
        </div>
      </section>
      <section className="flex flex-1 items-center justify-center px-6 py-12 md:py-0">
        <div className="glass-panel w-full max-w-[440px] p-8">
          {children}
        </div>
      </section>
    </main>
  );
}
