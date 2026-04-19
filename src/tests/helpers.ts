import { AgentRegistry } from "../agents/registry/index.js";
import { JarvisAgent } from "../agents/jarvis/index.js";
import { type AppConfig, createConfig } from "../config/index.js";
import { InMemoryPersistence } from "../db/in-memory.js";
import { MemoryService } from "../memory/service.js";
import { ModelProviderRegistry } from "../models/registry.js";
import { Logger } from "../observability/logger.js";
import { JarvisOrchestrator } from "../orchestrator/index.js";
import { ToolRegistry } from "../tools/registry.js";
import { ToolRouter } from "../tools/tool-router.js";

const TEST_ENV_DEFAULTS: Record<string, string> = {
    APP_ENV: "test",
    ENABLE_HTTP: "false",
    ENABLE_TERMINAL: "false",
    ENABLE_TELEGRAM: "false",
    OPENAI_API_KEY: "test-key",
    ENABLE_WEB_SEARCH: "false",
};

export function createTestStack(env: Record<string, string> = {}) {
    const config = createConfig({ ...TEST_ENV_DEFAULTS, ...env });
    const logger = new Logger("error");
    const persistence = new InMemoryPersistence();
    const models = new ModelProviderRegistry({ config, logger });
    const memory = new MemoryService({
        config,
        logger,
        memories: persistence.memories,
        conversations: persistence.conversations,
    });
    const agents = new AgentRegistry(new JarvisAgent(config));
    const tools = new ToolRegistry({ config, logger, memories: persistence.memories });
    const toolRouter = new ToolRouter({ config, logger, models });
    const orchestrator = new JarvisOrchestrator({
        config,
        logger,
        conversations: persistence.conversations,
        runs: persistence.runs,
        memory,
        tools,
        toolRouter,
        models,
        agents,
    });

    return { config, logger, persistence, models, memory, agents, tools, toolRouter, orchestrator };
}
