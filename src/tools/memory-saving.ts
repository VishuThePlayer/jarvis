import type { AppConfig } from "../config/index.js";
import type { MemoryService } from "../memory/service.js";
import type { Logger } from "../observability/logger.js";
import type { ChannelKind, ToolCallRecord, UserRequest } from "../types/core.js";
import { getDirectCommandArgText } from "../utils/direct-command.js";
import { errorMessage } from "../utils/error.js";
import { normalizeWhitespace } from "../utils/text.js";
import { createToolInput } from "../utils/tool-input.js";
import { createToolRecord } from "../utils/tool-record.js";
import type { CommandToolDescriptor, CommandToolInvocation } from "./contracts.js";

interface MemorySavingToolDependencies {
    config: AppConfig;
    logger: Logger;
    memory: MemoryService;
}

function normalizeSavedContent(text: string): string {
    return normalizeWhitespace(text).replace(/[.!]+$/g, "").trim();
}

export class MemorySavingTool {
    private readonly config: AppConfig;
    private readonly logger: Logger;
    private readonly memory: MemoryService;

    public constructor(dependencies: MemorySavingToolDependencies) {
        this.config = dependencies.config;
        this.logger = dependencies.logger;
        this.memory = dependencies.memory;
    }

    public describe(): CommandToolDescriptor {
        return {
            name: "memory-saving",
            description:
                "Save new long-term user information. Use for declarative facts or preferences the user is telling Jarvis to remember, even when phrased like 'remember my name is Vishu'. Do not use for questions asking what Jarvis already knows.",
            command: "save",
            argsHint: "<fact-or-preference>",
            examples: [
                "save my name is Vishu",
                "remember my favorite editor is VS Code",
                "don't forget that I prefer black coffee",
            ],
            autoRoute: true,
            parameters: {
                type: "object",
                properties: {
                    content: {
                        type: "string",
                        description: "The fact or preference to store, rewritten as a clean declarative statement.",
                    },
                },
                required: ["content"],
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

    public matchDirectInvocation(request: UserRequest): CommandToolInvocation | null {
        if (!this.isEnabled(request.channel)) {
            return null;
        }

        const argText = getDirectCommandArgText(request.message, this.describe().command);
        if (argText == null) {
            return null;
        }

        const content = normalizeSavedContent(argText);
        return {
            request,
            source: "direct-command",
            arguments: content ? { content } : {},
        };
    }

    public async execute(invocation: CommandToolInvocation): Promise<ToolCallRecord> {
        const content = this.readContent(invocation.arguments);
        const input = createToolInput(
            invocation.source,
            invocation.request.message,
            content ? { content } : {},
        );

        if (!content) {
            return createToolRecord(
                "memory-saving",
                input,
                false,
                "Please tell me what to save. Example: save my name is Vishu",
            );
        }
        try {
            const result = await this.memory.saveExplicitMemory({
                request: invocation.request,
                content,
            });

            if (result.duplicate) {
                return createToolRecord(
                    "memory-saving",
                    input,
                    true,
                    `I already had this saved: ${(result.existing ?? result.entry).content}`,
                );
            }

            return createToolRecord("memory-saving", input, true, `Saved to memory: ${content}`);
        } catch (error) {
            const text = errorMessage(error);
            this.logger.warn("Memory save failed", { error: text });
            return createToolRecord("memory-saving", input, false, `Memory save failed: ${text}`);
        }
    }

    private readContent(args: Record<string, unknown>): string | null {
        const raw = args.content;
        if (typeof raw !== "string") {
            return null;
        }

        const content = normalizeSavedContent(raw);
        return content || null;
    }
}
