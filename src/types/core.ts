export type ChannelKind = "terminal" | "http" | "telegram";
export type MessageRole = "system" | "user" | "assistant" | "tool";
export type ProviderKind = "openai";
export type ModelSlot = "default" | "fast" | "reasoning" | "embedding";
export type ModelCapability = "chat" | "embeddings" | "streaming";
export type RunStatus = "running" | "completed" | "failed";
export type MemoryKind = "fact" | "preference" | "episode" | "summary";

export interface RequestAttachment {
    id: string;
    name: string;
    contentType: string;
    url?: string;
}

export interface RequestMetadata {
    username?: string;
    allowWebSearch?: boolean;
    preferWebSearch?: boolean;
    externalConversationRef?: string;
    sourceMessageId?: string;
}

export interface UserRequest {
    requestId: string;
    channel: ChannelKind;
    userId: string;
    conversationId?: string;
    message: string;
    attachments: RequestAttachment[];
    requestedModel?: string;
    metadata: RequestMetadata;
}

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
    createdAt: Date;
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
    createdAt: Date;
    updatedAt: Date;
}

export interface MessageRecord  {
    id: string;
    conversationId: string;
    role: MessageRole;
    content: string;
    channel: ChannelKind;
    userId: string;
    provider?: ProviderKind;
    model?: string;
    toolName?: string;
    createdAt: Date;
}

export interface RunRecord {
    id: string;
    requestId: string;
    conversationId: string;
    userId: string;
    channel: ChannelKind;
    provider?: ProviderKind;
    model?: string;
    status: RunStatus;
    startedAt: Date;
    completedAt?: Date;
    error?: string;
}

export interface ConversationSummary {
    id: string;
    conversationId: string;
    content: string;
    sourceMessageIds: string[];
    createdAt: Date;
    updatedAt: Date;
}

export interface MemoryEntry {
    id: string;
    userId: string;
    kind: MemoryKind;
    content: string;
    keywords: string[];
    confidence: number;
    createdAt: Date;
    lastAccessedAt: Date;
    conversationId?: string;
    sourceMessageId?: string;
}

export interface ModelMessage {
    role: "system" | "user" | "assistant";
    content: string;
}

export interface ModelInvocation {
    messages: ModelMessage[];
    model: string;
    temperature: number;
}

export interface ModelResult {
    provider: ProviderKind;
    model: string;
    text: string;
    usage?: TokenUsage;
}

export interface ModelDescriptor {
    provider: ProviderKind;
    id: string;
    roles: ModelSlot[];
    isConfigured: boolean;
    capabilities: ModelCapability[];
}
