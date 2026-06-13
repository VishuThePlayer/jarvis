import type { AppConfig } from "../config/index.js";
import type { ConversationRepository, MemoryRepository } from "../db/contracts.js";
import type { ModelProviderRegistry } from "../models/registry.js";
import type { Logger } from "../observability/logger.js";
import type { MemoryKind, MemoryEntry, MessageRecord, UserRequest } from "../types/core.js";
import { errorMessage } from "../utils/error.js";
import { createId } from "../utils/id.js";
import { memoryKindBoost } from "../utils/memory.js";
import { keywordOverlapScore, normalizeWhitespace, tokenize, truncate } from "../utils/text.js";
import type { MemoryContext, MemoryLookupResult, MemoryProvider, MemorySaveResult } from "./provider.js";

interface LocalMemoryProviderDependencies {
    config: AppConfig;
    logger: Logger;
    memories: MemoryRepository;
    conversations: ConversationRepository;
    models?: ModelProviderRegistry;
}

function normalizeSavedContent(text: string): string {
    return normalizeWhitespace(text).replace(/[.!]+$/g, "").trim();
}

function normalizeForComparison(text: string): string {
    return normalizeSavedContent(text).toLowerCase();
}

function inferMemoryKind(content: string): MemoryKind {
    const normalized = content.toLowerCase();

    if (
        /\b(?:prefer|favorite|like|dislike|allergic|vegetarian|vegan|gluten-free|lactose)\b/.test(normalized)
    ) {
        return "preference";
    }

    return "fact";
}

export class LocalMemoryProvider implements MemoryProvider {
    private readonly config: AppConfig;
    private readonly logger: Logger;
    private readonly memories: MemoryRepository;
    private readonly conversations: ConversationRepository;
    private readonly models?: ModelProviderRegistry;

    public constructor(dependencies: LocalMemoryProviderDependencies) {
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
            const keywords = entry.keywords ?? [];
            const score = keywordOverlapScore(queryTokens, keywords) + memoryKindBoost(entry.kind);
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
                const entryMap = new Map(allEntries.map((entry) => [entry.id, entry]));
                for (const [id, entry] of embeddingEntries) {
                    if (!entryMap.has(id)) {
                        entryMap.set(id, entry);
                    }
                }

                const maxKeyword = Math.max(...keywordScores.values(), 1);
                const hybridScored = [...allIds]
                    .map((id) => {
                        const keywordScore = (keywordScores.get(id) ?? 0) / maxKeyword;
                        const embeddingScore = embeddingScores.get(id) ?? 0;
                        return { id, score: 0.4 * keywordScore + 0.6 * embeddingScore };
                    })
                    .sort((left, right) => right.score - left.score)
                    .slice(0, limit);

                ranked = hybridScored.map((entry) => entryMap.get(entry.id)!).filter(Boolean);
            } catch (error) {
                this.logger.warn("Embedding retrieval failed, falling back to keyword search", {
                    error: errorMessage(error),
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
        const newCandidates = candidates.filter((entry) => !existingContent.has(entry.content.toLowerCase()));

        let embeddings: number[][] | undefined;
        if (newCandidates.length > 0 && this.config.persistence.pgvector.enabled && this.models) {
            try {
                embeddings = await this.models.embed(newCandidates.map((entry) => entry.content));
            } catch (error) {
                this.logger.warn("Failed to embed memories, saving without embeddings", {
                    error: errorMessage(error),
                });
            }
        }

        const writes: MemoryEntry[] = [];
        for (let index = 0; index < newCandidates.length; index += 1) {
            const candidate = newCandidates[index]!;
            const embedding = embeddings?.[index];
            await this.memories.save(candidate, embedding);
            writes.push(candidate);
        }

        await this.maybeSummarizeConversation({
            messageCount: input.messageCount,
            recentMessages: input.recentMessages,
        });

        return writes;
    }

    public async saveExplicitMemory(input: {
        request: UserRequest;
        content: string;
    }): Promise<MemorySaveResult> {
        const content = normalizeSavedContent(input.content);
        const now = new Date();
        const existingEntries = await this.memories.listByUser(input.request.userId);
        const duplicate = existingEntries.find(
            (entry) => normalizeForComparison(entry.content) === normalizeForComparison(content),
        );

        if (duplicate) {
            await this.memories.touch(duplicate.id, now);
            return {
                entry: duplicate,
                duplicate: true,
                existing: duplicate,
            };
        }

        const entry: MemoryEntry = {
            id: createId("mem"),
            userId: input.request.userId,
            kind: inferMemoryKind(content),
            content,
            keywords: tokenize(content),
            confidence: 1,
            createdAt: now,
            lastAccessedAt: now,
            ...(input.request.conversationId ? { conversationId: input.request.conversationId } : {}),
            ...(input.request.metadata.sourceMessageId
                ? { sourceMessageId: input.request.metadata.sourceMessageId }
                : {}),
        };

        await this.memories.save(entry);

        return {
            entry,
            duplicate: false,
        };
    }

    public async lookupExplicitMemory(input: {
        request: UserRequest;
        query: string;
    }): Promise<MemoryLookupResult> {
        const allEntries = await this.memories.listByUser(input.request.userId);
        if (allEntries.length === 0) {
            return { matches: [], fallback: [] };
        }

        const queryTokens = tokenize(input.query);
        const scored = allEntries
            .map((entry) => {
                const keywords = entry.keywords ?? [];
                const score = keywordOverlapScore(queryTokens, keywords) + memoryKindBoost(entry.kind);
                return { entry, score };
            })
            .filter((entry) => entry.score > 0)
            .sort((left, right) => right.score - left.score)
            .slice(0, this.config.memory.retrievalLimit)
            .map((entry) => entry.entry);

        const fallback = scored.length === 0
            ? allEntries.slice(0, this.config.memory.retrievalLimit)
            : [];

        const now = new Date();
        for (const entry of scored) {
            await this.memories.touch(entry.id, now);
        }

        return {
            matches: scored,
            fallback,
        };
    }

    private keywordRank(entries: MemoryEntry[], scores: Map<string, number>, limit: number): MemoryEntry[] {
        return entries
            .filter((entry) => (scores.get(entry.id) ?? 0) > 0)
            .sort((left, right) => (scores.get(right.id) ?? 0) - (scores.get(left.id) ?? 0))
            .slice(0, limit);
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
            if (!match?.[1]) {
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

    private async maybeSummarizeConversation(input: {
        messageCount: number;
        recentMessages: MessageRecord[];
    }): Promise<void> {
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
