# Tool Calling - How to Add Tools (with Native Function Calling)

This document is a practical guide for expanding Jarvis tool calling: adding new tools, wiring config, testing, and using OpenAI-style native function tool calling.

Jarvis supports two concepts:

1) **Runtime tools (deterministic, local)** - Tools run inside the Jarvis runtime (Node.js). They can run before the LLM call, or they can short-circuit the LLM entirely.
2) **Native function tools (OpenAI-style)** - The ToolRouter sends tool definitions with JSON Schema parameters to the model, which returns structured `tool_calls` instead of free-text JSON.

Keep both:
-
---

## 1) Current request pipeline

Source of truth: `src/orchestrator/index.ts`.

High-level flow per user message:

1. Persist conversation + message + run record.
2. **Command tool pass**: `ToolRegistry.tryRunCommand(request)`
   - If a command tool matches, Jarvis returns immediately (no LLM call).
3. **Tool router pass (optional)**: `ToolRouter.routeCommandTool(...)`
   - Uses **native OpenAI tool calling** (`tools` + `tool_choice: "auto"`) to select the right tool.
   - Converts the model's structured `tool_calls` response into a `//command ...` string.
4. **Pre-model tools pass**: `ToolRegistry.runPreModelTools(request)`
   - Runs tools that add context to the prompt (example: web search).
5. Memory retrieval, agent prompt build, model call, persistence, memory capture.

Important: a command tool can also trigger on natural language directly (not only `//...`). For safe tools (like time), this is the cheapest and most reliable approach.

---

## 2) Tool types you can add today

### A) Command tools (deterministic; can short-circuit the LLM)

Use when:
- The tool output is the final answer (time, health, simple lookups).
- You want predictable behavior and minimal cost.

Contract:
- `src/tools/contracts.ts` defines `CommandTool` + `CommandToolDescriptor`.

Where they are registered:
- `src/tools/registry.ts` adds them to `commandTools`.

How they are enabled:
- `src/config/index.ts` maps env vars into `config.tools.<tool>.enabled` and `perChannel` flags.

Key fields in `describe()`:
- `name`: tool id (kebab-case recommended).
- `description`: one sentence describing the output.
- `command`: canonical debug command (example: `//tool`).
- `argsHint` (optional): a short hint (example: `[place]`).
- `examples`: 1-3 realistic examples.
- `autoRoute`: set `true` only for safe, read-only tools you want auto-routed.
- `parameters` (optional): JSON Schema for structured arguments. Used by the ToolRouter for native tool calling.

Example tool: time
- Code: `src/tools/system_com.ts`
- Behavior: auto-detects natural language like what time is it in Boston? (and also supports an explicit debug command).

### B) Pre-model tools (augment the prompt; LLM still replies)

Use when:
- You want to inject context and still let the model compose the final response.
- Example: web search snippets, retrieval, normalization, content redaction.

Example tool:
- `src/tools/web-search.ts` runs before the model and writes a tool message into history.

---

## 3) Native function tool calling (how it works)

Source of truth: `src/tools/tool-router.ts`.

The ToolRouter uses **OpenAI's native `tools` and `tool_choice` API** to select which command tool to run. This replaces the old prompt-engineering approach of asking the model to return free-text JSON.

### How the router works

1. **Fast-path (regex):** For known patterns (e.g., time queries), the router uses regex directly -- no LLM call.
2. **Native tool calling:** When 2+ tools have `autoRoute: true`, the router:
   - Converts each tool's `CommandToolDescriptor` into an OpenAI function tool definition using the `parameters` JSON Schema.
   - Sends the tool definitions to the fast model with `tool_choice: "auto"`.
   - The model returns a structured `tool_calls` array (not free-text JSON).
   - The router extracts the function name and arguments, then builds a `//command args` string.

### What gets sent to the API

When the router has 2+ auto-routable tools, it sends a request like:

```json
{
  "model": "gpt-4o-mini",
  "messages": [
    {"role": "system", "content": "You are ToolRouter for Jarvis.\nPick at most ONE tool to run for the user message.\nIf no tool is appropriate, do not call any tool."},
    {"role": "user", "content": "what's the weather in Tokyo?"}
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "system-com",
        "description": "Return server local time, UTC time, or time in a given place.",
        "parameters": {
          "type": "object",
          "properties": {
            "place": {
              "type": "string",
              "description": "City or location to get the time for. Omit for local/UTC time."
            }
          },
          "required": []
        }
      }
    },
    {
      "type": "function",
      "function": {
        "name": "weather",
        "description": "Get current weather for a location.",
        "parameters": {
          "type": "object",
          "properties": {
            "city": {
              "type": "string",
              "description": "City name to get weather for."
            }
          },
          "required": ["city"]
        }
      }
    }
  ],
  "tool_choice": "auto",
  "temperature": 0
}
```

### What the model returns

Instead of free-text JSON, the model returns a structured response:

```json
{
  "choices": [{
    "message": {
      "content": null,
      "tool_calls": [{
        "id": "call_abc123",
        "type": "function",
        "function": {
          "name": "weather",
          "arguments": "{\"city\": \"Tokyo\"}"
        }
      }]
    }
  }]
}
```

The router then converts this into: `{ tool: "weather", command: "//weather Tokyo" }`.

### Type definitions

The native tool calling types live in `src/types/core.ts`:

```typescript
// Sent to the API as tool definitions
export interface ToolParameterDefinition {
    type: "function";
    function: {
        name: string;
        description: string;
        parameters?: Record<string, unknown>;  // JSON Schema
    };
}

// Returned by the API as tool call results
export interface ToolCallResult {
    id: string;
    type: "function";
    function: {
        name: string;
        arguments: string;  // JSON string
    };
}

// Extended invocation supports tools
export interface ModelInvocation {
    messages: ModelMessage[];
    model: string;
    temperature: number;
    tools?: ToolParameterDefinition[];
    tool_choice?: "auto" | "required" | "none" | { type: "function"; function: { name: string } };
}

// Extended result carries tool calls
export interface ModelResult {
    provider: ProviderKind;
    model: string;
    text: string;
    usage?: TokenUsage;
    toolCalls?: ToolCallResult[];
}
```

### Safety checks

The router enforces several safety rules after receiving tool calls:
- Tool name must exist in the set of auto-routable tools
- The generated command must start with the tool's registered command prefix
- Commands are capped at 240 characters
- Malformed JSON arguments default to no-args invocation (tool still runs, just without args)
- On any error, the router returns `null` and the orchestrator falls through to the normal LLM path

---

## 4) Add a new tool (step-by-step)

### Step 0: Decide the tool kind

Pick one:
- **Command tool**: deterministic output; can short-circuit the model.
- **Pre-model tool**: adds context; model still answers.

Rule of thumb:
- If it can cost money, touch secrets, write to DB, or take side effects: keep it explicit (command-only, `autoRoute: false`) or require confirmation.

### Step 1: Scaffold the tool

Command tool:
```bash
npm run tool:new -- my-tool
```

Command tool with auto-routing enabled:
```bash
npm run tool:new -- weather --kind command --command weather --auto-route
```

Pre-model tool:
```bash
npm run tool:new -- redact --kind pre-model
```

The scaffolder wires up:
- `src/tools/<tool>.ts` (with `parameters` JSON Schema in `describe()`)
- `.env.example` (adds `ENABLE_<TOOL>=false`)
- `src/config/index.ts` (adds config plumbing)
- `src/tools/registry.ts` (registers the tool in the right pipeline)

### Step 2: Implement `describe()`

Make examples realistic and add a `parameters` JSON Schema. The ToolRouter sends `parameters` directly to the OpenAI API for native tool calling.

```typescript
public describe(): CommandToolDescriptor {
    return {
        name: "weather",
        description: "Get current weather for a location.",
        command: "//weather",
        argsHint: "<city>",
        examples: ["//weather London", "//weather Tokyo, Japan"],
        autoRoute: true,
        parameters: {
            type: "object",
            properties: {
                city: {
                    type: "string",
                    description: "City name to get weather for.",
                },
            },
            required: ["city"],
        },
    };
}
```

**Parameter schema tips:**
- Use `type: "object"` at the top level.
- Each property needs a `type` and `description`.
- Mark truly required params in the `required` array.
- Optional params: omit from `required` (the model may or may not include them).
- If your tool takes no arguments, you can omit `parameters` entirely or use `{ type: "object", properties: {} }`.

### Step 3: Implement `shouldRun(...)`

Always gate first:
- tool enabled flag
- per-channel allowlist

Then decide what triggers it:
- command-only: match `//your-command ...`
- command + natural language: add intent detection (safe tools only)

### Step 4: Implement `execute(...)`

Output design tips:
- Keep it short (tool output is stored in history).
- Use bullet or key/value formatting.
- Never return secrets (tokens, passwords, API keys).
- Handle errors by returning `{ success: false, output: ... }`.

### Step 5: Add tests

Tests live in `src/tests/*.test.ts` and run with:
```bash
npm test
```

For HTTP tools, stub `globalThis.fetch` in tests (do not hit the real network).

---

## 5) When to use runtime tools vs native function tools

Use runtime tools (direct `shouldRun()` matching) when:
- You need deterministic behavior (time, health).
- You want to avoid model cost/latency.
- You need the feature to work even when provider is `local`.

Use native function tools (via `autoRoute: true` + `parameters`) when:
- You have many tools and want the model to choose.
- You need structured arguments (JSON schema).
- The tool should respond to natural language without hardcoded regex.

Recommended hybrid:
- Keep runtime tools as fast-paths for safe basics.
- Add `autoRoute: true` + `parameters` for tools that benefit from NL routing.
- The regex fast-path in the router fires first and avoids an LLM call when possible.

---

## 6) Full example: Weather tool with native tool calling

```typescript
// src/tools/weather.ts
import type { AppConfig } from "../config/index.js";
import type { Logger } from "../observability/logger.js";
import type { ToolCallRecord, UserRequest } from "../types/core.js";
import { createId } from "../utils/id.js";
import type { CommandToolDescriptor } from "./contracts.js";

interface WeatherToolDependencies {
    config: AppConfig;
    logger: Logger;
}

const COMMAND_RE = /^\/\/weather(?:\s+(.+))?$/i;

export class WeatherTool {
    private readonly config: AppConfig;
    private readonly logger: Logger;

    public constructor(deps: WeatherToolDependencies) {
        this.config = deps.config;
        this.logger = deps.logger;
    }

    public describe(): CommandToolDescriptor {
        return {
            name: "weather",
            description: "Get current weather for a location.",
            command: "//weather",
            argsHint: "<city>",
            examples: ["//weather London", "//weather Tokyo, Japan"],
            autoRoute: true,
            parameters: {
                type: "object",
                properties: {
                    city: {
                        type: "string",
                        description: "City name to get weather for.",
                    },
                },
                required: ["city"],
            },
        };
    }

    public shouldRun(request: UserRequest): boolean {
        if (!this.config.tools.weather.enabled) return false;
        if (!this.config.tools.weather.perChannel[request.channel]) return false;
        return COMMAND_RE.test(request.message.trim());
    }

    public async execute(message: string): Promise<ToolCallRecord> {
        const createdAt = new Date();
        const input = message.trim();
        const match = input.match(COMMAND_RE);
        const city = match?.[1]?.trim();

        if (!city) {
            return {
                id: createId("tool"),
                name: "weather",
                input,
                output: "Please specify a city. Example: //weather London",
                success: false,
                createdAt,
            };
        }

        try {
            const geoUrl = new URL("https://geocoding-api.open-meteo.com/v1/search");
            geoUrl.searchParams.set("name", city);
            geoUrl.searchParams.set("count", "1");
            const geoRes = await fetch(geoUrl);
            const geoData = (await geoRes.json()) as {
                results?: Array<{ latitude: number; longitude: number; name: string; country: string }>;
            };

            const location = geoData.results?.[0];
            if (!location) {
                return {
                    id: createId("tool"),
                    name: "weather",
                    input,
                    output: `Could not find location: "${city}"`,
                    success: false,
                    createdAt,
                };
            }

            const wxUrl = new URL("https://api.open-meteo.com/v1/forecast");
            wxUrl.searchParams.set("latitude", String(location.latitude));
            wxUrl.searchParams.set("longitude", String(location.longitude));
            wxUrl.searchParams.set("current", "temperature_2m,weathercode,windspeed_10m");
            const wxRes = await fetch(wxUrl);
            const wxData = (await wxRes.json()) as {
                current?: { temperature_2m?: number; weathercode?: number; windspeed_10m?: number };
            };

            const current = wxData.current;
            const output = [
                `Weather in ${location.name}, ${location.country}:`,
                `- Temperature: ${current?.temperature_2m ?? "N/A"}C`,
                `- Wind: ${current?.windspeed_10m ?? "N/A"} km/h`,
                `- Code: ${current?.weathercode ?? "N/A"}`,
            ].join("\n");

            return { id: createId("tool"), name: "weather", input, output, success: true, createdAt };
        } catch (error) {
            const text = error instanceof Error ? error.message : String(error);
            this.logger.warn("weather tool failed", { error: text });
            return { id: createId("tool"), name: "weather", input, output: `Weather lookup failed: ${text}`, success: false, createdAt };
        }
    }
}
```

When a user says "what's the weather in Tokyo?", the flow is:
1. `shouldRun()` does NOT match (no `//weather` prefix).
2. The ToolRouter sends native tool definitions to the fast model.
3. The model returns `tool_calls: [{ function: { name: "weather", arguments: '{"city":"Tokyo"}' } }]`.
4. The router converts this to `{ tool: "weather", command: "//weather Tokyo" }`.
5. The orchestrator re-runs `tryRunCommand()` with `"//weather Tokyo"`.
6. `shouldRun()` matches the `//weather` prefix, `execute()` runs, and the result is returned.

---

## 7) Quick checklist for any new tool

- Env flag exists in `.env.example`
- Config wired in `src/config/index.ts`
- Tool registered in `src/tools/registry.ts`
- `describe()` is accurate + has examples
- `parameters` JSON Schema matches what the tool expects (if auto-routed)
- `autoRoute` matches risk profile
- Tests stub external IO and cover success + failure
- Tool output never contains secrets
