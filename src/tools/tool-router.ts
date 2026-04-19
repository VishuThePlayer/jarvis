import type { AppConfig } from "../config/index.js";
import type { ModelInvocation, ToolCallResult, ToolParameterDefinition, UserRequest } from "../types/core.js";
import type { ModelProviderRegistry } from "../models/registry.js";
import type { Logger } from "../observability/logger.js";
import type { CommandToolDescriptor } from "./contracts.js";
import { extractTimeIntent } from "./time.js";

export interface ToolRoute {
    tool: string;
    command: string;
}

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

    public async routeCommandTool(request: UserRequest, availableTools: CommandToolDescriptor[]): Promise<ToolRoute | null> {
        if (!this.isEnabledForChannel(request.channel)) {
            return null;
        }

        const routableTools = availableTools.filter((tool) => tool.autoRoute);
        if (routableTools.length === 0) {
            return null;
        }

        const timeTool = routableTools.find((tool) => tool.name === "time");
        const timeIntent = timeTool ? extractTimeIntent(request.message) : null;
        if (timeTool && timeIntent) {
            const command = timeIntent.place ? `${timeTool.command} ${timeIntent.place}` : timeTool.command;
            return { tool: timeTool.name, command };
        }

        if (routableTools.length < 2) {
            return null;
        }

        const providerConfigured = this.models
            .getProviderHealth()
            .some((health) => health.provider === "openai" && health.configured);

        if (!providerConfigured) {
            return null;
        }

        const forcedModelRequest: UserRequest = {
            ...request,
            requestedModel: `openai:${this.config.models.fast}`,
        };

        const invocation: ModelInvocation = {
            messages: [
                {
                    role: "system",
                    content: "You are ToolRouter for Jarvis.\nPick at most ONE tool to run for the user message.\nIf no tool is appropriate, do not call any tool.",
                },
                { role: "user", content: request.message },
            ],
            model: this.config.models.fast,
            temperature: 0,
            tools: this.buildToolDefinitions(routableTools),
            tool_choice: "auto",
        };

        try {
            const plan = this.models.resolveForRequest(forcedModelRequest);
            const result = await this.models.generate(invocation, plan);

            if (!result.toolCalls || result.toolCalls.length === 0) {
                return null;
            }

            const route = this.buildCommandFromToolCall(result.toolCalls[0]!, routableTools);
            if (!route) {
                return null;
            }

            const allowed = new Set(routableTools.map((tool) => tool.name));
            if (!allowed.has(route.tool)) {
                return null;
            }

            const selected = routableTools.find((tool) => tool.name === route.tool);
            if (!selected || !route.command.toLowerCase().startsWith(selected.command.toLowerCase())) {
                return null;
            }

            return route;
        } catch (error) {
            this.logger.warn("ToolRouter failed; continuing without tool routing", {
                error: error instanceof Error ? error.message : String(error),
            });
            return null;
        }
    }

    private buildToolDefinitions(tools: CommandToolDescriptor[]): ToolParameterDefinition[] {
        return tools.map((tool) => ({
            type: "function" as const,
            function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters ?? { type: "object", properties: {} },
            },
        }));
    }

    private buildCommandFromToolCall(toolCall: ToolCallResult, tools: CommandToolDescriptor[]): ToolRoute | null {
        const descriptor = tools.find((t) => t.name === toolCall.function.name);
        if (!descriptor) {
            return null;
        }

        let args = "";
        try {
            const parsed = JSON.parse(toolCall.function.arguments);
            if (typeof parsed === "object" && parsed !== null) {
                const values = Object.values(parsed).filter(
                    (v): v is string => typeof v === "string" && v.trim().length > 0,
                );
                args = values.join(" ");
            }
        } catch {
            // empty or malformed arguments
        }

        const command = args ? `${descriptor.command} ${args}`.trim() : descriptor.command;

        if (command.length > 240) {
            return null;
        }

        return { tool: descriptor.name, command };
    }
}
