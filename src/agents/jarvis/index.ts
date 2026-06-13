import type { AppConfig } from "../../config/index.js";
import type { MemoryContext } from "../../memory/provider.js";
import type {
    ConversationRecord,
    MessageRecord,
    ModelInvocation,
    ToolCallRecord,
    UserRequest,
} from "../../types/core.js";
import { channelFormattingSystemPrompt } from "../../utils/channel-formatting.js";
import { truncate } from "../../utils/text.js";

interface AgentTurnContext {
    request: UserRequest;
    conversation: ConversationRecord;
    history: MessageRecord[];
    memoryContext: MemoryContext;
    toolCalls: ToolCallRecord[];
}

export interface AssistantAgent {
    id: string;
    prepareInvocation(context: AgentTurnContext): Promise<ModelInvocation>;
}

export class JarvisAgent implements AssistantAgent {
    public readonly id = "jarvis";
    private readonly config: AppConfig;

    public constructor(config: AppConfig) {
        this.config = config;
    }

    public async prepareInvocation(context: AgentTurnContext): Promise<ModelInvocation> {
        const toolNames = Object.keys(this.config.tools)
            .filter((name) => name !== "toolRouter")
            .join(", ");

        const systemSections = [
            "You are Jarvis, a capable and practical assistant. Be clear, calm, and conversational.",
            "Read intent, not just literal wording. Use short headings or bullets when they help. If you are missing a key detail, ask one concise question.",
            `You are replying on channel "${context.request.channel}". Match the tone and formatting to that channel.`,
            channelFormattingSystemPrompt(context.request.channel),
            `Available tools: ${toolNames}. Some may already have run for this turn. If you see "Tool results from this turn" below, treat those results as facts and use them directly. Do not discuss routing or internal mechanics unless the user asks.`,
            "Files and folders: do not force the user to paste full Windows paths unless nothing else will work. Use the available folder and search context to infer likely paths first, then ask one short clarification if needed.",
            "Never claim you cannot access the user's files when tool results or folder tools are available. Ask a short clarification instead of giving a generic refusal.",
            "Honor long-term preferences and memories when they are provided.",
        ];

        if (context.memoryContext.summary) {
            systemSections.push(
                `${context.memoryContext.summaryLabel ?? "Conversation summary"}:\n${context.memoryContext.summary.content}`,
            );
        }

        if (context.memoryContext.contextBlock) {
            systemSections.push(`Long-term memory context:\n${context.memoryContext.contextBlock}`);
        }

        if (context.memoryContext.entries.length > 0) {
            systemSections.push(
                `Known long-term memories:\n${context.memoryContext.entries
                    .map((entry) => `- (${entry.kind}) ${truncate(entry.content, 180)}`)
                    .join("\n")}`,
            );
        }

        if (context.toolCalls.length > 0) {
            systemSections.push(
                `Tool results from this turn:\n${context.toolCalls
                    .map((toolCall) => {
                        const cap = toolCall.name === "ps-folder" ? 16_000 : 220;
                        return `- ${truncate(toolCall.output, cap)}`;
                    })
                    .join("\n")}`,
            );
        }

        const historyMessages = context.history
            .filter((message) => message.role !== "tool")
            .slice(-10)
            .map((message) => this.toModelMessage(message));

        return {
            model: this.config.models.default,
            temperature: this.config.app.defaultTemperature,
            messages: [
                {
                    role: "system",
                    content: systemSections.join("\n\n"),
                },
                ...historyMessages,
            ],
        };
    }

    private toModelMessage(message: MessageRecord): ModelInvocation["messages"][number] {
        switch (message.role) {
            case "assistant":
            case "system":
            case "user":
                return {
                    role: message.role,
                    content: message.content,
                };
            case "tool":
                return {
                    role: "assistant",
                    content: message.content,
                };
        }
    }
}
