import type { AppConfig } from "../../config/index.js";
import type { ModelCapability, ModelInvocation, ModelResult, ToolCallResult } from "../../types/core.js";
import type { ModelProvider } from "../contracts.js";
import { tokenize } from "../../utils/text.js";

interface OpenAIChatChoice {
    message?: {
        content?: string | Array<{ type?: string; text?: string }>;
        tool_calls?: Array<{
            id: string;
            type: "function";
            function: {
                name: string;
                arguments: string;
            };
        }>;
    };
}

type OpenAIMessageContent = string | Array<{ type?: string; text?: string }> | undefined;

interface OpenAIChatResponse {
    choices?: OpenAIChatChoice[];
    usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
    };
}

function resolveContent(content: OpenAIMessageContent): string {
    if (typeof content === "string") {
        return content;
    }

    if (Array.isArray(content)) {
        return content.map((item) => item.text ?? "").join("\n").trim();
    }

    return "";
}

export class OpenAIModelProvider implements ModelProvider {
    public readonly kind = "openai" as const;
    private readonly config: AppConfig;

    public constructor(config: AppConfig) {
        this.config = config;
    }

    public isConfigured(): boolean {
        return Boolean(this.config.providers.openai.apiKey);
    }

    public supports(capability: ModelCapability): boolean {
        return capability === "chat" || capability === "embeddings";
    }

    public async generate(invocation: ModelInvocation): Promise<ModelResult> {
        const apiKey = this.config.providers.openai.apiKey;
        if (!apiKey) {
            throw new Error("OpenAI provider is not configured.");
        }

        const baseUrl = this.config.providers.openai.baseUrl.replace(/\/$/, "");
        const body: Record<string, unknown> = {
            model: invocation.model,
            messages: invocation.messages,
            temperature: invocation.temperature,
        };

        if (invocation.tools && invocation.tools.length > 0) {
            body.tools = invocation.tools;
        }

        if (invocation.tool_choice !== undefined) {
            body.tool_choice = invocation.tool_choice;
        }

        const response = await fetch(`${baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify(body),
        });


        if (!response.ok) {
            throw new Error(`OpenAI request failed with ${response.status}: ${await response.text()}`);
        }

        const data = (await response.json()) as OpenAIChatResponse;
        const text = resolveContent(data.choices?.[0]?.message?.content).trim();

        const rawToolCalls = data.choices?.[0]?.message?.tool_calls;
        const toolCalls: ToolCallResult[] | undefined = rawToolCalls?.map((tc) => ({
            id: tc.id,
            type: tc.type,
            function: {
                name: tc.function.name,
                arguments: tc.function.arguments,
            },
        }));

        return {
            provider: this.kind,
            model: invocation.model,
            text,
            ...(toolCalls ? { toolCalls } : {}),
            usage: {
                inputTokens:
                    data.usage?.prompt_tokens ?? tokenize(invocation.messages.map((message) => message.content).join(" ")).length,
                outputTokens: data.usage?.completion_tokens ?? tokenize(text).length,
                totalTokens:
                    data.usage?.total_tokens ??
                    tokenize(invocation.messages.map((message) => message.content).join(" ")).length + tokenize(text).length,
            },
        };
    }

    public async embed(texts: string[]): Promise<number[][]> {
        return texts.map((text) => tokenize(text).slice(0, 8).map((token) => token.length / 10));
    }
}
