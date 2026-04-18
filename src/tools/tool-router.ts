import type { AppConfig } from "../config/index.js";
import type { ModelInvocation, ProviderKind, UserRequest } from "../types/core.js";
import type { ModelProviderRegistry } from "../models/registry.js";
import type { Logger } from "../observability/logger.js";
import type { CommandToolDescriptor } from "./contracts.js";

export interface ToolRoute {
    tool: string;
    command: string;
}

interface ToolRouterDependencies {
    config: AppConfig;
    logger: Logger;
    models: ModelProviderRegistry;
}

function looksLikeTimeQuestion(message: string): boolean {
    return /\b(what\s*time\s+is\s+it|what(?:'|')?s?\s+the\s+time|current\s+time|time\s+now|tell\s+me\s+the\s+time)\b/i.test(
        message,
    );
}

function extractJsonObject(text: string): unknown | null {
    const trimmed = text.trim();

    try {
        return JSON.parse(trimmed);
    } catch {
        // ignore
    }

    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) {
        return null;
    }

    try {
        return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
        return null;
    }
}

function parseRoute(text: string): ToolRoute | null {
    const parsed = extractJsonObject(text);
    if (!parsed || typeof parsed !== "object") {
        return null;
    }

    const record = parsed as Record<string, unknown>;
    const tool = record.tool;
    const command = record.command;

    if (tool == null) {
        return null;
    }

    if (typeof tool !== "string" || typeof command !== "string") {
        return null;
    }

    const cleanCommand = command.trim();
    if (!cleanCommand.startsWith("//")) {
        return null;
    }

    if (cleanCommand.length > 240) {
        return null;
    }

    return { tool: tool.trim(), command: cleanCommand };
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

        if (availableTools.length === 0) {
            return null;
        }

        const timeTool = availableTools.find((tool) => tool.name === "system-com");
        if (timeTool && looksLikeTimeQuestion(request.message)) {
            return { tool: timeTool.name, command: timeTool.command };
        }

        const preferredProvider = this.config.providers.defaultProvider;
        if (preferredProvider === "local") {
            return null;
        }

        const providerConfigured = this.models
            .getProviderHealth()
            .some((health) => health.provider === preferredProvider && health.configured);

        if (!providerConfigured) {
            return null;
        }

        const toolsText = availableTools
            .map((tool) => {
                const examples = tool.examples.length > 0 ? `\nexamples:\n${tool.examples.map((ex) => `- ${ex}`).join("\n")}` : "";
                return `tool: ${tool.name}\ncommand: ${tool.command}\ndescription: ${tool.description}${examples}`;
            })
            .join("\n\n");

        const system = [
            "You are ToolRouter for Jarvis.",
            "Pick at most ONE command tool to run for the user message.",
            "Return JSON only (no markdown):",
            '{"tool": "<tool-name>", "command": "//<command> [args]"}',
            "If no tool is appropriate, return:",
            '{"tool": null, "command": ""}',
            "Only choose a tool from the provided list.",
            'Always use a command that starts with "//".',
        ].join("\n");

        const user = [
            `channel: ${request.channel}`,
            "",
            "available tools:",
            toolsText,
            "",
            `user message: ${request.message}`,
        ].join("\n");

        const forcedModelRequest: UserRequest = {
            ...request,
            // Force the "fast" model for routing to keep this cheap.
            requestedModel: `${preferredProvider}:${this.config.models.fast}`,
        };

        const invocation: ModelInvocation = {
            messages: [
                { role: "system", content: system },
                { role: "user", content: user },
            ],
            model: this.config.models.fast,
            temperature: 0,
        };

        try {
            const plan = this.models.resolveForRequest(forcedModelRequest);
            const result = await this.models.generateWithFallback(invocation, plan);
            const route = parseRoute(result.text);

            if (!route) {
                return null;
            }

            const allowed = new Set(availableTools.map((tool) => tool.name));
            if (!allowed.has(route.tool)) {
                return null;
            }

            return route;
        } catch (error) {
            this.logger.warn("ToolRouter failed; continuing without tool routing", {
                error: error instanceof Error ? error.message : String(error),
                provider: preferredProvider satisfies ProviderKind,
            });
            return null;
        }
    }
}

