# Jarvis Developer Guide

A complete reference for adding tools, editing features, and working with the Jarvis codebase.

---

## Table of Contents

- [Project Overview](#project-overview)
- [Project Structure](#project-structure)
- [Architecture at a Glance](#architecture-at-a-glance)
- [Request Lifecycle](#request-lifecycle)
- [Adding a New Tool](#adding-a-new-tool)
  - [Automated Scaffolding](#automated-scaffolding)
  - [Manual Wiring](#manual-wiring)
  - [Full Example: Building a Weather Tool](#full-example-building-a-weather-tool)
- [Editing an Existing Tool](#editing-an-existing-tool)
- [Tool Types Explained](#tool-types-explained)
- [Tool Router (Natural Language Routing)](#tool-router)
- [Adding a New Channel](#adding-a-new-channel)
- [Adding a New Model Provider](#adding-a-new-model-provider)
- [Editing the Config System](#editing-the-config-system)
- [Working with Persistence](#working-with-persistence)
- [Working with Memory](#working-with-memory)
- [Working with the Agent System](#working-with-the-agent-system)
- [Frontend (Web UI)](#frontend-web-ui)
- [Testing](#testing)
- [Conventions and Patterns](#conventions-and-patterns)
- [Common Tasks Cheat Sheet](#common-tasks-cheat-sheet)

---

## Project Overview

Jarvis is a local-first, provider-agnostic AI assistant runtime built with Node.js and TypeScript. It receives user messages from multiple channels (HTTP, terminal, Telegram), optionally runs tools, calls an LLM, persists conversations and memory, and returns responses.

**Key technologies:**
- **Runtime:** Node.js with ESM modules
- **Language:** TypeScript 6 (strict mode)
- **Validation:** Zod v4
- **Web framework:** Express v5
- **Database:** In-memory (default) or PostgreSQL
- **Frontend:** React 19 + Vite + Tailwind CSS v4 (in `web/`)

---

## Project Structure

```
src/
├── index.ts                          # Entry point
├── app/
│   └── create-application.ts         # Composition root (wires everything)
├── types/
│   └── core.ts                       # All shared domain types
├── config/
│   └── index.ts                      # Zod-validated env -> AppConfig
├── orchestrator/
│   └── index.ts                      # Central request coordinator
├── agents/
│   ├── jarvis/index.ts               # Primary agent (system prompt + history)
│   └── registry/index.ts             # Agent registry
├── models/
│   ├── contracts.ts                  # ModelProvider interface
│   ├── registry.ts                   # Provider selection + fallback
│   └── providers/
│       ├── local.ts                  # Offline stub provider
│       ├── openai.ts                 # OpenAI-compatible API
│       └── openrouter.ts            # OpenRouter SDK
├── tools/
│   ├── contracts.ts                  # CommandTool + CommandToolDescriptor
│   ├── registry.ts                   # Tool registry (command + pre-model)
│   ├── tool-router.ts                # NL -> //command routing
│   ├── system_com.ts                 # Time/timezone tool
│   └── web-search.ts                # DuckDuckGo web search
├── memory/
│   └── service.ts                    # Memory retrieval + capture
├── db/
│   ├── contracts.ts                  # Repository interfaces
│   ├── in-memory.ts                  # Map-based persistence
│   └── postgres/
│       └── persistence.ts            # PostgreSQL persistence
├── channels/
│   ├── types.ts                      # ChannelAdapter interface
│   ├── terminal/index.ts             # Readline terminal
│   └── telegram/index.ts            # Telegram long-polling
├── server/
│   └── http-server.ts                # Express REST + SSE
├── observability/
│   └── logger.ts                     # JSON structured logging
├── utils/
│   ├── id.ts                         # createId("prefix") -> prefix_uuid
│   ├── text.ts                       # Tokenize, truncate, keyword scoring
│   └── channel-formatting.ts         # Per-channel system prompts
└── tests/
    ├── config.test.ts
    ├── orchestrator.test.ts
    └── http-server.test.ts

scripts/
├── scaffold-tool.mjs                # Tool scaffolding script
├── new-tool.sh / new-tool.ps1       # Shell wrappers
└── install-pgvector.ps1

web/                                  # React frontend (separate Vite app)
docs/                                 # Documentation
```

---

## Architecture at a Glance

```
┌─────────────────────────────────────────────────────────────┐
│                        Channels                              │
│  ┌──────────┐   ┌──────────┐   ┌──────────────────────┐     │
│  │ Terminal  │   │   HTTP   │   │      Telegram        │     │
│  └────┬─────┘   └────┬─────┘   └──────────┬───────────┘     │
│       │              │                     │                  │
│       └──────────────┼─────────────────────┘                  │
│                      ▼                                        │
│           ┌─────────────────────┐                             │
│           │   Orchestrator      │◄──── Tool Registry          │
│           │  (handleRequest)    │◄──── Tool Router             │
│           │                     │◄──── Memory Service          │
│           └────────┬────────────┘                             │
│                    │                                          │
│           ┌────────▼────────────┐                             │
│           │   Agent (Jarvis)    │  builds system prompt        │
│           └────────┬────────────┘                             │
│                    │                                          │
│           ┌────────▼────────────┐                             │
│           │  Model Registry     │                             │
│           │  local│openai│OR    │                             │
│           └─────────────────────┘                             │
│                                                               │
│           ┌─────────────────────┐                             │
│           │  Persistence Layer  │                             │
│           │  memory │ postgres  │                             │
│           └─────────────────────┘                             │
└─────────────────────────────────────────────────────────────┘
```

Every channel talks **only** to the orchestrator. The orchestrator coordinates tools, memory, the agent, and the model provider.

---

## Request Lifecycle

When a user sends a message, here is exactly what happens:

1. **Channel** receives the message and creates a `UserRequest`
2. **Orchestrator** takes over:
   1. `ensureConversation()` — creates or retrieves conversation
   2. `resolveForRequest()` — picks provider + model (slot heuristics or explicit override)
   3. Creates a `RunRecord` (status: `running`)
   4. Persists the user message
   5. **Command tool pass** — `tools.tryRunCommand(request)`:
      - If a tool matches → **short-circuits** (no LLM call), returns tool output as the response
   6. **Tool router pass** — converts natural language to `//command`, re-runs command tools
   7. **Memory retrieval** — fetches relevant memories + conversation summary
   8. **Pre-model tools** — runs web search etc., persists tool messages
   9. **Agent invocation** — builds system prompt + message history
   10. **LLM call** — `generateWithFallback()` with primary + fallback provider
   11. Persists assistant message
   12. **Memory capture** — extracts facts/preferences from user message
   13. Completes the run record
3. **Channel** receives `AssistantResponse` and sends it to the user

---

## Adding a New Tool

### Automated Scaffolding

The fastest way to add a tool. Run:

```bash
# Command tool (short-circuits the LLM)
npm run tool:new -- my-tool

# Command tool with a custom //command name
npm run tool:new -- weather --kind command --command weather

# Pre-model tool (augments the prompt, LLM still responds)
npm run tool:new -- redact --kind pre-model
```

**What the scaffolder does automatically:**

| What | Where |
|------|-------|
| Creates the tool file | `src/tools/my-tool.ts` |
| Adds env variable | `.env.example` → `ENABLE_MY_TOOL=false` |
| Adds config type | `src/config/index.ts` → `AppConfig.tools.myTool` |
| Adds env schema | `src/config/index.ts` → `envSchema` |
| Adds config value | `src/config/index.ts` → `createConfig()` |
| Imports the tool | `src/tools/registry.ts` → import statement |
| Creates instance | `src/tools/registry.ts` → constructor |
| Registers in pipeline | `src/tools/registry.ts` → `commandTools[]` or `runPreModelTools()` |

After scaffolding, you only need to implement the logic in the generated file.

### Manual Wiring

If you prefer to wire things by hand, you need to touch **4 files**:

#### 1. Create the tool file: `src/tools/my-tool.ts`

```typescript
import type { AppConfig } from "../config/index.js";
import type { Logger } from "../observability/logger.js";
import type { ToolCallRecord, UserRequest } from "../types/core.js";
import { createId } from "../utils/id.js";
import type { CommandToolDescriptor } from "./contracts.js";

interface MyToolDependencies {
    config: AppConfig;
    logger: Logger;
}

const COMMAND_RE = /^\/\/my-tool(?:\s+(.+))?$/i;

export class MyTool {
    private readonly config: AppConfig;
    private readonly logger: Logger;

    public constructor(deps: MyToolDependencies) {
        this.config = deps.config;
        this.logger = deps.logger;
    }

    public describe(): CommandToolDescriptor {
        return {
            name: "my-tool",
            description: "What this tool does in one sentence.",
            command: "//my-tool",
            argsHint: "[args]",
            examples: ["//my-tool", "//my-tool some-argument"],
            autoRoute: false,
        };
    }

    public shouldRun(request: UserRequest): boolean {
        if (!this.config.tools.myTool.enabled) return false;
        if (!this.config.tools.myTool.perChannel[request.channel]) return false;
        return COMMAND_RE.test(request.message.trim());
    }

    public async execute(message: string): Promise<ToolCallRecord> {
        const createdAt = new Date();
        const input = message.trim();
        const match = input.match(COMMAND_RE);
        const args = match?.[1]?.trim() ?? "";

        try {
            const output = `Result for: ${args}`;
            return {
                id: createId("tool"),
                name: "my-tool",
                input,
                output,
                success: true,
                createdAt,
            };
        } catch (error) {
            const text = error instanceof Error ? error.message : String(error);
            this.logger.warn("my-tool failed", { error: text });
            return {
                id: createId("tool"),
                name: "my-tool",
                input,
                output: `my-tool failed: ${text}`,
                success: false,
                createdAt,
            };
        }
    }
}
```

#### 2. Register in the tool registry: `src/tools/registry.ts`

```typescript
// Add import at the top
import { MyTool } from "./my-tool.js";

// Add field in the class
private readonly myTool: MyTool;

// Add in constructor
this.myTool = new MyTool(dependencies);

// For command tools — add to the commandTools array:
this.commandTools = [
    this.systemCom,
    this.myTool,        // <-- add here
];

// For pre-model tools — add in runPreModelTools():
if (this.myTool.shouldRun(request)) {
    results.push(await this.myTool.execute(request.message));
}
```

#### 3. Add config: `src/config/index.ts`

```typescript
// In the AppConfig interface, under tools:
myTool: {
    enabled: boolean;
    perChannel: Record<ChannelKind, boolean>;
};

// In envSchema:
ENABLE_MY_TOOL: envBoolean.optional().default(false),

// In createConfig() return, under tools:
myTool: {
    enabled: parsed.ENABLE_MY_TOOL,
    perChannel: {
        terminal: true,
        http: true,
        telegram: true,
    },
},
```

#### 4. Add env variable: `.env.example`

```
ENABLE_MY_TOOL=false
```

### Full Example: Building a Weather Tool

Here's a complete, real-world example of building a weather tool:

```bash
# Step 1: Scaffold
npm run tool:new -- weather --kind command --command weather
```

```typescript
// Step 2: Edit src/tools/weather.ts

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

interface WeatherResponse {
    current?: {
        temperature_2m?: number;
        weathercode?: number;
        windspeed_10m?: number;
    };
}

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
            // Geocode the city
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

            // Fetch weather
            const wxUrl = new URL("https://api.open-meteo.com/v1/forecast");
            wxUrl.searchParams.set("latitude", String(location.latitude));
            wxUrl.searchParams.set("longitude", String(location.longitude));
            wxUrl.searchParams.set("current", "temperature_2m,weathercode,windspeed_10m");
            const wxRes = await fetch(wxUrl);
            const wxData = (await wxRes.json()) as WeatherResponse;

            const current = wxData.current;
            const output = [
                `Weather in ${location.name}, ${location.country}:`,
                `- Temperature: ${current?.temperature_2m ?? "N/A"}°C`,
                `- Wind: ${current?.windspeed_10m ?? "N/A"} km/h`,
                `- Code: ${current?.weathercode ?? "N/A"}`,
            ].join("\n");

            return {
                id: createId("tool"),
                name: "weather",
                input,
                output,
                success: true,
                createdAt,
            };
        } catch (error) {
            const text = error instanceof Error ? error.message : String(error);
            this.logger.warn("weather tool failed", { error: text });
            return {
                id: createId("tool"),
                name: "weather",
                input,
                output: `Weather lookup failed: ${text}`,
                success: false,
                createdAt,
            };
        }
    }
}
```

```bash
# Step 3: Enable it
# In your .env file:
ENABLE_WEATHER=true

# Step 4: Test it
npm test
npm run dev

# In the terminal or web UI, type:
# //weather Paris
```

---

## Editing an Existing Tool

### Where to find tool code

All tools live in `src/tools/`. Current tools:

| Tool | File | Command | Type |
|------|------|---------|------|
| Time/timezone | `src/tools/system_com.ts` | `//time [place]` | Command |
| Web search | `src/tools/web-search.ts` | (auto-triggered) | Pre-model |

### What you can change

**Change trigger behavior** → Edit `shouldRun()`:
- Add/remove regex patterns for natural language detection
- Change per-channel gating logic
- Add new metadata checks (e.g., `request.metadata.someFlag`)

**Change tool output** → Edit `execute()`:
- Modify the output format (bullet points, key-value, etc.)
- Add new API calls or data sources
- Change error handling/messages

**Change tool description** → Edit `describe()`:
- Update `description` (affects tool router LLM context)
- Update `examples` (affects tool router accuracy)
- Toggle `autoRoute` (enables/disables natural language routing)
- Change `command` (the `//command` prefix)
- Change `argsHint` (shown in help text)

**Change config options** → Edit `src/config/index.ts`:
- Add new env vars to the tool's config section
- Add new fields to the tool's config type

### Example: Adding natural language detection to an existing command tool

```typescript
// In shouldRun(), after the command regex check:
public shouldRun(request: UserRequest): boolean {
    if (!this.config.tools.myTool.enabled) return false;
    if (!this.config.tools.myTool.perChannel[request.channel]) return false;

    const message = request.message.trim();

    // Explicit command always works
    if (COMMAND_RE.test(message)) return true;

    // Natural language detection (optional)
    if (/\b(weather|forecast|temperature)\b/i.test(message)) return true;

    return false;
}
```

### Example: Adding a config option to a tool

```typescript
// 1. In src/config/index.ts — AppConfig interface:
myTool: {
    enabled: boolean;
    maxResults: number;          // <-- new field
    perChannel: Record<ChannelKind, boolean>;
};

// 2. In envSchema:
MY_TOOL_MAX_RESULTS: z.coerce.number().int().positive().max(20).default(5),

// 3. In createConfig() return:
myTool: {
    enabled: parsed.ENABLE_MY_TOOL,
    maxResults: parsed.MY_TOOL_MAX_RESULTS,
    perChannel: { terminal: true, http: true, telegram: true },
},

// 4. In .env.example:
MY_TOOL_MAX_RESULTS=5

// 5. Use it in your tool:
const limit = this.config.tools.myTool.maxResults;
```

---

## Tool Types Explained

### Command Tools

**When to use:** The tool output IS the final answer. No LLM call needed.

- Triggered by `//command` prefix or natural language patterns in `shouldRun()`
- The orchestrator short-circuits — returns tool output directly
- Cheap, fast, works even with `local` provider
- Good for: time, weather, health checks, simple lookups, calculators

**Pipeline position:** `orchestrator.handleRequest()` → `tools.tryRunCommand()` → returns immediately if matched

### Pre-model Tools

**When to use:** You want to inject context and let the LLM compose the final response.

- Triggered automatically by heuristics or metadata flags
- Runs BEFORE the LLM call
- Output is injected into the conversation as a `role: "tool"` message
- The LLM sees this context and can reference it in its response
- Good for: web search, RAG retrieval, content enrichment, data normalization

**Pipeline position:** `orchestrator.handleRequest()` → `tools.runPreModelTools()` → output injected into prompt → LLM call

### Decision Guide

| Scenario | Type | Why |
|----------|------|-----|
| "What time is it?" | Command | Deterministic answer, no LLM needed |
| "Search the web for X" | Pre-model | LLM should compose the answer using results |
| "Calculate 2+2" | Command | Simple computation, no LLM needed |
| "Summarize this article at URL" | Pre-model | Fetch content, let LLM summarize |
| "What's my IP?" | Command | Direct lookup |
| "Tell me about recent news on X" | Pre-model | Search results + LLM synthesis |

---

## Tool Router

The tool router (`src/tools/tool-router.ts`) converts natural language into `//command` invocations so the user doesn't need to know command syntax.

### How it works

1. **Fast-path (regex):** For known patterns (e.g., time queries), the router uses regex directly — no LLM call
2. **LLM-assisted:** When 2+ tools have `autoRoute: true`, the router makes a cheap LLM call using the `fast` model slot to pick the right tool

### Enabling auto-routing for your tool

In your tool's `describe()`, set `autoRoute: true`:

```typescript
public describe(): CommandToolDescriptor {
    return {
        name: "weather",
        autoRoute: true,  // enables NL routing
        // ...
    };
}
```

**Only set `autoRoute: true` for safe, read-only tools.** The router has safety checks:
- Validates tool name against an allowlist
- Validates the command starts with the tool's prefix
- Commands must start with `//` and be under 240 chars
- Gracefully degrades on failure (returns `null`, no routing)

### Adding a fast-path to the router

For ultra-reliable routing without an LLM call, add a regex fast-path in `tool-router.ts`:

```typescript
// In routeCommandTool(), before the LLM-assisted routing:
const weatherIntent = this.extractWeatherIntent(request.message);
if (weatherIntent) {
    return { toolName: "weather", command: `//weather ${weatherIntent.city}` };
}
```

---

## Adding a New Channel

Channels are entry points that translate external I/O into `UserRequest` objects.

### Steps

1. **Create the adapter** implementing `ChannelAdapter` from `src/channels/types.ts`:

```typescript
import type { ChannelAdapter } from "../channels/types.js";

export class DiscordChannelAdapter implements ChannelAdapter {
    async start(): Promise<void> {
        // Connect to Discord, set up message handlers
        // On message: call this.orchestrator.handleRequest(userRequest)
    }

    async stop(): Promise<void> {
        // Disconnect gracefully
    }
}
```

2. **Add channel kind** to `src/types/core.ts`:

```typescript
export type ChannelKind = "terminal" | "http" | "telegram" | "discord";
```

3. **Add config** in `src/config/index.ts`:

```typescript
// AppConfig interface:
discord: {
    enabled: boolean;
    botToken?: string;
};

// envSchema:
ENABLE_DISCORD: envBoolean.optional().default(false),
DISCORD_BOT_TOKEN: z.string().optional(),

// createConfig():
discord: {
    enabled: parsed.ENABLE_DISCORD,
    ...(parsed.DISCORD_BOT_TOKEN ? { botToken: parsed.DISCORD_BOT_TOKEN } : {}),
},
```

4. **Register in composition root** (`src/app/create-application.ts`):

```typescript
if (config.channels.discord.enabled) {
    channels.push(new DiscordChannelAdapter({ config, logger, orchestrator }));
}
```

5. **Add `perChannel` entries** for every tool in `src/config/index.ts`:

```typescript
// In every tool's perChannel:
perChannel: {
    terminal: true,
    http: true,
    telegram: true,
    discord: true,   // <-- add for each tool
},
```

6. **Add formatting** in `src/utils/channel-formatting.ts` (optional but recommended).

---

## Adding a New Model Provider

1. **Implement `ModelProvider`** from `src/models/contracts.ts`:

```typescript
export class MyProvider implements ModelProvider {
    readonly kind: ProviderKind = "my-provider";

    isConfigured(): boolean { /* ... */ }
    getHealth(): ProviderHealth { /* ... */ }
    async generate(invocation: ModelInvocation, model: string): Promise<ModelResult> { /* ... */ }
}
```

2. **Add to `ProviderKind`** in `src/types/core.ts`:

```typescript
export type ProviderKind = "local" | "openai" | "openrouter" | "my-provider";
```

3. **Register** in `ModelProviderRegistry` constructor (`src/models/registry.ts`).

4. **Add config** in `src/config/index.ts` (API keys, etc.).

---

## Editing the Config System

All config lives in `src/config/index.ts`. The pattern is:

1. **`AppConfig` interface** — TypeScript type for the config object
2. **`envSchema`** — Zod schema that validates + transforms env vars
3. **`createConfig()`** — Maps parsed env vars into the `AppConfig` structure

### Adding a new env variable

```typescript
// 1. Add to AppConfig:
myFeature: {
    enabled: boolean;
    threshold: number;
};

// 2. Add to envSchema:
ENABLE_MY_FEATURE: envBoolean.optional().default(false),
MY_FEATURE_THRESHOLD: z.coerce.number().min(0).max(100).default(50),

// 3. Add to createConfig() return:
myFeature: {
    enabled: parsed.ENABLE_MY_FEATURE,
    threshold: parsed.MY_FEATURE_THRESHOLD,
},

// 4. Add to .env.example:
ENABLE_MY_FEATURE=false
MY_FEATURE_THRESHOLD=50
```

### Boolean env vars

The config system handles flexible boolean parsing. All of these work:
- `true`, `1`, `yes`, `y`, `on` → `true`
- `false`, `0`, `no`, `n`, `off` → `false`

Use `envBoolean` for any boolean env var:

```typescript
MY_TOGGLE: envBoolean.optional().default(false),
```

---

## Working with Persistence

### Repository interfaces (`src/db/contracts.ts`)

| Repository | Methods |
|------------|---------|
| `ConversationRepository` | `ensureConversation`, `getConversation`, `appendMessage`, `countMessages`, `listRecentMessages`, `listMessages`, `saveSummary`, `getLatestSummary` |
| `RunRepository` | `create`, `complete` |
| `MemoryRepository` | `save`, `listByUser`, `touch` |

### Adding a new repository method

1. Add the method to the interface in `src/db/contracts.ts`
2. Implement in `src/db/in-memory.ts` (Map-based)
3. Implement in `src/db/postgres/persistence.ts` (SQL)
4. Use it from the orchestrator or any service

### Switching persistence drivers

```bash
# In-memory (default, no setup needed)
PERSISTENCE_DRIVER=memory

# PostgreSQL (requires DATABASE_URL)
PERSISTENCE_DRIVER=postgres
DATABASE_URL=postgresql://postgres:password@localhost:5432/jarvis
```

The Postgres driver auto-creates the database and runs migrations on startup.

---

## Working with Memory

The memory service (`src/memory/service.ts`) handles two flows:

### Retrieval — `retrieveContext()`
- Fetches conversation summary + user memories
- Ranks by keyword overlap + kind boost (preference > fact > episode > summary)
- Returns top N entries (configurable via `MEMORY_RETRIEVAL_LIMIT`)

### Capture — `captureTurn()`
- Extracts facts/preferences from user messages via regex
- Patterns: "remember that X", "I prefer X", "my name is X", "call me X"
- Skips sensitive messages (API keys, tokens, passwords)
- Deduplicates against existing memories

### Adding a new memory extraction pattern

In `src/memory/service.ts`, find the extraction regex patterns in `captureTurn()` and add yours:

```typescript
// Example: detect "I work at X"
const workMatch = message.match(/\bi\s+work\s+at\s+(.+?)(?:\.|$)/i);
if (workMatch?.[1]) {
    candidates.push({
        kind: "fact",
        content: `Works at ${workMatch[1].trim()}`,
        confidence: 0.9,
    });
}
```

---

## Working with the Agent System

### Editing the system prompt

The system prompt is built in `src/agents/jarvis/index.ts` in the `prepareInvocation()` method. It's composed of sections:

1. **Identity** — personality and guidelines
2. **Channel awareness** — adapts to terminal/http/telegram
3. **Formatting instructions** — per-channel output rules
4. **Tool instructions** — available tools and usage
5. **Conversation summary** — if available
6. **Memory context** — relevant memories
7. **Tool results** — from current turn's pre-model tools

To modify the personality, edit the identity section. To add new context sections, add them in `prepareInvocation()`.

### Adding a new agent

1. Implement the `AssistantAgent` interface (see `src/agents/jarvis/index.ts`)
2. Register it in `AgentRegistry` (`src/agents/registry/index.ts`)
3. The registry currently supports one primary agent — extend `getPrimary()` or add agent selection logic

---

## Frontend (Web UI)

The frontend is a separate Vite + React app in `web/`.

### Running the frontend

```bash
# Run both backend + frontend together
npm run dev:all

# Or separately:
npm run dev          # Backend on port 3000
npm run dev:web      # Frontend on port 5173
```

### Frontend structure

```
web/src/
├── App.tsx                     # Root component
├── index.css                   # Tailwind theme + animations
├── stores/chat-store.ts        # Zustand global state
├── api/client.ts               # HTTP + SSE API client
├── types/api.ts                # TypeScript interfaces
├── components/
│   ├── layout/                 # AppLayout, Sidebar, ChatHeader
│   ├── chat/                   # MessageArea, ChatInput, MessageBubble, etc.
│   ├── controls/               # ModelSelector, WebSearchToggle
│   ├── conversation/           # ConversationList, ConversationItem
│   ├── status/                 # HealthIndicator, ConnectionBanner
│   └── details/                # ToolCallSection, MemorySection, TokenUsageBadge
├── hooks/                      # useHealthPoll, useMobile, useAutoScroll, etc.
└── lib/utils.ts                # cn(), formatRelativeTime(), formatTokenCount()
```

### Adding a new UI feature

1. **State** → Add to Zustand store in `src/stores/chat-store.ts`
2. **API call** → Add to `src/api/client.ts`
3. **Component** → Create in the appropriate `components/` subdirectory
4. **Wire up** → Import and use in the relevant layout component

### API endpoints the frontend uses

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/health` | GET | Connection monitoring (30s poll) |
| `/models` | GET | Model selector dropdown |
| `/chat/stream` | POST | Send message (SSE response) |
| `/conversations/:id` | GET | Load conversation |
| `/conversations/:id/messages` | GET | Load conversation history |

---

## Testing

```bash
# Run all tests
npm test

# Tests use Node's built-in test runner
# Test files: src/tests/*.test.ts
```

### Writing tests for tools

```typescript
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

describe("MyTool", () => {
    it("should execute with valid args", async () => {
        const tool = new MyTool({ config: testConfig, logger: testLogger });
        const result = await tool.execute("//my-tool test-arg");
        assert.equal(result.success, true);
        assert.ok(result.output.includes("test-arg"));
    });

    it("should return error for missing args", async () => {
        const tool = new MyTool({ config: testConfig, logger: testLogger });
        const result = await tool.execute("//my-tool");
        assert.equal(result.success, false);
    });
});
```

For HTTP tools, stub `globalThis.fetch`:

```typescript
const originalFetch = globalThis.fetch;
before(() => {
    globalThis.fetch = async () => new Response(JSON.stringify({ data: "test" }));
});
after(() => {
    globalThis.fetch = originalFetch;
});
```

---

## Conventions and Patterns

### Naming

| What | Convention | Example |
|------|-----------|---------|
| Files | kebab-case | `web-search.ts` |
| Classes | PascalCase | `WebSearchTool` |
| Config keys | camelCase | `config.tools.webSearch` |
| Tool names (in `ToolCallRecord`) | kebab-case | `"web-search"` |
| IDs | `prefix_uuid` | `msg_a1b2c3d4-...` |
| Env vars | UPPER_SNAKE_CASE | `ENABLE_WEB_SEARCH` |

### Dependency injection

Every class takes a `*Dependencies` interface in its constructor. No DI container — everything is manually wired in `src/app/create-application.ts`.

```typescript
interface MyServiceDependencies {
    config: AppConfig;
    logger: Logger;
}

export class MyService {
    constructor(private readonly deps: MyServiceDependencies) {}
}
```

### Scaffold markers

Files use `// tool-scaffold:insert:*` comments as injection points:

```typescript
// tool-scaffold:insert:import     — new import statements
// tool-scaffold:insert:field      — new class fields
// tool-scaffold:insert:ctor       — constructor initializations
// tool-scaffold:insert:command-tool — commandTools array entries
// tool-scaffold:insert:pre-model  — pre-model tool blocks
// tool-scaffold:insert:tools-type — AppConfig type fields
// tool-scaffold:insert:env        — envSchema entries
// tool-scaffold:insert:tools-value — createConfig() values
```

**Do not remove these markers** — they are needed for the scaffold script.

### Error handling

- Tools return `{ success: false, output: "error message" }` — never throw
- Orchestrator catches errors, marks runs as `failed`, re-throws to channel
- Channels handle errors per their protocol (HTTP 500, Telegram retry, terminal print)

### Safety

- Tool output must never contain secrets (API keys, tokens, passwords)
- Memory capture skips messages matching sensitive patterns
- Tool router validates against an allowlist of tool names
- Database names are sanitized (alphanumeric + underscore only)

---

## Common Tasks Cheat Sheet

| Task | How |
|------|-----|
| **Add a new tool** | `npm run tool:new -- my-tool` |
| **Enable a tool** | Set `ENABLE_MY_TOOL=true` in `.env` |
| **Disable a tool** | Set `ENABLE_MY_TOOL=false` in `.env` |
| **Change the default LLM** | Set `DEFAULT_PROVIDER` and `DEFAULT_MODEL` in `.env` |
| **Add an API key** | Set `OPENAI_API_KEY` or `OPENROUTER_API_KEY` in `.env` |
| **Switch to Postgres** | Set `PERSISTENCE_DRIVER=postgres` and `DATABASE_URL` in `.env` |
| **Run the full stack** | `npm run dev:all` |
| **Run backend only** | `npm run dev` |
| **Run frontend only** | `npm run dev:web` |
| **Build everything** | `npm run build:all` |
| **Run tests** | `npm test` |
| **Change the port** | Set `PORT=3001` in `.env` |
| **Enable Telegram** | Set `ENABLE_TELEGRAM=true` and `TELEGRAM_BOT_TOKEN` in `.env` |
| **Adjust memory** | `MEMORY_RETRIEVAL_LIMIT`, `MEMORY_SUMMARY_TRIGGER_MESSAGES` |
| **Set log level** | `LOG_LEVEL=debug` in `.env` |
