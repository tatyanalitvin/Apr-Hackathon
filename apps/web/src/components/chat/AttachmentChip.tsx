"use client";

import {
  File,
  FileArchive,
  FileMusic,
  FileText,
  FileVideo,
  type LucideIcon,
} from "lucide-react";
import type { AttachmentPayload } from "@ai-herders/shared/protocol";
import { BACKEND_URL } from "@/lib/backend";

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Pick a lucide icon per MIME family. Keeps the chip visually differentiated
// instead of the old catch-all paperclip emoji. Fallback is a neutral File
// glyph (vs a Paperclip) so the chip reads as "a file" even for unknown types.
function iconForMime(mimeType: string): LucideIcon {
  if (mimeType === "application/pdf") return FileText;
  if (mimeType === "application/zip" || mimeType.endsWith("+zip")) {
    return FileArchive;
  }
  if (mimeType.startsWith("text/")) return FileText;
  if (mimeType.startsWith("video/")) return FileVideo;
  if (mimeType.startsWith("audio/")) return FileMusic;
  return File;
}

export function AttachmentChip({ attachment }: { attachment: AttachmentPayload }) {
  const url = `${BACKEND_URL}${attachment.downloadUrl}`;
  const Icon = iconForMime(attachment.mimeType);
  return (
    // NB: `download` is intentionally omitted — the attribute is ignored by
    // browsers for cross-origin responses (the frontend on :3000 talks to the
    // backend on :4000 in dev, and typically through different hostnames in
    // prod). The backend stamps `Content-Disposition: attachment; filename*=`
    // per RFC 5987 (routes/attachments.ts R11) which is what actually drives
    // the download filename. Leaving the hint in was misleading.
    <a
      href={url}
      className="inline-flex items-center gap-2 rounded border bg-muted/40 px-3 py-2 text-sm hover:bg-muted max-w-sm"
    >
      <Icon aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" />
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
