import { AgentRegistry } from "../agents/registry/index.js";
import type { AppConfig } from "../config/index.js";
import type { ConversationRepository, RunRepository } from "../db/contracts.js";
import type { MemoryService } from "../memory/service.js";
import type { ModelProviderRegistry } from "../models/registry.js";
import type { Logger } from "../observability/logger.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ToolRouter } from "../tools/tool-router.js";
import type { SelectedCommandTool } from "../tools/registry.js";
import type {
    AssistantResponse,
    ConversationRecord,
    MemoryEntry,
    MessageRecord,
    ModelInvocation,
    ModelResult,
    ProgressEvent,
    ProviderKind,
    RunRecord,
    StreamEvent,
    ToolCallRecord,
    UserRequest,
} from "../types/core.js";
import { errorMessage } from "../utils/error.js";
import { createId } from "../utils/id.js";
import { formatToolInput } from "../utils/tool-input.js";
import { toTitleFromMessage } from "../utils/text.js";

interface RunContext {
    conversation: ConversationRecord;
    resolvedModels: ReturnType<ModelProviderRegistry["resolveForRequest"]>;
    runId: string;
}

interface CommandPathResult {
    kind: "tool" | "clarification";
    toolCall?: ToolCallRecord;
    response: AssistantResponse;
}

interface ModelContext extends RunContext {
    invocation: ModelInvocation;
    toolCalls: ToolCallRecord[];
}

type ProgressEmitter = (progress: Omit<ProgressEvent, "createdAt">) => void;

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

    private async handleCommandToolPath(
        request: UserRequest,
        ctx: RunContext,
        emitProgress?: ProgressEmitter,
    ): Promise<CommandPathResult | null> {
        emitProgress?.({
            phase: "command-check",
            message: "Checking exact command tools",
        });

        const directSelection = this.tools.matchDirectCommand(request);
        if (directSelection) {
            const directResult = await this.executeCommandSelection(directSelection, request, ctx, emitProgress);
            if (directResult) {
                return directResult;
            }
        }

        const availableTools = this.tools.listAvailableCommandTools(request.channel);
        emitProgress?.({
            phase: "tool-router",
            message: `Routing with ${availableTools.length} available command tools`,
        });

        const recentMessages = await this.conversations.listRecentMessages(
            ctx.conversation.id,
            Math.max(8, this.config.orchestrator.historyMessageLimit),
        );

        const route = await this.toolRouter.routeCommandTool(request, availableTools, recentMessages);
        if (route.kind === "no-tool") {
            return null;
        }

        if (route.kind === "ask-clarification") {
            emitProgress?.({
                phase: "tool-router",
                message: "Tool router asked for clarification",
            });

            return this.completeClarificationTurn(request, ctx, route.question);
        }

        emitProgress?.({
            phase: "tool-router",
            message: "Tool router selected a command",
            toolName: route.toolName,
            commandPreview: formatToolInput({
                source: "tool-router",
                rawMessage: request.message,
                arguments: route.arguments,
            }),
        });

        return this.executeCommandSelection(
            {
                toolName: route.toolName,
                invocation: {
                    request,
                    source: "tool-router",
                    arguments: route.arguments,
                },
            },
            request,
            ctx,
            emitProgress,
        );
    }

    private async executeCommandSelection(
        selection: SelectedCommandTool,
        request: UserRequest,
        ctx: RunContext,
        emitProgress?: ProgressEmitter,
    ): Promise<CommandPathResult | null> {
        const toolCall = await this.tools.executeSelectedCommandTool(selection);
        if (!toolCall) {
            return null;
        }

        emitProgress?.({
            phase: "tool-run",
            message: "Executing command tool",
            toolName: toolCall.name,
            commandPreview: formatToolInput(toolCall.input),
        });

        await this.persistToolMessages(ctx.conversation, request, [toolCall]);
        const formattedContent = await this.formatToolResult(request, toolCall, ctx, emitProgress);
        const assistantMessage = this.createAssistantMessage(
            ctx.conversation.id,
            request,
            formattedContent,
            "openai",
            "jarvis-command",
        );

        await this.conversations.appendMessage(assistantMessage);
        await this.runs.complete(ctx.runId, {
            status: "completed",
            completedAt: new Date(),
            provider: "openai",
            model: "jarvis-command",
        });

        return {
            kind: "tool",
            toolCall,
            response: {
                messageId: assistantMessage.id,
                conversationId: ctx.conversation.id,
                content: assistantMessage.content,
                toolCalls: [toolCall],
                providerUsed: "openai",
                modelUsed: "jarvis-command",
                memoryWrites: [],
            },
        };
    }

    private async completeClarificationTurn(
        request: UserRequest,
        ctx: RunContext,
        question: string,
    ): Promise<CommandPathResult> {
        const assistantMessage = this.createAssistantMessage(
            ctx.conversation.id,
            request,
            question,
            "openai",
            "jarvis-router",
        );

        await this.conversations.appendMessage(assistantMessage);
        await this.runs.complete(ctx.runId, {
            status: "completed",
            completedAt: new Date(),
            provider: "openai",
            model: "jarvis-router",
        });

        return {
            kind: "clarification",
            response: {
                messageId: assistantMessage.id,
                conversationId: ctx.conversation.id,
                content: assistantMessage.content,
                toolCalls: [],
                providerUsed: "openai",
                modelUsed: "jarvis-router",
                memoryWrites: [],
            },
        };
    }

    private async formatToolResult(
        request: UserRequest,
        toolCall: ToolCallRecord,
        ctx: RunContext,
        emitProgress?: ProgressEmitter,
    ): Promise<string> {
        try {
            emitProgress?.({
                phase: "tool-format",
                message: "Formatting tool output for chat",
                toolName: toolCall.name,
            });

            const invocation = await this.agents.getFormatter().prepareInvocation({ request, toolCall });
            const forcedModelRequest: UserRequest = {
                ...request,
                requestedModel: `openai:${this.config.models.fast}`,
            };
            const plan = this.models.resolveForRequest(forcedModelRequest);
            const result = await this.models.generate(invocation, plan);
            const text = result.text.trim();
            return text || toolCall.output;
        } catch (error) {
            this.logger.warn("Tool result formatting failed; using raw output", {
                requestId: request.requestId,
                conversationId: ctx.conversation.id,
                tool: toolCall.name,
                error: errorMessage(error),
            });
            return toolCall.output;
        }
    }

    private async buildModelContext(
        request: UserRequest,
        ctx: RunContext,
        emitProgress?: ProgressEmitter,
    ): Promise<ModelContext> {
        const memoryContext = await this.memory.retrieveContext({
            userId: request.userId,
            conversationId: ctx.conversation.id,
            query: request.message,
        });

        emitProgress?.({
            phase: "pre-model-tools",
            message: "Running pre-model tools",
        });

        const toolCalls = await this.tools.executePreModelTools(request);
        await this.persistToolMessages(ctx.conversation, request, toolCalls);

        const historyLimit = this.config.orchestrator.historyMessageLimit;
        const history = await this.conversations.listRecentMessages(ctx.conversation.id, historyLimit);
        const invocation = await this.agents.getAssistant().prepareInvocation({
            request,
            conversation: ctx.conversation,
            history,
            memoryContext,
            toolCalls,
        });

        return { ...ctx, invocation, toolCalls };
    }

    private async handleModelPath(
        request: UserRequest,
        ctx: RunContext,
        emitProgress?: ProgressEmitter,
    ): Promise<AssistantResponse> {
        const modelContext = await this.buildModelContext(request, ctx, emitProgress);
        const result = await this.models.generate(modelContext.invocation, modelContext.resolvedModels);
        const assistantMessage = this.createAssistantMessage(
            ctx.conversation.id,
            request,
            result.text,
            result.provider,
            result.model,
        );

        const { memoryWrites } = await this.finalizeSuccessfulRun(
            request,
            ctx,
            assistantMessage,
            result.provider,
            result.model,
        );

        this.logger.info("Completed orchestration request", {
            requestId: request.requestId,
            conversationId: ctx.conversation.id,
            provider: result.provider,
            model: result.model,
            toolCalls: modelContext.toolCalls.length,
            memoryWrites: memoryWrites.length,
        });

        return {
            messageId: assistantMessage.id,
            conversationId: ctx.conversation.id,
            content: assistantMessage.content,
            toolCalls: modelContext.toolCalls,
            providerUsed: result.provider,
            modelUsed: result.model,
            memoryWrites,
            ...(result.usage ? { usage: result.usage } : {}),
        };
    }

    private createAssistantMessage(
        conversationId: string,
        request: UserRequest,
        content: string,
        provider: ProviderKind,
        model: string,
    ): MessageRecord {
        return {
            id: createId("msg"),
            conversationId,
            role: "assistant",
            content,
            channel: request.channel,
            userId: request.userId,
            provider,
            model,
            createdAt: new Date(),
        };
    }

    private async finalizeSuccessfulRun(
        request: UserRequest,
        ctx: RunContext,
        assistantMessage: MessageRecord,
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

    private async finalizeFailedRun(ctx: RunContext, request: UserRequest, error: unknown): Promise<never> {
        const message = errorMessage(error);
        await this.runs.complete(ctx.runId, {
            status: "failed",
            completedAt: new Date(),
            error: message,
        });
        this.logger.error("Request orchestration failed", {
            requestId: request.requestId,
            conversationId: ctx.conversation.id,
            error: message,
        });
        throw error;
    }

    public async handleRequest(request: UserRequest): Promise<AssistantResponse> {
        const ctx = await this.initRun(request);

        try {
            const commandResult = await this.handleCommandToolPath(request, ctx);
            if (commandResult) {
                return commandResult.response;
            }

            return await this.handleModelPath(request, ctx);
        } catch (error) {
            return this.finalizeFailedRun(ctx, request, error);
        }
    }

    public async *handleRequestStream(request: UserRequest): AsyncIterable<StreamEvent> {
        const ctx = await this.initRun(request);
        const pushProgress = (progress: Omit<ProgressEvent, "createdAt">) => ({
            type: "progress" as const,
            progress: {
                ...progress,
                createdAt: new Date().toISOString(),
            },
        });

        try {
            yield pushProgress({ phase: "init", message: "Request received" });

            const commandProgressQueue: StreamEvent[] = [];
            const commandProgress: ProgressEmitter = (progress) => {
                commandProgressQueue.push(pushProgress(progress));
            };

            const commandResult = await this.handleCommandToolPath(request, ctx, commandProgress);
            for (const event of commandProgressQueue) {
                yield event;
            }

            if (commandResult) {
                yield pushProgress({
                    phase: "complete",
                    message: commandResult.kind === "tool" ? "Command tool completed" : "Clarification returned",
                    ...(commandResult.toolCall ? { toolName: commandResult.toolCall.name } : {}),
                });
                yield { type: "response", response: commandResult.response };
                yield { type: "done" };
                return;
            }

            const modelProgressQueue: StreamEvent[] = [];
            const modelProgress: ProgressEmitter = (progress) => {
                modelProgressQueue.push(pushProgress(progress));
            };

            const modelContext = await this.buildModelContext(request, ctx, modelProgress);
            for (const event of modelProgressQueue) {
                yield event;
            }
            yield pushProgress({ phase: "model-generate", message: "Generating model response" });

            let fullText = "";
            let finalResult: ModelResult | undefined;

            for await (const chunk of this.models.generateStream(modelContext.invocation, modelContext.resolvedModels)) {
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
                    provider: modelContext.resolvedModels.primary.provider.kind,
                    model: modelContext.resolvedModels.primary.model,
                    text: fullText,
                };
            }

            const assistantMessage = this.createAssistantMessage(
                ctx.conversation.id,
                request,
                finalResult.text,
                finalResult.provider,
                finalResult.model,
            );
            const { memoryWrites } = await this.finalizeSuccessfulRun(
                request,
                ctx,
                assistantMessage,
                finalResult.provider,
                finalResult.model,
            );

            yield pushProgress({ phase: "persist", message: "Persisting conversation updates" });
            yield {
                type: "response",
                response: {
                    messageId: assistantMessage.id,
                    conversationId: ctx.conversation.id,
                    content: assistantMessage.content,
                    toolCalls: modelContext.toolCalls,
                    providerUsed: finalResult.provider,
                    modelUsed: finalResult.model,
                    memoryWrites,
                    ...(finalResult.usage ? { usage: finalResult.usage } : {}),
                },
            };
            yield pushProgress({ phase: "complete", message: "Request completed" });
            yield { type: "done" };
        } catch (error) {
            const message = errorMessage(error);
            await this.runs.complete(ctx.runId, {
                status: "failed",
                completedAt: new Date(),
                error: message,
            });
            this.logger.error("Streaming request failed", {
                requestId: request.requestId,
                conversationId: ctx.conversation.id,
                error: message,
            });
            yield { type: "error", error: message };
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
