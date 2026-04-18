import type { Server } from "node:http";
import express, { type Request, type Response } from "express";
import type { AppConfig } from "../config/index.js";
import type { Logger } from "../observability/logger.js";
import type { Orchestrator } from "../orchestrator/index.js";
import type { ChannelAdapter } from "../channels/types.js";
import { createId } from "../utils/id.js";

interface HttpServerDependencies {
    config: AppConfig;
    logger: Logger;
    orchestrator: Orchestrator;
}

interface ParsedChatBody {
    message: string;
    conversationId?: string;
    userId: string;
    requestedModel?: string;
    allowWebSearch?: boolean;
    preferWebSearch?: boolean;
}

export class HttpServer implements ChannelAdapter {
    private readonly config: AppConfig;
    private readonly logger: Logger;
    private readonly orchestrator: Orchestrator;
    private readonly app = express();
    private server: Server | undefined;

    public constructor(dependencies: HttpServerDependencies) {
        this.config = dependencies.config;
        this.logger = dependencies.logger;
        this.orchestrator = dependencies.orchestrator;

        this.app.use(express.json({ limit: "1mb" }));
        this.registerRoutes();
    }

    public async start(): Promise<void> {
        await new Promise<void>((resolve) => {
            this.server = this.app.listen(this.config.app.port, () => {
                this.logger.info("HTTP channel started", { port: this.config.app.port });
                resolve();
            });
        });
    }

    public async stop(): Promise<void> {
        const server = this.server;
        if (!server) {
            return;
        }

        this.server = undefined;

        await new Promise<void>((resolve, reject) => {
            try {
                server.close((error) => {
                    if (error) {
                        reject(error);
                        return;
                    }

                    resolve();
                });
            } catch (error) {
                if (
                    error instanceof Error &&
                    "code" in error &&
                    (error as NodeJS.ErrnoException).code === "ERR_SERVER_NOT_RUNNING"
                ) {
                    resolve();
                    return;
                }

                reject(error);
            }
        });
    }

    private registerRoutes() {
        this.app.get("/health", (_request, response) => {
            response.json(this.orchestrator.getHealth());
        });

        this.app.get("/models", (_request, response) => {
            response.json({ models: this.orchestrator.listModels() });
        });

        this.app.get("/conversations/:id", async (request, response) => {
            const conversation = await this.orchestrator.getConversation(request.params.id);
            if (!conversation) {
                response.status(404).json({ error: "Conversation not found." });
                return;
            }

            response.json({ conversation });
        });

        this.app.get("/conversations/:id/messages", async (request, response) => {
            const conversation = await this.orchestrator.getConversation(request.params.id);
            if (!conversation) {
                response.status(404).json({ error: "Conversation not found." });
                return;
            }

            const messages = await this.orchestrator.getConversationMessages(request.params.id);
            response.json({ messages });
        });

        this.app.post("/chat", async (request, response) => {
            await this.handleChatRequest(request, response, false);
        });

        this.app.post("/chat/stream", async (request, response) => {
            await this.handleChatRequest(request, response, true);
        });
    }

    private async handleChatRequest(request: Request, response: Response, stream: boolean) {
        let parsedBody: ParsedChatBody;

        try {
            parsedBody = this.parseChatBody(request.body);
        } catch (error) {
            response.status(400).json({
                error: error instanceof Error ? error.message : String(error),
            });
            return;
        }

        try {
            const result = await this.orchestrator.handleRequest({
                requestId: createId("req"),
                channel: "http",
                userId: parsedBody.userId,
                ...(parsedBody.conversationId ? { conversationId: parsedBody.conversationId } : {}),
                message: parsedBody.message,
                attachments: [],
                ...(parsedBody.requestedModel ? { requestedModel: parsedBody.requestedModel } : {}),
                metadata: {
                    ...(parsedBody.allowWebSearch !== undefined
                        ? { allowWebSearch: parsedBody.allowWebSearch }
                        : {}),
                    ...(parsedBody.preferWebSearch !== undefined
                        ? { preferWebSearch: parsedBody.preferWebSearch }
                        : {}),
                },
            });

            if (!stream) {
                response.json(result);
                return;
            }

            response.setHeader("Content-Type", "text/event-stream");
            response.setHeader("Cache-Control", "no-cache");
            response.setHeader("Connection", "keep-alive");
            response.write(`event: response\ndata: ${JSON.stringify(result)}\n\n`);
            response.write("event: done\ndata: [DONE]\n\n");
            response.end();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);

            if (stream) {
                response.setHeader("Content-Type", "text/event-stream");
                response.write(`event: error\ndata: ${JSON.stringify({ error: message })}\n\n`);
                response.end();
                return;
            }

            response.status(500).json({ error: message });
        }
    }

    private parseChatBody(body: unknown): ParsedChatBody {
        if (!body || typeof body !== "object") {
            throw new Error("Request body must be an object.");
        }

        const candidate = body as Record<string, unknown>;
        if (typeof candidate.message !== "string" || candidate.message.trim().length === 0) {
            throw new Error("A non-empty 'message' field is required.");
        }

        return {
            message: candidate.message.trim(),
            userId: typeof candidate.userId === "string" && candidate.userId.trim().length > 0
                ? candidate.userId.trim()
                : this.config.app.defaultUserId,
            ...(typeof candidate.conversationId === "string" && candidate.conversationId.trim().length > 0
                ? { conversationId: candidate.conversationId.trim() }
                : {}),
            ...(typeof candidate.requestedModel === "string" && candidate.requestedModel.trim().length > 0
                ? { requestedModel: candidate.requestedModel.trim() }
                : {}),
            ...(typeof candidate.allowWebSearch === "boolean"
                ? { allowWebSearch: candidate.allowWebSearch }
                : {}),
            ...(typeof candidate.preferWebSearch === "boolean"
                ? { preferWebSearch: candidate.preferWebSearch }
                : {}),
        };
    }
}
