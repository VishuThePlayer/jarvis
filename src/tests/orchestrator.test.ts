import assert from "node:assert/strict";
import test from "node:test";
import { createTestStack } from "./helpers.js";

function createOrchestrator(env: Record<string, string> = {}) {
    return createTestStack(env).orchestrator;
}

test("command tools short-circuit the LLM", async () => {
    const orchestrator = createOrchestrator({
        ENABLE_TIME: "true",
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
    assert.equal(response.toolCalls[0]?.name, "time");
    assert.equal(response.providerUsed, "openai");
    assert.equal(response.modelUsed, "jarvis-command");
    assert.match(response.content, /^Time\b/);
});

test("tool router can route natural language to command tools", async () => {
    const orchestrator = createOrchestrator({
        ENABLE_TIME: "true",
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
    assert.equal(response.toolCalls[0]?.name, "time");
    assert.match(response.content, /^Time\b/);
});

test("time tool can resolve city time via geocoding", async (t) => {
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
        message: "what time is it in Boston, MA?",
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
