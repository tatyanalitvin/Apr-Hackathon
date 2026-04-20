// REQ-110/112/114 — per-message Edit / Delete affordance for the author of
// the row. Renders a compact "⋯" button that reveals the actions. Parent
// (MessageList) decides which subset to mount: Edit/Delete are gated by
// authorship, Reply is author-agnostic per REQ-133 R13. Omitting a
// handler drops its button cleanly — this component does not reason
// about authorship itself.
//
// Delete uses a two-step inline confirm (click "Delete" → click "Confirm")
// rather than a full modal — matches the brief's "small inline confirm,
// not a full modal" guidance (§1d).
"use client";

import { useState } from "react";
import { Reply as ReplyIcon, Pencil, Trash2, X } from "lucide-react";

export interface MessageActionsProps {
  // REQ-212 — onEdit may be omitted by admin-delete callers (who can't
  // edit another author's row). Authors still pass onEdit; admins omit it.
  onEdit?: () => void;
  onDelete?: () => void;
  onReply?: () => void;
}

export function MessageActions({ onEdit, onDelete, onReply }: MessageActionsProps) {
  const [open, setOpen] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        aria-label="Message actions"
        data-testid="message-actions-toggle"
        onClick={() => setOpen(true)}
        className="rounded px-1 text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover:opacity-100 focus:opacity-100"
      >
        ⋯
      </button>
    );
  }

  return (
    <div
      role="group"
      aria-label="Message actions"
      className="flex items-center gap-1 rounded-md border border-border bg-popover px-2 py-1.5 text-xs text-popover-foreground shadow-md"
    >
      {onReply ? (
        <button
          type="button"
          data-testid="message-reply"
          onClick={() => {
            setOpen(false);
            setConfirmingDelete(false);
            onReply();
          }}
          className="inline-flex items-center gap-1 rounded bg-muted px-2 py-0.5 transition-colors hover:bg-muted-foreground/20"
        >
          <ReplyIcon aria-hidden="true" size={14} />
          Reply
        </button>
      ) : null}
      {onEdit ? (
        <button
          type="button"
          data-testid="message-edit"
          onClick={() => {
            setOpen(false);
            setConfirmingDelete(false);
            onEdit();
          }}
          className="inline-flex items-center gap-1 rounded bg-muted px-2 py-0.5 transition-colors hover:bg-muted-foreground/20"
        >
          <Pencil aria-hidden="true" size={14} />
          Edit
        </button>
      ) : null}
      {onDelete ? (
        confirmingDelete ? (
          <button
            type="button"
            data-testid="message-delete-confirm"
            onClick={() => {
              setOpen(false);
              setConfirmingDelete(false);
              onDelete();
            }}
            className="inline-flex items-center gap-1 rounded bg-destructive px-2 py-0.5 text-destructive-foreground transition-colors hover:bg-destructive/90"
          >
            <Trash2 aria-hidden="true" size={14} />
            Confirm
          </button>
        ) : (
          <button
            type="button"
            data-testid="message-delete"
            onClick={() => setConfirmingDelete(true)}
            className="inline-flex items-center gap-1 rounded bg-muted px-2 py-0.5 transition-colors hover:bg-muted-foreground/20"
          >
            <Trash2 aria-hidden="true" size={14} />
            Delete
          </button>
        )
      ) : null}
      <button
        type="button"
        aria-label="Cancel"
        onClick={() => {
          setOpen(false);
          setConfirmingDelete(false);
        }}
        className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <X aria-hidden="true" size={14} />
      </button>
    </div>
  );
}
