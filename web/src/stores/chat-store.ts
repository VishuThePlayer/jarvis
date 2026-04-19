import { create } from "zustand";
import type {
  AssistantResponse,
  ConversationRecord,
  HealthResponse,
  MessageRecord,
  ModelDescriptor,
  ResponseMeta,
} from "@/types/api";
import {
  fetchHealth,
  fetchMessages,
  fetchModels,
  sendMessageStream,
} from "@/api/client";

interface ChatState {
  // Connection
  health: HealthResponse | null;
  isConnected: boolean;

  // Models
  models: ModelDescriptor[];
  selectedModel: string | null;

  // Conversations
  conversations: Record<string, ConversationRecord>;
  activeConversationId: string | null;

  // Messages
  messages: MessageRecord[];
  responseMeta: Record<string, ResponseMeta>;

  // UI
  isLoading: boolean;
  isSidebarOpen: boolean;
  error: string | null;
  streamingContent: string;

  // Chat options
  allowWebSearch: boolean;
  preferWebSearch: boolean;

  // Abort controller for in-flight request
  _abortController: AbortController | null;

  // Actions
  checkHealth: () => Promise<void>;
  loadModels: () => Promise<void>;
  selectModel: (modelId: string | null) => void;
  startNewConversation: () => void;
  selectConversation: (id: string) => Promise<void>;
  sendMessage: (content: string) => void;
  abortRequest: () => void;
  setWebSearch: (allow: boolean, prefer: boolean) => void;
  toggleSidebar: () => void;
  clearError: () => void;
  deleteConversation: (id: string) => void;
  renameConversation: (id: string, title: string) => void;
  retryLastMessage: () => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  health: null,
  isConnected: false,
  models: [],
  selectedModel: null,
  conversations: {},
  activeConversationId: null,
  messages: [],
  responseMeta: {},
  isLoading: false,
  isSidebarOpen: true,
  error: null,
  streamingContent: "",
  allowWebSearch: false,
  preferWebSearch: false,
  _abortController: null,

  checkHealth: async () => {
    try {
      const health = await fetchHealth();
      set({ health, isConnected: true });
    } catch {
      set({ isConnected: false });
    }
  },

  loadModels: async () => {
    try {
      const models = await fetchModels();
      set({ models });
      const state = get();
      if (!state.selectedModel && models.length > 0) {
        const defaultModel = models.find(
          (m) => m.isConfigured && m.roles.includes("default"),
        );
        const anyConfigured = models.find(
          (m) => m.isConfigured,
        );
        const pick = defaultModel ?? anyConfigured;
        set({ selectedModel: pick ? `${pick.provider}:${pick.id}` : null });
      }
    } catch {
      // silently fail — models will be empty
    }
  },

  selectModel: (modelId) => set({ selectedModel: modelId }),

  startNewConversation: () => {
    set({
      activeConversationId: null,
      messages: [],
      responseMeta: {},
      error: null,
    });
  },

  selectConversation: async (id) => {
    set({ activeConversationId: id, messages: [], responseMeta: {}, error: null });
    try {
      const messages = await fetchMessages(id);
      set({ messages });
    } catch {
      set({ error: "Failed to load conversation" });
    }
  },

  sendMessage: (content) => {
    const state = get();
    if (state.isLoading) return;

    const now = new Date().toISOString();
    const userMsg: MessageRecord = {
      id: `tmp_${Date.now()}`,
      conversationId: state.activeConversationId ?? "",
      role: "user",
      content,
      channel: "http",
      userId: "local-user",
      createdAt: now,
    };

    set({
      messages: [...state.messages, userMsg],
      isLoading: true,
      error: null,
    });

    const streamingMsgId = `streaming_${Date.now()}`;

    const controller = sendMessageStream(
      {
        message: content,
        conversationId: state.activeConversationId ?? undefined,
        requestedModel: state.selectedModel ?? undefined,
        allowWebSearch: state.allowWebSearch || undefined,
        preferWebSearch: state.preferWebSearch || undefined,
      },
      {
        onToken: (text: string) => {
          const current = get();
          const newContent = current.streamingContent + text;
          const hasPlaceholder = current.messages.some((m) => m.id === streamingMsgId);

          if (!hasPlaceholder) {
            const placeholder: MessageRecord = {
              id: streamingMsgId,
              conversationId: current.activeConversationId ?? "",
              role: "assistant",
              content: newContent,
              channel: "http",
              userId: "jarvis",
              createdAt: new Date().toISOString(),
            };
            set({
              messages: [...current.messages, placeholder],
              streamingContent: newContent,
            });
          } else {
            set({
              messages: current.messages.map((m) =>
                m.id === streamingMsgId ? { ...m, content: newContent } : m,
              ),
              streamingContent: newContent,
            });
          }
        },
        onResponse: (response: AssistantResponse) => {
          const current = get();

          const assistantMsg: MessageRecord = {
            id: response.messageId,
            conversationId: response.conversationId,
            role: "assistant",
            content: response.content,
            channel: "http",
            userId: "jarvis",
            provider: response.providerUsed,
            model: response.modelUsed,
            createdAt: new Date().toISOString(),
          };

          const meta: ResponseMeta = {
            toolCalls: response.toolCalls,
            memoryWrites: response.memoryWrites,
            usage: response.usage,
            providerUsed: response.providerUsed,
            modelUsed: response.modelUsed,
          };

          // Create/update conversation record
          const convTitle =
            current.conversations[response.conversationId]?.title ??
            content.slice(0, 60);
          const conv: ConversationRecord = {
            id: response.conversationId,
            userId: "local-user",
            channel: "http",
            title: convTitle,
            createdAt:
              current.conversations[response.conversationId]?.createdAt ?? now,
            updatedAt: new Date().toISOString(),
          };

          // Fix user message conversationId and replace streaming placeholder
          const fixedMessages = current.messages
            .filter((m) => m.id !== streamingMsgId)
            .map((m) =>
              m.id === userMsg.id
                ? { ...m, conversationId: response.conversationId }
                : m,
            );

          set({
            messages: [...fixedMessages, assistantMsg],
            streamingContent: "",
            responseMeta: {
              ...current.responseMeta,
              [response.messageId]: meta,
            },
            activeConversationId: response.conversationId,
            conversations: {
              ...current.conversations,
              [response.conversationId]: conv,
            },
          });
        },
        onError: (error: string) => {
          set({ error });
        },
        onDone: () => {
          set({ isLoading: false, _abortController: null, streamingContent: "" });
        },
      },
    );

    set({ _abortController: controller });
  },

  abortRequest: () => {
    const state = get();
    state._abortController?.abort();
    set({ isLoading: false, _abortController: null });
  },

  setWebSearch: (allow, prefer) =>
    set({ allowWebSearch: allow, preferWebSearch: prefer }),

  toggleSidebar: () => set((s) => ({ isSidebarOpen: !s.isSidebarOpen })),

  clearError: () => set({ error: null }),

  deleteConversation: (id) => {
    const state = get();
    const { [id]: _, ...rest } = state.conversations;
    const isActive = state.activeConversationId === id;
    set({
      conversations: rest,
      ...(isActive && {
        activeConversationId: null,
        messages: [],
        responseMeta: {},
      }),
    });
  },

  renameConversation: (id, title) => {
    const state = get();
    const conv = state.conversations[id];
    if (!conv) return;
    set({
      conversations: {
        ...state.conversations,
        [id]: { ...conv, title },
      },
    });
  },

  retryLastMessage: () => {
    const state = get();
    if (state.isLoading) return;
    const userMessages = state.messages.filter((m) => m.role === "user");
    const lastUserMsg = userMessages[userMessages.length - 1];
    if (!lastUserMsg) return;
    const lastAssistantIdx = state.messages.findLastIndex(
      (m) => m.role === "assistant",
    );
    const messagesWithoutLast =
      lastAssistantIdx >= 0
        ? state.messages.slice(0, lastAssistantIdx)
        : state.messages;
    set({ messages: messagesWithoutLast });
    get().sendMessage(lastUserMsg.content);
  },
}));
