import type { AppConfig } from "../../config/index.js";
import type { Logger } from "../../observability/logger.js";
import type { Orchestrator } from "../../orchestrator/index.js";
import type { ChannelAdapter } from "../types.js";
import { escapeTelegramHtml, telegramPlainFallback } from "../../utils/channel-formatting.js";
import { errorMessage } from "../../utils/error.js";
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
        caption?: string;
        photo?: Array<{ file_id: string; width: number; height: number }>;
        document?: { file_id: string; file_name?: string; mime_type?: string };
        chat: {
            id: number;
            type: "private" | "group" | "supergroup" | "channel";
            username?: string;
        };
        from?: {
            id: number;
            is_bot?: boolean;
            username?: string;
            first_name?: string;
        };
        reply_to_message?: {
            from?: { id: number; is_bot?: boolean };
        };
        entities?: Array<{ type: string; offset: number; length: number }>;
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
    private botUserId?: number;
    private botUsername?: string;

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
        await this.clearWebhook();
        await this.fetchBotIdentity();
        this.pollTask = this.pollLoop();
        this.logger.info("Telegram channel started");
    }

    private async clearWebhook(): Promise<void> {
        try {
            const response = await fetch(
                this.buildApiUrl("deleteWebhook", { drop_pending_updates: "false" }),
                { method: "POST" },
            );
            if (!response.ok) {
                this.logger.warn("Telegram deleteWebhook returned non-OK", {
                    status: response.status,
                });
            }
        } catch (error) {
            this.logger.warn("Telegram deleteWebhook failed", {
                error: errorMessage(error),
            });
        }
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
                    try {
                        await this.handleUpdate(update);
                    } catch (error) {
                        if (!this.running || isAbortError(error)) {
                            throw error;
                        }

                        this.logger.error("Telegram update handling failed", {
                            error: errorMessage(error),
                            updateId: update.update_id,
                        });
                    } finally {
                        this.offset = Math.max(this.offset, update.update_id + 1);
                    }
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
                    error: errorMessage(error),
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
        if (!message) return;

        const isGroup = message.chat.type === "group" || message.chat.type === "supergroup";
        if (isGroup && !this.isBotAddressed(message)) return;

        const text = message.text?.trim();
        const caption = message.caption?.trim();
        const content = text ?? caption;

        if (!content) {
            if (message.photo || message.document) {
                await this.sendMessage(
                    message.chat.id,
                    "I received your file, but I can only process text messages and captions for now.",
                );
            }
            return;
        }

        if (content === "/start") {
            await this.sendMessage(
                message.chat.id,
                "<b>Jarvis</b> is online.\n\nSend a message or use /models for configured models.",
            );
            return;
        }

        if (content === "/models") {
            const modelText = this.orchestrator
                .listModels()
                .map((model) => `- ${model.provider}:${model.id} [${model.roles.join(", ")}]`)
                .join("\n");
            const body = modelText ? `<b>Models</b>\n<pre>${escapeTelegramHtml(modelText)}</pre>` : "<i>No models configured.</i>";
            await this.sendMessage(message.chat.id, body);
            return;
        }

        let userMessage = content;
        if (!text && caption) {
            if (message.photo) userMessage = `[User sent a photo] ${caption}`;
            else if (message.document) userMessage = `[User sent a document: ${message.document.file_name ?? "unknown"}] ${caption}`;
        }

        await this.sendChatAction(message.chat.id, "typing");

        let fullContent = "";

        for await (const event of this.orchestrator.handleRequestStream({
            requestId: createId("req"),
            channel: "telegram",
            userId: `telegram:${message.from?.id ?? message.chat.id}`,
            conversationId: `telegram:${message.chat.id}`,
            message: userMessage,
            attachments: [],
            metadata: {
                ...(message.from?.username ?? message.chat.username
                    ? { username: message.from?.username ?? message.chat.username }
                    : {}),
                sourceMessageId: String(message.message_id),
            },
        })) {
            if (event.type === "delta") {
                fullContent += event.text;
            } else if (event.type === "response") {
                fullContent = event.response.content;
            } else if (event.type === "error") {
                fullContent = `Error: ${event.error}`;
            }
        }

        await this.sendMessage(message.chat.id, fullContent);
    }

    private isBotAddressed(message: NonNullable<TelegramUpdate["message"]>): boolean {
        if (message.chat.type === "private") return true;

        if (message.reply_to_message?.from?.id === this.botUserId) return true;

        const text = message.text ?? message.caption ?? "";
        if (this.botUsername && text.includes(`@${this.botUsername}`)) return true;

        if (message.entities?.some((e) => e.type === "bot_command")) return true;

        return false;
    }

    private async fetchBotIdentity(): Promise<void> {
        try {
            const response = await fetch(this.buildApiUrl("getMe"), { method: "POST" });
            if (!response.ok) return;

            const data = (await response.json()) as TelegramResponse<{ id: number; username?: string }>;
            if (data.ok) {
                this.botUserId = data.result.id;
                if (data.result.username) {
                    this.botUsername = data.result.username;
                }
                this.logger.info("Telegram bot identity resolved", { id: this.botUserId, username: this.botUsername });
            }
        } catch {
            this.logger.warn("Failed to fetch Telegram bot identity");
        }
    }

    private async sendChatAction(chatId: number, action: string): Promise<void> {
        try {
            await fetch(this.buildApiUrl("sendChatAction"), {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ chat_id: chatId, action }),
            });
        } catch { /* best-effort */ }
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
            if (response.status === 409) {
                this.logger.warn(
                    "Telegram getUpdates returned 409 Conflict - another instance is polling or a webhook is set. Clearing webhook and backing off.",
                );
                await this.clearWebhook();
            }
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
        const fallbackText = "Sorry - I could not generate a reply. Please try again.";
        const trimmed = (text ?? "").slice(0, 4096).trim();
        const initialText = trimmed.length > 0 ? trimmed : fallbackText;

        let response = await fetch(this.buildApiUrl("sendMessage"), {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                chat_id: chatId,
                text: initialText,
                parse_mode: "HTML",
                disable_web_page_preview: true,
            }),
        });

        if (response.ok) {
            return;
        }

        const detail = await response.text();

        let description: string | undefined;
        try {
            const parsed = JSON.parse(detail) as { description?: unknown };
            if (parsed && typeof parsed === "object" && typeof parsed.description === "string") {
                description = parsed.description;
            }
        } catch {
            // ignore
        }

        if (response.status === 400) {
            this.logger.warn("Telegram sendMessage returned 400; retrying plain text", {
                status: response.status,
                detail: (description ?? detail).slice(0, 500),
            });

            const plain = telegramPlainFallback(initialText).slice(0, 4096).trim();
            const safePlain = plain.length > 0 ? plain : fallbackText;

            response = await fetch(this.buildApiUrl("sendMessage"), {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    chat_id: chatId,
                    text: safePlain,
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
