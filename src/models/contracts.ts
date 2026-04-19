import type { ModelCapability, ModelInvocation, ModelResult, ProviderKind, StreamChunk } from "../types/core.js";

export interface ModelProvider {
    readonly kind: ProviderKind;
    isConfigured(): boolean;
    supports(capability: ModelCapability): boolean;
    generate(invocation: ModelInvocation): Promise<ModelResult>;
    generateStream(invocation: ModelInvocation): AsyncIterable<StreamChunk>;
    embed(texts: string[]): Promise<number[][]>;
}

export interface ResolvedProviderSelection {
    provider: ModelProvider;
    model: string;
}

export interface ResolvedModelPlan {
    primary: ResolvedProviderSelection;
}

export interface ProviderHealth {
    provider: ProviderKind;
    configured: boolean;
    capabilities: ModelCapability[];
}
