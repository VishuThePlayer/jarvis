export type ChannelKind = "terminal" | "http" | "telegram";
export type MessageRole = "system" | "user" | "assistant" | "tool";
export type ProviderKind = "openai";
export type ModelSlot = "default" | "fast" | "reasoning" | "embedding";
export type ModelCapability = "chat" | "embeddings" | "streaming";
export type MemoryKind = "fact" | "preference" | "episode" | "summary";

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface ToolCallRecord {
  id: string;
  name: string;
  input: string;
  output: string;
  success: boolean;
  createdAt: string;
}

export interface MemoryEntry {
  id: string;
  userId: string;
  kind: MemoryKind;
  content: string;
  keywords: string[];
  confidence: number;
  createdAt: string;
  lastAccessedAt: string;
  conversationId?: string;
  sourceMessageId?: string;
}

export interface AssistantResponse {
  messageId: string;
  conversationId: string;
  content: string;
  toolCalls: ToolCallRecord[];
  providerUsed: ProviderKind;
  modelUsed: string;
  memoryWrites: MemoryEntry[];
  usage?: TokenUsage;
}

export interface ConversationRecord {
  id: string;
  userId: string;
  channel: ChannelKind;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface MessageRecord {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  channel: ChannelKind;
  userId: string;
  provider?: ProviderKind;
  model?: string;
  toolName?: string;
  createdAt: string;
}

export interface ModelDescriptor {
  provider: ProviderKind;
  id: string;
  roles: ModelSlot[];
  isConfigured: boolean;
  capabilities: ModelCapability[];
}

export interface ProviderHealth {
  provider: ProviderKind;
  configured: boolean;
  capabilities: ModelCapability[];
}

export interface HealthResponse {
  status: string;
  persistenceDriver: string;
  providers: ProviderHealth[];
  channels: Record<string, boolean>;
}

export interface ChatRequest {
  message: string;
  userId?: string;
  conversationId?: string;
  requestedModel?: string;
  allowWebSearch?: boolean;
  preferWebSearch?: boolean;
}

/** Metadata attached to each assistant message for display */
export interface ResponseMeta {
  toolCalls: ToolCallRecord[];
  memoryWrites: MemoryEntry[];
  usage?: TokenUsage;
  providerUsed: string;
  modelUsed: string;
}
