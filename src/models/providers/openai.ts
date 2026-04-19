import type { AppConfig } from "../../config/index.js";
import type { Logger } from "../../observability/logger.js";
import type { ModelCapability, ModelInvocation, ModelResult, StreamChunk, ToolCallResult } from "../../types/core.js";
import type { ModelProvider } from "../contracts.js";
import { tokenize } from "../../utils/text.js";

const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503]);

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
    private readonly logger: Logger;

    public constructor(config: AppConfig, logger: Logger) {
        this.config = config;
        this.logger = logger;
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

        const response = await this.fetchWithRetry(`${baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify(body),
        });

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

    public async *generateStream(invocation: ModelInvocation): AsyncIterable<StreamChunk> {
        const apiKey = this.config.providers.openai.apiKey;
        if (!apiKey) {
            throw new Error("OpenAI provider is not configured.");
        }

        const baseUrl = this.config.providers.openai.baseUrl.replace(/\/$/, "");
        const body: Record<string, unknown> = {
            model: invocation.model,
            messages: invocation.messages,
            temperature: invocation.temperature,
            stream: true,
            stream_options: { include_usage: true },
        };

        if (invocation.tools && invocation.tools.length > 0) {
            body.tools = invocation.tools;
        }

        if (invocation.tool_choice !== undefined) {
            body.tool_choice = invocation.tool_choice;
        }

        const response = await this.fetchWithRetry(`${baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify(body),
        });

        const reader = response.body?.getReader();
        if (!reader) {
            throw new Error("Response body is not readable");
        }

        const decoder = new TextDecoder();
        let buffer = "";
        let accumulatedText = "";
        const accumulatedToolCalls = new Map<number, { id: string; name: string; arguments: string }>();
        let finalUsage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined;

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split("\n");
                buffer = lines.pop() ?? "";

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed.startsWith("data: ")) continue;

                    const payload = trimmed.slice(6);
                    if (payload === "[DONE]") continue;

                    let chunk: {
                        choices?: Array<{
                            delta?: { content?: string; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> };
                            finish_reason?: string | null;
                        }>;
                        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
                    };

                    try {
                        chunk = JSON.parse(payload);
                    } catch {
                        continue;
                    }

                    if (chunk.usage) {
                        finalUsage = chunk.usage;
                    }

                    const delta = chunk.choices?.[0]?.delta;
                    if (!delta) continue;

                    if (delta.content) {
                        accumulatedText += delta.content;
                        yield { text: delta.content, done: false };
                    }

                    if (delta.tool_calls) {
                        for (const tc of delta.tool_calls) {
                            const existing = accumulatedToolCalls.get(tc.index);
                            if (existing) {
                                if (tc.function?.arguments) existing.arguments += tc.function.arguments;
                            } else {
                                accumulatedToolCalls.set(tc.index, {
                                    id: tc.id ?? "",
                                    name: tc.function?.name ?? "",
                                    arguments: tc.function?.arguments ?? "",
                                });
                            }
                        }
                    }
                }
            }
        } finally {
            reader.releaseLock();
        }

        const toolCalls: ToolCallResult[] | undefined = accumulatedToolCalls.size > 0
            ? [...accumulatedToolCalls.values()].map((tc) => ({
                id: tc.id,
                type: "function" as const,
                function: { name: tc.name, arguments: tc.arguments },
            }))
            : undefined;

        const result: ModelResult = {
            provider: this.kind,
            model: invocation.model,
            text: accumulatedText,
            ...(toolCalls ? { toolCalls } : {}),
            usage: {
                inputTokens: finalUsage?.prompt_tokens ?? tokenize(invocation.messages.map((m) => m.content).join(" ")).length,
                outputTokens: finalUsage?.completion_tokens ?? tokenize(accumulatedText).length,
                totalTokens: finalUsage?.total_tokens ??
                    tokenize(invocation.messages.map((m) => m.content).join(" ")).length + tokenize(accumulatedText).length,
            },
        };

        yield { text: "", done: true, ...(result.usage ? { usage: result.usage } : {}), result };
    }

    private async fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
        const maxRetries = this.config.providers.openai.maxRetries;
        const timeoutMs = this.config.providers.openai.timeoutMs;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            const timeoutSignal = AbortSignal.timeout(timeoutMs);

            let response: Response;
            try {
                response = await fetch(url, { ...init, signal: timeoutSignal });
            } catch (error) {
                if (error instanceof DOMException && error.name === "TimeoutError") {
                    throw new Error(`LLM request timed out after ${timeoutMs}ms`);
                }
                throw error;
            }

            if (response.ok) {
                return response;
            }

            if (!RETRYABLE_STATUS_CODES.has(response.status) || attempt === maxRetries) {
                throw new Error(`OpenAI request failed with ${response.status}: ${await response.text()}`);
            }

            const retryAfter = response.headers.get("retry-after");
            let delayMs: number;
            if (retryAfter && !isNaN(Number(retryAfter))) {
                delayMs = Number(retryAfter) * 1000;
            } else {
                delayMs = Math.min(1000 * Math.pow(2, attempt), 16000) + Math.random() * 500;
            }

            this.logger.warn("LLM request failed, retrying", {
                status: response.status,
                attempt: attempt + 1,
                maxRetries,
                delayMs: Math.round(delayMs),
            });

            await new Promise((resolve) => setTimeout(resolve, delayMs));
        }

        throw new Error("LLM request failed after all retries");
    }

    public async embed(texts: string[]): Promise<number[][]> {
        const apiKey = this.config.providers.openai.apiKey;
        if (!apiKey) {
            throw new Error("OpenAI provider is not configured.");
        }

        const baseUrl = this.config.providers.openai.baseUrl.replace(/\/$/, "");

        const response = await this.fetchWithRetry(`${baseUrl}/embeddings`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model: this.config.models.embedding,
                input: texts,
            }),
        });

        const data = (await response.json()) as {
            data: Array<{ embedding: number[]; index: number }>;
        };

        return data.data
            .sort((a, b) => a.index - b.index)
            .map((item) => item.embedding);
    }
}
