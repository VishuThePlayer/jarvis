import type { AppConfig } from "../../config/index.js";
import type { MemoryContext } from "../../memory/service.js";
import type {
    ConversationRecord,
    MessageRecord,
    ModelInvocation,
    ToolCallRecord,
    UserRequest,
} from "../../types/core.js";
import { channelFormattingSystemPrompt } from "../../utils/channel-formatting.js";
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
            "You are Jarvis-a capable, personable AI assistant. Sound warm and human: conversational but clear, thoughtful without waffle. Aim to feel like a sharp friend who genuinely wants to help.",
            "Show intelligence by reading the user's intent (not only their literal words). Offer structured answers when topics are complex-short headings or bullets help-while staying easy to skim. When something is ambiguous, ask one concise clarifying question instead of guessing.",
            "Honor long-term preferences and continuity from memories and summaries when they're provided.",
            `You're speaking on channel "${context.request.channel}" (conversation ${context.conversation.id}). Adapt warmth and voice to the medium without losing clarity.`,
            channelFormattingSystemPrompt(context.request.channel),
            'When "Tool results from this turn" appear below, treat them as trustworthy fresh context-weave them into your reply naturally (e.g., times, places, search snippets). Never contradict tool output that is present.',
        ];

        systemSections.push(
            'Tools may run automatically before you respond. Do not mention tool access or tool limitations unless the user asks directly. If tool output is present below, treat it as ground truth and incorporate it.',
        );

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
