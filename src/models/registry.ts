import type { AppConfig } from "../config/index.js";
import type { Logger } from "../observability/logger.js";
import type { ModelDescriptor, ModelInvocation, ModelResult, ModelSlot, ProviderKind, UserRequest } from "../types/core.js";
import type { ProviderHealth, ResolvedModelPlan } from "./contracts.js";
import { LocalModelProvider } from "./providers/local.js";
import { OpenAIModelProvider } from "./providers/openai.js";
import { OpenRouterModelProvider } from "./providers/openrouter.js";

interface ModelProviderRegistryDependencies {
    config: AppConfig;
    logger: Logger;
}

export class ModelProviderRegistry {
    private readonly config: AppConfig;
    private readonly logger: Logger;
    private readonly providers = new Map<ProviderKind, LocalModelProvider | OpenAIModelProvider | OpenRouterModelProvider>();

    public constructor(dependencies: ModelProviderRegistryDependencies) {
        this.config = dependencies.config;
        this.logger = dependencies.logger;
        this.providers.set("local", new LocalModelProvider());
        this.providers.set("openai", new OpenAIModelProvider(this.config));
        this.providers.set("openrouter", new OpenRouterModelProvider(this.config));
    }

    public listModels(): ModelDescriptor[] {
        const descriptors = new Map<string, ModelDescriptor>();
        const addDescriptor = (provider: ProviderKind, id: string, role: ModelSlot) => {
            const key = `${provider}:${id}`;
            const existing = descriptors.get(key);
            if (existing) {
                if (!existing.roles.includes(role)) {
                    existing.roles.push(role);
                }
                return;
            }

            descriptors.set(key, {
                provider,
                id,
                roles: [role],
                isConfigured: this.requireProvider(provider).isConfigured(),
                capabilities: ["chat", "embeddings"],
            });
        };

        addDescriptor(this.config.providers.defaultProvider, this.config.models.default, "default");
        addDescriptor(this.config.providers.defaultProvider, this.config.models.fast, "fast");
        addDescriptor(this.config.providers.defaultProvider, this.config.models.reasoning, "reasoning");
        addDescriptor(this.config.providers.defaultProvider, this.config.models.embedding, "embedding");
        addDescriptor(this.config.providers.fallbackProvider, this.config.models.fallback, "fallback");

        addDescriptor("local", "jarvis-local", "default");
        addDescriptor("local", "jarvis-local-fast", "fast");
        addDescriptor("local", "jarvis-local-reasoning", "reasoning");
        addDescriptor("local", "jarvis-local-embedding", "embedding");

        return [...descriptors.values()].sort((left, right) => `${left.provider}:${left.id}`.localeCompare(`${right.provider}:${right.id}`));
    }

    public getProviderHealth(): ProviderHealth[] {
        return [...this.providers.values()].map((provider) => ({
            provider: provider.kind,
            configured: provider.isConfigured(),
            capabilities: ["chat", "embeddings"],
        }));
    }

    public resolveForRequest(request: UserRequest): ResolvedModelPlan {
        const requested = this.parseRequestedModel(request.requestedModel);
        const slot = requested ? "default" : this.selectSlot(request.message);
        const preferredProvider = requested?.provider ?? this.config.providers.defaultProvider;
        const primaryProvider = this.getUsableProvider(preferredProvider) ?? this.requireProvider("local");
        const primaryModel = requested?.model ?? this.modelForSlot(slot);

        if (primaryProvider.kind !== preferredProvider) {
            this.logger.warn("Falling back to a configured provider for request", {
                requestedProvider: preferredProvider,
                selectedProvider: primaryProvider.kind,
                requestId: request.requestId,
            });
        }

        const fallbackProvider = this.getUsableProvider(this.config.providers.fallbackProvider);
        const fallback =
            fallbackProvider && (fallbackProvider.kind !== primaryProvider.kind || this.config.models.fallback !== primaryModel)
                ? {
                      provider: fallbackProvider,
                      model: this.config.models.fallback,
                  }
                : undefined;

        return {
            primary: {
                provider: primaryProvider,
                model: primaryModel,
            },
            ...(fallback ? { fallback } : {}),
        };
    }

    public async generateWithFallback(invocation: ModelInvocation, plan: ResolvedModelPlan): Promise<ModelResult> {
        try {
            return await plan.primary.provider.generate({
                ...invocation,
                model: plan.primary.model,
            });
        } catch (error) {
            if (!plan.fallback) {
                throw error;
            }

            const message = error instanceof Error ? error.message : String(error);
            this.logger.warn("Primary model provider failed; trying fallback provider", {
                primaryProvider: plan.primary.provider.kind,
                fallbackProvider: plan.fallback.provider.kind,
                error: message,
            });

            return plan.fallback.provider.generate({
                ...invocation,
                model: plan.fallback.model,
            });
        }
    }

    private parseRequestedModel(requestedModel?: string): { provider: ProviderKind; model: string } | null {
        if (!requestedModel) {
            return null;
        }

        const separatorIndex = requestedModel.indexOf(":");
        if (separatorIndex < 0) {
            return {
                provider: this.config.providers.defaultProvider,
                model: requestedModel,
            };
        }

        const provider = requestedModel.slice(0, separatorIndex) as ProviderKind;
        const model = requestedModel.slice(separatorIndex + 1);
        if (!["local", "openai", "openrouter"].includes(provider) || model.length === 0) {
            return null;
        }

        return {
            provider,
            model,
        };
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
            case "fallback":
                return this.config.models.fallback;
            case "default":
                return this.config.models.default;
        }
    }

    private getUsableProvider(kind: ProviderKind) {
        const provider = this.requireProvider(kind);
        return provider.isConfigured() ? provider : undefined;
    }

    private requireProvider(kind: ProviderKind) {
        const provider = this.providers.get(kind);
        if (!provider) {
            throw new Error(`Unsupported provider: ${kind}`);
        }

        return provider;
    }
}
