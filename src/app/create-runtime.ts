import { AgentRegistry } from "../agents/registry/index.js";
import { JarvisAgent } from "../agents/jarvis/index.js";
import { ToolResultFormatterAgent } from "../agents/tool-result-formatter/index.js";
import { AutomationService } from "../automation/service.js";
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

export interface JarvisRuntime {
    start(): Promise<void>;
    stop(): Promise<void>;
}

export async function createRuntime(): Promise<JarvisRuntime> {
    const config = createConfig(process.env);
    const logger = new Logger(config.app.logLevel);
    const persistence =
        config.persistence.driver === "postgres"
            ? await createPostgresPersistence({ config, logger })
            : new InMemoryPersistence();
    const models = new ModelProviderRegistry({ config, logger });
    const memory = new MemoryService({
        config,
        logger,
        memories: persistence.memories,
        conversations: persistence.conversations,
        models,
    });
    const automation = new AutomationService({ config, logger, automations: persistence.automations });
    const tools = new ToolRegistry({ config, logger, memory, automation });
    const toolRouter = new ToolRouter({ config, logger, models });
    const agents = new AgentRegistry(new JarvisAgent(config), new ToolResultFormatterAgent(config));
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
    automation.setOrchestrator(orchestrator);

    const channels: ChannelAdapter[] = [];

    if (config.channels.http.enabled) {
        channels.push(new HttpServer({ config, logger, orchestrator, automation }));
    }

    if (config.channels.telegram.enabled) {
        channels.push(new TelegramChannelAdapter({ config, logger, orchestrator }));
    }

    if (config.channels.terminal.enabled) {
        channels.push(new TerminalChannelAdapter({ config, logger, orchestrator, automation }));
    }

    return {
        async start() {
            logger.info("Starting Jarvis runtime", {
                channels: channels.length,
                persistenceDriver: config.persistence.driver,
            });

            for (const channel of channels) {
                await channel.start();
            }

            automation.start();
        },
        async stop() {
            automation.stop();

            for (const channel of [...channels].reverse()) {
                await channel.stop();
            }

            await persistence.stop();
            logger.info("Stopped Jarvis runtime");
        },
    };
}
