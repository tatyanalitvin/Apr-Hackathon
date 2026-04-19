// Unit tests for reply-preview.ts (REQ-110 / s2-replies R4, R5, R7).
// Pure helper — no DB. See docs/specs/s2-replies.md §5 "Hydration helper".

import { describe, expect, it } from "vitest";
import {
  REPLY_PREVIEW_ELLIPSIS,
  REPLY_PREVIEW_MAX,
} from "@ai-herders/shared/protocol";
import { previewFromParent } from "./reply-preview";

describe("REQ-110 R5 previewFromParent shape", () => {
  it("REQ-110 R5 returns id + text + authorUsername + deletedAt for a live parent", () => {
    const preview = previewFromParent({
      id: "p1",
      body: "hello team",
      authorUsername: "alice",
      deletedAt: null,
    });
    expect(preview).toEqual({
      id: "p1",
      text: "hello team",
      authorUsername: "alice",
      deletedAt: null,
    });
  });
});

describe("REQ-110 R7 truncation", () => {
  it("REQ-110 R7 leaves bodies <= 120 chars unchanged", () => {
    const body = "x".repeat(120);
    const preview = previewFromParent({
      id: "p1",
      body,
      authorUsername: "alice",
      deletedAt: null,
    });
    expect(preview!.text).toBe(body);
    expect(preview!.text.length).toBe(120);
  });

  it("REQ-110 R7 truncates bodies > 120 chars to 120 + ellipsis", () => {
    const body = "x".repeat(500);
    const preview = previewFromParent({
      id: "p1",
      body,
      authorUsername: "alice",
      deletedAt: null,
    });
    expect(preview!.text.length).toBe(REPLY_PREVIEW_MAX + 1);
    expect(preview!.text.endsWith(REPLY_PREVIEW_ELLIPSIS)).toBe(true);
    expect(preview!.text.slice(0, REPLY_PREVIEW_MAX)).toBe(
      "x".repeat(REPLY_PREVIEW_MAX),
    );
  });

  it("REQ-110 R7 body of exactly 121 chars is truncated (not passed through)", () => {
    const body = "a".repeat(121);
    const preview = previewFromParent({
      id: "p1",
      body,
      authorUsername: "alice",
      deletedAt: null,
    });
    expect(preview!.text).toBe("a".repeat(120) + REPLY_PREVIEW_ELLIPSIS);
  });
});

describe("REQ-110 R4 deleted-parent substitution", () => {
  it("REQ-110 R4 replaces body with empty string when parent deletedAt is set", () => {
    const ts = new Date("2026-04-19T12:00:00.000Z");
    const preview = previewFromParent({
      id: "p1",
      body: "hello team",
      authorUsername: "alice",
      deletedAt: ts,
    });
    expect(preview!.text).toBe("");
    expect(preview!.deletedAt).toBe(ts.toISOString());
    expect(preview!.authorUsername).toBe("alice");
    expect(preview!.id).toBe("p1");
  });
});

describe("previewFromParent nullish parent", () => {
  it("returns null when parent is null (caller knows there is none)", () => {
    expect(previewFromParent(null)).toBeNull();
  });

  it("returns null when parent is undefined (caller did not hydrate)", () => {
    expect(previewFromParent(undefined)).toBeNull();
  });
});
