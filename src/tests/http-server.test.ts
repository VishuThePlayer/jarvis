import assert from "node:assert/strict";
import test from "node:test";
import { AgentRegistry } from "../agents/registry/index.js";
import { JarvisAgent } from "../agents/jarvis/index.js";
import { type AppConfig, createConfig } from "../config/index.js";
import { InMemoryPersistence } from "../db/in-memory.js";
import { MemoryService } from "../memory/service.js";
import { ModelProviderRegistry } from "../models/registry.js";
import { Logger } from "../observability/logger.js";
import { JarvisOrchestrator } from "../orchestrator/index.js";
import { HttpServer } from "../server/http-server.js";
import { ToolRegistry } from "../tools/registry.js";
import { ToolRouter } from "../tools/tool-router.js";

function createHttpConfig(): AppConfig {
    const baseConfig = createConfig({
        APP_ENV: "test",
        LOG_LEVEL: "error",
        PORT: "3001",
        ENABLE_HTTP: "true",
        ENABLE_TERMINAL: "false",
        ENABLE_TELEGRAM: "false",
        OPENAI_API_KEY: "test-key",
        ENABLE_WEB_SEARCH: "false",
        WEB_APP_ORIGIN: "http://localhost:5173",
    });

    return {
        ...baseConfig,
        app: {
            ...baseConfig.app,
            port: 0,
        },
    };
}

function createServer() {
    const config = createHttpConfig();
    const logger = new Logger("error");
    const persistence = new InMemoryPersistence();
    const memory = new MemoryService({
        config,
        logger,
        memories: persistence.memories,
        conversations: persistence.conversations,
    });
    const models = new ModelProviderRegistry({ config, logger });
    const agents = new AgentRegistry(new JarvisAgent(config));
    const tools = new ToolRegistry({ config, logger });
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
    const server = new HttpServer({ config, logger, orchestrator });

    return { server, persistence };
}

function getServerPort(server: HttpServer) {
    const instance = server as unknown as {
        server?: {
            address(): string | { port: number } | null;
        };
    };
    const address = instance.server?.address();

    if (!address || typeof address === "string") {
        throw new Error("HTTP server did not expose a TCP address.");
    }

    return address.port;
}

test("http server exposes API routes and allows the configured web origin", async (t) => {
    const { server, persistence } = createServer();

    await server.start();

    t.after(async () => {
        await server.stop();
        await persistence.stop();
    });

    const port = getServerPort(server);

    const healthResponse = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: {
            Origin: "http://localhost:5173",
        },
    });
    assert.equal(healthResponse.status, 200);
    assert.match(healthResponse.headers.get("content-type") ?? "", /application\/json/i);
    assert.equal(
        healthResponse.headers.get("access-control-allow-origin"),
        "http://localhost:5173",
    );

    const payload = await healthResponse.json();
    assert.equal(payload.status, "ok");

    const preflightResponse = await fetch(`http://127.0.0.1:${port}/chat`, {
        method: "OPTIONS",
        headers: {
            Origin: "http://localhost:5173",
            "Access-Control-Request-Method": "POST",
        },
    });
    assert.equal(preflightResponse.status, 204);
    assert.equal(
        preflightResponse.headers.get("access-control-allow-origin"),
        "http://localhost:5173",
    );
    assert.match(
        preflightResponse.headers.get("access-control-allow-methods") ?? "",
        /POST/,
    );

    const rootResponse = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(rootResponse.status, 404);
});
