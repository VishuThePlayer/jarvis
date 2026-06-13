import type { AppConfig } from "../config/index.js";
import type { Logger } from "../observability/logger.js";
import type { ConversationSummary, MemoryEntry, MessageRecord, UserRequest } from "../types/core.js";
import { errorMessage } from "../utils/error.js";
import { createId } from "../utils/id.js";
import { normalizeWhitespace, tokenize } from "../utils/text.js";
import type { MemoryContext, MemoryLookupResult, MemoryProvider, MemorySaveResult } from "./provider.js";
import { ZepClient, type ZepGraphSearchResponse, type ZepSessionMemoryResponse } from "./zep-client.js";

interface ZepMemoryProviderDependencies {
    config: AppConfig;
    logger: Logger;
    fallback: MemoryProvider;
}

export class ZepMemoryProvider implements MemoryProvider {
    private readonly config: AppConfig;
    private readonly logger: Logger;
    private readonly fallback: MemoryProvider;
    private readonly client: ZepClient;

    public constructor(dependencies: ZepMemoryProviderDependencies) {
        this.config = dependencies.config;
        this.logger = dependencies.logger;
        this.fallback = dependencies.fallback;
        this.client = new ZepClient({
            apiKey: dependencies.config.providers.zep.apiKey!,
            baseUrl: dependencies.config.providers.zep.baseUrl,
        });
    }

    public async retrieveContext(input: {
        userId: string;
        conversationId: string;
        query: string;
    }): Promise<MemoryContext> {
        const fallbackContextPromise = this.fallback.retrieveContext(input);

        try {
            await this.ensureScope(input.userId, input.conversationId);

            const [sessionMemory, graphSearch, fallbackContext] = await Promise.all([
                this.client.getSessionMemory(input.conversationId),
                this.client.searchGraph({
                    userId: input.userId,
                    query: input.query,
                    limit: this.config.memory.retrievalLimit,
                }),
                fallbackContextPromise,
            ]);

            const zepEntries = this.combineEntries(
                this.entriesFromSessionMemory(sessionMemory, input.userId, input.conversationId),
                this.entriesFromGraphSearch(graphSearch, input.userId, input.conversationId),
            );
            const entries = this.combineEntries(zepEntries, fallbackContext.entries);
            const summary = this.summaryFromSessionMemory(sessionMemory, input.conversationId) ?? fallbackContext.summary;
            const contextBlock = this.firstNonEmpty(sessionMemory?.context, fallbackContext.contextBlock);

            return {
                entries,
                summary,
                ...(summary ? { summaryLabel: "Long-term memory summary" } : {}),
                ...(contextBlock ? { contextBlock } : {}),
            };
        } catch (error) {
            this.logger.warn("Zep memory retrieval failed, falling back to local memory", {
                error: errorMessage(error),
                userId: input.userId,
                conversationId: input.conversationId,
            });
            return fallbackContextPromise;
        }
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

        const sessionId = this.sessionIdForRequest(input.request);
        const userName = this.userNameForRequest(input.request);

        try {
            await this.ensureScope(input.request.userId, sessionId);
            await this.client.addSessionMemory({
                sessionId,
                messages: [
                    {
                        created_at: new Date().toISOString(),
                        role_type: "user",
                        content: input.request.message,
                        ...(userName ? { name: userName } : {}),
                    },
                    {
                        created_at: input.response.createdAt.toISOString(),
                        role_type: "assistant",
                        content: input.response.content,
                        name: "Jarvis",
                    },
                ],
                ignoreRoles: ["assistant"],
            });
            return [];
        } catch (error) {
            this.logger.warn("Zep turn capture failed, falling back to local memory", {
                error: errorMessage(error),
                requestId: input.request.requestId,
                userId: input.request.userId,
            });
            return this.fallback.captureTurn(input);
        }
    }

    public async saveExplicitMemory(input: {
        request: UserRequest;
        content: string;
    }): Promise<MemorySaveResult> {
        const sessionId = this.sessionIdForRequest(input.request);
        const userName = this.userNameForRequest(input.request);

        try {
            await this.ensureScope(input.request.userId, sessionId);

            const existing = await this.findExactMatch(input.request.userId, input.content, sessionId);
            if (existing) {
                await this.fallback.saveExplicitMemory(input);
                return {
                    entry: existing,
                    duplicate: true,
                    existing,
                };
            }

            await this.client.addSessionMemory({
                sessionId,
                messages: [
                    {
                        created_at: new Date().toISOString(),
                        role_type: "user",
                        content: normalizeWhitespace(input.content),
                        ...(userName ? { name: userName } : {}),
                    },
                ],
            });

            return this.fallback.saveExplicitMemory(input);
        } catch (error) {
            this.logger.warn("Zep explicit memory save failed, falling back to local memory", {
                error: errorMessage(error),
                requestId: input.request.requestId,
                userId: input.request.userId,
            });
            return this.fallback.saveExplicitMemory(input);
        }
    }

    public async lookupExplicitMemory(input: {
        request: UserRequest;
        query: string;
    }): Promise<MemoryLookupResult> {
        const sessionId = this.sessionIdForRequest(input.request);
        const fallbackResultPromise = this.fallback.lookupExplicitMemory(input);

        try {
            await this.ensureScope(input.request.userId, sessionId);

            const [sessionMemory, graphSearch, fallbackResult] = await Promise.all([
                this.client.getSessionMemory(sessionId),
                this.client.searchGraph({
                    userId: input.request.userId,
                    query: input.query,
                    limit: this.config.memory.retrievalLimit,
                }),
                fallbackResultPromise,
            ]);

            const matches = this.combineEntries(
                this.entriesFromGraphSearch(graphSearch, input.request.userId, sessionId),
                fallbackResult.matches,
            );

            const fallback = matches.length === 0
                ? this.combineEntries(
                    this.entriesFromSessionMemory(sessionMemory, input.request.userId, sessionId),
                    fallbackResult.fallback,
                )
                : [];

            return { matches, fallback };
        } catch (error) {
            this.logger.warn("Zep explicit memory lookup failed, falling back to local memory", {
                error: errorMessage(error),
                requestId: input.request.requestId,
                userId: input.request.userId,
            });
            return fallbackResultPromise;
        }
    }

    private async ensureScope(userId: string, sessionId: string): Promise<void> {
        await this.client.ensureUser(userId);
        await this.client.ensureSession(sessionId, userId);
    }

    private sessionIdForRequest(request: UserRequest): string {
        return request.conversationId ?? request.requestId;
    }

    private async findExactMatch(userId: string, content: string, conversationId: string): Promise<MemoryEntry | null> {
        const response = await this.client.searchGraph({
            userId,
            query: content,
            limit: this.config.memory.retrievalLimit,
        });
        const normalized = this.normalizeForComparison(content);
        const candidates = this.combineEntries(
            this.entriesFromGraphSearch(response, userId, conversationId),
            [],
        );

        return candidates.find((entry) => this.normalizeForComparison(entry.content) === normalized) ?? null;
    }

    private summaryFromSessionMemory(
        response: ZepSessionMemoryResponse | null,
        conversationId: string,
    ): ConversationSummary | null {
        const content = this.firstNonEmpty(
            response?.summary,
            this.extractSummaryFromContext(response?.context),
        );
        if (!content) {
            return null;
        }

        const now = new Date();
        return {
            id: `zep-summary-${conversationId}`,
            conversationId,
            content,
            sourceMessageIds: [],
            createdAt: now,
            updatedAt: now,
        };
    }

    private entriesFromSessionMemory(
        response: ZepSessionMemoryResponse | null,
        userId: string,
        conversationId: string,
    ): MemoryEntry[] {
        if (!response) {
            return [];
        }

        const factEntries = this.readRelevantFacts(response)
            .map((content, index) => this.createEntry({
                id: `zep-fact-${conversationId}-${index}`,
                userId,
                conversationId,
                content,
                kind: "fact",
            }))
            .filter((entry): entry is MemoryEntry => entry != null);

        const episodeEntries = (response.episodes ?? [])
            .map((episode, index) => {
                const content = this.firstNonEmpty(episode.content, episode.summary);
                if (!content) {
                    return null;
                }

                return this.createEntry({
                    id: episode.uuid ?? `zep-episode-${conversationId}-${index}`,
                    userId,
                    conversationId,
                    content,
                    kind: "episode",
                    ...(episode.created_at ? { createdAt: episode.created_at } : {}),
                });
            })
            .filter((entry): entry is MemoryEntry => entry != null);

        return this.combineEntries(factEntries, episodeEntries);
    }

    private readRelevantFacts(response: ZepSessionMemoryResponse | null): string[] {
        if (!response) {
            return [];
        }

        const explicitFacts = (response.relevant_facts ?? [])
            .map((fact) => normalizeWhitespace(fact))
            .filter(Boolean);
        if (explicitFacts.length > 0) {
            return explicitFacts;
        }

        return this.extractFactsFromContext(response.context);
    }

    private entriesFromGraphSearch(
        response: ZepGraphSearchResponse | null,
        userId: string,
        conversationId: string,
    ): MemoryEntry[] {
        if (!response) {
            return [];
        }

        const pools = [
            response.results ?? [],
            response.edges ?? [],
            response.nodes ?? [],
            response.episodes ?? [],
        ];

        const entries: MemoryEntry[] = [];
        for (const pool of pools) {
            for (const item of pool) {
                const parsed = this.parseGraphItem(item);
                if (!parsed) {
                    continue;
                }

                const entry = this.createEntry({
                    id: parsed.id ?? createId("mem"),
                    userId,
                    conversationId,
                    content: parsed.content,
                    kind: parsed.kind,
                    ...(parsed.createdAt ? { createdAt: parsed.createdAt } : {}),
                });
                if (entry) {
                    entries.push(entry);
                }
            }
        }

        return this.combineEntries(entries, []);
    }

    private parseGraphItem(item: unknown): {
        id?: string;
        content: string;
        kind: MemoryEntry["kind"];
        createdAt?: string;
    } | null {
        if (typeof item === "string") {
            return {
                content: item,
                kind: "fact",
            };
        }

        if (!item || typeof item !== "object") {
            return null;
        }

        const record = item as Record<string, unknown>;
        const content = this.firstNonEmpty(
            this.readString(record.content),
            this.readString(record.fact),
            this.readString(record.summary),
            this.readString(record.name),
            this.stringifyRelationship(record),
        );

        if (!content) {
            return null;
        }

        const parsed: {
            id?: string;
            content: string;
            kind: MemoryEntry["kind"];
            createdAt?: string;
        } = {
            content,
            kind: this.inferKind(record),
        };

        const id = this.readString(record.uuid) ?? this.readString(record.id);
        if (id) {
            parsed.id = id;
        }

        const createdAt = this.readString(record.created_at) ?? this.readString(record.valid_at);
        if (createdAt) {
            parsed.createdAt = createdAt;
        }

        return parsed;
    }

    private stringifyRelationship(record: Record<string, unknown>): string | null {
        const source = this.readString(record.source_name) ?? this.readString(record.source);
        const target = this.readString(record.target_name) ?? this.readString(record.target);
        const relation = this.readString(record.fact) ?? this.readString(record.name);

        if (!source || !target || !relation) {
            return null;
        }

        return `${source} ${relation} ${target}`;
    }

    private inferKind(record: Record<string, unknown>): MemoryEntry["kind"] {
        const label = this.readString(record.kind) ?? this.readString(record.type) ?? "";
        const normalized = label.toLowerCase();

        if (normalized.includes("preference")) {
            return "preference";
        }

        if (normalized.includes("episode")) {
            return "episode";
        }

        if (normalized.includes("summary")) {
            return "summary";
        }

        return "fact";
    }

    private createEntry(input: {
        id: string;
        userId: string;
        conversationId: string;
        content: string;
        kind: MemoryEntry["kind"];
        createdAt?: string;
    }): MemoryEntry | null {
        const content = normalizeWhitespace(input.content);
        if (!content) {
            return null;
        }

        const createdAt = input.createdAt ? new Date(input.createdAt) : new Date();
        const safeCreatedAt = Number.isNaN(createdAt.getTime()) ? new Date() : createdAt;

        return {
            id: input.id,
            userId: input.userId,
            kind: input.kind,
            content,
            keywords: tokenize(content),
            confidence: 0.9,
            createdAt: safeCreatedAt,
            lastAccessedAt: new Date(),
            conversationId: input.conversationId,
        };
    }

    private combineEntries(...groups: MemoryEntry[][]): MemoryEntry[] {
        const entries = new Map<string, MemoryEntry>();

        for (const group of groups) {
            for (const entry of group) {
                const key = this.normalizeForComparison(entry.content);
                if (!entries.has(key)) {
                    entries.set(key, entry);
                }
            }
        }

        return [...entries.values()].slice(0, this.config.memory.retrievalLimit);
    }

    private normalizeForComparison(text: string): string {
        return normalizeWhitespace(text).replace(/[.!]+$/g, "").trim().toLowerCase();
    }

    private firstNonEmpty(...values: Array<string | undefined | null>): string | null {
        for (const value of values) {
            if (typeof value === "string" && value.trim()) {
                return value.trim();
            }
        }

        return null;
    }

    private readString(value: unknown): string | undefined {
        return typeof value === "string" ? value : undefined;
    }

    private userNameForRequest(request: UserRequest): string | undefined {
        return this.firstNonEmpty(request.metadata.username, request.userId) ?? undefined;
    }

    private extractSummaryFromContext(context: string | null | undefined): string | null {
        return this.extractTaggedBlock(context, "USER_SUMMARY");
    }

    private extractFactsFromContext(context: string | null | undefined): string[] {
        const source = this.extractTaggedBlock(context, "FACTS") ?? context;
        if (!source) {
            return [];
        }

        return source
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line.startsWith("-"))
            .map((line) => line.replace(/^-+\s*/, ""))
            .map((line) => line.replace(/\s+\((?:Date range:\s*)?[^()]*\d{4}[^()]*\)\s*$/, "").trim())
            .filter(Boolean);
    }

    private extractTaggedBlock(context: string | null | undefined, tag: string): string | null {
        if (!context) {
            return null;
        }

        const pattern = new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*<\\/${tag}>`, "i");
        const match = pattern.exec(context);
        return match?.[1]?.trim() || null;
    }
}
