import type { AutomationRepository, ConversationRepository, MemoryRepository, RunRepository } from "./contracts.js";
import type {
    AutomationRun,
    AutomationTask,
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

function cloneAutomationTask(task: AutomationTask): AutomationTask {
    return {
        ...task,
        nextRunAt: new Date(task.nextRunAt),
        createdAt: new Date(task.createdAt),
        updatedAt: new Date(task.updatedAt),
        ...(task.lastRunAt ? { lastRunAt: new Date(task.lastRunAt) } : {}),
    };
}

function cloneAutomationRun(run: AutomationRun): AutomationRun {
    return {
        ...run,
        startedAt: new Date(run.startedAt),
        completedAt: new Date(run.completedAt),
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

    public async countMessages(conversationId: string): Promise<number> {
        return (this.messages.get(conversationId) ?? []).length;
    }

    public async listRecentMessages(conversationId: string, limit: number): Promise<MessageRecord[]> {
        if (limit <= 0) {
            return [];
        }

        const list = this.messages.get(conversationId) ?? [];
        const startIndex = Math.max(0, list.length - limit);
        return list.slice(startIndex).map(cloneMessage);
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

    public async save(entry: MemoryEntry, _embedding?: number[]): Promise<void> {
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

export class InMemoryAutomationRepository implements AutomationRepository {
    private readonly tasks = new Map<string, AutomationTask>();
    private readonly runs = new Map<string, AutomationRun[]>();

    public async createTask(task: AutomationTask): Promise<void> {
        this.tasks.set(task.id, cloneAutomationTask(task));
        this.runs.set(task.id, []);
    }

    public async getTask(taskId: string): Promise<AutomationTask | null> {
        const task = this.tasks.get(taskId);
        return task ? cloneAutomationTask(task) : null;
    }

    public async listTasksByUser(userId: string, includeInactive = false): Promise<AutomationTask[]> {
        return [...this.tasks.values()]
            .filter((task) => task.userId === userId)
            .filter((task) => includeInactive || task.status === "active")
            .sort((left, right) => left.nextRunAt.getTime() - right.nextRunAt.getTime())
            .map(cloneAutomationTask);
    }

    public async listRunsByTask(taskId: string): Promise<AutomationRun[]> {
        return (this.runs.get(taskId) ?? [])
            .sort((left, right) => right.startedAt.getTime() - left.startedAt.getTime())
            .map(cloneAutomationRun);
    }

    public async getDueTasks(now: Date, limit: number): Promise<AutomationTask[]> {
        if (limit <= 0) {
            return [];
        }

        return [...this.tasks.values()]
            .filter((task) => task.status === "active" && task.nextRunAt.getTime() <= now.getTime())
            .sort((left, right) => left.nextRunAt.getTime() - right.nextRunAt.getTime())
            .slice(0, limit)
            .map(cloneAutomationTask);
    }

    public async saveRun(run: AutomationRun): Promise<void> {
        const list = this.runs.get(run.taskId) ?? [];
        list.push(cloneAutomationRun(run));
        this.runs.set(run.taskId, list);
    }

    public async rescheduleTask(taskId: string, nextRunAt: Date, lastRunAt: Date): Promise<void> {
        const task = this.tasks.get(taskId);
        if (!task) {
            return;
        }

        const { error: _error, ...taskWithoutError } = task;
        this.tasks.set(taskId, {
            ...taskWithoutError,
            nextRunAt,
            lastRunAt,
            updatedAt: lastRunAt,
        });
    }

    public async completeTask(taskId: string, completedAt: Date): Promise<void> {
        const task = this.tasks.get(taskId);
        if (!task) {
            return;
        }

        const { error: _error, ...taskWithoutError } = task;
        this.tasks.set(taskId, {
            ...taskWithoutError,
            status: "completed",
            lastRunAt: completedAt,
            updatedAt: completedAt,
        });
    }

    public async failTask(taskId: string, failedAt: Date, error: string): Promise<void> {
        this.patchTask(taskId, {
            status: "failed",
            lastRunAt: failedAt,
            updatedAt: failedAt,
            error,
        });
    }

    public async cancelTask(userId: string, taskId: string, canceledAt: Date): Promise<boolean> {
        const task = this.tasks.get(taskId);
        if (!task || task.userId !== userId || task.status !== "active") {
            return false;
        }

        this.tasks.set(taskId, {
            ...task,
            status: "canceled",
            updatedAt: canceledAt,
        });
        return true;
    }

    private patchTask(taskId: string, patch: Partial<AutomationTask>): void {
        const task = this.tasks.get(taskId);
        if (!task) {
            return;
        }

        this.tasks.set(taskId, { ...task, ...patch });
    }
}

export class InMemoryPersistence {
    public readonly conversations = new InMemoryConversationRepository();
    public readonly runs = new InMemoryRunRepository();
    public readonly memories = new InMemoryMemoryRepository();
    public readonly automations = new InMemoryAutomationRepository();

    public async stop(): Promise<void> {
        // No-op for the in-memory persistence adapter.
    }
}
