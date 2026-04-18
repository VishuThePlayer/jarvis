import type {
    ChannelKind,
    ConversationRecord,
    ConversationSummary,
    MemoryEntry,
    MessageRecord,
    ProviderKind,
    RunRecord,
    RunStatus,
} from "../types/core.js";

export interface ConversationRepository {
    ensureConversation(input: {
        conversationId?: string;
        userId: string;
        channel: ChannelKind;
        title: string;
    }): Promise<ConversationRecord>;
    getConversation(conversationId: string): Promise<ConversationRecord | null>;
    appendMessage(message: MessageRecord): Promise<void>;
    listMessages(conversationId: string): Promise<MessageRecord[]>;
    saveSummary(summary: ConversationSummary): Promise<void>;
    getLatestSummary(conversationId: string): Promise<ConversationSummary | null>;
}

export interface RunRepository {
    create(run: RunRecord): Promise<void>;
    complete(
        runId: string,
        patch: {
            status: RunStatus;
            completedAt: Date;
            provider?: ProviderKind;
            model?: string;
            error?: string;
        },
    ): Promise<void>;
}

export interface MemoryRepository {
    save(entry: MemoryEntry): Promise<void>;
    listByUser(userId: string): Promise<MemoryEntry[]>;
    touch(memoryId: string, accessedAt: Date): Promise<void>;
}
