"use client";

import type { AttachmentPayload } from "@ai-herders/shared/protocol";
import { BACKEND_URL } from "@/lib/backend";

export function AttachmentImage({ attachment }: { attachment: AttachmentPayload }) {
  const url = `${BACKEND_URL}${attachment.downloadUrl}`;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className="inline-block">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={url}
        alt={attachment.originalName}
        className="max-w-sm max-h-80 rounded border object-contain bg-muted"
      />
      {attachment.comment ? (
        <div
          className="mt-1 italic text-xs text-muted-foreground truncate max-w-[18rem]"
          title={attachment.comment}
        >
          {attachment.comment}
        </div>
      ) : null}
    </a>
  );
}
