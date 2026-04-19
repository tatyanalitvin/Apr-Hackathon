// REQ-110/111 — inline textarea editor shown when an author clicks Edit on
// their own message row. Enter submits, Shift+Enter inserts a newline, Esc
// cancels. Submit empties the field guard so the PATCH never fires with an
// empty body (backend rejects with 400, but cheaper to gate here too).
"use client";

import { useEffect, useRef, useState } from "react";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";

export interface EditMessageFormProps {
  initialBody: string;
  onSave: (body: string) => Promise<void> | void;
  onCancel: () => void;
}

export function EditMessageForm({ initialBody, onSave, onCancel }: EditMessageFormProps) {
  const [value, setValue] = useState(initialBody);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    ref.current?.focus();
    // Place caret at the end for natural editing.
    const node = ref.current;
    if (node) {
      const end = node.value.length;
      node.setSelectionRange(end, end);
    }
  }, []);

  const submit = async () => {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      setError("Message cannot be empty.");
      return;
    }
    if (trimmed === initialBody.trim()) {
      onCancel();
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onSave(trimmed);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Edit failed");
      setSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col gap-1">
      <Textarea
        ref={ref}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void submit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        disabled={submitting}
        data-testid="message-edit-input"
        className="min-h-[60px]"
      />
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span>
          <kbd className="rounded bg-muted px-1">Enter</kbd> to save,{" "}
          <kbd className="rounded bg-muted px-1">Esc</kbd> to cancel
        </span>
        <Button
          size="sm"
          variant="ghost"
          onClick={onCancel}
          disabled={submitting}
          className="h-6 px-2 text-xs"
        >
          Cancel
        </Button>
        <Button
          size="sm"
          onClick={() => void submit()}
          disabled={submitting}
          data-testid="message-edit-save"
          className="h-6 px-2 text-xs"
        >
          Save
        </Button>
        {error ? <span className="text-destructive">{error}</span> : null}
      </div>
    </div>
  );
}
