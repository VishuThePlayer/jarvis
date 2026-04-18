import assert from "node:assert/strict";
import test from "node:test";
import { AgentRegistry } from "../agents/registry/index.js";
import { JarvisAgent } from "../agents/jarvis/index.js";
import { createConfig } from "../config/index.js";
import { InMemoryPersistence } from "../db/in-memory.js";
import { MemoryService } from "../memory/service.js";
import { ModelProviderRegistry } from "../models/registry.js";
import { Logger } from "../observability/logger.js";
import { JarvisOrchestrator } from "../orchestrator/index.js";
import { ToolRegistry } from "../tools/registry.js";
import { ToolRouter } from "../tools/tool-router.js";

function createOrchestrator(env: Record<string, string> = {}) {
    const config = createConfig({
        APP_ENV: "test",
        ENABLE_HTTP: "false",
        ENABLE_TERMINAL: "false",
        ENABLE_TELEGRAM: "false",
        DEFAULT_PROVIDER: "local",
        FALLBACK_PROVIDER: "local",
        ENABLE_WEB_SEARCH: "false",
        ...env,
    });
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

    return new JarvisOrchestrator({
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
}

test("orchestrator stores preferences in durable memory", async () => {
    const orchestrator = createOrchestrator();
    const conversationId = "conv-test";

    await orchestrator.handleRequest({
        requestId: "req-1",
        channel: "terminal",
        userId: "user-1",
        conversationId,
        message: "I prefer concise answers.",
        attachments: [],
        metadata: {},
    });

    const response = await orchestrator.handleRequest({
        requestId: "req-2",
        channel: "terminal",
        userId: "user-1",
        conversationId,
        message: "How should you answer me?",
        attachments: [],
        metadata: {},
    });

    assert.match(response.content, /concise/i);
});

test("command tools short-circuit the LLM", async () => {
    const orchestrator = createOrchestrator({
        ENABLE_SYSTEM_COM: "true",
    });

    const response = await orchestrator.handleRequest({
        requestId: "req-1",
        channel: "terminal",
        userId: "user-1",
        conversationId: "conv-cmd",
        message: "//time",
        attachments: [],
        metadata: {},
    });

    assert.equal(response.toolCalls.length, 1);
    assert.equal(response.toolCalls[0]?.name, "system-com");
    assert.equal(response.providerUsed, "local");
    assert.equal(response.modelUsed, "jarvis-command");
    assert.match(response.content, /^Time\b/);
});

test("tool router can route natural language to command tools", async () => {
    const orchestrator = createOrchestrator({
        ENABLE_SYSTEM_COM: "true",
        ENABLE_TOOL_ROUTER: "true",
    });

    const response = await orchestrator.handleRequest({
        requestId: "req-1",
        channel: "terminal",
        userId: "user-1",
        conversationId: "conv-router",
        message: "what time is it?",
        attachments: [],
        metadata: {},
    });

    assert.equal(response.toolCalls.length, 1);
    assert.equal(response.toolCalls[0]?.name, "system-com");
    assert.match(response.content, /^Time\b/);
});
