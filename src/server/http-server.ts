import type { Server } from "node:http";
import express, { type Request, type Response, type NextFunction } from "express";
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

class SlidingWindowRateLimiter {
    private readonly windows = new Map<string, number[]>();

    public isAllowed(key: string, windowMs: number, maxRequests: number): { allowed: boolean; retryAfterMs?: number } {
        const now = Date.now();
        const cutoff = now - windowMs;
        const timestamps = this.windows.get(key) ?? [];
        const recent = timestamps.filter((t) => t > cutoff);

        if (recent.length >= maxRequests) {
            const oldest = recent[0]!;
            return { allowed: false, retryAfterMs: oldest + windowMs - now };
        }

        recent.push(now);
        this.windows.set(key, recent);
        return { allowed: true };
    }
}

export class HttpServer implements ChannelAdapter {
    private readonly config: AppConfig;
    private readonly logger: Logger;
    private readonly orchestrator: Orchestrator;
    private readonly app = express();
    private readonly rateLimiter = new SlidingWindowRateLimiter();
    private server: Server | undefined;

    public constructor(dependencies: HttpServerDependencies) {
        this.config = dependencies.config;
        this.logger = dependencies.logger;
        this.orchestrator = dependencies.orchestrator;

        this.app.use((request, response, next) => {
            this.applyCorsHeaders(request, response);

            if (request.method === "OPTIONS") {
                response.status(204).end();
                return;
            }

            next();
        });
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

        const auth = this.createAuthMiddleware();

        this.app.get("/models", auth, (_request, response) => {
            response.json({ models: this.orchestrator.listModels() });
        });

        this.app.get("/conversations/:id", auth, async (request: Request<{ id: string }>, response: Response) => {
            const conversation = await this.orchestrator.getConversation(request.params.id);
            if (!conversation) {
                response.status(404).json({ error: "Conversation not found." });
                return;
            }

            response.json({ conversation });
        });

        this.app.get("/conversations/:id/messages", auth, async (request: Request<{ id: string }>, response: Response) => {
            const conversation = await this.orchestrator.getConversation(request.params.id);
            if (!conversation) {
                response.status(404).json({ error: "Conversation not found." });
                return;
            }

            const messages = await this.orchestrator.getConversationMessages(request.params.id);
            response.json({ messages });
        });

        this.app.post("/chat", auth, async (request, response) => {
            await this.handleChatRequest(request, response);
        });

        this.app.post("/chat/stream", auth, async (request, response) => {
            await this.handleStreamRequest(request, response);
        });
    }

    private createAuthMiddleware(): (req: Request, res: Response, next: NextFunction) => void {
        return (req: Request, res: Response, next: NextFunction) => {
            const expectedKey = this.config.app.apiKey;
            if (!expectedKey) {
                next();
                return;
            }

            const header = req.headers.authorization;
            if (!header || !header.startsWith("Bearer ")) {
                res.status(401).json({ error: "Unauthorized — provide Authorization: Bearer <API_KEY>" });
                return;
            }

            const token = header.slice(7);
            if (token !== expectedKey) {
                res.status(401).json({ error: "Unauthorized — invalid API key" });
                return;
            }

            next();
        };
    }

    private buildUserRequest(parsedBody: ParsedChatBody): import("../types/core.js").UserRequest {
        return {
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
        };
    }

    private validateAndRateLimit(request: Request, response: Response): ParsedChatBody | null {
        let parsedBody: ParsedChatBody;
        try {
            parsedBody = this.parseChatBody(request.body);
        } catch (error) {
            response.status(400).json({
                error: error instanceof Error ? error.message : String(error),
            });
            return null;
        }

        const { allowed, retryAfterMs } = this.rateLimiter.isAllowed(
            parsedBody.userId,
            this.config.app.rateLimitWindowMs,
            this.config.app.rateLimitMaxRequests,
        );

        if (!allowed) {
            response.setHeader("Retry-After", String(Math.ceil((retryAfterMs ?? 1000) / 1000)));
            response.status(429).json({ error: "Too many requests — try again later." });
            return null;
        }

        return parsedBody;
    }

    private async handleChatRequest(request: Request, response: Response) {
        const parsedBody = this.validateAndRateLimit(request, response);
        if (!parsedBody) return;

        try {
            const result = await this.orchestrator.handleRequest(this.buildUserRequest(parsedBody));
            response.json(result);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            response.status(500).json({ error: message });
        }
    }

    private async handleStreamRequest(request: Request, response: Response) {
        const parsedBody = this.validateAndRateLimit(request, response);
        if (!parsedBody) return;

        response.setHeader("Content-Type", "text/event-stream");
        response.setHeader("Cache-Control", "no-cache");
        response.setHeader("Connection", "keep-alive");
        response.flushHeaders();

        let clientDisconnected = false;
        request.on("close", () => {
            clientDisconnected = true;
        });

        try {
            const userRequest = this.buildUserRequest(parsedBody);

            for await (const event of this.orchestrator.handleRequestStream(userRequest)) {
                if (clientDisconnected) break;

                switch (event.type) {
                    case "delta":
                        response.write(`event: delta\ndata: ${JSON.stringify({ text: event.text })}\n\n`);
                        break;
                    case "response":
                        response.write(`event: response\ndata: ${JSON.stringify(event.response)}\n\n`);
                        break;
                    case "error":
                        response.write(`event: error\ndata: ${JSON.stringify({ error: event.error })}\n\n`);
                        break;
                    case "done":
                        response.write("event: done\ndata: [DONE]\n\n");
                        break;
                }
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (!clientDisconnected) {
                response.write(`event: error\ndata: ${JSON.stringify({ error: message })}\n\n`);
            }
        }

        response.end();
    }

    private parseChatBody(body: unknown): ParsedChatBody {
        if (!body || typeof body !== "object") {
            throw new Error("Request body must be an object.");
        }

        const candidate = body as Record<string, unknown>;
        if (typeof candidate.message !== "string" || candidate.message.trim().length === 0) {
            throw new Error("A non-empty 'message' field is required.");
        }

        const trimmed = candidate.message.trim();
        if (trimmed.length > this.config.app.maxMessageLength) {
            throw new Error(`Message too long (${trimmed.length} chars). Maximum is ${this.config.app.maxMessageLength}.`);
        }

        return {
            message: trimmed,
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

    private applyCorsHeaders(request: Request, response: Response) {
        const allowedOrigin = this.config.web.appOrigin;
        const requestOrigin = request.headers.origin;

        if (!allowedOrigin || requestOrigin !== allowedOrigin) {
            return;
        }

        response.setHeader("Access-Control-Allow-Origin", allowedOrigin);
        response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
        response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
        response.setHeader("Vary", "Origin");
    }
}
