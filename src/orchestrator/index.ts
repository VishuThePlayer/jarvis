import { AgentRegistry } from "../agents/registry/index.js";
import type { AppConfig } from "../config/index.js";
import type { ConversationRepository, RunRepository } from "../db/contracts.js";
import type { MemoryService } from "../memory/service.js";
import type { ModelProviderRegistry } from "../models/registry.js";
import type { Logger } from "../observability/logger.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ToolRouter } from "../tools/tool-router.js";
import type {
    AssistantResponse,
    ConversationRecord,
    MemoryEntry,
    MessageRecord,
    ModelInvocation,
    ProviderKind,
    RunRecord,
    StreamEvent,
    ToolCallRecord,
    UserRequest,
} from "../types/core.js";
import { errorMessage } from "../utils/error.js";
import { createId } from "../utils/id.js";
import { toTitleFromMessage } from "../utils/text.js";

interface RunContext {
    conversation: ConversationRecord;
    resolvedModels: ReturnType<ModelProviderRegistry["resolveForRequest"]>;
    runId: string;
}

interface CommandToolResult {
    toolCall: ToolCallRecord;
    assistantMessage: MessageRecord;
    response: AssistantResponse;
}

interface ModelContext extends RunContext {
    invocation: ModelInvocation;
    toolCalls: ToolCallRecord[];
}

export interface Orchestrator {
    handleRequest(request: UserRequest): Promise<AssistantResponse>;
    handleRequestStream(request: UserRequest): AsyncIterable<StreamEvent>;
    listModels(): ReturnType<ModelProviderRegistry["listModels"]>;
    getConversation(conversationId: string): Promise<ConversationRecord | null>;
    getConversationMessages(conversationId: string): Promise<MessageRecord[]>;
    getHealth(): {
        status: "ok";
        persistenceDriver: AppConfig["persistence"]["driver"];
        providers: ReturnType<ModelProviderRegistry["getProviderHealth"]>;
        channels: AppConfig["channels"];
    };
}

interface OrchestratorDependencies {
    config: AppConfig;
    logger: Logger;
    conversations: ConversationRepository;
    runs: RunRepository;
    memory: MemoryService;
    tools: ToolRegistry;
    toolRouter: ToolRouter;
    models: ModelProviderRegistry;
    agents: AgentRegistry;
}

export class JarvisOrchestrator implements Orchestrator {
    private readonly config: AppConfig;
    private readonly logger: Logger;
    private readonly conversations: ConversationRepository;
    private readonly runs: RunRepository;
    private readonly memory: MemoryService;
    private readonly tools: ToolRegistry;
    private readonly toolRouter: ToolRouter;
    private readonly models: ModelProviderRegistry;
    private readonly agents: AgentRegistry;

    public constructor(dependencies: OrchestratorDependencies) {
        this.config = dependencies.config;
        this.logger = dependencies.logger;
        this.conversations = dependencies.conversations;
        this.runs = dependencies.runs;
        this.memory = dependencies.memory;
        this.tools = dependencies.tools;
        this.toolRouter = dependencies.toolRouter;
        this.models = dependencies.models;
        this.agents = dependencies.agents;
    }

    public listModels() {
        return this.models.listModels();
    }

    public async getConversation(conversationId: string) {
        return this.conversations.getConversation(conversationId);
    }

    public async getConversationMessages(conversationId: string) {
        return this.conversations.listMessages(conversationId);
    }

    public getHealth() {
        return {
            status: "ok" as const,
            persistenceDriver: this.config.persistence.driver,
            providers: this.models.getProviderHealth(),
            channels: this.config.channels,
        };
    }

    private async initRun(request: UserRequest): Promise<RunContext> {
        const conversation = await this.conversations.ensureConversation({
            userId: request.userId,
            channel: request.channel,
            title: toTitleFromMessage(request.message),
            ...(request.conversationId ? { conversationId: request.conversationId } : {}),
        });

        const resolvedModels = this.models.resolveForRequest(request);
        const runId = createId("run");

        const runRecord: RunRecord = {
            id: runId,
            requestId: request.requestId,
            conversationId: conversation.id,
            userId: request.userId,
            channel: request.channel,
            provider: resolvedModels.primary.provider.kind,
            model: resolvedModels.primary.model,
            status: "running",
            startedAt: new Date(),
        };

        await this.runs.create(runRecord);
        await this.conversations.appendMessage({
            id: createId("msg"),
            conversationId: conversation.id,
            role: "user",
            content: request.message,
            channel: request.channel,
            userId: request.userId,
            createdAt: new Date(),
        });

        return { conversation, resolvedModels, runId };
    }

    private async tryCommandTool(request: UserRequest, ctx: RunContext): Promise<CommandToolResult | null> {
        let commandToolCall = await this.tools.tryRunCommand(request);

        if (!commandToolCall) {
            const available = this.tools.listAvailableCommandTools(request.channel);
            const route = await this.toolRouter.routeCommandTool(request, available);
            if (route) {
                commandToolCall = await this.tools.tryRunCommand({ ...request, message: route.command });
            }
        }

        if (!commandToolCall) return null;

        const toolCalls = [commandToolCall];
        await this.persistToolMessages(ctx.conversation, request, toolCalls);

        const assistantMessage: MessageRecord = {
            id: createId("msg"),
            conversationId: ctx.conversation.id,
            role: "assistant",
            content: commandToolCall.output,
            channel: request.channel,
            userId: request.userId,
            provider: "openai",
            model: "jarvis-command",
            createdAt: new Date(),
        };

        await this.conversations.appendMessage(assistantMessage);
        await this.runs.complete(ctx.runId, {
            status: "completed",
            completedAt: new Date(),
            provider: "openai",
            model: "jarvis-command",
        });

        return {
            toolCall: commandToolCall,
            assistantMessage,
            response: {
                messageId: assistantMessage.id,
                conversationId: ctx.conversation.id,
                content: assistantMessage.content,
                toolCalls,
                providerUsed: "openai",
                modelUsed: "jarvis-command",
                memoryWrites: [],
            },
        };
    }

    private async prepareModelContext(request: UserRequest, ctx: RunContext): Promise<ModelContext> {
        const memoryContext = await this.memory.retrieveContext({
            userId: request.userId,
            conversationId: ctx.conversation.id,
            query: request.message,
        });

        const toolCalls = await this.tools.runPreModelTools(request);
        await this.persistToolMessages(ctx.conversation, request, toolCalls);

        const historyLimit = this.config.orchestrator.historyMessageLimit;
        const history = await this.conversations.listRecentMessages(ctx.conversation.id, historyLimit);
        const invocation = await this.agents.getPrimary().prepareInvocation({
            request,
            conversation: ctx.conversation,
            history,
            memoryContext,
            toolCalls,
        });

        return { ...ctx, invocation, toolCalls };
    }

    private async finalizeRun(
        request: UserRequest,
        ctx: RunContext,
        assistantMessage: MessageRecord,
        toolCalls: ToolCallRecord[],
        provider: ProviderKind,
        model: string,
    ): Promise<{ memoryWrites: MemoryEntry[] }> {
        await this.conversations.appendMessage(assistantMessage);

        const historyLimit = this.config.orchestrator.historyMessageLimit;
        const messageCount = await this.conversations.countMessages(ctx.conversation.id);
        const recentMessages = await this.conversations.listRecentMessages(
            ctx.conversation.id,
            Math.max(8, historyLimit),
        );
        const memoryWrites = await this.memory.captureTurn({
            request,
            response: assistantMessage,
            messageCount,
            recentMessages,
        });

        await this.runs.complete(ctx.runId, {
            status: "completed",
            completedAt: new Date(),
            provider,
            model,
        });

        return { memoryWrites };
    }

    private async failRun(ctx: RunContext, request: UserRequest, error: unknown): Promise<never> {
        const msg = errorMessage(error);
        await this.runs.complete(ctx.runId, { status: "failed", completedAt: new Date(), error: msg });
        this.logger.error("Request orchestration failed", {
            requestId: request.requestId,
            conversationId: ctx.conversation.id,
            error: msg,
        });
        throw error;
    }

    public async handleRequest(request: UserRequest): Promise<AssistantResponse> {
        const ctx = await this.initRun(request);

        try {
            const cmdResult = await this.tryCommandTool(request, ctx);
            if (cmdResult) return cmdResult.response;

            const mctx = await this.prepareModelContext(request, ctx);
            const result = await this.models.generate(mctx.invocation, mctx.resolvedModels);

            const assistantMessage: MessageRecord = {
                id: createId("msg"),
                conversationId: ctx.conversation.id,
                role: "assistant",
                content: result.text,
                channel: request.channel,
                userId: request.userId,
                provider: result.provider,
                model: result.model,
                createdAt: new Date(),
            };

            const { memoryWrites } = await this.finalizeRun(request, ctx, assistantMessage, mctx.toolCalls, result.provider, result.model);

            this.logger.info("Completed orchestration request", {
                requestId: request.requestId,
                conversationId: ctx.conversation.id,
                provider: result.provider,
                model: result.model,
                toolCalls: mctx.toolCalls.length,
                memoryWrites: memoryWrites.length,
            });

            return {
                messageId: assistantMessage.id,
                conversationId: ctx.conversation.id,
                content: assistantMessage.content,
                toolCalls: mctx.toolCalls,
                providerUsed: result.provider,
                modelUsed: result.model,
                memoryWrites,
                ...(result.usage ? { usage: result.usage } : {}),
            };
        } catch (error) {
            return this.failRun(ctx, request, error);
        }
    }

    public async *handleRequestStream(request: UserRequest): AsyncIterable<StreamEvent> {
        const ctx = await this.initRun(request);

        try {
            const cmdResult = await this.tryCommandTool(request, ctx);
            if (cmdResult) {
                yield { type: "response", response: cmdResult.response };
                yield { type: "done" };
                return;
            }

            const mctx = await this.prepareModelContext(request, ctx);

            let fullText = "";
            let finalResult: import("../types/core.js").ModelResult | undefined;

            for await (const chunk of this.models.generateStream(mctx.invocation, mctx.resolvedModels)) {
                if (!chunk.done && chunk.text) {
                    fullText += chunk.text;
                    yield { type: "delta", text: chunk.text };
                }
                if (chunk.done && chunk.result) {
                    finalResult = chunk.result;
                    fullText = chunk.result.text;
                }
            }

            if (!finalResult) {
                finalResult = {
                    provider: mctx.resolvedModels.primary.provider.kind,
                    model: mctx.resolvedModels.primary.model,
                    text: fullText,
                };
            }

            const assistantMessage: MessageRecord = {
                id: createId("msg"),
                conversationId: ctx.conversation.id,
                role: "assistant",
                content: finalResult.text,
                channel: request.channel,
                userId: request.userId,
                provider: finalResult.provider,
                model: finalResult.model,
                createdAt: new Date(),
            };

            const { memoryWrites } = await this.finalizeRun(request, ctx, assistantMessage, mctx.toolCalls, finalResult.provider, finalResult.model);

            yield {
                type: "response",
                response: {
                    messageId: assistantMessage.id,
                    conversationId: ctx.conversation.id,
                    content: assistantMessage.content,
                    toolCalls: mctx.toolCalls,
                    providerUsed: finalResult.provider,
                    modelUsed: finalResult.model,
                    memoryWrites,
                    ...(finalResult.usage ? { usage: finalResult.usage } : {}),
                },
            };
            yield { type: "done" };
        } catch (error) {
            const msg = errorMessage(error);
            await this.runs.complete(ctx.runId, { status: "failed", completedAt: new Date(), error: msg });
            this.logger.error("Streaming request failed", {
                requestId: request.requestId,
                conversationId: ctx.conversation.id,
                error: msg,
            });
            yield { type: "error", error: msg };
        }
    }

    private async persistToolMessages(
        conversation: ConversationRecord,
        request: UserRequest,
        toolCalls: ToolCallRecord[],
    ) {
        for (const toolCall of toolCalls) {
            const toolMessage: MessageRecord = {
                id: createId("msg"),
                conversationId: conversation.id,
                role: "tool",
                content: toolCall.output,
                channel: request.channel,
                userId: request.userId,
                toolName: toolCall.name,
                createdAt: toolCall.createdAt,
            };

            await this.conversations.appendMessage(toolMessage);
        }
    }
}
