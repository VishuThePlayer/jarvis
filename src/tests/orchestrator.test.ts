import assert from "node:assert/strict";
import test from "node:test";
import { createTestStack } from "./helpers.js";
import type { ModelResult } from "../types/core.js";

function createOrchestrator(env: Record<string, string> = {}) {
    return createTestStack(env).orchestrator;
}

test("exact command tools still short-circuit the LLM", async () => {
    const orchestrator = createOrchestrator({
        ENABLE_TIME: "true",
    });

    const response = await orchestrator.handleRequest({
        requestId: "req-1",
        channel: "terminal",
        userId: "user-1",
        conversationId: "conv-cmd",
        message: "time",
        attachments: [],
        metadata: {},
    });

    assert.equal(response.toolCalls.length, 1);
    assert.equal(response.toolCalls[0]?.name, "time");
    assert.equal(response.providerUsed, "openai");
    assert.equal(response.modelUsed, "jarvis-command");
    assert.match(response.content, /^Time\b/);
});

test("orchestrator executes a router-selected command tool", async () => {
    const { orchestrator, toolRouter } = createTestStack({
        ENABLE_TIME: "true",
        ENABLE_TOOL_ROUTER: "true",
    });

    toolRouter.routeCommandTool = async () => ({
        kind: "run-tool",
        toolName: "time",
        arguments: {},
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
    assert.equal(response.toolCalls[0]?.name, "time");
    assert.match(response.content, /^Time\b/);
});

test("router can choose memory-saving for declarative memory statements", async () => {
    const { toolRouter, tools, models } = createTestStack({
        ENABLE_MEMORY_LOOKUP: "true",
        ENABLE_MEMORY: "true",
        ENABLE_TOOL_ROUTER: "true",
    });

    models.generate = async () =>
        ({
            provider: "openai",
            model: "gpt-test",
            text: "",
            toolCalls: [
                {
                    id: "call-1",
                    type: "function",
                    function: {
                        name: "memory-saving",
                        arguments: JSON.stringify({ content: "my name is Vishu" }),
                    },
                },
            ],
        }) satisfies ModelResult;

    const route = await toolRouter.routeCommandTool(
        {
            requestId: "req-route-memory",
            channel: "terminal",
            userId: "user-1",
            conversationId: "conv-router-memory",
            message: "remember mmy name is vishu",
            attachments: [],
            metadata: {},
        },
        tools.listAvailableCommandTools("terminal"),
    );

    assert.deepEqual(route, {
        kind: "run-tool",
        toolName: "memory-saving",
        arguments: { content: "my name is Vishu" },
    });
});

test("router can ask for clarification when memory intent is ambiguous", async () => {
    const { toolRouter, tools, models } = createTestStack({
        ENABLE_MEMORY_LOOKUP: "true",
        ENABLE_MEMORY: "true",
        ENABLE_TOOL_ROUTER: "true",
    });

    models.generate = async () =>
        ({
            provider: "openai",
            model: "gpt-test",
            text: "",
            toolCalls: [
                {
                    id: "call-clarify",
                    type: "function",
                    function: {
                        name: "ask_clarification",
                        arguments: JSON.stringify({ question: "Do you want me to save that, or tell you what I already remember?" }),
                    },
                },
            ],
        }) satisfies ModelResult;

    const route = await toolRouter.routeCommandTool(
        {
            requestId: "req-route-clarify",
            channel: "terminal",
            userId: "user-1",
            conversationId: "conv-router-clarify",
            message: "remember Vishu",
            attachments: [],
            metadata: {},
        },
        tools.listAvailableCommandTools("terminal"),
    );

    assert.deepEqual(route, {
        kind: "ask-clarification",
        question: "Do you want me to save that, or tell you what I already remember?",
    });
});

test("router prompt prefers no-tool for normal writing requests about the user", async () => {
    const { toolRouter, tools, models } = createTestStack({
        ENABLE_MEMORY_LOOKUP: "true",
        ENABLE_MEMORY: "true",
        ENABLE_TOOL_ROUTER: "true",
    });

    models.generate = async (invocation) => {
        const systemPrompt = invocation.messages.find((message) => message.role === "system")?.content ?? "";
        const userPrompt = invocation.messages.find((message) => message.role === "user")?.content ?? "";

        assert.match(systemPrompt, /Prefer no-tool when Jarvis can answer normally without a command tool/);
        assert.match(systemPrompt, /write short info on me/);
        assert.match(systemPrompt, /not memory-lookup by default/);
        assert.match(userPrompt, /Current user message: write short info on me/);

        return {
            provider: "openai",
            model: "gpt-test",
            text: "",
            toolCalls: [],
        } satisfies ModelResult;
    };

    const route = await toolRouter.routeCommandTool(
        {
            requestId: "req-route-writing",
            channel: "terminal",
            userId: "user-1",
            conversationId: "conv-router-writing",
            message: "write short info on me",
            attachments: [],
            metadata: {},
        },
        tools.listAvailableCommandTools("terminal"),
    );

    assert.deepEqual(route, { kind: "no-tool" });
});

test("router receives recent conversation context for folder follow-ups", async () => {
    const { toolRouter, tools, models } = createTestStack({
        ENABLE_TOOL_ROUTER: "true",
    });

    models.generate = async (invocation) => {
        const userPrompt = invocation.messages.find((message) => message.role === "user")?.content ?? "";
        assert.match(userPrompt, /Recent conversation:/);
        assert.match(userPrompt, /open coding folder/);
        assert.match(userPrompt, /tool:ps-folder/);
        assert.match(userPrompt, /C:\\Coding/);
        assert.match(userPrompt, /Current user message: only list all folder in it/);

        return {
            provider: "openai",
            model: "gpt-test",
            text: "",
            toolCalls: [
                {
                    id: "call-folder-list",
                    type: "function",
                    function: {
                        name: "ps-folder",
                        arguments: JSON.stringify({ action: "list", target: "C:\\Coding" }),
                    },
                },
            ],
        } satisfies ModelResult;
    };

    const route = await toolRouter.routeCommandTool(
        {
            requestId: "req-route-folder-followup",
            channel: "terminal",
            userId: "user-1",
            conversationId: "conv-folder-followup",
            message: "only list all folder in it",
            attachments: [],
            metadata: {},
        },
        tools.listAvailableCommandTools("terminal"),
        [
            {
                id: "msg-user-1",
                conversationId: "conv-folder-followup",
                role: "user",
                content: "open coding folder",
                channel: "terminal",
                userId: "user-1",
                createdAt: new Date("2026-04-24T00:00:00.000Z"),
            },
            {
                id: "msg-tool-1",
                conversationId: "conv-folder-followup",
                role: "tool",
                content: "dir\tCoding\tC:\\Coding",
                channel: "terminal",
                userId: "user-1",
                toolName: "ps-folder",
                createdAt: new Date("2026-04-24T00:00:01.000Z"),
            },
            {
                id: "msg-assistant-1",
                conversationId: "conv-folder-followup",
                role: "assistant",
                content: "I found the folder at C:\\Coding.",
                channel: "terminal",
                userId: "user-1",
                createdAt: new Date("2026-04-24T00:00:02.000Z"),
            },
        ],
    );

    assert.deepEqual(route, {
        kind: "run-tool",
        toolName: "ps-folder",
        arguments: { action: "list", target: "C:\\Coding" },
    });
});

test("orchestrator returns router clarification without running a tool", async () => {
    const { orchestrator, toolRouter } = createTestStack({
        ENABLE_MEMORY_LOOKUP: "true",
        ENABLE_MEMORY: "true",
        ENABLE_TOOL_ROUTER: "true",
    });

    toolRouter.routeCommandTool = async () => ({
        kind: "ask-clarification",
        question: "Do you want me to save that, or look it up?",
    });

    const response = await orchestrator.handleRequest({
        requestId: "req-clarify",
        channel: "terminal",
        userId: "user-1",
        conversationId: "conv-clarify",
        message: "remember Vishu",
        attachments: [],
        metadata: {},
    });

    assert.equal(response.toolCalls.length, 0);
    assert.equal(response.modelUsed, "jarvis-router");
    assert.equal(response.content, "Do you want me to save that, or look it up?");
});

test("exact time command can resolve city time via geocoding", async (t) => {
    const originalFetch = globalThis.fetch;

    (globalThis as unknown as { fetch: typeof globalThis.fetch }).fetch = (async () => {
        return new Response(
            JSON.stringify({
                results: [
                    {
                        name: "Boston",
                        admin1: "Massachusetts",
                        country: "United States",
                        latitude: 42.3601,
                        longitude: -71.0589,
                        timezone: "America/New_York",
                    },
                ],
            }),
            {
                status: 200,
                headers: { "Content-Type": "application/json" },
            },
        );
    }) as typeof globalThis.fetch;

    t.after(() => {
        (globalThis as unknown as { fetch: typeof globalThis.fetch }).fetch = originalFetch;
    });

    const orchestrator = createOrchestrator({
        ENABLE_TIME: "true",
        ENABLE_TOOL_ROUTER: "true",
    });

    const response = await orchestrator.handleRequest({
        requestId: "req-1",
        channel: "terminal",
        userId: "user-1",
        conversationId: "conv-time-city",
        message: "time Boston, MA",
        attachments: [],
        metadata: {},
    });

    assert.equal(response.toolCalls.length, 1);
    assert.equal(response.toolCalls[0]?.name, "time");
    assert.equal(response.providerUsed, "openai");
    assert.equal(response.modelUsed, "jarvis-command");
    assert.match(response.content, /^Time\b/);
    assert.match(response.content, /Boston/i);
    assert.match(response.content, /America\/New_York/);
});

test("router-selected memory save persists facts that lookup can retrieve", async () => {
    const { orchestrator, persistence, toolRouter } = createTestStack({
        ENABLE_TOOL_ROUTER: "true",
        ENABLE_MEMORY_LOOKUP: "true",
        ENABLE_MEMORY: "true",
    });

    toolRouter.routeCommandTool = async (request) => {
        if (request.message.toLowerCase().includes("mmy name is")) {
            return {
                kind: "run-tool",
                toolName: "memory-saving",
                arguments: {
                    content: "my name is Vishu",
                },
            };
        }

        return {
            kind: "run-tool",
            toolName: "memory-lookup",
            arguments: {
                query: "my name",
            },
        };
    };

    const saveResponse = await orchestrator.handleRequest({
        requestId: "req-save",
        channel: "terminal",
        userId: "user-1",
        conversationId: "conv-memory",
        message: "remember mmy name is vishu",
        attachments: [],
        metadata: {
            sourceMessageId: "source-1",
        },
    });

    assert.equal(saveResponse.toolCalls.length, 1);
    assert.equal(saveResponse.toolCalls[0]?.name, "memory-saving");
    assert.match(saveResponse.toolCalls[0]?.output ?? "", /Saved to memory: my name is Vishu/);

    const stored = await persistence.memories.listByUser("user-1");
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.content, "my name is Vishu");
    assert.equal(stored[0]?.kind, "fact");
    assert.equal(stored[0]?.conversationId, "conv-memory");
    assert.equal(stored[0]?.sourceMessageId, "source-1");

    const lookupResponse = await orchestrator.handleRequest({
        requestId: "req-lookup",
        channel: "terminal",
        userId: "user-1",
        conversationId: "conv-memory",
        message: "remember my name",
        attachments: [],
        metadata: {},
    });

    assert.equal(lookupResponse.toolCalls.length, 1);
    assert.equal(lookupResponse.toolCalls[0]?.name, "memory-lookup");
    assert.match(lookupResponse.toolCalls[0]?.output ?? "", /my name is Vishu/);
});
