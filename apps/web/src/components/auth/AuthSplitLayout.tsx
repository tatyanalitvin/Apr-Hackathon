import type { ReactNode } from "react";
import { SakuraPetals, type VariantKey } from "./SakuraPetals";
import { ThemeToggle } from "@/components/theme-toggle";

interface AuthSplitLayoutProps {
  headline: string;
  tagline?: string;
  variant?: VariantKey;
  children: ReactNode;
}

export function AuthSplitLayout({ headline, tagline, variant, children }: AuthSplitLayoutProps) {
  return (
    <main id="main" className="min-h-dvh flex flex-col md:flex-row">
      <section className="relative flex flex-1 items-center justify-center overflow-hidden px-8 py-16 md:py-0 md:min-h-dvh">
        <SakuraPetals variant={variant} />
        <div className="relative z-10 max-w-md">
          <h1 className="font-display text-5xl leading-[0.95] tracking-[-0.03em] md:text-7xl" style={{ color: "var(--text-hi)" }}>
            AI Herders Jam
          </h1>
          <p className="mt-4 font-display italic text-2xl" style={{ color: "var(--text-lo)" }}>
            {headline}
          </p>
          {tagline ? (
            <p className="mt-6 text-sm" style={{ color: "var(--text-lo)" }}>{tagline}</p>
          ) : null}
        </div>
        <div className="absolute bottom-6 left-6 z-10">
          <ThemeToggle size="default" />
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
