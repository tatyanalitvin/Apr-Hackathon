"use client";

import { useState } from "react";
import { ImageOff } from "lucide-react";
import type { AttachmentPayload } from "@ai-herders/shared/protocol";
import { BACKEND_URL } from "@/lib/backend";

// Without explicit dimensions from the backend DTO the layout cannot reserve
// an exact intrinsic size; we use a constrained max with an aspect-ratio fallback
// so the image placeholder keeps its slot during decode and we avoid the layout
// shift + broken-glyph that the raw <img> used to produce when the URL expired.
export function AttachmentImage({ attachment }: { attachment: AttachmentPayload }) {
  const url = `${BACKEND_URL}${attachment.downloadUrl}`;
  const [errored, setErrored] = useState(false);
  const [loaded, setLoaded] = useState(false);

  if (errored) {
    return (
      <div
        role="img"
        aria-label={`Preview unavailable: ${attachment.originalName}`}
        className="inline-flex items-start gap-2 rounded border bg-muted/40 px-3 py-2 text-sm max-w-sm"
      >
        <ImageOff aria-hidden className="mt-0.5 h-4 w-4 text-muted-foreground" />
        <span className="flex-1 min-w-0">
          <span className="block truncate font-medium" title={attachment.originalName}>
            {attachment.originalName}
          </span>
          <span className="block text-xs text-muted-foreground">
            Preview unavailable
          </span>
          {attachment.comment ? (
            <span
              className="block italic text-xs text-muted-foreground truncate max-w-[18rem]"
              title={attachment.comment}
            >
              {attachment.comment}
            </span>
          ) : null}
        </span>
      </div>
    );
  }

  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className="inline-block">
      <div
        className="relative max-w-sm overflow-hidden rounded border bg-muted"
        // aspect-[4/3] is a defensible default for unknown image dimensions
        // — keeps layout stable during decode on slow connections. Once the
        // image loads the intrinsic ratio takes over via object-contain.
        style={{ aspectRatio: loaded ? "auto" : "4 / 3" }}
      >
        {!loaded ? (
          <div
            aria-hidden
            className="absolute inset-0 animate-pulse bg-muted"
          />
        ) : null}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={url}
          alt={attachment.originalName}
          loading="lazy"
          onLoad={() => setLoaded(true)}
          onError={() => setErrored(true)}
          className="max-h-80 w-auto max-w-full object-contain"
        />
      </div>
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
