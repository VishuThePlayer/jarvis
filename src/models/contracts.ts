import type { ModelCapability, ModelDescriptor, ModelInvocation, ModelResult, ProviderKind } from "../types/core.js";

export interface ModelProvider {
    readonly kind: ProviderKind;
    isConfigured(): boolean;
    supports(capability: ModelCapability): boolean;
    generate(invocation: ModelInvocation): Promise<ModelResult>;
    embed(texts: string[]): Promise<number[][]>;
}

export interface ResolvedProviderSelection {
    provider: ModelProvider;
    model: string;
}

export interface ResolvedModelPlan {
    primary: ResolvedProviderSelection;
    fallback?: ResolvedProviderSelection;
}

export interface ProviderHealth {
    provider: ProviderKind;
    configured: boolean;
    capabilities: ModelCapability[];
}

export interface ModelProviderRegistryLike {
    listModels(): ModelDescriptor[];
}
