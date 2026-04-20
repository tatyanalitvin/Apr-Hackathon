import type { MessagePayload } from "@ai-herders/shared/protocol";
import { Avatar } from "@/components/avatar/Avatar";
import { ConfidenceChip } from "./ConfidenceChip";
import { StreamingShimmer } from "./StreamingShimmer";

interface Props {
  message: MessagePayload;
}

export function AiMessageBubble({ message }: Props) {
  const isStreaming = message.status === "streaming";
  return (
    <article
      className="relative flex gap-3 glass-panel px-4 py-3"
      style={{
        backgroundImage: "linear-gradient(to bottom, rgba(196, 181, 253, 0.12), transparent 40%)",
      }}
    >
      <Avatar userId={message.authorId} name={message.authorName} size={32} />
      <div className="flex-1 min-w-0">
        <header className="flex items-baseline gap-2 mb-1">
          <span className="text-sm font-semibold" style={{ color: "var(--text-hi)" }}>
            {message.authorName}
          </span>
          <span className="text-[11px]" style={{ color: "var(--accent)" }}>✦ AI</span>
          <time className="ml-auto text-[11px]" style={{ color: "var(--text-lo)" }}>
            {new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </time>
        </header>
        <div className="text-[15px] leading-[1.55] whitespace-pre-wrap" style={{ color: "var(--text-hi)" }}>
          {message.body}
        </div>
        <footer className="mt-2 flex justify-end">
          <ConfidenceChip confidence={message.confidence} />
        </footer>
      </div>
      {isStreaming && <StreamingShimmer />}
    </article>
  );
}
