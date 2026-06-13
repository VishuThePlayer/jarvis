# Jarvis

Jarvis is a TypeScript assistant runtime. It accepts requests from terminal, HTTP, and Telegram, decides whether a safe tool should run, calls an OpenAI-compatible model when needed, persists conversation state, and attaches long-term memory.

This repository is the backend runtime only. There is no first-party web frontend in this codebase.

## What This Repo Is

- A multi-channel assistant runtime.
- A single-orchestrator architecture with shared behavior across channels.
- A backend that supports in-memory or Postgres persistence.
- A tool-driven system with exact commands, AI-based command routing, and pre-model enrichment.
- A task automation runtime for scheduled reminders and recurring AI prompt jobs.
- A codebase meant to be understandable by one developer reading the source from top to bottom.

## What This Repo Is Not

- Not a frontend app.
- Not a general plugin marketplace.
- Not a multi-agent platform with autonomous background workers.
- Not a framework for arbitrary unsafe system automation.
- Not a source-of-truth for generated `dist/` output. Source lives in `src/`.

## Read This First

If you are new to the project, read the docs in this order:

1. [Codebase Handbook](./docs/CODEBASE-HANDBOOK.md)
2. [Tools And Routing](./docs/TOOLS-AND-ROUTING.md)
3. [Operations](./docs/OPERATIONS.md)

That order matches how the runtime is structured:

1. overall architecture
2. tool behavior and routing
3. setup, configuration, and runbook concerns

## Quick Start

1. Install dependencies with `npm install`.
2. Copy `jarvis.config.example.json` to `jarvis.config.json`, or run `npm run setup`.
3. Add `OPENAI_API_KEY` through `jarvis.config.json` or `.env`.
4. Optional: enable Postgres with `PERSISTENCE_DRIVER=postgres` and `DATABASE_URL=...`.
5. Optional: enable Zep-backed memory with `MEMORY_BACKEND=zep` and `ZEP_API_KEY=...`.
6. Build with `npm run build`.
7. Start with `npm start`.

## Daily Commands

| Command | Purpose |
| --- | --- |
| `npm run build` | Compile `src/` into `dist/`. |
| `npm start` | Run the compiled runtime. |
| `npm run dev` | Watch TypeScript and restart the runtime after successful rebuilds. |
| `npm test` | Build and run the current test suite. |
| `npm run setup` | Run the interactive setup wizard and write `jarvis.config.json`. |
| `npm run tool:new -- <tool-id>` | Scaffold a new tool and update the tool registration markers. |

## Runtime Surface

Enabled channels share one orchestrator:

- terminal REPL
- HTTP API
- Telegram bot

Current HTTP endpoints:

- `GET /health`
- `GET /models`
- `POST /chat`
- `POST /chat/stream`
- `GET /conversations/:id`
- `GET /conversations/:id/messages`
- `GET /automations`
- `GET /automations/:id/runs`
- `DELETE /automations/:id`

## Architecture At A Glance

The request path is intentionally linear:

1. a channel adapter builds a `UserRequest`
2. `JarvisOrchestrator` creates or resumes a conversation run
3. exact command tools get first chance
4. `ToolRouter` may select one command tool through the fast model
5. if no command tool handles the turn, pre-model tools run
6. `JarvisAgent` builds the main prompt with memory and current-turn tool results
7. `ModelProviderRegistry` calls the chosen model provider
8. the assistant message, run state, and memory updates are persisted

Automation runs beside the request path. `AutomationService` polls due tasks, stores run history, emits terminal notifications, and uses the orchestrator for recurring prompt jobs.

## Repo Map

| Path | Why it exists |
| --- | --- |
| `src/index.ts` | Process entrypoint, setup trigger, config-file env application, signal handling. |
| `src/app/create-runtime.ts` | Composition root for the whole runtime. |
| `src/automation/` | Scheduled reminder and recurring prompt job service. |
| `src/orchestrator/` | Central request lifecycle and streaming lifecycle. |
| `src/channels/` | Terminal and Telegram adapters plus shared channel contract. |
| `src/server/` | HTTP adapter. |
| `src/tools/` | Command tools, pre-model tools, registry, and router. |
| `src/agents/` | Prompt builders for the assistant and tool-result formatter. |
| `src/models/` | Model provider contracts, registry, and OpenAI-compatible implementation. |
| `src/memory/` | Memory backend selection and memory provider implementations. |
| `src/db/` | Storage contracts plus in-memory and Postgres implementations. |
| `src/config/` | Runtime config schema and config-file schema. |
| `src/setup/` | Interactive setup flow and config-file bootstrap logic. |
| `src/utils/` | Narrow stateless helpers. |
| `src/tests/` | Integration-style tests over the real runtime stack. |
| `docs/` | Owner docs and onboarding docs. |

## Documentation Rules

When code changes, update docs in the same change if the behavior or ownership changed.

Use these rules:

- Update [Codebase Handbook](./docs/CODEBASE-HANDBOOK.md) when control flow, module boundaries, or architecture changes.
- Update [Tools And Routing](./docs/TOOLS-AND-ROUTING.md) when a tool, tool contract, router rule, or formatter behavior changes.
- Update [Operations](./docs/OPERATIONS.md) when config, secrets, persistence, startup, or deployment behavior changes.
- Treat the source code as the final authority. Docs must describe what the code does now, not what it did two refactors ago.
