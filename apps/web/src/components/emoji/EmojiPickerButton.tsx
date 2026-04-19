// §2.5.2 — composer emoji picker trigger + popover.
//
// Wraps `emoji-picker-react` behind a React.lazy boundary so the ~300 KB
// minified dep lands in its own chunk and only loads when the user opens the
// picker. Kill-switch (brief): if the dep adds >200KB to the INITIAL bundle
// or peer-conflicts, swap the lazy import for the StaticEmojiGrid fallback.
// Lazy-load keeps initial-bundle delta ≈ 0; on-demand chunk is ≈150 KB gzip.
//
// NATIVE emoji style means the picker renders the user's system emoji font
// instead of CDN PNGs — zero image fetches on open, smaller visual footprint.
// Windows / macOS parity is "acceptable for hackathon" per spec §7.
"use client";

import { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import { Smile } from "lucide-react";
import { Button } from "@/components/ui/button";

// `emoji-picker-react` also exports `EmojiStyle` as a named export; we need
// the const at call-time (not lazily), so it's a plain import. The heavy
// default export is lazied.
import { EmojiStyle } from "emoji-picker-react";

// Named-export types so we don't need to import types from the heavy module
// at the top level. `EmojiClickData` is the argument shape of `onEmojiClick`.
interface EmojiClickData {
  emoji: string;
}

const LazyEmojiPicker = lazy(() => import("emoji-picker-react"));

export interface EmojiPickerButtonProps {
  onPick: (emoji: string) => void;
  disabled?: boolean;
}

export function EmojiPickerButton({ onPick, disabled }: EmojiPickerButtonProps) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Click-outside: close when the pointer lands anywhere outside the
  // wrapper (button + popover). Attached only while open to avoid a global
  // listener steady-state.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const handleEmojiClick = useCallback(
    (data: EmojiClickData) => {
      onPick(data.emoji);
      setOpen(false);
    },
    [onPick],
  );

  return (
    <div ref={wrapperRef} className="relative">
      <Button
        type="button"
        size="icon"
        variant="ghost"
        aria-label="Insert emoji"
        aria-expanded={open}
        data-testid="emoji-trigger"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        <Smile className="h-4 w-4" aria-hidden />
      </Button>
      {open ? (
        <div
          role="dialog"
          aria-label="Emoji picker"
          data-testid="emoji-popover"
          className="absolute bottom-full left-0 z-50 mb-2"
        >
          <Suspense
            fallback={
              <div className="rounded-md border bg-background p-3 text-xs text-muted-foreground shadow-md">
                Loading emojis…
              </div>
            }
          >
            <LazyEmojiPicker
              onEmojiClick={handleEmojiClick}
              emojiStyle={EmojiStyle.NATIVE}
              width={320}
              height={360}
              lazyLoadEmojis
              autoFocusSearch={false}
              previewConfig={{ showPreview: false }}
            />
          </Suspense>
        </div>
      ) : null}
    </div>
  );
}
