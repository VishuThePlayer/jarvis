import type { AppConfig } from "../config/index.js";
import type { Logger } from "../observability/logger.js";
import type { ModelDescriptor, ModelInvocation, ModelResult, ModelSlot, StreamChunk, UserRequest } from "../types/core.js";
import type { ProviderHealth, ResolvedModelPlan } from "./contracts.js";
import { OpenAIModelProvider } from "./providers/openai.js";

interface ModelProviderRegistryDependencies {
    config: AppConfig;
    logger: Logger;
}

export class ModelProviderRegistry {
    private readonly config: AppConfig;
    private readonly logger: Logger;
    private readonly provider: OpenAIModelProvider;

    public constructor(dependencies: ModelProviderRegistryDependencies) {
        this.config = dependencies.config;
        this.logger = dependencies.logger;
        this.provider = new OpenAIModelProvider(this.config, this.logger);
    }

    public listModels(): ModelDescriptor[] {
        const descriptors = new Map<string, ModelDescriptor>();
        const addDescriptor = (id: string, role: ModelSlot) => {
            const key = `openai:${id}`;
            const existing = descriptors.get(key);
            if (existing) {
                if (!existing.roles.includes(role)) {
                    existing.roles.push(role);
                }
                return;
            }

            descriptors.set(key, {
                provider: "openai",
                id,
                roles: [role],
                isConfigured: this.provider.isConfigured(),
                capabilities: ["chat", "embeddings"],
            });
        };

        addDescriptor(this.config.models.default, "default");
        addDescriptor(this.config.models.fast, "fast");
        addDescriptor(this.config.models.reasoning, "reasoning");
        addDescriptor(this.config.models.embedding, "embedding");

        return [...descriptors.values()];
    }

    public getProviderHealth(): ProviderHealth[] {
        return [{
            provider: "openai",
            configured: this.provider.isConfigured(),
            capabilities: ["chat", "embeddings"],
        }];
    }

    public resolveForRequest(request: UserRequest): ResolvedModelPlan {
        const requested = this.parseRequestedModel(request.requestedModel);
        const slot = requested ? "default" : this.selectSlot(request.message);
        const model = requested?.model ?? this.modelForSlot(slot);

        if (!this.provider.isConfigured()) {
            throw new Error("OpenAI provider is not configured — set OPENAI_API_KEY");
        }

        return {
            primary: {
                provider: this.provider,
                model,
            },
        };
    }

    public async generate(invocation: ModelInvocation, plan: ResolvedModelPlan): Promise<ModelResult> {
        return plan.primary.provider.generate({
            ...invocation,
            model: plan.primary.model,
        });
    }

    public async embed(texts: string[]): Promise<number[][]> {
        return this.provider.embed(texts);
    }

    public async *generateStream(invocation: ModelInvocation, plan: ResolvedModelPlan): AsyncIterable<StreamChunk> {
        yield* plan.primary.provider.generateStream({
            ...invocation,
            model: plan.primary.model,
        });
    }

    private parseRequestedModel(requestedModel?: string): { model: string } | null {
        if (!requestedModel) {
            return null;
        }

        const separatorIndex = requestedModel.indexOf(":");
        if (separatorIndex < 0) {
            return { model: requestedModel };
        }

        const provider = requestedModel.slice(0, separatorIndex);
        const model = requestedModel.slice(separatorIndex + 1);
        if (provider !== "openai" || model.length === 0) {
            return null;
        }

        return { model };
    }

    private selectSlot(message: string): ModelSlot {
        if (/\b(plan|analy[sz]e|architecture|design|reason|debug)\b/i.test(message)) {
            return "reasoning";
        }

        if (message.length <= 80) {
            return "fast";
        }

        return "default";
    }

    private modelForSlot(slot: ModelSlot): string {
        switch (slot) {
            case "fast":
                return this.config.models.fast;
            case "reasoning":
                return this.config.models.reasoning;
            case "embedding":
                return this.config.models.embedding;
            case "default":
                return this.config.models.default;
        }
    }
}
