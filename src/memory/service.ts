import type { AppConfig } from "../config/index.js";
import type { ConversationRepository, MemoryRepository } from "../db/contracts.js";
import type { ModelProviderRegistry } from "../models/registry.js";
import type { Logger } from "../observability/logger.js";
import type { MemoryEntry, MessageRecord, UserRequest } from "../types/core.js";
import { errorMessage } from "../utils/error.js";
import type { MemoryContext, MemoryLookupResult, MemorySaveResult } from "./provider.js";
import { LocalMemoryProvider } from "./local-provider.js";
import type { MemoryProvider } from "./provider.js";
import { ZepMemoryProvider } from "./zep-provider.js";

interface MemoryServiceDependencies {
    config: AppConfig;
    logger: Logger;
    memories: MemoryRepository;
    conversations: ConversationRepository;
    models?: ModelProviderRegistry;
}

export class MemoryService {
    private readonly config: AppConfig;
    private readonly logger: Logger;
    private readonly provider: MemoryProvider;

    public constructor(dependencies: MemoryServiceDependencies) {
        this.config = dependencies.config;
        this.logger = dependencies.logger;

        const localProvider = new LocalMemoryProvider(dependencies);
        this.provider = this.selectProvider(dependencies, localProvider);
    }

    public async retrieveContext(input: {
        userId: string;
        conversationId: string;
        query: string;
    }): Promise<MemoryContext> {
        return this.provider.retrieveContext(input);
    }

    public async captureTurn(input: {
        request: UserRequest;
        response: MessageRecord;
        messageCount: number;
        recentMessages: MessageRecord[];
    }): Promise<MemoryEntry[]> {
        if (!this.config.memory.enabled || !this.config.memory.autoStore) {
            return [];
        }

        if (this.looksSensitive(input.request.message)) {
            this.logger.warn("Skipped sensitive memory write", {
                requestId: input.request.requestId,
            });
            return [];
        }

        try {
            return await this.provider.captureTurn(input);
        } catch (error) {
            this.logger.warn("Memory capture failed", {
                error: errorMessage(error),
                requestId: input.request.requestId,
            });
            return [];
        }
    }

    public async saveExplicitMemory(input: {
        request: UserRequest;
        content: string;
    }): Promise<MemorySaveResult> {
        return this.provider.saveExplicitMemory(input);
    }

    public async lookupExplicitMemory(input: {
        request: UserRequest;
        query: string;
    }): Promise<MemoryLookupResult> {
        return this.provider.lookupExplicitMemory(input);
    }

    private selectProvider(
        dependencies: MemoryServiceDependencies,
        localProvider: LocalMemoryProvider,
    ): MemoryProvider {
        if (dependencies.config.memory.backend !== "zep") {
            return localProvider;
        }

        if (!dependencies.config.providers.zep.apiKey) {
            this.logger.warn("MEMORY_BACKEND=zep requested without ZEP_API_KEY; using local memory instead");
            return localProvider;
        }

        return new ZepMemoryProvider({
            config: dependencies.config,
            logger: dependencies.logger,
            fallback: localProvider,
        });
    }

    private looksSensitive(message: string): boolean {
        return /(api[_ -]?key|token|password|secret|bearer|sk-[a-z0-9]+)/i.test(message);
    }
}

export type { MemoryContext } from "./provider.js";
