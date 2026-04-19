import type { AppConfig } from "../config/index.js";
import type { ConversationRepository, MemoryRepository } from "../db/contracts.js";
import type { ModelProviderRegistry } from "../models/registry.js";
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
    models?: ModelProviderRegistry;
}

export class MemoryService {
    private readonly config: AppConfig;
    private readonly logger: Logger;
    private readonly memories: MemoryRepository;
    private readonly conversations: ConversationRepository;
    private readonly models?: ModelProviderRegistry;

    public constructor(dependencies: MemoryServiceDependencies) {
        this.config = dependencies.config;
        this.logger = dependencies.logger;
        this.memories = dependencies.memories;
        this.conversations = dependencies.conversations;
        if (dependencies.models) {
            this.models = dependencies.models;
        }
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
        const limit = this.config.memory.retrievalLimit;

        const allEntries = await this.memories.listByUser(input.userId);
        const queryTokens = tokenize(input.query);

        const keywordScores = new Map<string, number>();
        for (const entry of allEntries) {
            const score = keywordOverlapScore(queryTokens, entry.keywords) + this.kindBoost(entry.kind);
            if (score > 0) {
                keywordScores.set(entry.id, score);
            }
        }

        let ranked: MemoryEntry[];

        const canUseEmbeddings = this.config.persistence.pgvector.enabled
            && this.models
            && this.memories.searchByEmbedding;

        if (canUseEmbeddings) {
            try {
                const [queryEmbedding] = await this.models!.embed([input.query]);
                const embeddingResults = await this.memories.searchByEmbedding!(input.userId, queryEmbedding!, limit * 2);

                const embeddingScores = new Map<string, number>();
                const embeddingEntries = new Map<string, MemoryEntry>();
                for (const { entry, similarity } of embeddingResults) {
                    embeddingScores.set(entry.id, similarity);
                    embeddingEntries.set(entry.id, entry);
                }

                const allIds = new Set([...keywordScores.keys(), ...embeddingScores.keys()]);
                const entryMap = new Map(allEntries.map((e) => [e.id, e]));
                for (const [id, entry] of embeddingEntries) {
                    if (!entryMap.has(id)) entryMap.set(id, entry);
                }

                const maxKeyword = Math.max(...keywordScores.values(), 1);

                const hybridScored = [...allIds]
                    .map((id) => {
                        const kw = (keywordScores.get(id) ?? 0) / maxKeyword;
                        const emb = embeddingScores.get(id) ?? 0;
                        return { id, score: 0.4 * kw + 0.6 * emb };
                    })
                    .sort((a, b) => b.score - a.score)
                    .slice(0, limit);

                ranked = hybridScored.map((s) => entryMap.get(s.id)!).filter(Boolean);
            } catch (error) {
                this.logger.warn("Embedding retrieval failed, falling back to keyword search", {
                    error: error instanceof Error ? error.message : String(error),
                });
                ranked = this.keywordRank(allEntries, keywordScores, limit);
            }
        } else {
            ranked = this.keywordRank(allEntries, keywordScores, limit);
        }

        const accessedAt = new Date();
        for (const entry of ranked) {
            await this.memories.touch(entry.id, accessedAt);
        }

        return { entries: ranked, summary };
    }

    private keywordRank(entries: MemoryEntry[], scores: Map<string, number>, limit: number): MemoryEntry[] {
        return entries
            .filter((e) => (scores.get(e.id) ?? 0) > 0)
            .sort((a, b) => (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0))
            .slice(0, limit);
    }

    public async captureTurn(input: {
        request: UserRequest;
        response: MessageRecord;
        messageCount: number;
        recentMessages: MessageRecord[];
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
        const newCandidates = candidates.filter((c) => !existingContent.has(c.content.toLowerCase()));

        let embeddings: number[][] | undefined;
        if (newCandidates.length > 0 && this.config.persistence.pgvector.enabled && this.models) {
            try {
                embeddings = await this.models.embed(newCandidates.map((c) => c.content));
            } catch (error) {
                this.logger.warn("Failed to embed memories, saving without embeddings", {
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }

        const writes: MemoryEntry[] = [];

        for (let i = 0; i < newCandidates.length; i++) {
            const candidate = newCandidates[i]!;
            const embedding = embeddings?.[i];
            await this.memories.save(candidate, embedding);
            writes.push(candidate);
        }

        await this.maybeSummarizeConversation({ messageCount: input.messageCount, recentMessages: input.recentMessages });

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

    private async maybeSummarizeConversation(input: { messageCount: number; recentMessages: MessageRecord[] }): Promise<void> {
        if (input.messageCount < this.config.memory.summaryTriggerMessageCount) {
            return;
        }

        const recent = input.recentMessages.slice(-Math.min(input.recentMessages.length, 8));
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
