import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

/**
 * Streaming chat endpoint.
 *
 * POST /api/chat
 * { messages: [{ role: "user" | "assistant", content: string }], system?: string }
 *
 * Returns a Server-Sent-Events-style text stream of Claude's response.
 * Swap the model via env var ANTHROPIC_MODEL.
 */

export const runtime = "nodejs";

const MessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1),
});

const BodySchema = z.object({
  messages: z.array(MessageSchema).min(1),
  system: z.string().optional(),
});

export async function POST(req: Request) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return Response.json({ error: "ANTHROPIC_API_KEY not set" }, { status: 500 });
  }

  const json = await req.json().catch(() => null);
  const parsed = BodySchema.safeParse(json);
  if (!parsed.success) {
    return Response.json({ error: "Invalid body", issues: parsed.error.issues }, { status: 400 });
  }

  const client = new Anthropic({ apiKey });
  const model = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5";

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        const response = await client.messages.stream({
          model,
          max_tokens: 2048,
          system: parsed.data.system,
          messages: parsed.data.messages,
        });
        for await (const event of response) {
          if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            controller.enqueue(encoder.encode(event.delta.text));
          }
        }
        controller.close();
      } catch (err) {
        const msg = err instanceof Error ? err.message : "stream error";
        controller.enqueue(encoder.encode(`\n\n[ERROR] ${msg}`));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
