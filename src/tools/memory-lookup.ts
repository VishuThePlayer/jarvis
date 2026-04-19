import type { AppConfig } from "../config/index.js";
import type { MemoryRepository } from "../db/contracts.js";
import type { Logger } from "../observability/logger.js";
import type { ToolCallRecord, UserRequest } from "../types/core.js";
import { errorMessage } from "../utils/error.js";
import { memoryKindBoost } from "../utils/memory.js";
import { keywordOverlapScore, tokenize, truncate } from "../utils/text.js";
import { createToolRecord } from "../utils/tool-record.js";
import type { CommandToolDescriptor } from "./contracts.js";

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
    private lastUserId: string;

    public constructor(dependencies: MemoryLookupToolDependencies) {
        this.config = dependencies.config;
        this.logger = dependencies.logger;
        this.memories = dependencies.memories;
        this.lastUserId = this.config.app.defaultUserId;
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
        const matches = COMMAND_RE.test(message) || extractMemoryLookupIntent(message) != null;
        if (matches) {
            this.lastUserId = request.userId;
        }
        return matches;
    }

    public async execute(message: string): Promise<ToolCallRecord> {
        const query = this.parseQuery(message);

        if (!query) {
            return createToolRecord("memory-lookup", message, false, "Please provide a query. Example: //remember my name");
        }

        try {
            const userId = this.lastUserId;
            const allEntries = await this.memories.listByUser(userId);

            if (allEntries.length === 0) {
                return createToolRecord("memory-lookup", message, true, "I don't have any memories stored yet. Tell me something to remember!");
            }

            const queryTokens = tokenize(query);
            const scored = allEntries
                .map((entry) => ({
                    entry,
                    score: keywordOverlapScore(queryTokens, entry.keywords) + memoryKindBoost(entry.kind),
                }))
                .filter((s) => s.score > 0)
                .sort((a, b) => b.score - a.score)
                .slice(0, this.config.memory.retrievalLimit);

            if (scored.length === 0) {
                const allMemories = allEntries
                    .slice(0, this.config.memory.retrievalLimit)
                    .map((e) => `- ${truncate(e.content, 120)} (${e.kind})`)
                    .join("\n");
                return createToolRecord(
                    "memory-lookup",
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

            return createToolRecord("memory-lookup", message, true, `Here's what I remember about "${query}":\n${lines}`);
        } catch (error) {
            const text = errorMessage(error);
            this.logger.warn("Memory lookup failed", { error: text });
            return createToolRecord("memory-lookup", message, false, `Memory lookup failed: ${text}`);
        }
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

}
