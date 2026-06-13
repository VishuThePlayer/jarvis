import assert from "node:assert/strict";
import test from "node:test";
import { createConfig } from "../config/index.js";
import { InMemoryPersistence } from "../db/in-memory.js";
import { MemoryService } from "../memory/service.js";
import { ZepClient } from "../memory/zep-client.js";
import { Logger } from "../observability/logger.js";
import type { MessageRecord, UserRequest } from "../types/core.js";

function createMemoryStack(env: Record<string, string> = {}) {
    const config = createConfig({
        APP_ENV: "test",
        ENABLE_HTTP: "false",
        ENABLE_TERMINAL: "false",
        ENABLE_TELEGRAM: "false",
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

    return { config, logger, persistence, memory };
}

function createRequest(overrides: Partial<UserRequest> = {}): UserRequest {
    return {
        requestId: "req-memory",
        channel: "terminal",
        userId: "user-1",
        conversationId: "conv-memory",
        message: "remember my name is Vishu",
        attachments: [],
        metadata: {},
        ...overrides,
    };
}

function resolveUrl(input: URL | RequestInfo): string {
    if (typeof input === "string") {
        return input;
    }

    if (input instanceof URL) {
        return input.toString();
    }

    return input.url;
}

function readHeader(headers: HeadersInit | undefined, name: string): string | null {
    if (!headers) {
        return null;
    }

    if (headers instanceof Headers) {
        return headers.get(name);
    }

    if (Array.isArray(headers)) {
        const pair = headers.find(([key]) => key.toLowerCase() === name.toLowerCase());
        return pair?.[1] ?? null;
    }

    const record = headers as Record<string, string>;
    const entry = Object.entries(record).find(([key]) => key.toLowerCase() === name.toLowerCase());
    return entry?.[1] ?? null;
}

test("memory service falls back to local memory when zep backend has no API key", async () => {
    const { memory, persistence } = createMemoryStack({
        MEMORY_BACKEND: "zep",
    });
    const request = createRequest();

    const saveResult = await memory.saveExplicitMemory({
        request,
        content: "my name is Vishu",
    });

    assert.equal(saveResult.duplicate, false);

    const lookupResult = await memory.lookupExplicitMemory({
        request,
        query: "my name",
    });

    assert.equal(lookupResult.matches.length, 1);
    assert.equal(lookupResult.matches[0]?.content, "my name is Vishu");

    const stored = await persistence.memories.listByUser("user-1");
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.content, "my name is Vishu");
});

test("zep memory retrieval maps session context and graph results into prompt context", async (t) => {
    const originalFetch = globalThis.fetch;

    (globalThis as { fetch: typeof globalThis.fetch }).fetch = (async (input, init) => {
        const url = resolveUrl(input);
        const method = init?.method ?? "GET";

        if (url.endsWith("/api/v2/users") && method === "POST") {
            return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
        }

        if (url.endsWith("/api/v2/threads") && method === "POST") {
            return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
        }

        if (url.endsWith("/api/v2/threads/conv-memory/context") && method === "GET") {
            return new Response(
                JSON.stringify({
                    context: [
                        "<USER_SUMMARY>",
                        "The user builds automation tools and prefers concise help.",
                        "</USER_SUMMARY>",
                        "<FACTS>",
                        "- User name is Vishu (2026-04-24 10:00:00+00:00 - present)",
                        "- User lives in Bangalore and prefers practical answers. (2026-04-24 10:00:00+00:00 - present)",
                        "</FACTS>",
                    ].join("\n"),
                    episodes: [
                        {
                            uuid: "ep-1",
                            summary: "User builds coding tools in a folder named Coding.",
                            created_at: "2026-04-24T10:00:00.000Z",
                        },
                    ],
                }),
                { status: 200, headers: { "Content-Type": "application/json" } },
            );
        }

        if (url.endsWith("/api/v2/graph/search") && method === "POST") {
            return new Response(
                JSON.stringify({
                    edges: [
                        {
                            uuid: "edge-1",
                            fact: "prefers VS Code",
                            kind: "preference",
                            created_at: "2026-04-24T10:00:00.000Z",
                        },
                    ],
                }),
                { status: 200, headers: { "Content-Type": "application/json" } },
            );
        }

        throw new Error(`Unexpected fetch: ${method} ${url}`);
    }) as typeof globalThis.fetch;

    t.after(() => {
        (globalThis as { fetch: typeof globalThis.fetch }).fetch = originalFetch;
    });

    const { memory } = createMemoryStack({
        MEMORY_BACKEND: "zep",
        ZEP_API_KEY: "test-zep-key",
    });

    const context = await memory.retrieveContext({
        userId: "user-1",
        conversationId: "conv-memory",
        query: "what do you know about my coding setup?",
    });

    assert.equal(context.summary?.content, "The user builds automation tools and prefers concise help.");
    assert.equal(context.summaryLabel, "Long-term memory summary");
    assert.match(context.contextBlock ?? "", /<USER_SUMMARY>/);
    assert.deepEqual(
        context.entries.map((entry) => entry.content),
        [
            "User name is Vishu",
            "User lives in Bangalore and prefers practical answers.",
            "User builds coding tools in a folder named Coding.",
            "prefers VS Code",
        ],
    );
});

test("zep memory retrieval parses facts from live-style context blocks without FACTS tags", async (t) => {
    const originalFetch = globalThis.fetch;

    (globalThis as { fetch: typeof globalThis.fetch }).fetch = (async (input, init) => {
        const url = resolveUrl(input);
        const method = init?.method ?? "GET";

        if (url.endsWith("/api/v2/users") && method === "POST") {
            return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
        }

        if (url.endsWith("/api/v2/threads") && method === "POST") {
            return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
        }

        if (url.endsWith("/api/v2/threads/conv-memory/context") && method === "GET") {
            return new Response(
                JSON.stringify({
                    context: [
                        "# This is the user summary",
                        "<USER_SUMMARY>",
                        "The user prefers concise help.",
                        "</USER_SUMMARY>",
                        "# These are the most relevant facts and their valid date ranges",
                        "- User favorite editor is VS Code. (2026-04-24 10:00:00+00:00 - present)",
                    ].join("\n"),
                }),
                { status: 200, headers: { "Content-Type": "application/json" } },
            );
        }

        if (url.endsWith("/api/v2/graph/search") && method === "POST") {
            return new Response(JSON.stringify({ results: [] }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
        }

        throw new Error(`Unexpected fetch: ${method} ${url}`);
    }) as typeof globalThis.fetch;

    t.after(() => {
        (globalThis as { fetch: typeof globalThis.fetch }).fetch = originalFetch;
    });

    const { memory } = createMemoryStack({
        MEMORY_BACKEND: "zep",
        ZEP_API_KEY: "test-zep-key",
    });

    const context = await memory.retrieveContext({
        userId: "user-1",
        conversationId: "conv-memory",
        query: "what editor do I use?",
    });

    assert.equal(context.summary?.content, "The user prefers concise help.");
    assert.deepEqual(
        context.entries.map((entry) => entry.content),
        ["User favorite editor is VS Code."],
    );
});

test("zep captureTurn posts both sides of the turn and ignores assistant graph writes", async (t) => {
    const originalFetch = globalThis.fetch;
    const postedBodies: unknown[] = [];

    (globalThis as { fetch: typeof globalThis.fetch }).fetch = (async (input, init) => {
        const url = resolveUrl(input);
        const method = init?.method ?? "GET";

        if ((url.endsWith("/api/v2/users") || url.endsWith("/api/v2/threads")) && method === "POST") {
            return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
        }

        if (url.endsWith("/api/v2/threads/conv-memory/messages") && method === "POST") {
            postedBodies.push(init?.body ? JSON.parse(String(init.body)) : null);
            return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
        }

        throw new Error(`Unexpected fetch: ${method} ${url}`);
    }) as typeof globalThis.fetch;

    t.after(() => {
        (globalThis as { fetch: typeof globalThis.fetch }).fetch = originalFetch;
    });

    const { memory } = createMemoryStack({
        MEMORY_BACKEND: "zep",
        ZEP_API_KEY: "test-zep-key",
    });
    const request = createRequest({ message: "I prefer VS Code" });
    const response: MessageRecord = {
        id: "msg-assistant",
        conversationId: "conv-memory",
        role: "assistant",
        content: "Noted.",
        channel: "terminal",
        userId: "user-1",
        provider: "openai",
        model: "gpt-test",
        createdAt: new Date("2026-04-24T10:05:00.000Z"),
    };

    const writes = await memory.captureTurn({
        request,
        response,
        messageCount: 2,
        recentMessages: [],
    });

    assert.deepEqual(writes, []);
    assert.equal(postedBodies.length, 1);
    const payload = postedBodies[0] as {
        messages?: Array<{
            role?: string;
            content?: string;
            name?: string;
            created_at?: string;
        }>;
    };
    assert.equal(payload.messages?.length, 2);
    assert.deepEqual(
        payload.messages?.map((message) => ({
            role: message.role,
            content: message.content,
            name: message.name,
        })),
        [
            { role: "user", content: "I prefer VS Code", name: "user-1" },
            { role: "assistant", content: "Noted.", name: "Jarvis" },
        ],
    );
    assert.match(payload.messages?.[0]?.created_at ?? "", /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(payload.messages?.[1]?.created_at, "2026-04-24T10:05:00.000Z");
});

test("zep explicit saves are mirrored locally so immediate lookup still works", async (t) => {
    const originalFetch = globalThis.fetch;

    (globalThis as { fetch: typeof globalThis.fetch }).fetch = (async (input, init) => {
        const url = resolveUrl(input);
        const method = init?.method ?? "GET";

        if ((url.endsWith("/api/v2/users") || url.endsWith("/api/v2/threads")) && method === "POST") {
            return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
        }

        if (url.endsWith("/api/v2/graph/search") && method === "POST") {
            return new Response(
                JSON.stringify({ results: [] }),
                { status: 200, headers: { "Content-Type": "application/json" } },
            );
        }

        if (url.endsWith("/api/v2/threads/conv-memory/messages") && method === "POST") {
            return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
        }

        if (url.endsWith("/api/v2/threads/conv-memory/context") && method === "GET") {
            return new Response("", { status: 404 });
        }

        throw new Error(`Unexpected fetch: ${method} ${url}`);
    }) as typeof globalThis.fetch;

    t.after(() => {
        (globalThis as { fetch: typeof globalThis.fetch }).fetch = originalFetch;
    });

    const { memory } = createMemoryStack({
        MEMORY_BACKEND: "zep",
        ZEP_API_KEY: "test-zep-key",
    });
    const request = createRequest();

    const saveResult = await memory.saveExplicitMemory({
        request,
        content: "my name is Vishu",
    });

    assert.equal(saveResult.duplicate, false);

    const lookupResult = await memory.lookupExplicitMemory({
        request,
        query: "my name",
    });

    assert.equal(lookupResult.matches.length, 1);
    assert.equal(lookupResult.matches[0]?.content, "my name is Vishu");
});

test("zep client prefers Api-Key auth and normalizes api base urls", async (t) => {
    const originalFetch = globalThis.fetch;
    const seen: Array<{ url: string; authorization: string | null; xApiKey: string | null }> = [];

    (globalThis as { fetch: typeof globalThis.fetch }).fetch = (async (input, init) => {
        const url = resolveUrl(input);
        const authorization = readHeader(init?.headers, "Authorization");
        const xApiKey = readHeader(init?.headers, "X-API-Key");
        seen.push({ url, authorization, xApiKey });

        if (authorization === "Api-Key test-zep-key") {
            return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
        }

        throw new Error(`Unexpected auth header for ${url}`);
    }) as typeof globalThis.fetch;

    t.after(() => {
        (globalThis as { fetch: typeof globalThis.fetch }).fetch = originalFetch;
    });

    const client = new ZepClient({
        apiKey: "test-zep-key",
        baseUrl: "https://api.getzep.com/api/v2",
    });

    await client.ensureUser("user-1");

    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.url, "https://api.getzep.com/api/v2/users");
    assert.equal(seen[0]?.authorization, "Api-Key test-zep-key");
    assert.equal(seen[0]?.xApiKey, "test-zep-key");
});

test("zep client retries with raw auth when Api-Key auth is rejected", async (t) => {
    const originalFetch = globalThis.fetch;
    const seen: Array<{ url: string; authorization: string | null }> = [];

    (globalThis as { fetch: typeof globalThis.fetch }).fetch = (async (input, init) => {
        const url = resolveUrl(input);
        const authorization = readHeader(init?.headers, "Authorization");
        seen.push({ url, authorization });

        if (authorization === "Api-Key test-zep-key") {
            return new Response("unauthorized", { status: 401 });
        }

        if (authorization === "test-zep-key") {
            return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
        }

        throw new Error(`Unexpected auth header for ${url}`);
    }) as typeof globalThis.fetch;

    t.after(() => {
        (globalThis as { fetch: typeof globalThis.fetch }).fetch = originalFetch;
    });

    const client = new ZepClient({
        apiKey: "test-zep-key",
        baseUrl: "https://api.getzep.com",
    });

    await client.ensureUser("user-1");

    assert.equal(seen.length, 2);
    assert.equal(seen[0]?.authorization, "Api-Key test-zep-key");
    assert.equal(seen[1]?.authorization, "test-zep-key");
});

test("zep client treats existing user and thread create responses as success", async (t) => {
    const originalFetch = globalThis.fetch;
    const seen: string[] = [];

    (globalThis as { fetch: typeof globalThis.fetch }).fetch = (async (input, init) => {
        const url = resolveUrl(input);
        const method = init?.method ?? "GET";
        seen.push(`${method} ${url}`);

        if (url.endsWith("/api/v2/users") && method === "POST") {
            return new Response(
                JSON.stringify({ message: "bad request: user already exists with user_id: local-user" }),
                { status: 400, headers: { "Content-Type": "application/json" } },
            );
        }

        if (url.endsWith("/api/v2/threads") && method === "POST") {
            return new Response(
                JSON.stringify({ message: "bad request: thread already exists with thread_id: conv-memory" }),
                { status: 400, headers: { "Content-Type": "application/json" } },
            );
        }

        throw new Error(`Unexpected fetch: ${method} ${url}`);
    }) as typeof globalThis.fetch;

    t.after(() => {
        (globalThis as { fetch: typeof globalThis.fetch }).fetch = originalFetch;
    });

    const client = new ZepClient({
        apiKey: "test-zep-key",
        baseUrl: "https://api.getzep.com",
    });

    await client.ensureUser("local-user");
    await client.ensureSession("conv-memory", "local-user");

    assert.deepEqual(seen, [
        "POST https://api.getzep.com/api/v2/users",
        "POST https://api.getzep.com/api/v2/threads",
    ]);
});

test("zep client error includes exact method and url when requests fail", async (t) => {
    const originalFetch = globalThis.fetch;

    (globalThis as { fetch: typeof globalThis.fetch }).fetch = (async () => {
        return new Response("404 page not found\n", { status: 404 });
    }) as typeof globalThis.fetch;

    t.after(() => {
        (globalThis as { fetch: typeof globalThis.fetch }).fetch = originalFetch;
    });

    const client = new ZepClient({
        apiKey: "test-zep-key",
        baseUrl: "https://api.getzep.com",
    });

    await assert.rejects(
        () => client.ensureSession("session-1", "user-1"),
        (error: unknown) => {
            assert.match(String(error), /POST https:\/\/api\.getzep\.com\/api\/v2\/sessions/);
            assert.match(String(error), /auth=api-key-prefix/);
            return true;
        },
    );
});
