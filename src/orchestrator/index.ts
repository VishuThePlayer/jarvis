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
    MessageRecord,
    RunRecord,
    ToolCallRecord,
    UserRequest,
} from "../types/core.js";
import { createId } from "../utils/id.js";
import { toTitleFromMessage } from "../utils/text.js";

export interface Orchestrator {
    handleRequest(request: UserRequest): Promise<AssistantResponse>;
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

    public async handleRequest(request: UserRequest): Promise<AssistantResponse> {
        const conversation = await this.conversations.ensureConversation({
            userId: request.userId,
            channel: request.channel,
            title: toTitleFromMessage(request.message),
            ...(request.conversationId ? { conversationId: request.conversationId } : {}),
        });

        const resolvedModels = this.models.resolveForRequest(request);
        const runId = createId("run");
        const userMessage: MessageRecord = {
            id: createId("msg"),
            conversationId: conversation.id,
            role: "user",
            content: request.message,
            channel: request.channel,
            userId: request.userId,
            createdAt: new Date(),
        };

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
        await this.conversations.appendMessage(userMessage);

        try {
            let commandToolCall = await this.tools.tryRunCommand(request);

            if (!commandToolCall) {
                const availableCommandTools = this.tools.listAvailableCommandTools(request.channel);
                const route = await this.toolRouter.routeCommandTool(request, availableCommandTools);
                if (route) {
                    commandToolCall = await this.tools.tryRunCommand({ ...request, message: route.command });
                }
            }

            if (commandToolCall) {
                const toolCalls = [commandToolCall];
                await this.persistToolMessages(conversation, request, toolCalls);

                const assistantMessage: MessageRecord = {
                    id: createId("msg"),
                    conversationId: conversation.id,
                    role: "assistant",
                    content: commandToolCall.output,
                    channel: request.channel,
                    userId: request.userId,
                    provider: "local",
                    model: "jarvis-command",
                    createdAt: new Date(),
                };

                await this.conversations.appendMessage(assistantMessage);

                await this.runs.complete(runId, {
                    status: "completed",
                    completedAt: new Date(),
                    provider: "local",
                    model: "jarvis-command",
                });

                return {
                    messageId: assistantMessage.id,
                    conversationId: conversation.id,
                    content: assistantMessage.content,
                    toolCalls,
                    providerUsed: "local",
                    modelUsed: "jarvis-command",
                    memoryWrites: [],
                };
            }

            const memoryContext = await this.memory.retrieveContext({
                userId: request.userId,
                conversationId: conversation.id,
                query: request.message,
            });

            const toolCalls = await this.tools.runPreModelTools(request);
            await this.persistToolMessages(conversation, request, toolCalls);

            const history = await this.conversations.listMessages(conversation.id);
            const invocation = await this.agents.getPrimary().prepareInvocation({
                request,
                conversation,
                history,
                memoryContext,
                toolCalls,
            });

            const result = await this.models.generateWithFallback(invocation, resolvedModels);

            const assistantMessage: MessageRecord = {
                id: createId("msg"),
                conversationId: conversation.id,
                role: "assistant",
                content: result.text,
                channel: request.channel,
                userId: request.userId,
                provider: result.provider,
                model: result.model,
                createdAt: new Date(),
            };

            await this.conversations.appendMessage(assistantMessage);

            const messages = await this.conversations.listMessages(conversation.id);
            const memoryWrites = await this.memory.captureTurn({
                request,
                response: assistantMessage,
                messages,
            });

            await this.runs.complete(runId, {
                status: "completed",
                completedAt: new Date(),
                provider: result.provider,
                model: result.model,
            });

            this.logger.info("Completed orchestration request", {
                requestId: request.requestId,
                conversationId: conversation.id,
                provider: result.provider,
                model: result.model,
                toolCalls: toolCalls.length,
                memoryWrites: memoryWrites.length,
            });

            return {
                messageId: assistantMessage.id,
                conversationId: conversation.id,
                content: assistantMessage.content,
                toolCalls,
                providerUsed: result.provider,
                modelUsed: result.model,
                memoryWrites,
                ...(result.usage ? { usage: result.usage } : {}),
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);

            await this.runs.complete(runId, {
                status: "failed",
                completedAt: new Date(),
                error: message,
            });

            this.logger.error("Request orchestration failed", {
                requestId: request.requestId,
                conversationId: conversation.id,
                error: message,
            });

            throw error;
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
