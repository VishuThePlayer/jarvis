import type {
  AssistantResponse,
  ChatRequest,
  ConversationRecord,
  HealthResponse,
  MessageRecord,
  ModelDescriptor,
} from "@/types/api";

const BASE = import.meta.env.VITE_API_BASE_URL ?? "";

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(`${BASE}${url}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error ?? `Request failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export async function fetchHealth(): Promise<HealthResponse> {
  return fetchJson<HealthResponse>("/health");
}

export async function fetchModels(): Promise<ModelDescriptor[]> {
  const data = await fetchJson<{ models: ModelDescriptor[] }>("/models");
  return data.models;
}

export async function fetchConversation(id: string): Promise<ConversationRecord> {
  const data = await fetchJson<{ conversation: ConversationRecord }>(`/conversations/${id}`);
  return data.conversation;
}

export async function fetchMessages(conversationId: string): Promise<MessageRecord[]> {
  const data = await fetchJson<{ messages: MessageRecord[] }>(
    `/conversations/${conversationId}/messages`,
  );
  return data.messages;
}

export interface StreamCallbacks {
  onResponse: (response: AssistantResponse) => void;
  onError: (error: string) => void;
  onDone: () => void;
}

export function sendMessageStream(
  request: ChatRequest,
  callbacks: StreamCallbacks,
): AbortController {
  const controller = new AbortController();

  (async () => {
    try {
      const res = await fetch(`${BASE}/chat/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }));
        callbacks.onError(body.error ?? `Request failed: ${res.status}`);
        callbacks.onDone();
        return;
      }

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";

        for (const frame of frames) {
          const lines = frame.trim().split("\n");
          let eventType = "";
          let data = "";

          for (const line of lines) {
            if (line.startsWith("event: ")) eventType = line.slice(7).trim();
            else if (line.startsWith("data: ")) data = line.slice(6);
          }

          if (eventType === "response" && data) {
            try {
              callbacks.onResponse(JSON.parse(data) as AssistantResponse);
            } catch {
              callbacks.onError("Failed to parse response");
            }
          } else if (eventType === "error" && data) {
            try {
              const err = JSON.parse(data) as { error: string };
              callbacks.onError(err.error);
            } catch {
              callbacks.onError(data);
            }
          } else if (eventType === "done") {
            // stream complete
          }
        }
      }

      callbacks.onDone();
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "AbortError") {
        callbacks.onDone();
        return;
      }
      callbacks.onError(err instanceof Error ? err.message : "Network error");
      callbacks.onDone();
    }
  })();

  return controller;
}
