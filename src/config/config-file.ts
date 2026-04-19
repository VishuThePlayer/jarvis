import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

const CONFIG_FILENAME = "jarvis.config.json";

export function getConfigFilePath(): string {
    return path.resolve(process.cwd(), CONFIG_FILENAME);
}

export function configFileExists(): boolean {
    return fs.existsSync(getConfigFilePath());
}

const openaiProviderSchema = z.object({
    apiKey: z.string().default(""),
    baseUrl: z.string().default("https://api.openai.com/v1"),
});

const telegramChannelSchema = z.object({
    enabled: z.boolean().default(false),
    botToken: z.string().default(""),
    pollIntervalMs: z.number().int().positive().optional(),
    longPollTimeoutSec: z.number().int().min(0).max(50).optional(),
});

const toolWithOptionsSchema = z.object({
    enabled: z.boolean().default(true),
    allowByDefault: z.boolean().optional(),
    maxResults: z.number().int().positive().max(10).optional(),
});

const modelsSchema = z.object({
    default: z.string().default("gpt-4o"),
    fast: z.string().default("gpt-4o-mini"),
    reasoning: z.string().default("o1"),
    embedding: z.string().default("text-embedding-3-small"),
});

const memorySchema = z.object({
    enabled: z.boolean().default(true),
    autoStore: z.boolean().default(true),
    retrievalLimit: z.number().int().positive().max(10).default(5),
    summaryTriggerMessages: z.number().int().positive().default(8),
});

const orchestratorSchema = z.object({
    temperature: z.number().min(0).max(2).default(0.3),
    historyLimit: z.number().int().positive().max(200).default(50),
});

const agentConfigSchema = z.looseObject({
    models: z.record(z.string(), z.string()).optional(),
});

const providersSchema = z.object({
    openai: openaiProviderSchema.default(() => ({ apiKey: "", baseUrl: "https://api.openai.com/v1" })),
});

const channelsSchema = z.object({
    terminal: z.boolean().default(true),
    http: z.boolean().default(true),
    telegram: telegramChannelSchema.default(() => ({ enabled: false, botToken: "" })),
});

const toolsSchema = z.object({
    webSearch: toolWithOptionsSchema.default(() => ({ enabled: true })),
    time: z.boolean().default(true),
    toolRouter: z.boolean().default(true),
});

export const configFileSchema = z.object({
    providers: providersSchema.default(() => ({
        openai: { apiKey: "", baseUrl: "https://api.openai.com/v1" },
    })),
    models: modelsSchema.default(() => ({
        default: "gpt-4o",
        fast: "gpt-4o-mini",
        reasoning: "o1",
        embedding: "text-embedding-3-small",
    })),
    agents: z.record(z.string(), agentConfigSchema).default(() => ({ jarvis: {} })),
    channels: channelsSchema.default(() => ({
        terminal: true,
        http: true,
        telegram: { enabled: false, botToken: "" },
    })),
    tools: toolsSchema.default(() => ({
        webSearch: { enabled: true },
        time: true,
        toolRouter: true,
    })),
    memory: memorySchema.default(() => ({
        enabled: true,
        autoStore: true,
        retrievalLimit: 5,
        summaryTriggerMessages: 8,
    })),
    orchestrator: orchestratorSchema.default(() => ({
        temperature: 0.3,
        historyLimit: 50,
    })),
});

export type JarvisConfigFile = z.infer<typeof configFileSchema>;

export function loadConfigFile(): JarvisConfigFile | null {
    const filePath = getConfigFilePath();
    if (!fs.existsSync(filePath)) {
        return null;
    }

    const raw = fs.readFileSync(filePath, "utf-8");
    const json: unknown = JSON.parse(raw);
    return configFileSchema.parse(json);
}

export function saveConfigFile(config: JarvisConfigFile): void {
    const filePath = getConfigFilePath();
    fs.writeFileSync(filePath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

export function configFileToEnvOverrides(config: JarvisConfigFile): Record<string, string> {
    const env: Record<string, string> = {};

    if (config.providers.openai.apiKey) {
        env.OPENAI_API_KEY = config.providers.openai.apiKey;
    }
    if (config.providers.openai.baseUrl) {
        env.OPENAI_BASE_URL = config.providers.openai.baseUrl;
    }

    env.DEFAULT_MODEL = config.models.default;
    env.FAST_MODEL = config.models.fast;
    env.REASONING_MODEL = config.models.reasoning;
    env.EMBEDDING_MODEL = config.models.embedding;

    env.ENABLE_TERMINAL = String(config.channels.terminal);
    env.ENABLE_HTTP = String(config.channels.http);
    env.ENABLE_TELEGRAM = String(config.channels.telegram.enabled);
    if (config.channels.telegram.botToken) {
        env.TELEGRAM_BOT_TOKEN = config.channels.telegram.botToken;
    }
    if (config.channels.telegram.pollIntervalMs != null) {
        env.TELEGRAM_POLL_INTERVAL_MS = String(config.channels.telegram.pollIntervalMs);
    }
    if (config.channels.telegram.longPollTimeoutSec != null) {
        env.TELEGRAM_LONG_POLL_TIMEOUT_SEC = String(config.channels.telegram.longPollTimeoutSec);
    }

    env.ENABLE_WEB_SEARCH = String(config.tools.webSearch.enabled);
    if (config.tools.webSearch.allowByDefault != null) {
        env.ALLOW_WEB_SEARCH_BY_DEFAULT = String(config.tools.webSearch.allowByDefault);
    }
    if (config.tools.webSearch.maxResults != null) {
        env.WEB_SEARCH_MAX_RESULTS = String(config.tools.webSearch.maxResults);
    }
    env.ENABLE_TIME = String(config.tools.time);
    env.ENABLE_TOOL_ROUTER = String(config.tools.toolRouter);

    env.ENABLE_MEMORY = String(config.memory.enabled);
    env.AUTO_STORE_MEMORY = String(config.memory.autoStore);
    env.MEMORY_RETRIEVAL_LIMIT = String(config.memory.retrievalLimit);
    env.MEMORY_SUMMARY_TRIGGER_MESSAGES = String(config.memory.summaryTriggerMessages);

    env.DEFAULT_TEMPERATURE = String(config.orchestrator.temperature);
    env.ORCHESTRATOR_HISTORY_MESSAGE_LIMIT = String(config.orchestrator.historyLimit);

    return env;
}
