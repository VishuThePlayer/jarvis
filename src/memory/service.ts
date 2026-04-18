import type { AppConfig } from "../config/index.js";
import type { ConversationRepository, MemoryRepository } from "../db/contracts.js";
import type { Logger } from "../observability/logger.js";
import type { ConversationSummary, MemoryEntry, MessageRecord, UserRequest } from "../types/core.js";
import { createId } from "../utils/id.js";
import { keywordOverlapScore, normalizeWhitespace, tokenize, truncate } from "../utils/text.js";

export interface MemoryContext {
    entries: MemoryEntry[];
    summary: ConversationSummary | null;
}

interface MemoryServiceDependencies {
    config: AppConfig;
    logger: Logger;
    memories: MemoryRepository;
    conversations: ConversationRepository;
}

export class MemoryService {
    private readonly config: AppConfig;
    private readonly logger: Logger;
    private readonly memories: MemoryRepository;
    private readonly conversations: ConversationRepository;

    public constructor(dependencies: MemoryServiceDependencies) {
        this.config = dependencies.config;
        this.logger = dependencies.logger;
        this.memories = dependencies.memories;
        this.conversations = dependencies.conversations;
    }

    public async retrieveContext(input: {
        userId: string;
        conversationId: string;
        query: string;
    }): Promise<MemoryContext> {
        if (!this.config.memory.enabled) {
            return { entries: [], summary: null };
        }

        const summary = await this.conversations.getLatestSummary(input.conversationId);
        const allEntries = await this.memories.listByUser(input.userId);
        const queryTokens = tokenize(input.query);
        const ranked = allEntries
            .map((entry) => ({
                entry,
                score: keywordOverlapScore(queryTokens, entry.keywords) + this.kindBoost(entry.kind),
            }))
            .filter((candidate) => candidate.score > 0)
            .sort((left, right) => right.score - left.score)
            .slice(0, this.config.memory.retrievalLimit)
            .map((candidate) => candidate.entry);

        const accessedAt = new Date();
        for (const entry of ranked) {
            await this.memories.touch(entry.id, accessedAt);
        }

        return { entries: ranked, summary };
    }

    public async captureTurn(input: {
        request: UserRequest;
        response: MessageRecord;
        messages: MessageRecord[];
    }): Promise<MemoryEntry[]> {
        if (!this.config.memory.enabled || !this.config.memory.autoStore) {
            return [];
        }

        if (this.looksSensitive(input.request.message)) {
            this.logger.warn("Skipped sensitive memory write", {
                requestId: input.request.requestId,
            });
            return [];
        }

        const existing = await this.memories.listByUser(input.request.userId);
        const existingContent = new Set(existing.map((entry) => entry.content.toLowerCase()));
        const candidates = this.extractCandidates(input.request.message, input.response.id, input.request);
        const writes: MemoryEntry[] = [];

        for (const candidate of candidates) {
            if (existingContent.has(candidate.content.toLowerCase())) {
                continue;
            }

            await this.memories.save(candidate);
            writes.push(candidate);
        }

        await this.maybeSummarizeConversation(input.messages);

        return writes;
    }

    private kindBoost(kind: MemoryEntry["kind"]): number {
        switch (kind) {
            case "preference":
                return 0.4;
            case "fact":
                return 0.25;
            case "episode":
                return 0.1;
            case "summary":
                return 0.05;
        }
    }

    private extractCandidates(
        message: string,
        sourceMessageId: string,
        request: UserRequest,
    ): MemoryEntry[] {
        const normalized = normalizeWhitespace(message);
        const now = new Date();
        const candidates: Array<Pick<MemoryEntry, "kind" | "content" | "confidence">> = [];

        const patterns: Array<{
            expression: RegExp;
            kind: MemoryEntry["kind"];
            transform: (value: string) => string;
            confidence: number;
        }> = [
            {
                expression: /remember that (.+)/i,
                kind: "fact",
                transform: (value) => `User asked Jarvis to remember: ${normalizeWhitespace(value)}`,
                confidence: 0.92,
            },
            {
                expression: /please remember (.+)/i,
                kind: "fact",
                transform: (value) => `User asked Jarvis to remember: ${normalizeWhitespace(value)}`,
                confidence: 0.9,
            },
            {
                expression: /i prefer (.+)/i,
                kind: "preference",
                transform: (value) => `User preference: ${normalizeWhitespace(value)}`,
                confidence: 0.95,
            },
            {
                expression: /my name is ([^.?!]+)/i,
                kind: "fact",
                transform: (value) => `User name is ${normalizeWhitespace(value)}`,
                confidence: 0.98,
            },
            {
                expression: /call me ([^.?!]+)/i,
                kind: "preference",
                transform: (value) => `User prefers to be called ${normalizeWhitespace(value)}`,
                confidence: 0.94,
            },
        ];

        for (const pattern of patterns) {
            const match = normalized.match(pattern.expression);
            if (!match || !match[1]) {
                continue;
            }

            candidates.push({
                kind: pattern.kind,
                content: pattern.transform(match[1]),
                confidence: pattern.confidence,
            });
        }

        return candidates.map((candidate) => ({
            id: createId("mem"),
            userId: request.userId,
            kind: candidate.kind,
            content: candidate.content,
            keywords: tokenize(candidate.content),
            confidence: candidate.confidence,
            createdAt: now,
            lastAccessedAt: now,
            ...(request.conversationId ? { conversationId: request.conversationId } : {}),
            sourceMessageId,
        }));
    }

    private async maybeSummarizeConversation(messages: MessageRecord[]): Promise<void> {
        if (messages.length < this.config.memory.summaryTriggerMessageCount) {
            return;
        }

        const recent = messages.slice(-Math.min(messages.length, 8));
        const conversationId = recent[0]?.conversationId;
        if (!conversationId) {
            return;
        }

        const summaryLines = recent.map(
            (message) => `${message.role}: ${truncate(normalizeWhitespace(message.content), 180)}`,
        );
        const now = new Date();

        await this.conversations.saveSummary({
            id: `summary_${conversationId}`,
            conversationId,
            content: `Recent conversation summary:\n${summaryLines.map((line) => `- ${line}`).join("\n")}`,
            sourceMessageIds: recent.map((message) => message.id),
            createdAt: now,
            updatedAt: now,
        });
    }

    private looksSensitive(message: string): boolean {
        return /(api[_ -]?key|token|password|secret|bearer|sk-[a-z0-9]+)/i.test(message);
    }
}
