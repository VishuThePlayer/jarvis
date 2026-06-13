import type { AppConfig } from "../config/index.js";
import type { ModelProviderRegistry } from "../models/registry.js";
import type { Logger } from "../observability/logger.js";
import type { MessageRecord, ModelInvocation, ToolCallResult, ToolParameterDefinition, UserRequest } from "../types/core.js";
import { errorMessage } from "../utils/error.js";
import { truncate } from "../utils/text.js";
import type { CommandToolDescriptor } from "./contracts.js";

const CLARIFICATION_TOOL_NAME = "ask_clarification";

export type ToolRouteDecision =
    | { kind: "run-tool"; toolName: string; arguments: Record<string, unknown> }
    | { kind: "ask-clarification"; question: string }
    | { kind: "no-tool" };

interface ToolRouterDependencies {
    config: AppConfig;
    logger: Logger;
    models: ModelProviderRegistry;
}

export class ToolRouter {
    private readonly config: AppConfig;
    private readonly logger: Logger;
    private readonly models: ModelProviderRegistry;

    public constructor(dependencies: ToolRouterDependencies) {
        this.config = dependencies.config;
        this.logger = dependencies.logger;
        this.models = dependencies.models;
    }

    public isEnabledForChannel(channel: UserRequest["channel"]): boolean {
        return (
            this.config.tools.toolRouter.enabled === true &&
            this.config.tools.toolRouter.perChannel[channel] === true
        );
    }

    public async routeCommandTool(
        request: UserRequest,
        availableTools: CommandToolDescriptor[],
        recentMessages: MessageRecord[] = [],
    ): Promise<ToolRouteDecision> {
        if (!this.isEnabledForChannel(request.channel)) {
            return { kind: "no-tool" };
        }

        const routableTools = availableTools.filter((tool) => tool.autoRoute);
        if (routableTools.length === 0) {
            return { kind: "no-tool" };
        }

        const providerConfigured = this.models
            .getProviderHealth()
            .some((health) => health.provider === "openai" && health.configured);

        if (!providerConfigured) {
            return { kind: "no-tool" };
        }

        const forcedModelRequest: UserRequest = {
            ...request,
            requestedModel: `openai:${this.config.models.fast}`,
        };

        const conversationContext = this.buildConversationContext(request, recentMessages);
        const invocation: ModelInvocation = {
            messages: [
                {
                    role: "system",
                    content: this.buildSystemPrompt(),
                },
                {
                    role: "user",
                    content: `${conversationContext}\n\nCurrent user message: ${request.message}`,
                },
            ],
            model: this.config.models.fast,
            temperature: 0,
            tools: this.buildToolDefinitions(routableTools),
            tool_choice: "auto",
        };

        try {
            const plan = this.models.resolveForRequest(forcedModelRequest);
            const result = await this.models.generate(invocation, plan);
            const firstToolCall = result.toolCalls?.[0];

            if (!firstToolCall) {
                return { kind: "no-tool" };
            }

            if (firstToolCall.function.name === CLARIFICATION_TOOL_NAME) {
                const question = this.readClarificationQuestion(firstToolCall);
                return question ? { kind: "ask-clarification", question } : { kind: "no-tool" };
            }

            const selected = routableTools.find((tool) => tool.name === firstToolCall.function.name);
            if (!selected) {
                return { kind: "no-tool" };
            }

            const args = this.parseToolArguments(firstToolCall);
            if (!args) {
                return { kind: "no-tool" };
            }

            return {
                kind: "run-tool",
                toolName: selected.name,
                arguments: args,
            };
        } catch (error) {
            this.logger.warn("ToolRouter failed; continuing without tool routing", {
                error: errorMessage(error),
            });
            return { kind: "no-tool" };
        }
    }

    private buildSystemPrompt(): string {
        return [
            "You are ToolRouter for Jarvis.",
            "Your job is to choose exactly one of these outcomes for the current user message:",
            "1. run exactly one command tool",
            "2. ask exactly one short clarification question",
            "3. use no command tool",
            "",
            "Core policy:",
            "- Be intelligent, careful, and conservative about tool use.",
            "- Read for the user's real goal, not just keywords.",
            "- Prefer no-tool when Jarvis can answer normally without a command tool.",
            "- Prefer no-tool over clarification when no command tool is actually required.",
            "- Only run a tool when the user's intent clearly matches a real command tool and the tool will materially help.",
            "- Only ask a clarification question when a command tool is needed but the target is genuinely missing or recent context still leaves multiple reasonable tool actions.",
            "- Never invent tools, arguments, paths, apps, files, or stored memories.",
            "",
            "Normal assistant requests that should usually be no-tool:",
            "- writing, rewriting, summarizing, explaining, translating, brainstorming, drafting, planning, answering questions, or general conversation",
            "- requests like 'write short info on me', 'write a bio about me', 'introduce me', 'who am I', 'summarize me', or 'help me describe myself'",
            "- do not call a memory tool just because the message mentions me, my, name, remember, info, or who am I",
            "",
            "Use recent conversation intelligently:",
            "- Use recent messages and recent tool output to resolve references like it, that, there, them, this folder, that app, same one, open it, or list it.",
            "- If recent context already identifies the target, do not ask a clarification question.",
            "",
            "Memory rules:",
            "- Use memory-saving when the user is explicitly telling Jarvis a new fact, preference, profile detail, or durable personal information to store for later.",
            "- Use memory-lookup when the user is explicitly asking what Jarvis already knows, remembers, or saved earlier.",
            "- Declarative statements like 'remember my name is Vishu' should usually save memory.",
            "- Requests like 'write short info on me' are not memory-lookup by default; they are usually normal assistant tasks and should be no-tool.",
            "- If a message is truly ambiguous between saving memory and retrieving memory, call ask_clarification with one short question.",
            "",
            "Automation rules:",
            "- Use automation when the user clearly wants a reminder, scheduled task, repeated task, or recurring AI prompt job.",
            "- Use create-reminder for one-time reminders with a future time or relative delay.",
            "- Use create-recurring for repeated prompts such as daily summaries or recurring checks.",
            "- Use list when the user asks to see scheduled tasks.",
            "- Use cancel when the user provides an automation task id to cancel.",
            "- Ask clarification if the reminder text is clear but the due time is missing.",
            "",
            "Filesystem rules:",
            "- ps-folder is for directories and project folders.",
            "- ps-app is only for installed applications or executables.",
            "- If the user gives a folder or project name fragment but not an exact path, prefer ps-folder discovery instead of asking for a path.",
            "- Use ps-folder where to find candidate directories by name.",
            "- Use ps-folder openfind to open a directory when the user wants to open a named folder but only gave its name fragment.",
            "- Use ps-folder list when the user wants the contents of a directory and you already know or can infer the path from recent tool output.",
            "- Do not ask for a path when a folder name fragment like 'coding folder' is enough to try discovery first.",
            "",
            "Output discipline:",
            "- Call at most one tool.",
            "- If no command tool is appropriate, do not call any tool.",
            "- If clarification is necessary, ask one short concrete question.",
        ].join("\n");
    }

    private buildToolDefinitions(tools: CommandToolDescriptor[]): ToolParameterDefinition[] {
        const routerTools = tools.map((tool) => ({
            type: "function" as const,
            function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters ?? { type: "object", properties: {} },
            },
        }));

        return [
            ...routerTools,
            {
                type: "function" as const,
                function: {
                    name: CLARIFICATION_TOOL_NAME,
                    description: "Ask one short clarification question when command-tool intent is ambiguous.",
                    parameters: {
                        type: "object",
                        properties: {
                            question: {
                                type: "string",
                                description: "A short clarification question for the user.",
                            },
                        },
                        required: ["question"],
                    },
                },
            },
        ];
    }

    private parseToolArguments(toolCall: ToolCallResult): Record<string, unknown> | null {
        try {
            const parsed = JSON.parse(toolCall.function.arguments || "{}");
            return typeof parsed === "object" && parsed !== null ? parsed : null;
        } catch {
            return null;
        }
    }

    private readClarificationQuestion(toolCall: ToolCallResult): string | null {
        const parsed = this.parseToolArguments(toolCall);
        const question = parsed?.question;
        if (typeof question !== "string") {
            return null;
        }

        const cleaned = question.trim();
        return cleaned || null;
    }

    private buildConversationContext(request: UserRequest, recentMessages: MessageRecord[]): string {
        const usable = recentMessages
            .filter((message) => !(message.role === "user" && message.content === request.message))
            .slice(-6);

        if (usable.length === 0) {
            return "Recent conversation: none";
        }

        const lines = usable.map((message) => {
            const role = message.role === "tool" ? `tool:${message.toolName ?? "unknown"}` : message.role;
            const content = truncate(message.content.replace(/\s+/g, " ").trim(), 320);
            return `- ${role}: ${content}`;
        });

        return `Recent conversation:\n${lines.join("\n")}`;
    }
}
