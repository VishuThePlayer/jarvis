export type ChannelKind = "terminal" | "http" | "telegram";
export type MessageRole = "system" | "user" | "assistant" | "tool";
export type ProviderKind = "openai";
export type ModelSlot = "default" | "fast" | "reasoning" | "embedding";
export type ModelCapability = "chat" | "embeddings" | "streaming";
export type RunStatus = "running" | "completed" | "failed";
export type MemoryKind = "fact" | "preference" | "episode" | "summary" | "user-input";
export type AutomationTaskType = "reminder" | "recurring-prompt";
export type AutomationTaskStatus = "active" | "completed" | "canceled" | "failed";
export type AutomationRunStatus = "completed" | "failed";

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

export type ToolCallSource = "direct-command" | "tool-router" | "pre-model-tool";

export interface ToolCallInput {
    source: ToolCallSource;
    rawMessage: string;
    arguments: Record<string, unknown>;
}

export interface ToolCallRecord {
    id: string;
    name: string;
    input: ToolCallInput;
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

export interface AutomationTask {
    id: string;
    userId: string;
    channel: ChannelKind;
    type: AutomationTaskType;
    title: string;
    prompt: string;
    status: AutomationTaskStatus;
    nextRunAt: Date;
    createdAt: Date;
    updatedAt: Date;
    conversationId?: string;
    intervalMs?: number;
    lastRunAt?: Date;
    error?: string;
}

export interface AutomationRun {
    id: string;
    taskId: string;
    userId: string;
    status: AutomationRunStatus;
    startedAt: Date;
    completedAt: Date;
    conversationId?: string;
    output?: string;
    error?: string;
}

export interface ToolParameterDefinition {
    type: "function";
    function: {
        name: string;
        description: string;
        parameters?: Record<string, unknown>;
    };
}

export interface ToolCallResult {
    id: string;
    type: "function";
    function: {
        name: string;
        arguments: string;
    };
}

export interface ModelMessage {
    role: "system" | "user" | "assistant";
    content: string;
}

export interface ModelInvocation {
    messages: ModelMessage[];
    model: string;
    temperature: number;
    tools?: ToolParameterDefinition[];
    tool_choice?: "auto" | "required" | "none" | { type: "function"; function: { name: string } };
}

export interface ModelResult {
    provider: ProviderKind;
    model: string;
    text: string;
    usage?: TokenUsage;
    toolCalls?: ToolCallResult[];
}

export interface ModelDescriptor {
    provider: ProviderKind;
    id: string;
    roles: ModelSlot[];
    isConfigured: boolean;
    capabilities: ModelCapability[];
}

export interface StreamChunk {
    text: string;
    done: boolean;
    usage?: TokenUsage;
    result?: ModelResult;
}

export type ProgressPhase =
    | "init"
    | "command-check"
    | "tool-router"
    | "tool-run"
    | "tool-format"
    | "pre-model-tools"
    | "model-generate"
    | "persist"
    | "complete";

export interface ProgressEvent {
    phase: ProgressPhase;
    message: string;
    toolName?: string;
    commandPreview?: string;
    createdAt: string;
}

export type StreamEvent =
    | { type: "delta"; text: string }
    | { type: "progress"; progress: ProgressEvent }
    | { type: "response"; response: AssistantResponse }
    | { type: "error"; error: string }
    | { type: "done" };
