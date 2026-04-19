import type { Logger } from "../observability/logger.js";
import type { AppConfig } from "../config/index.js";
import type { MemoryRepository } from "../db/contracts.js";
import { createId } from "../utils/id.js";
import type { ToolCallRecord, UserRequest } from "../types/core.js";
import type { CommandToolDescriptor } from "./contracts.js";
import { keywordOverlapScore, tokenize, truncate } from "../utils/text.js";

interface MemoryLookupToolDependencies {
    config: AppConfig;
    logger: Logger;
    memories: MemoryRepository;
}

const COMMAND_RE = /^\/\/remember(?:\s+(.+))?$/i;

const MEMORY_PHRASES_RE =
    /\b(?:do\s+you\s+(?:remember|recall|know)|what\s+do\s+you\s+(?:remember|know)\s+about|what(?:'|')?s?\s+my|tell\s+me\s+what\s+you\s+(?:remember|know)|have\s+i\s+told\s+you|did\s+i\s+(?:tell|mention|say))\b/i;

export function extractMemoryLookupIntent(message: string): { query: string } | null {
    const cleaned = message.trim();
    if (!cleaned) return null;

    if (MEMORY_PHRASES_RE.test(cleaned)) {
        return { query: cleaned };
    }

    return null;
}

export class MemoryLookupTool {
    private readonly config: AppConfig;
    private readonly logger: Logger;
    private readonly memories: MemoryRepository;

    public constructor(dependencies: MemoryLookupToolDependencies) {
        this.config = dependencies.config;
        this.logger = dependencies.logger;
        this.memories = dependencies.memories;
    }

    public describe(): CommandToolDescriptor {
        return {
            name: "memory-lookup",
            description: "Search Jarvis's memory for things the user has told it to remember — facts, preferences, names, etc.",
            command: "//remember",
            argsHint: "<query>",
            examples: ["//remember my name", "//remember preferences", "do you remember my name?"],
            autoRoute: true,
            parameters: {
                type: "object",
                properties: {
                    query: {
                        type: "string",
                        description: "What to search for in memory (e.g. 'my name', 'preferences', 'typescript').",
                    },
                },
                required: ["query"],
            },
        };
    }

    public shouldRun(request: UserRequest): boolean {
        if (!this.config.tools.memoryLookup.enabled) return false;
        if (!this.config.tools.memoryLookup.perChannel[request.channel]) return false;

        const message = request.message.trim();
        return COMMAND_RE.test(message) || extractMemoryLookupIntent(message) != null;
    }

    public async execute(message: string): Promise<ToolCallRecord> {
        const query = this.parseQuery(message);

        if (!query) {
            return this.record(message, false, "Please provide a query. Example: //remember my name");
        }

        try {
            const userId = this.config.app.defaultUserId;
            const allEntries = await this.memories.listByUser(userId);

            if (allEntries.length === 0) {
                return this.record(message, true, "I don't have any memories stored yet. Tell me something to remember!");
            }

            const queryTokens = tokenize(query);
            const scored = allEntries
                .map((entry) => ({
                    entry,
                    score: keywordOverlapScore(queryTokens, entry.keywords) + this.kindBoost(entry.kind),
                }))
                .filter((s) => s.score > 0)
                .sort((a, b) => b.score - a.score)
                .slice(0, this.config.memory.retrievalLimit);

            if (scored.length === 0) {
                const allMemories = allEntries
                    .slice(0, this.config.memory.retrievalLimit)
                    .map((e) => `- ${truncate(e.content, 120)} (${e.kind})`)
                    .join("\n");
                return this.record(
                    message,
                    true,
                    `I couldn't find anything matching "${query}". Here's what I do remember:\n${allMemories}`,
                );
            }

            const now = new Date();
            for (const { entry } of scored) {
                await this.memories.touch(entry.id, now);
            }

            const lines = scored
                .map(({ entry }) => `- ${truncate(entry.content, 160)} (${entry.kind}, confidence: ${Math.round(entry.confidence * 100)}%)`)
                .join("\n");

            return this.record(message, true, `Here's what I remember about "${query}":\n${lines}`);
        } catch (error) {
            const text = error instanceof Error ? error.message : String(error);
            this.logger.warn("Memory lookup failed", { error: text });
            return this.record(message, false, `Memory lookup failed: ${text}`);
        }
    }

    private record(input: string, success: boolean, output: string): ToolCallRecord {
        return { id: createId("tool"), name: "memory-lookup", input, output, success, createdAt: new Date() };
    }

    private parseQuery(message: string): string | null {
        const trimmed = message.trim();

        const cmdMatch = trimmed.match(COMMAND_RE);
        if (cmdMatch) {
            return cmdMatch[1]?.trim() || null;
        }

        const intent = extractMemoryLookupIntent(trimmed);
        if (intent) {
            return intent.query;
        }

        return null;
    }

    private kindBoost(kind: string): number {
        switch (kind) {
            case "preference":
                return 0.4;
            case "fact":
                return 0.25;
            case "episode":
                return 0.1;
            case "summary":
                return 0.05;
            default:
                return 0;
        }
    }
}
