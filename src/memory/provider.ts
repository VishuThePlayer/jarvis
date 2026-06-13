import type { ConversationSummary, MemoryEntry, MessageRecord, UserRequest } from "../types/core.js";

export interface MemoryContext {
    entries: MemoryEntry[];
    summary: ConversationSummary | null;
    summaryLabel?: string;
    contextBlock?: string;
}

export interface MemoryLookupResult {
    matches: MemoryEntry[];
    fallback: MemoryEntry[];
}

export interface MemorySaveResult {
    entry: MemoryEntry;
    duplicate: boolean;
    existing?: MemoryEntry;
}

export interface MemoryProvider {
    retrieveContext(input: {
        userId: string;
        conversationId: string;
        query: string;
    }): Promise<MemoryContext>;
    captureTurn(input: {
        request: UserRequest;
        response: MessageRecord;
        messageCount: number;
        recentMessages: MessageRecord[];
    }): Promise<MemoryEntry[]>;
    saveExplicitMemory(input: {
        request: UserRequest;
        content: string;
    }): Promise<MemorySaveResult>;
    lookupExplicitMemory(input: {
        request: UserRequest;
        query: string;
    }): Promise<MemoryLookupResult>;
}
