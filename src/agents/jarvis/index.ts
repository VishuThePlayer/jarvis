import type { AppConfig } from "../../config/index.js";
import type { MemoryContext } from "../../memory/service.js";
import type {
    ConversationRecord,
    MessageRecord,
    ModelInvocation,
    ToolCallRecord,
    UserRequest,
} from "../../types/core.js";
import { truncate } from "../../utils/text.js";

export interface AgentTurnContext {
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
        const systemSections = [
            "You are Jarvis, a reliable personal AI assistant.",
            "Be direct, structured, helpful, and consistent with the user's long-term preferences.",
            `Channel: ${context.request.channel}. Conversation ID: ${context.conversation.id}.`,
            "If fresh tool results are provided, treat them as trusted runtime context for this turn.",
        ];

        if (context.memoryContext.summary) {
            systemSections.push(`Conversation summary:\n${context.memoryContext.summary.content}`);
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
                    .map((toolCall) => `- ${truncate(toolCall.output, 220)}`)
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
