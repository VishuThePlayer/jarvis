import type { AppConfig } from "../../config/index.js";
import type { Logger } from "../../observability/logger.js";
import type { Orchestrator } from "../../orchestrator/index.js";
import type { ChannelAdapter } from "../types.js";
import { escapeTelegramHtml, telegramPlainFallback } from "../../utils/channel-formatting.js";
import { createId } from "../../utils/id.js";

interface TelegramChannelDependencies {
    config: AppConfig;
    logger: Logger;
    orchestrator: Orchestrator;
}

interface TelegramUpdate {
    update_id: number;
    message?: {
        message_id: number;
        text?: string;
        chat: {
            id: number;
            username?: string;
        };
        from?: {
            id: number;
            username?: string;
            first_name?: string;
        };
    };
}

type TelegramResponse<T> =
    | {
          ok: true;
          result: T;
      }
    | {
          ok: false;
          error_code: number;
          description: string;
          parameters?: {
              retry_after?: number;
          };
      };

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === "AbortError";
}

export class TelegramChannelAdapter implements ChannelAdapter {
    private readonly config: AppConfig;
    private readonly logger: Logger;
    private readonly orchestrator: Orchestrator;
    private running = false;
    private offset = 0;
    private pollTask?: Promise<void>;
    private pollAbort: AbortController | undefined;

    public constructor(dependencies: TelegramChannelDependencies) {
        this.config = dependencies.config;
        this.logger = dependencies.logger;
        this.orchestrator = dependencies.orchestrator;
    }

    public async start(): Promise<void> {
        if (!this.config.channels.telegram.botToken) {
            this.logger.warn("Telegram channel is enabled but TELEGRAM_BOT_TOKEN is missing.");
            return;
        }

        if (this.running) {
            return;
        }

        this.running = true;
        this.pollTask = this.pollLoop();
        this.logger.info("Telegram channel started");
    }

    public async stop(): Promise<void> {
        this.running = false;
        this.pollAbort?.abort();

        try {
            await this.pollTask;
        } catch (error) {
            if (!isAbortError(error)) {
                throw error;
            }
        }
    }

    private async pollLoop(): Promise<void> {
        while (this.running) {
            const controller = new AbortController();
            this.pollAbort = controller;

            try {
                const timeoutSeconds = this.config.channels.telegram.longPollTimeoutSec;
                const updates = await this.getUpdates({
                    timeoutSeconds,
                    limit: 100,
                    signal: controller.signal,
                });

                for (const update of updates) {
                    await this.handleUpdate(update);
                    this.offset = Math.max(this.offset, update.update_id + 1);
                }

                // If long polling is disabled, prevent a tight loop when idle.
                if (timeoutSeconds === 0 && updates.length === 0) {
                    await sleep(this.config.channels.telegram.pollIntervalMs);
                }
            } catch (error) {
                if (!this.running || isAbortError(error)) {
                    return;
                }

                this.logger.error("Telegram polling failed", {
                    error: error instanceof Error ? error.message : String(error),
                });

                const retryAfterSeconds =
                    error instanceof Error && "retryAfterSeconds" in error
                        ? Number((error as Error & { retryAfterSeconds?: number }).retryAfterSeconds)
                        : NaN;

                await sleep(
                    Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
                        ? retryAfterSeconds * 1000
                        : this.config.channels.telegram.pollIntervalMs,
                );
            } finally {
                if (this.pollAbort === controller) {
                    this.pollAbort = undefined;
                }
            }
        }
    }

    private async handleUpdate(update: TelegramUpdate): Promise<void> {
        const message = update.message;
        if (!message?.text) {
            return;
        }

        const text = message.text.trim();
        if (text === "/start") {
            await this.sendMessage(
                message.chat.id,
                "<b>Jarvis</b> is online.\n\nSend a message or use /models for configured models.",
            );
            return;
        }

        if (text === "/models") {
            const modelText = this.orchestrator
                .listModels()
                .map((model) => `- ${model.provider}:${model.id} [${model.roles.join(", ")}]`)
                .join("\n");
            const body = modelText ? `<b>Models</b>\n<pre>${escapeTelegramHtml(modelText)}</pre>` : "<i>No models configured.</i>";
            await this.sendMessage(message.chat.id, body);
            return;
        }

        const response = await this.orchestrator.handleRequest({
            requestId: createId("req"),
            channel: "telegram",
            userId: `telegram:${message.from?.id ?? message.chat.id}`,
            conversationId: `telegram:${message.chat.id}`,
            message: text,
            attachments: [],
            metadata: {
                ...(message.from?.username ?? message.chat.username
                    ? { username: message.from?.username ?? message.chat.username }
                    : {}),
                sourceMessageId: String(message.message_id),
            },
        });

        await this.sendMessage(message.chat.id, response.content.slice(0, 4000));
    }

    private async getUpdates(input: {
        timeoutSeconds: number;
        limit: number;
        signal: AbortSignal;
    }): Promise<TelegramUpdate[]> {
        const response = await fetch(
            this.buildApiUrl("getUpdates", {
                offset: String(this.offset),
                timeout: String(input.timeoutSeconds),
                limit: String(input.limit),
            }),
            { signal: input.signal },
        );

        if (!response.ok) {
            const error = new Error(`Telegram getUpdates failed with ${response.status} ${response.statusText}`);
            const retryAfterSeconds = Number(response.headers.get("Retry-After"));
            if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
                (error as Error & { retryAfterSeconds?: number }).retryAfterSeconds = retryAfterSeconds;
            }
            throw error;
        }

        const data = (await response.json()) as TelegramResponse<TelegramUpdate[]>;
        if (!data.ok) {
            const error = new Error(`Telegram getUpdates error ${data.error_code}: ${data.description}`);
            if (data.parameters?.retry_after) {
                (error as Error & { retryAfterSeconds?: number }).retryAfterSeconds = data.parameters.retry_after;
            }
            throw error;
        }

        return data.result ?? [];
    }

    private async sendMessage(chatId: number, text: string): Promise<void> {
        const trimmed = text.slice(0, 4000);
        let response = await fetch(this.buildApiUrl("sendMessage"), {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                chat_id: chatId,
                text: trimmed,
                parse_mode: "HTML",
                disable_web_page_preview: true,
            }),
        });

        if (response.ok) {
            return;
        }

        const detail = await response.text();

        if (response.status === 400) {
            this.logger.warn("Telegram HTML parse failed; retrying plain text", {
                status: response.status,
                detail: detail.slice(0, 500),
            });

            const plain = telegramPlainFallback(trimmed).slice(0, 4000);
            response = await fetch(this.buildApiUrl("sendMessage"), {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    chat_id: chatId,
                    text: plain,
                    disable_web_page_preview: true,
                }),
            });

            if (response.ok) {
                return;
            }
        }

        throw new Error(`Telegram sendMessage failed with ${response.status}: ${detail}`);
    }

    private buildApiUrl(method: string, params?: Record<string, string>): string {
        const token = this.config.channels.telegram.botToken;
        if (!token) {
            throw new Error("Telegram bot token is missing.");
        }

        const url = new URL(`https://api.telegram.org/bot${token}/${method}`);
        if (params) {
            for (const [key, value] of Object.entries(params)) {
                url.searchParams.set(key, value);
            }
        }

        return url.toString();
    }
}
