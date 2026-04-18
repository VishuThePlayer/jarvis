import assert from "node:assert/strict";
import test from "node:test";
import { createConfig } from "../config/index.js";

test("createConfig applies sensible defaults", () => {
    const config = createConfig({});

    assert.equal(config.app.port, 3000);
    assert.equal(config.providers.defaultProvider, "local");
    assert.equal(config.channels.http.enabled, true);
    assert.equal(config.memory.enabled, true);
});
