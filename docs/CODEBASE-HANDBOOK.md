# Codebase Handbook

This is the primary technical reference for the Jarvis codebase. It is written for a new developer who needs to understand how the runtime is structured, which module owns what, and where to make changes safely.

Read this document before changing architecture, request flow, tools, memory, or persistence.

## 1. What Jarvis Actually Is

Jarvis is a backend assistant runtime with a single orchestrator and multiple channel adapters.

The runtime accepts a `UserRequest`, decides whether to:

1. run a command tool directly
2. route a command tool through the fast model
3. continue into the main assistant model path

After that, it persists the turn and optionally updates long-term memory.

Important boundaries:

- Jarvis is backend-only in this repository.
- HTTP is an API surface, not a bundled frontend.
- Channels are transport adapters, not separate products.
- Tools are not allowed to own orchestration.
- Agents build prompts; they do not call providers directly.
- Persistence adapters store data; they do not make product decisions.

## 2. How To Read The Codebase

If you want the shortest accurate path through the source, read files in this order:

1. `src/index.ts`
2. `src/app/create-runtime.ts`
3. `src/orchestrator/index.ts`
4. `src/agents/jarvis/index.ts`
5. `src/tools/registry.ts`
6. `src/tools/tool-router.ts`
7. `src/automation/service.ts`
8. `src/memory/service.ts`
9. `src/models/registry.ts`
10. `src/server/http-server.ts`
11. `src/channels/terminal/index.ts`
12. `src/channels/telegram/index.ts`

That path takes you from process boot, to object graph construction, to the main request lifecycle, then into the major subsystems.

## 3. Repository Layout

### Top Level

| Path | Purpose |
| --- | --- |
| `README.md` | Project overview and doc map. |
| `docs/` | Source-of-truth project documentation. |
| `src/` | All runtime source code. |
| `db/` | SQL helpers and Postgres support files. |
| `scripts/` | Tool scaffolding and repo utility scripts. |
| `dist/` | Build output. Not source of truth. |
| `jarvis.config.example.json` | Safe example config file. |
| `.env.example` | Safe example environment variables. |

### `src/`

| Path | Owns | Does not own |
| --- | --- | --- |
| `src/index.ts` | process startup and shutdown | runtime composition details |
| `src/app/` | object graph assembly | request handling |
| `src/automation/` | scheduled reminders, recurring prompt jobs, task notifications | transport parsing |
| `src/agents/` | prompt construction | transport, persistence, provider calls |
| `src/channels/` | terminal and Telegram request adaptation | business logic |
| `src/server/` | HTTP request adaptation | conversational reasoning |
| `src/orchestrator/` | end-to-end request control flow | provider HTTP details |
| `src/config/` | config schema and parsing | setup UI or orchestration |
| `src/setup/` | interactive setup and config-file bootstrapping | runtime decision-making |
| `src/models/` | provider access, slot selection, model listing | tool routing policy or prompt content |
| `src/tools/` | tool contracts, command tool registry, router, tool implementations | cross-turn persistence logic |
| `src/memory/` | memory backend selection and memory providers | transport handling |
| `src/db/` | storage contracts and adapters | prompt logic or request routing |
| `src/observability/` | logging | metrics backend or tracing |
| `src/utils/` | small stateless helpers | product policy |
| `src/tests/` | integration-style verification | runtime behavior itself |
| `src/types/` | shared core runtime types | implementation |
| `src/skills/` | formatter-only skill hints | main conversation logic |

## 4. Boot Sequence

### `src/index.ts`

Startup order is:

1. load `.env` through `dotenv/config`
2. call `runSetupIfNeeded()`
3. call `applyConfigFileToEnv()`
4. import `createRuntime()`
5. create the runtime
6. register `SIGINT`, `SIGTERM`, `unhandledRejection`, and `uncaughtException` handlers
7. start the runtime

Why this matters:

- `jarvis.config.json` is optional and local-only
- environment variables always win over config-file values
- the runtime is only composed after config sources have been normalized

### Setup Bootstrapping

`src/setup/index.ts` does two separate jobs:

- `runSetupIfNeeded()` creates `jarvis.config.json` if missing or when `--setup` is passed
- `applyConfigFileToEnv()` maps config-file values into `process.env` only when an env var is still unset

This separation is intentional. Setup owns local configuration bootstrap, not runtime configuration policy.

## 5. Composition Root

### `src/app/create-runtime.ts`

This file is the composition root. It wires the runtime in one place so the rest of the code can stay dependency-injected and testable.

Current assembly order:

1. `createConfig(process.env)`
2. `Logger`
3. persistence adapter
4. `ModelProviderRegistry`
5. `MemoryService`
6. `AutomationService`
7. `ToolRegistry`
8. `ToolRouter`
9. `AgentRegistry`
10. `JarvisOrchestrator`
11. enabled channel adapters

The current dependency shape is:

```text
config
  -> logger
  -> persistence
  -> models
  -> memory
  -> automation
  -> tools
  -> tool router
  -> agents
  -> orchestrator
  -> channels
```

Important ownership rule:

- `create-runtime.ts` should assemble objects, not hide runtime logic.

If business logic starts accumulating there, it belongs somewhere else.

## 6. Core Data Model

These types live in `src/types/core.ts` and are the shared language of the runtime.

### Requests and Responses

- `UserRequest`: normalized input from any channel
- `AssistantResponse`: normalized output from the orchestrator
- `StreamEvent`: streaming event envelope for progress, deltas, final response, and errors

### Conversation State

- `ConversationRecord`
- `MessageRecord`
- `RunRecord`

### Automation State

- `AutomationTask`: scheduled reminder or recurring prompt job
- `AutomationRun`: persisted execution result for a task

### Tools

- `ToolCallInput`
- `ToolCallRecord`
- `ToolCallSource`

### Models

- `ModelInvocation`
- `ModelResult`
- `ToolCallResult`
- `ToolParameterDefinition`

### Memory

- `MemoryEntry`
- `ConversationSummary`

If you change these types, you are changing multiple layers at once. Update docs and tests in the same change.

## 7. End-To-End Request Lifecycle

The orchestrator is the center of the runtime.

### Entry Point

All channels eventually call one of:

- `JarvisOrchestrator.handleRequest(...)`
- `JarvisOrchestrator.handleRequestStream(...)`

The non-streaming and streaming paths share the same business flow. The streaming version just exposes progress and token deltas as they happen.

### Step 1: `initRun`

`initRun` does the minimum work required to turn an incoming request into a tracked run:

- ensure a conversation exists
- resolve the model plan
- create a run id and save a `RunRecord`
- append the user message to conversation history

What `initRun` does not do:

- it does not retrieve memory
- it does not run tools
- it does not call the model

### Step 2: `handleCommandToolPath`

This is the fast path.

The sequence is:

1. ask `ToolRegistry.matchDirectCommand(...)`
2. if no exact command matches, ask `ToolRouter.routeCommandTool(...)`
3. if the router asks a clarification question, end the turn early
4. if a tool is selected, execute it and skip the normal assistant path

Important distinctions:

- exact command matching is strict and local
- routed tool selection is AI-assisted and uses recent conversation context
- the router does not execute tools
- the registry does not decide natural-language intent

### Step 3: Command Tool Execution

If a command tool is selected:

1. `ToolRegistry.executeSelectedCommandTool(...)` runs the tool
2. tool output is stored as a `tool` message
3. `ToolResultFormatterAgent` turns raw tool output into a user-facing answer
4. the formatted assistant reply is stored with model id `jarvis-command`
5. the run completes without calling the main assistant model

This is why command tools can return strict, structured output without worrying about final prose quality.

### Step 4: `buildModelContext`

If no command tool ends the turn, the normal assistant path begins.

`buildModelContext` does four things:

1. retrieve memory context
2. run pre-model tools
3. persist pre-model tool output
4. load recent history and ask `JarvisAgent` to build a `ModelInvocation`

### Step 5: `handleModelPath`

The main model path:

1. call `ModelProviderRegistry.generate(...)`
2. create the assistant message
3. persist the assistant message
4. capture memory from the completed turn
5. mark the run complete

### Step 6: Streaming Path

`handleRequestStream` mirrors the same logic but yields:

- progress events
- streaming token deltas
- one final response event
- one done event

The streaming path is not a separate architecture. It is the same architecture with incremental output.

## 8. Module Ownership Matrix

This is the most important section for a new developer.

### `src/orchestrator/index.ts`

Owns:

- request lifecycle
- branch selection between command tool path and model path
- persistence timing
- streaming event order

Does not own:

- tool-specific parsing
- prompt wording
- provider HTTP calls
- channel-specific input parsing

### `src/agents/jarvis/index.ts`

Owns:

- the main assistant system prompt
- how memory, tool results, and history are injected into the model input
- channel-aware formatting guidance

Does not own:

- model choice
- provider access
- tool routing
- persistence

### `src/agents/tool-result-formatter/index.ts`

Owns:

- post-tool answer formatting
- selection of brief, steps, or analysis profiles
- loading and using `src/skills/*.md` as formatter hints

Does not own:

- tool execution
- command routing
- main assistant conversation behavior

### `src/tools/registry.ts`

Owns:

- tool inventory
- command tool order
- exact command matching
- running selected tools
- running pre-model tools

Does not own:

- AI routing between tools
- channel behavior
- memory storage implementation

### `src/tools/tool-router.ts`

Owns:

- AI-assisted command-tool selection
- clarification routing
- use of recent conversation for reference resolution

Does not own:

- actual tool execution
- tool output formatting
- persistence

### `src/memory/service.ts`

Owns:

- memory backend selection
- uniform memory API used by the rest of the app
- sensitive-text guard before capture

Does not own:

- SQL persistence
- Zep HTTP implementation details
- prompt construction

### `src/memory/local-provider.ts`

Owns:

- local memory retrieval
- local auto-store extraction
- local dedupe and ranking
- local summary generation

Does not own:

- backend selection
- channel logic
- tool routing

### `src/memory/zep-provider.ts`

Owns:

- Zep-backed memory retrieval
- Zep turn ingestion
- Zep graph lookup
- graceful fallback to local memory

Does not own:

- env parsing
- tool messages
- conversation transport

### `src/models/registry.ts`

Owns:

- provider health reporting
- model listing
- request-level model override parsing
- slot selection for fast/default/reasoning
- delegation to the provider implementation

Does not own:

- system prompts
- channel formatting
- routing policy beyond model slot resolution

### `src/models/providers/openai.ts`

Owns:

- OpenAI-compatible HTTP calls
- retries and request timeout behavior
- streaming chat completion parsing
- embedding API calls

Does not own:

- business logic
- tool semantics
- memory policy

### `src/channels/*` and `src/server/http-server.ts`

Own:

- transport-specific input parsing
- transport-specific output formatting
- transport-specific auth or progress presentation

Do not own:

- reasoning policy
- memory policy
- tool routing

### `src/db/*`

Own:

- repository contracts
- in-memory storage behavior
- Postgres schema setup and queries

Do not own:

- runtime behavior
- prompt content
- request routing

## 9. Channels

### HTTP: `src/server/http-server.ts`

Responsibilities:

- Express app lifecycle
- optional bearer auth through `API_KEY`
- CORS for one allowed origin
- request validation and message-length checks
- per-user sliding-window rate limiting
- SSE streaming on `/chat/stream`

Notable behavior:

- `userId` defaults to `config.app.defaultUserId` if omitted
- `allowWebSearch` and `preferWebSearch` are passed through metadata
- the HTTP adapter does not parse commands itself; it passes raw message text through

### Terminal: `src/channels/terminal/index.ts`

Responsibilities:

- local REPL loop
- `/new`, `/models`, `/model`, `/search`, `/exit`
- rendering progress events
- rendering tool activity previews

Notable behavior:

- it keeps one current `conversationId` until `/new`
- `/search` does not call a separate endpoint; it sets metadata so web search is allowed for that turn

### Telegram: `src/channels/telegram/index.ts`

Responsibilities:

- long-poll update loop
- startup webhook clearing
- bot identity lookup
- group mention filtering
- progress message editing
- Telegram HTML fallback logic

Notable behavior:

- Telegram `conversationId` is scoped to `telegram:<chat.id>`
- Telegram `userId` is scoped to `telegram:<from.id>`
- attachments are acknowledged but text and caption handling are the main supported flow today

## 10. Configuration Model

Two config layers feed the runtime:

1. environment variables
2. `jarvis.config.json`

Precedence is:

1. environment variables
2. `jarvis.config.json`
3. defaults in `src/config/index.ts`

### Runtime Config Source Of Truth

- `src/config/index.ts` defines runtime config shape and env parsing
- `src/config/config-file.ts` defines config-file shape and mapping into env overrides

### Important Config Groups

- `app`
- `http`
- `channels`
- `providers`
- `models`
- `orchestrator`
- `tools`
- `memory`
- `persistence`

### Compatibility Note

`WEB_APP_ORIGIN` is still accepted as a compatibility alias, but the canonical setting is `HTTP_ALLOWED_ORIGIN`.

## 11. Model Layer

### `src/models/registry.ts`

Today there is one provider implementation: `OpenAIModelProvider`.

The registry still matters because it centralizes:

- model slot resolution
- provider health
- request-level explicit model overrides
- generation
- streaming generation
- embedding calls

### Current Slot Selection

Current slot selection is intentionally simple:

- reasoning-like prompts prefer the reasoning model
- short prompts prefer the fast model
- everything else uses the default model

This heuristic is not supposed to be magical. It is just a lightweight default.

## 12. Memory Layer

### Overview

`src/memory/service.ts` provides one API to the rest of the runtime while hiding which backend is active.

Current backends:

- local provider
- Zep-backed provider

### Local Memory Provider

`src/memory/local-provider.ts`

Responsibilities:

- retrieve ranked local memories
- optionally use embeddings if pgvector is enabled and supported
- auto-extract simple memory candidates from user text
- dedupe repeated saves
- update conversation summaries locally

Tradeoff:

- simple and local
- limited semantic intelligence

### Zep Memory Provider

`src/memory/zep-provider.ts`

Responsibilities:

- create or ensure Zep user and session scope
- ingest completed turns into Zep memory
- retrieve Zep context blocks and summaries
- search graph memory
- mirror explicit saves and lookups through the local fallback so immediate recall still works

Tradeoff:

- better long-term memory structure
- external dependency and network dependency

### Important Rule

The rest of the runtime should talk to `MemoryService`, not directly to local or Zep providers.

## 13. Persistence Layer

### Contracts

`src/db/contracts.ts` defines repository contracts for:

- conversations
- runs
- memories

### In-Memory Adapter

`src/db/in-memory.ts`

Use it for:

- tests
- local experiments
- zero-setup development

### Postgres Adapter

`src/db/postgres/persistence.ts`

Responsibilities:

- ensure database exists
- migrate schema
- optionally enable pgvector
- implement repository queries

Important note:

- Postgres is the durable system of record for local conversation data
- it is not the same thing as the optional Zep memory backend

## 14. Tool System

This handbook only gives the architecture summary. The full tool guide is in `docs/TOOLS-AND-ROUTING.md`.

At a high level:

- command tools can end the turn early
- pre-model tools add context before the normal model call
- the router can select one command tool through structured tool calling
- the formatter turns raw tool output into user-facing prose

Current built-in command tools:

- `time`
- `memory-saving`
- `memory-lookup`
- `ps-process`
- `ps-service`
- `ps-file`
- `ps-network`
- `ps-system`
- `ps-script`
- `ps-search`
- `ps-folder`
- `ps-app`

Current pre-model tool:

- `web-search`

## 15. Utility Layer

`src/utils/` should stay small and boring.

Good uses:

- id generation
- error normalization
- direct-command parsing
- text tokenization and ranking helpers
- tool input formatting
- channel-formatting helpers

Bad uses:

- hidden orchestration
- hidden runtime policy
- cross-module behavior that should live in a proper service

If a helper starts accumulating domain behavior, move it into a named module.

## 16. Testing Strategy

Tests in `src/tests/` are integration-style tests over the real runtime stack, usually with in-memory persistence.

Current testing goals:

- config defaults remain stable
- HTTP contract remains stable
- command tools still short-circuit when expected
- tool router behavior stays deterministic under mocked model outputs
- memory backend behavior stays safe and understandable

### Shared Test Entry

`src/tests/helpers.ts` builds a real stack with:

- config
- logger
- in-memory persistence
- models
- memory service
- agents
- tools
- router
- orchestrator

That file is the main place to update when constructor wiring changes.

## 17. Common Change Scenarios

### Add a new command tool

Touch at least:

- `src/tools/<tool>.ts`
- `src/tools/registry.ts`
- `src/config/index.ts`
- `.env.example`
- tests
- `docs/TOOLS-AND-ROUTING.md`

### Add a new pre-model tool

Touch at least:

- the tool implementation
- `src/tools/registry.ts`
- config if toggleable
- tests
- docs

### Change request flow

Touch at least:

- `src/orchestrator/index.ts`
- `docs/CODEBASE-HANDBOOK.md`
- relevant tests

### Change memory behavior

Touch at least:

- `src/memory/*`
- tools that call memory
- memory tests
- operations doc if config changed

### Add a new channel

Touch at least:

- `src/channels/`
- `src/types/core.ts`
- `src/config/index.ts`
- `src/app/create-runtime.ts`
- channel-specific tests
- docs

## 18. Common Mistakes To Avoid

- Do not put runtime logic in channel adapters.
- Do not let tools write conversation messages directly.
- Do not let the router execute tools directly.
- Do not call provider HTTP APIs from agents.
- Do not bypass `MemoryService` from tool implementations.
- Do not update config shape in one place and forget the other schema file.
- Do not treat `dist/` as editable source.
- Do not describe future architecture in docs as if it already shipped.

## 19. Documentation Maintenance Rules

When the source changes, keep these docs aligned:

- if request lifecycle changes, update this handbook
- if tool contract or routing behavior changes, update `TOOLS-AND-ROUTING.md`
- if config or operational behavior changes, update `OPERATIONS.md`

The goal is simple: a new developer should be able to read the docs and then open the source without discovering a different architecture than the one we documented here.
