import type { AppConfig } from "../../config/index.js";
import type { Logger } from "../../observability/logger.js";
import type { Orchestrator } from "../../orchestrator/index.js";
import type { ChannelAdapter } from "../types.js";
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

interface TelegramResponse<T> {
    ok: boolean;
    result: T;
}

export class TelegramChannelAdapter implements ChannelAdapter {
    private readonly config: AppConfig;
    private readonly logger: Logger;
    private readonly orchestrator: Orchestrator;
    private running = false;
    private offset = 0;
    private pollTask?: Promise<void>;

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

        this.running = true;
        this.pollTask = this.pollLoop();
        this.logger.info("Telegram channel started");
    }

    public async stop(): Promise<void> {
        this.running = false;
        await this.pollTask;
    }

    private async pollLoop(): Promise<void> {
        while (this.running) {
            try {
                const updates = await this.getUpdates();

                for (const update of updates) {
                    this.offset = Math.max(this.offset, update.update_id + 1);
                    await this.handleUpdate(update);
                }
            } catch (error) {
                this.logger.error("Telegram polling failed", {
                    error: error instanceof Error ? error.message : String(error),
                });
            }

            await new Promise((resolve) => setTimeout(resolve, this.config.channels.telegram.pollIntervalMs));
        }
    }

    private async handleUpdate(update: TelegramUpdate): Promise<void> {
        const message = update.message;
        if (!message?.text) {
            return;
        }

        const text = message.text.trim();
        if (text === "/start") {
            await this.sendMessage(message.chat.id, "Jarvis is online. Send a message, or use /models to see configured models.");
            return;
        }

        if (text === "/models") {
            const modelText = this.orchestrator
                .listModels()
                .map((model) => `- ${model.provider}:${model.id} [${model.roles.join(", ")}]`)
                .join("\n");
            await this.sendMessage(message.chat.id, modelText || "No models configured.");
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

    private async getUpdates(): Promise<TelegramUpdate[]> {
        const response = await fetch(this.buildApiUrl("getUpdates", {
            offset: String(this.offset),
            timeout: "20",
        }));

        if (!response.ok) {
            throw new Error(`Telegram getUpdates failed with ${response.status}`);
        }

        const data = (await response.json()) as TelegramResponse<TelegramUpdate[]>;
        return data.result ?? [];
    }

    private async sendMessage(chatId: number, text: string): Promise<void> {
        const response = await fetch(this.buildApiUrl("sendMessage"), {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                chat_id: chatId,
                text,
            }),
        });

        if (!response.ok) {
            throw new Error(`Telegram sendMessage failed with ${response.status}`);
        }
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
