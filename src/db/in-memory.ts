import type { ConversationRepository, MemoryRepository, RunRepository } from "./contracts.js";
import type {
    ConversationRecord,
    ConversationSummary,
    MemoryEntry,
    MessageRecord,
    RunRecord,
} from "../types/core.js";
import { createId } from "../utils/id.js";

function cloneConversation(conversation: ConversationRecord): ConversationRecord {
    return {
        ...conversation,
        createdAt: new Date(conversation.createdAt),
        updatedAt: new Date(conversation.updatedAt),
    };
}

function cloneMessage(message: MessageRecord): MessageRecord {
    return {
        ...message,
        createdAt: new Date(message.createdAt),
    };
}

function cloneRun(run: RunRecord): RunRecord {
    return {
        ...run,
        startedAt: new Date(run.startedAt),
        ...(run.completedAt ? { completedAt: new Date(run.completedAt) } : {}),
    };
}

function cloneMemory(memory: MemoryEntry): MemoryEntry {
    return {
        ...memory,
        keywords: [...memory.keywords],
        createdAt: new Date(memory.createdAt),
        lastAccessedAt: new Date(memory.lastAccessedAt),
    };
}

function cloneSummary(summary: ConversationSummary): ConversationSummary {
    return {
        ...summary,
        sourceMessageIds: [...summary.sourceMessageIds],
        createdAt: new Date(summary.createdAt),
        updatedAt: new Date(summary.updatedAt),
    };
}

export class InMemoryConversationRepository implements ConversationRepository {
    private readonly conversations = new Map<string, ConversationRecord>();
    private readonly messages = new Map<string, MessageRecord[]>();
    private readonly summaries = new Map<string, ConversationSummary>();

    public async ensureConversation(input: {
        conversationId?: string;
        userId: string;
        channel: ConversationRecord["channel"];
        title: string;
    }): Promise<ConversationRecord> {
        const conversationId = input.conversationId ?? createId("conv");
        const existing = this.conversations.get(conversationId);

        if (existing) {
            return cloneConversation(existing);
        }

        const now = new Date();
        const created: ConversationRecord = {
            id: conversationId,
            userId: input.userId,
            channel: input.channel,
            title: input.title,
            createdAt: now,
            updatedAt: now,
        };

        this.conversations.set(conversationId, created);
        this.messages.set(conversationId, []);

        return cloneConversation(created);
    }

    public async getConversation(conversationId: string): Promise<ConversationRecord | null> {
        const conversation = this.conversations.get(conversationId);

        return conversation ? cloneConversation(conversation) : null;
    }

    public async appendMessage(message: MessageRecord): Promise<void> {
        const list = this.messages.get(message.conversationId) ?? [];
        list.push(cloneMessage(message));
        this.messages.set(message.conversationId, list);

        const conversation = this.conversations.get(message.conversationId);
        if (conversation) {
            this.conversations.set(message.conversationId, {
                ...conversation,
                updatedAt: new Date(message.createdAt),
                title: conversation.title || message.content,
            });
        }
    }

    public async listMessages(conversationId: string): Promise<MessageRecord[]> {
        const list = this.messages.get(conversationId) ?? [];

        return list.map(cloneMessage);
    }

    public async saveSummary(summary: ConversationSummary): Promise<void> {
        this.summaries.set(summary.conversationId, cloneSummary(summary));
    }

    public async getLatestSummary(conversationId: string): Promise<ConversationSummary | null> {
        const summary = this.summaries.get(conversationId);

        return summary ? cloneSummary(summary) : null;
    }
}

export class InMemoryRunRepository implements RunRepository {
    private readonly runs = new Map<string, RunRecord>();

    public async create(run: RunRecord): Promise<void> {
        this.runs.set(run.id, cloneRun(run));
    }

    public async complete(
        runId: string,
        patch: {
            status: RunRecord["status"];
            completedAt: Date;
            provider?: RunRecord["provider"];
            model?: string;
            error?: string;
        },
    ): Promise<void> {
        const run = this.runs.get(runId);
        if (!run) {
            return;
        }

        this.runs.set(runId, {
            ...run,
            status: patch.status,
            completedAt: patch.completedAt,
            ...(patch.provider ? { provider: patch.provider } : {}),
            ...(patch.model ? { model: patch.model } : {}),
            ...(patch.error ? { error: patch.error } : {}),
        });
    }
}

export class InMemoryMemoryRepository implements MemoryRepository {
    private readonly entries = new Map<string, MemoryEntry>();

    public async save(entry: MemoryEntry): Promise<void> {
        this.entries.set(entry.id, cloneMemory(entry));
    }

    public async listByUser(userId: string): Promise<MemoryEntry[]> {
        return [...this.entries.values()]
            .filter((entry) => entry.userId === userId)
            .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
            .map(cloneMemory);
    }

    public async touch(memoryId: string, accessedAt: Date): Promise<void> {
        const entry = this.entries.get(memoryId);
        if (!entry) {
            return;
        }

        this.entries.set(memoryId, {
            ...entry,
            lastAccessedAt: accessedAt,
        });
    }
}

export class InMemoryPersistence {
    public readonly conversations = new InMemoryConversationRepository();
    public readonly runs = new InMemoryRunRepository();
    public readonly memories = new InMemoryMemoryRepository();
}
