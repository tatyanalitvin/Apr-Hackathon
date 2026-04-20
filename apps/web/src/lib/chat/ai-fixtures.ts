import type { MessagePayload } from "@ai-herders/shared/protocol";

export function makeAiFixtures(roomId: string, baseSeq: number): MessagePayload[] {
  const base = {
    roomId,
    authorId: "ai-fixture",
    authorUsername: "fixture-ai",
    authorName: "Lavender",
    replyToId: null,
    replyTo: null,
    editedAt: null,
    deletedAt: null,
    authorType: "ai" as const,
  };
  return [
    { ...base, id: "fx-1", body: "Confidence is high: the spec grid renders cleanly at every breakpoint.", seq: String(baseSeq + 1), createdAt: new Date().toISOString(), confidence: 0.92, status: "final" },
    { ...base, id: "fx-2", body: "I think the composer fade passes — but it's medium confidence, review the 768px mock.", seq: String(baseSeq + 2), createdAt: new Date().toISOString(), confidence: 0.66, status: "final" },
    { ...base, id: "fx-3", body: "Low confidence on the admin table contrast — worth an axe run.", seq: String(baseSeq + 3), createdAt: new Date().toISOString(), confidence: 0.34, status: "final" },
    { ...base, id: "fx-4", body: "Typing… generating the next suggestion", seq: String(baseSeq + 4), createdAt: new Date().toISOString(), status: "streaming" },
    { ...base, id: "fx-5", body: "No-confidence variant (chip should be hidden).", seq: String(baseSeq + 5), createdAt: new Date().toISOString(), status: "final" },
  ];
}
