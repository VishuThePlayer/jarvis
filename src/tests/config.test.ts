import assert from "node:assert/strict";
import test from "node:test";
import { createConfig } from "../config/index.js";

test("createConfig applies sensible defaults", () => {
    const config = createConfig({});

    assert.equal(config.app.port, 3000);
    assert.equal(config.channels.http.enabled, true);
    assert.equal(config.memory.enabled, true);
    assert.equal(config.web.appOrigin, undefined);
    assert.equal(config.orchestrator.historyMessageLimit, 50);
    assert.equal(config.persistence.pgvector.enabled, false);
    assert.equal(config.persistence.pgvector.dimensions, 1536);
    assert.equal(config.models.default, "gpt-4o");
    assert.equal(config.models.fast, "gpt-4o-mini");
});
