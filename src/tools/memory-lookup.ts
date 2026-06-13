import type { AppConfig } from "../config/index.js";
import type { MemoryService } from "../memory/service.js";
import type { Logger } from "../observability/logger.js";
import type { ChannelKind, ToolCallRecord } from "../types/core.js";
import { errorMessage } from "../utils/error.js";
import { normalizeWhitespace, truncate } from "../utils/text.js";
import { createToolInput } from "../utils/tool-input.js";
import { createToolRecord } from "../utils/tool-record.js";
import type { CommandToolDescriptor, CommandToolInvocation } from "./contracts.js";

interface MemoryLookupToolDependencies {
    config: AppConfig;
    logger: Logger;
    memory: MemoryService;
}

function normalizeQuery(text: string): string {
    return normalizeWhitespace(text).replace(/[?.!]+$/g, "").trim();
}

export class MemoryLookupTool {
    private readonly config: AppConfig;
    private readonly logger: Logger;
    private readonly memory: MemoryService;

    public constructor(dependencies: MemoryLookupToolDependencies) {
        this.config = dependencies.config;
        this.logger = dependencies.logger;
        this.memory = dependencies.memory;
    }

    public describe(): CommandToolDescriptor {
        return {
            name: "memory-lookup",
            description:
                "Retrieve saved long-term user information. Use for recall questions like 'what's my name', 'what do you remember about me', or 'remember my preferences'. Do not use when the user is telling Jarvis a new fact to save.",
            command: "remember",
            argsHint: "<query>",
            examples: ["remember my name", "what do you remember about me", "what's my favorite editor"],
            autoRoute: true,
            parameters: {
                type: "object",
                properties: {
                    query: {
                        type: "string",
                        description: "What to retrieve from memory, such as 'my name' or 'favorite editor'.",
                    },
                },
                required: ["query"],
            },
        };
    }

    public isEnabled(channel: ChannelKind): boolean {
        return (
            this.config.memory.enabled &&
            this.config.tools.memoryLookup.enabled &&
            this.config.tools.memoryLookup.perChannel[channel]
        );
    }

    public matchDirectInvocation(): CommandToolInvocation | null {
        return null;
    }

    public async execute(invocation: CommandToolInvocation): Promise<ToolCallRecord> {
        const query = this.readQuery(invocation.arguments);
        const input = createToolInput(
            invocation.source,
            invocation.request.message,
            query ? { query } : {},
        );

        if (!query) {
            return createToolRecord(
                "memory-lookup",
                input,
                false,
                "Please provide a query. Example: remember my name",
            );
        }

        try {
            const result = await this.memory.lookupExplicitMemory({
                request: invocation.request,
                query,
            });

            if (result.matches.length === 0 && result.fallback.length === 0) {
                return createToolRecord(
                    "memory-lookup",
                    input,
                    true,
                    "I do not have any saved memories yet. Tell me something to remember first.",
                );
            }

            if (result.matches.length === 0) {
                const fallback = result.fallback
                    .map((entry) => `- ${truncate(entry.content, 120)} (${entry.kind})`)
                    .join("\n");
                return createToolRecord(
                    "memory-lookup",
                    input,
                    true,
                    `I could not find anything matching "${query}". Here is what I do remember:\n${fallback}`,
                );
            }

            const lines = result.matches
                .map(
                    (entry) =>
                        `- ${truncate(entry.content, 160)} (${entry.kind}, confidence: ${Math.round(entry.confidence * 100)}%)`,
                )
                .join("\n");

            return createToolRecord(
                "memory-lookup",
                input,
                true,
                `Here is what I remember about "${query}":\n${lines}`,
            );
        } catch (error) {
            const text = errorMessage(error);
            this.logger.warn("Memory lookup failed", { error: text });
            return createToolRecord("memory-lookup", input, false, `Memory lookup failed: ${text}`);
        }
    }

    private readQuery(args: Record<string, unknown>): string | null {
        const raw = args.query;
        if (typeof raw !== "string") {
            return null;
        }

        const query = normalizeQuery(raw);
        return query || null;
    }
}
