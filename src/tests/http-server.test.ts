import assert from "node:assert/strict";
import test from "node:test";
import { HttpServer } from "../server/http-server.js";
import { createTestStack } from "./helpers.js";

function createServer() {
    const stack = createTestStack({
        ENABLE_HTTP: "true",
        WEB_APP_ORIGIN: "http://localhost:5173",
    });
    const config = { ...stack.config, app: { ...stack.config.app, port: 0 } };
    const server = new HttpServer({ config, logger: stack.logger, orchestrator: stack.orchestrator });
    return { server, persistence: stack.persistence };
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
