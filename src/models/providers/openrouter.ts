import { OpenRouter } from "@openrouter/sdk";
import type { AppConfig } from "../../config/index.js";
import type { ModelCapability, ModelInvocation, ModelResult } from "../../types/core.js";
import type { ModelProvider } from "../contracts.js";
import { tokenize } from "../../utils/text.js";

interface OpenRouterChoice {
    message?: {
        content?: string | Array<{ text?: string }>;
    };
}

type OpenRouterMessageContent = string | Array<{ text?: string }> | undefined;

interface OpenRouterChatResult {
    choices?: OpenRouterChoice[];
    usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
    };
}

function resolveOpenRouterContent(content: OpenRouterMessageContent): string {
    if (typeof content === "string") {
        return content;
    }

    if (Array.isArray(content)) {
        return content.map((item) => item.text ?? "").join("\n").trim();
    }

    return "";
}

export class OpenRouterModelProvider implements ModelProvider {
    public readonly kind = "openrouter" as const;
    private readonly config: AppConfig;
    private readonly client?: OpenRouter;

    public constructor(config: AppConfig) {
        this.config = config;

        if (config.providers.openrouter.apiKey) {
            this.client = new OpenRouter({
                apiKey: config.providers.openrouter.apiKey,
                appTitle: "Jarvis",
            });
        }
    }

    public isConfigured(): boolean {
        return Boolean(this.client);
    }

    public supports(capability: ModelCapability): boolean {
        return capability === "chat" || capability === "embeddings";
    }

    public async generate(invocation: ModelInvocation): Promise<ModelResult> {
        if (!this.client) {
            throw new Error("OpenRouter provider is not configured.");
        }

        const result = (await this.client.chat.send({
            chatRequest: {
                model: invocation.model,
                messages: invocation.messages,
                temperature: invocation.temperature,
                stream: false,
                user: "jarvis",
            },
        })) as unknown as OpenRouterChatResult;

        const text = resolveOpenRouterContent(result.choices?.[0]?.message?.content).trim();

        return {
            provider: this.kind,
            model: invocation.model,
            text,
            usage: {
                inputTokens:
                    result.usage?.prompt_tokens ?? tokenize(invocation.messages.map((message) => message.content).join(" ")).length,
                outputTokens: result.usage?.completion_tokens ?? tokenize(text).length,
                totalTokens:
                    result.usage?.total_tokens ??
                    tokenize(invocation.messages.map((message) => message.content).join(" ")).length + tokenize(text).length,
            },
        };
    }

    public async embed(texts: string[]): Promise<number[][]> {
        return texts.map((text) => tokenize(text).slice(0, 8).map((token) => token.length / 10));
    }
}
