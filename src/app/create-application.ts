import { AgentRegistry } from "../agents/registry/index.js";
import { JarvisAgent } from "../agents/jarvis/index.js";
import { TerminalChannelAdapter } from "../channels/terminal/index.js";
import type { ChannelAdapter } from "../channels/types.js";
import { TelegramChannelAdapter } from "../channels/telegram/index.js";
import { createConfig } from "../config/index.js";
import { InMemoryPersistence } from "../db/in-memory.js";
import { createPostgresPersistence } from "../db/postgres/persistence.js";
import { MemoryService } from "../memory/service.js";
import { ModelProviderRegistry } from "../models/registry.js";
import { Logger } from "../observability/logger.js";
import { JarvisOrchestrator } from "../orchestrator/index.js";
import { HttpServer } from "../server/http-server.js";
import { ToolRegistry } from "../tools/registry.js";
import { ToolRouter } from "../tools/tool-router.js";

export interface Application {
    start(): Promise<void>;
    stop(): Promise<void>;
}

export async function createApplication(): Promise<Application> {
    const config = createConfig(process.env);
    const logger = new Logger(config.app.logLevel);
    const persistence =
        config.persistence.driver === "postgres"
            ? await createPostgresPersistence({ config, logger })
            : new InMemoryPersistence();
    const tools = new ToolRegistry({ config, logger, memories: persistence.memories });
    const models = new ModelProviderRegistry({ config, logger });
    const memory = new MemoryService({
        config,
        logger,
        memories: persistence.memories,
        conversations: persistence.conversations,
        models,
    });
    const toolRouter = new ToolRouter({ config, logger, models });
    const agents = new AgentRegistry(new JarvisAgent(config));
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

    const channels: ChannelAdapter[] = [];

    if (config.channels.http.enabled) {
        channels.push(new HttpServer({ config, logger, orchestrator }));
    }

    if (config.channels.telegram.enabled) {
        channels.push(new TelegramChannelAdapter({ config, logger, orchestrator }));
    }

    if (config.channels.terminal.enabled) {
        channels.push(new TerminalChannelAdapter({ config, logger, orchestrator }));
    }

    return {
        async start() {
            logger.info("Starting Jarvis application", {
                channels: channels.length,
                persistenceDriver: config.persistence.driver,
            });

            for (const channel of channels) {
                await channel.start();
            }
        },
        async stop() {
            for (const channel of [...channels].reverse()) {
                await channel.stop();
            }

            await persistence.stop();
            logger.info("Stopped Jarvis application");
        },
    };
}
