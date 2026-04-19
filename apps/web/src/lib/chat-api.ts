import type { MessagePayload, HistorySliceResponse } from "@ai-herders/shared/protocol";
import { BACKEND_URL } from "./backend";

export interface SendMessageInput {
  body: string;
  clientMessageId?: string;
  attachmentIds?: string[];
}

export interface FetchHistoryInput {
  fromSeq?: bigint;
  toSeq?: bigint;
  limit?: number;
}

export interface UploadAttachmentInput {
  roomId: string;
  file: File;
  comment?: string;
}

export interface UploadAttachmentResult {
  attachmentId: string;
}

export interface ChatAPI {
  sendMessage(roomId: string, input: SendMessageInput): Promise<MessagePayload>;
  fetchHistory(roomId: string, input: FetchHistoryInput): Promise<HistorySliceResponse>;
  uploadAttachment(input: UploadAttachmentInput): Promise<UploadAttachmentResult>;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: "include", ...init });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${text || res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export class RealChatAPI implements ChatAPI {
  async sendMessage(roomId: string, input: SendMessageInput): Promise<MessagePayload> {
    return fetchJson<MessagePayload>(`${BACKEND_URL}/api/v1/rooms/${encodeURIComponent(roomId)}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  }

  async fetchHistory(roomId: string, { fromSeq, toSeq, limit }: FetchHistoryInput): Promise<HistorySliceResponse> {
    const params = new URLSearchParams();
    if (fromSeq !== undefined) params.set("fromSeq", fromSeq.toString());
    if (toSeq !== undefined) params.set("toSeq", toSeq.toString());
    if (limit !== undefined) params.set("limit", String(limit));
    const qs = params.toString();
    const url = `${BACKEND_URL}/api/v1/rooms/${encodeURIComponent(roomId)}/messages${qs ? `?${qs}` : ""}`;
    return fetchJson<HistorySliceResponse>(url);
  }

  async uploadAttachment({ roomId, file, comment }: UploadAttachmentInput): Promise<UploadAttachmentResult> {
    const form = new FormData();
    form.append("roomId", roomId);
    if (comment && comment.length > 0) form.append("comment", comment);
    form.append("file", file, file.name);
    return fetchJson<UploadAttachmentResult>(`${BACKEND_URL}/api/v1/attachments`, {
      method: "POST",
      body: form,
    });
  }
}
