import { z } from "zod";
import type { ChannelKind, ProviderKind } from "../types/core.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

function parseEnvBoolean(value: unknown): unknown {
    if (typeof value === "boolean" || value == null) {
        return value;
    }

    if (typeof value !== "string") {
        return value;
    }

    const normalized = value.trim().toLowerCase();
    if (normalized === "") {
        return undefined;
    }

    if (["true", "1", "yes", "y", "on"].includes(normalized)) {
        return true;
    }

    if (["false", "0", "no", "n", "off"].includes(normalized)) {
        return false;
    }

    return value;
}

const envBoolean = z.preprocess(parseEnvBoolean, z.boolean());

export interface AppConfig {
    app: {
        env: "development" | "test" | "production";
        logLevel: LogLevel;
        port: number;
        defaultUserId: string;
        defaultTemperature: number;
    };
    channels: {
        terminal: {
            enabled: boolean;
        };
        http: {
            enabled: boolean;
        };
        telegram: {
            enabled: boolean;
            botToken?: string;
            pollIntervalMs: number;
            longPollTimeoutSec: number;
        };
    };
    providers: {
        defaultProvider: ProviderKind;
        fallbackProvider: ProviderKind;
        openai: {
            apiKey?: string;
            baseUrl: string;
        };
        openrouter: {
            apiKey?: string;
        };
    };
    models: {
        default: string;
        fast: string;
        reasoning: string;
        embedding: string;
        fallback: string;
    };
    tools: {
        webSearch: {
            enabled: boolean;
            allowByDefault: boolean;
            maxResults: number;
            perChannel: Record<ChannelKind, boolean>;
        };
        systemCom: {
            enabled: boolean;
            perChannel: Record<ChannelKind, boolean>;
        };
        toolRouter: {
            enabled: boolean;
            perChannel: Record<ChannelKind, boolean>;
        };
        // tool-scaffold:insert:tools-type
    };
    memory: {
        enabled: boolean;
        autoStore: boolean;
        retrievalLimit: number;
        summaryTriggerMessageCount: number;
    };
    persistence: {
        driver: "memory" | "postgres";
        databaseUrl?: string;
    };
}

const envSchema = z.object({
    APP_ENV: z.enum(["development", "test", "production"]).default("development"),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
    PORT: z.coerce.number().int().positive().max(65535).default(3000),
    DEFAULT_USER_ID: z.string().min(1).default("local-user"),
    DEFAULT_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.3),
    ENABLE_HTTP: envBoolean.optional().default(true),
    ENABLE_TERMINAL: envBoolean.optional().default(true),
    ENABLE_TELEGRAM: envBoolean.optional().default(false),
    TELEGRAM_BOT_TOKEN: z.string().optional(),
    TELEGRAM_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1500),
    TELEGRAM_LONG_POLL_TIMEOUT_SEC: z.coerce.number().int().min(0).max(50).default(30),
    DEFAULT_PROVIDER: z.enum(["local", "openai", "openrouter"]).default("local"),
    FALLBACK_PROVIDER: z.enum(["local", "openai", "openrouter"]).default("local"),
    OPENAI_API_KEY: z.string().optional(),
    OPENAI_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
    OPENROUTER_API_KEY: z.string().optional(),
    DEFAULT_MODEL: z.string().min(1).default("jarvis-local"),
    FAST_MODEL: z.string().min(1).default("jarvis-local-fast"),
    REASONING_MODEL: z.string().min(1).default("jarvis-local-reasoning"),
    EMBEDDING_MODEL: z.string().min(1).default("jarvis-local-embedding"),
    FALLBACK_MODEL: z.string().min(1).default("jarvis-local"),
    ENABLE_WEB_SEARCH: envBoolean.optional().default(true),
    ALLOW_WEB_SEARCH_BY_DEFAULT: envBoolean.optional().default(true),
    WEB_SEARCH_MAX_RESULTS: z.coerce.number().int().positive().max(10).default(5),
    ENABLE_SYSTEM_COM: envBoolean.optional().default(false),
    ENABLE_TOOL_ROUTER: envBoolean.optional().default(false),
    // tool-scaffold:insert:env
    ENABLE_MEMORY: envBoolean.optional().default(true),
    AUTO_STORE_MEMORY: envBoolean.optional().default(true),
    MEMORY_RETRIEVAL_LIMIT: z.coerce.number().int().positive().max(10).default(5),
    MEMORY_SUMMARY_TRIGGER_MESSAGES: z.coerce.number().int().positive().default(8),
    PERSISTENCE_DRIVER: z.enum(["memory", "postgres"]).default("memory"),
    DATABASE_URL: z.string().optional(),
});

export function createConfig(env: NodeJS.ProcessEnv): AppConfig {
    const parsed = envSchema.parse(env);
    const telegram = parsed.TELEGRAM_BOT_TOKEN?.trim();
    const openAiKey = parsed.OPENAI_API_KEY?.trim();
    const openRouterKey = parsed.OPENROUTER_API_KEY?.trim();
    const databaseUrl = parsed.DATABASE_URL?.trim();

    if (parsed.PERSISTENCE_DRIVER === "postgres" && !databaseUrl) {
        throw new Error("DATABASE_URL is required when PERSISTENCE_DRIVER=postgres");
    }

    return {
        app: {
            env: parsed.APP_ENV,
            logLevel: parsed.LOG_LEVEL,
            port: parsed.PORT,
            defaultUserId: parsed.DEFAULT_USER_ID,
            defaultTemperature: parsed.DEFAULT_TEMPERATURE,
        },
        channels: {
            terminal: {
                enabled: parsed.ENABLE_TERMINAL,
            },
            http: {
                enabled: parsed.ENABLE_HTTP,
            },
            telegram: {
                enabled: parsed.ENABLE_TELEGRAM,
                ...(telegram ? { botToken: telegram } : {}),
                pollIntervalMs: parsed.TELEGRAM_POLL_INTERVAL_MS,
                longPollTimeoutSec: parsed.TELEGRAM_LONG_POLL_TIMEOUT_SEC,
            },
        },
        providers: {
            defaultProvider: parsed.DEFAULT_PROVIDER,
            fallbackProvider: parsed.FALLBACK_PROVIDER,
            openai: {
                ...(openAiKey ? { apiKey: openAiKey } : {}),
                baseUrl: parsed.OPENAI_BASE_URL,
            },
            openrouter: {
                ...(openRouterKey ? { apiKey: openRouterKey } : {}),
            },
        },
        models: {
            default: parsed.DEFAULT_MODEL,
            fast: parsed.FAST_MODEL,
            reasoning: parsed.REASONING_MODEL,
            embedding: parsed.EMBEDDING_MODEL,
            fallback: parsed.FALLBACK_MODEL,
        },
        tools: {
            webSearch: {
                enabled: parsed.ENABLE_WEB_SEARCH,
                allowByDefault: parsed.ALLOW_WEB_SEARCH_BY_DEFAULT,
                maxResults: parsed.WEB_SEARCH_MAX_RESULTS,
                perChannel: {
                    terminal: true,
                    http: true,
                    telegram: true,
                },
            },
            systemCom: {
                enabled: parsed.ENABLE_SYSTEM_COM,
                perChannel: {
                    terminal: true,
                    http: true,
                    telegram: true,
                },
            },
            toolRouter: {
                enabled: parsed.ENABLE_TOOL_ROUTER,
                perChannel: {
                    terminal: true,
                    http: true,
                    telegram: true,
                },
            },
            // tool-scaffold:insert:tools-value
        },
        memory: {
            enabled: parsed.ENABLE_MEMORY,
            autoStore: parsed.AUTO_STORE_MEMORY,
            retrievalLimit: parsed.MEMORY_RETRIEVAL_LIMIT,
            summaryTriggerMessageCount: parsed.MEMORY_SUMMARY_TRIGGER_MESSAGES,
        },
        persistence: {
            driver: parsed.PERSISTENCE_DRIVER,
            ...(databaseUrl ? { databaseUrl } : {}),
        },
    };
}
