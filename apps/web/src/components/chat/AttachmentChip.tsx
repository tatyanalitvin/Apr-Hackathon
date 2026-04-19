"use client";

import type { AttachmentPayload } from "@ai-herders/shared/protocol";
import { BACKEND_URL } from "@/lib/backend";

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function AttachmentChip({ attachment }: { attachment: AttachmentPayload }) {
  const url = `${BACKEND_URL}${attachment.downloadUrl}`;
  return (
    <a
      href={url}
      download={attachment.originalName}
      className="inline-flex items-center gap-2 rounded border bg-muted/40 px-3 py-2 text-sm hover:bg-muted max-w-sm"
    >
      <span aria-hidden className="text-base">📎</span>
      <span className="flex-1 min-w-0">
        <span className="block truncate font-medium">{attachment.originalName}</span>
        <span className="block text-xs text-muted-foreground">{humanSize(attachment.sizeBytes)}</span>
        {attachment.comment ? (
          <span
            className="block italic text-xs text-muted-foreground truncate max-w-[18rem]"
            title={attachment.comment}
          >
            {attachment.comment}
          </span>
        ) : null}
      </span>
    </a>
  );
}
