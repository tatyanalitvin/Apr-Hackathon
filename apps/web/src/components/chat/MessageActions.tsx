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
    <div className="flex items-center gap-1 text-xs">
      {onReply ? (
        <button
          type="button"
          data-testid="message-reply"
          onClick={() => {
            setOpen(false);
            setConfirmingDelete(false);
            onReply();
          }}
          className="rounded bg-muted px-2 py-0.5 hover:bg-muted-foreground/20"
        >
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
          className="rounded bg-muted px-2 py-0.5 hover:bg-muted-foreground/20"
        >
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
            className="rounded bg-destructive px-2 py-0.5 text-destructive-foreground hover:bg-destructive/90"
          >
            Confirm
          </button>
        ) : (
          <button
            type="button"
            data-testid="message-delete"
            onClick={() => setConfirmingDelete(true)}
            className="rounded bg-muted px-2 py-0.5 hover:bg-muted-foreground/20"
          >
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
        className="rounded px-1 text-muted-foreground hover:bg-muted"
      >
        ×
      </button>
    </div>
  );
}
