"use client";

import * as React from "react";
import { Eye, EyeOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";

type Props = Omit<React.ComponentProps<"input">, "type"> & {
  wrapperClassName?: string;
};

// Wraps the shared Input with a local show/hide toggle. Kept intentionally
// lightweight — the toggle is purely local UI state; the underlying field
// still ships the real password through react-hook-form's register() so
// autofill + password managers keep working. The eye icon sits inside the
// input padding so the glow ring wraps the full control.
export const PasswordInput = React.forwardRef<HTMLInputElement, Props>(
  ({ className, wrapperClassName, ...props }, ref) => {
    const [visible, setVisible] = React.useState(false);
    const Icon = visible ? EyeOff : Eye;
    return (
      <div className={cn("relative", wrapperClassName)}>
        <Input
          ref={ref}
          type={visible ? "text" : "password"}
          className={cn("pr-10", className)}
          {...props}
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          className="absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r-md text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
          aria-label={visible ? "Hide password" : "Show password"}
          aria-pressed={visible}
          tabIndex={-1}
        >
          <Icon className="size-4" aria-hidden="true" />
        </button>
      </div>
    );
  },
);
PasswordInput.displayName = "PasswordInput";
