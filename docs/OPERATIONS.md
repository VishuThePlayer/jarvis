# Operations

This document covers setup, configuration precedence, secrets, runtime modes, persistence, memory backends, and day-to-day operational concerns.

Use this document when you need to run Jarvis, debug startup, or understand which config knob controls which behavior.

## 1. Configuration Precedence

Jarvis merges configuration from three sources:

1. environment variables
2. `jarvis.config.json`
3. hardcoded defaults in `src/config/index.ts`

Actual behavior:

- `src/setup/index.ts` loads `jarvis.config.json`
- config-file values are copied into `process.env` only when the matching env var is currently missing
- `createConfig(process.env)` then parses the final env view

Operational consequence:

- environment variables always win
- `jarvis.config.json` is a convenience layer for local machines
- code defaults are the last fallback only

## 2. Local Setup Options

### Option A: Interactive Setup

Run:

```bash
npm run setup
```

This creates or overwrites `jarvis.config.json`.

Use this when:

- bootstrapping a new local machine
- handing the repo to a developer who prefers guided setup

### Option B: Manual Config File

Copy:

- `jarvis.config.example.json` -> `jarvis.config.json`

Then fill in secrets and machine-specific values.

Use this when:

- you want reproducible local setup
- you want to review config shape directly

### Option C: Env-Only Setup

Use `.env` or shell environment variables without `jarvis.config.json`.

Use this when:

- running in CI
- deploying to a server
- using container-based configuration

## 3. Secrets Policy

Do not commit:

- `.env`
- `jarvis.config.json`
- `OPENAI_API_KEY`
- `ZEP_API_KEY`
- `TELEGRAM_BOT_TOKEN`
- `API_KEY`
- live `DATABASE_URL` values

Files intended to stay safe in git:

- `.env.example`
- `jarvis.config.example.json`

Operational rule:

- examples must stay secret-free
- local real config stays local

## 4. Runtime Config Groups

`src/config/index.ts` exposes these runtime groups:

- `app`
- `http`
- `channels`
- `providers`
- `models`
- `orchestrator`
- `tools`
- `automation`
- `memory`
- `persistence`

If you add a new config field, update:

1. `src/config/index.ts`
2. `src/config/config-file.ts`
3. `.env.example`
4. `jarvis.config.example.json` if relevant
5. docs

## 5. Core Environment Variables

### App

| Variable | Meaning |
| --- | --- |
| `APP_ENV` | Runtime environment label. |
| `LOG_LEVEL` | Logger threshold. |
| `PORT` | HTTP port. |
| `DEFAULT_USER_ID` | Fallback user id for channels that do not supply one. |
| `DEFAULT_TEMPERATURE` | Default chat temperature for main assistant calls. |
| `API_KEY` | Optional bearer token for HTTP auth. |
| `MAX_MESSAGE_LENGTH` | Request body message limit for HTTP. |
| `RATE_LIMIT_WINDOW_MS` | HTTP rate-limit window size. |
| `RATE_LIMIT_MAX_REQUESTS` | HTTP requests allowed per user per window. |

### HTTP

| Variable | Meaning |
| --- | --- |
| `HTTP_ALLOWED_ORIGIN` | Single allowed browser origin for CORS. |
| `WEB_APP_ORIGIN` | Deprecated compatibility alias for `HTTP_ALLOWED_ORIGIN`. |

### Channels

| Variable | Meaning |
| --- | --- |
| `ENABLE_HTTP` | Enable or disable HTTP server startup. |
| `ENABLE_TERMINAL` | Enable or disable terminal REPL startup. |
| `ENABLE_TELEGRAM` | Enable or disable Telegram polling. |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token. |
| `TELEGRAM_POLL_INTERVAL_MS` | Backoff or idle delay between poll attempts. |
| `TELEGRAM_LONG_POLL_TIMEOUT_SEC` | Telegram long-poll timeout. |

### Provider

| Variable | Meaning |
| --- | --- |
| `OPENAI_API_KEY` | OpenAI-compatible provider key. |
| `OPENAI_BASE_URL` | OpenAI-compatible API base URL. |
| `LLM_TIMEOUT_MS` | Provider request timeout. |
| `LLM_MAX_RETRIES` | Retry budget for retryable provider failures. |
| `ZEP_API_KEY` | Zep memory backend API key. |
| `ZEP_BASE_URL` | Zep API base URL. |

### Models

| Variable | Meaning |
| --- | --- |
| `DEFAULT_MODEL` | Main chat model. |
| `FAST_MODEL` | Fast model for router and formatter paths. |
| `REASONING_MODEL` | Reasoning-heavy model slot. |
| `EMBEDDING_MODEL` | Embedding model used by the OpenAI provider. |

### Orchestrator

| Variable | Meaning |
| --- | --- |
| `ORCHESTRATOR_HISTORY_MESSAGE_LIMIT` | Maximum recent messages loaded into the main prompt. |

### Tools

| Variable | Meaning |
| --- | --- |
| `ENABLE_WEB_SEARCH` | Enable pre-model web search tool. |
| `ALLOW_WEB_SEARCH_BY_DEFAULT` | Allow the web-search tool to auto-run on matching prompts. |
| `WEB_SEARCH_MAX_RESULTS` | Maximum number of web-search related topic results. |
| `ENABLE_TIME` | Enable the time command tool. |
| `ENABLE_TOOL_ROUTER` | Enable AI-assisted command tool routing. |
| `ENABLE_MEMORY_LOOKUP` | Enable memory save and memory lookup tools. |
| `ENABLE_POWERSHELL` | Enable PowerShell command tools. |
| `ENABLE_AUTOMATION` | Enable scheduled reminders and recurring prompt jobs. |
| `AUTOMATION_POLL_INTERVAL_MS` | Scheduler polling interval for due automation tasks. |
| `AUTOMATION_MAX_DUE_PER_TICK` | Maximum due tasks executed per scheduler tick. |

### Memory

| Variable | Meaning |
| --- | --- |
| `ENABLE_MEMORY` | Global memory enable flag. |
| `MEMORY_BACKEND` | `local` or `zep`. |
| `AUTO_STORE_MEMORY` | Enable memory capture after successful assistant turns. |
| `MEMORY_RETRIEVAL_LIMIT` | Max retrieved memory entries. |
| `MEMORY_SUMMARY_TRIGGER_MESSAGES` | Number of messages before local summary refresh. |

### Persistence

| Variable | Meaning |
| --- | --- |
| `PERSISTENCE_DRIVER` | `memory` or `postgres`. |
| `DATABASE_URL` | Postgres connection string. |
| `ENABLE_PGVECTOR` | Enable pgvector support in Postgres memory rows. |
| `PGVECTOR_DIMENSIONS` | Embedding vector size. |

## 6. Config File Shape

`jarvis.config.json` supports the same functional areas as env:

- `providers`
- `models`
- `agents`
- `channels`
- `http`
- `tools`
- `automation`
- `memory`
- `orchestrator`

Important limitation:

- the config file is a convenience format, not a separate configuration engine
- if an env var exists, it overrides the config file

## 7. Runtime Modes

### In-Memory Persistence

Set:

```bash
PERSISTENCE_DRIVER=memory
```

Use it for:

- tests
- quick local development
- stateless experiments

Characteristics:

- conversation data disappears on restart
- no Postgres dependency
- fastest setup

### Postgres Persistence

Set:

```bash
PERSISTENCE_DRIVER=postgres
DATABASE_URL=postgresql://postgres:password@localhost:5432/jarvis
```

Use it for:

- persistent conversations
- persistent local memory mirror
- durable run history
- durable automation tasks and automation run history

Characteristics:

- schema is created automatically
- the runtime attempts to create the database if it does not already exist
- startup fails early if `DATABASE_URL` is missing

## 8. pgvector Operation

Enable pgvector only when:

- persistence driver is `postgres`
- Postgres supports the `vector` extension
- you want embedding-assisted local memory retrieval

Set:

```bash
ENABLE_PGVECTOR=true
PGVECTOR_DIMENSIONS=1536
```

Operational effect:

- Postgres migration adds an `embedding` column to `memory_entries`
- local memory retrieval can combine keyword ranking with embedding similarity

If pgvector setup fails while enabled, startup fails loudly.

## 9. Memory Backend Operation

Persistence driver and memory backend are separate concerns.

### Local Memory Backend

Set:

```bash
MEMORY_BACKEND=local
```

Behavior:

- uses local persistence repositories
- supports explicit save and lookup
- supports local auto-store and local summaries
- supports embedding-assisted retrieval when pgvector is available

### Zep Memory Backend

Set:

```bash
MEMORY_BACKEND=zep
ZEP_API_KEY=...
```

Behavior:

- `MemoryService` selects `ZepMemoryProvider`
- turns are ingested into Zep
- context retrieval uses Zep session memory and graph search
- explicit saves and lookups still mirror through the local provider so the rest of the app stays stable

Fallback behavior:

- if `MEMORY_BACKEND=zep` but no `ZEP_API_KEY` exists, Jarvis logs a warning and falls back to local memory
- if Zep requests fail at runtime, provider calls fall back to local memory paths

## 10. Automation Operation

Enable with:

```bash
ENABLE_AUTOMATION=true
```

Supported commands:

- `remind submit assignment in 2h`
- `remind call mentor at 2026-05-08 18:00`
- `every 1d do summarize today's AI news`
- `tasks`
- `cancel task task_abc`

Operational notes:

- reminders complete once and store an automation run
- recurring prompt jobs call the normal orchestrator and then schedule the next interval
- Postgres persistence keeps tasks and run history across restarts
- terminal notifications are best-effort; task results remain stored even if terminal is not running

## 11. Channel Operations

### HTTP

Enable with:

```bash
ENABLE_HTTP=true
```

Operational notes:

- optional bearer auth uses `API_KEY`
- CORS allows exactly one configured origin
- rate limiting is in-process and per-user id
- `/chat/stream` uses SSE
- automation management endpoints are available at `/automations` and `/automations/:id/runs`

### Terminal

Enable with:

```bash
ENABLE_TERMINAL=true
```

Operational notes:

- only starts when stdin and stdout are TTYs
- useful for development and direct tool debugging
- supports `/new`, `/models`, `/model`, `/search`, `/exit`
- prints completed automation reminders and recurring job outputs while the terminal is running

### Telegram

Enable with:

```bash
ENABLE_TELEGRAM=true
TELEGRAM_BOT_TOKEN=...
```

Operational notes:

- uses long polling
- clears webhook on start
- fetches bot identity on start
- ignores most group messages unless the bot is addressed

## 12. Build, Run, and Verify

### Build

```bash
npm run build
```

### Start

```bash
npm start
```

### Watch Mode

```bash
npm run dev
```

### Tests

```bash
npm test
```

### Interactive Setup

```bash
npm run setup
```

## 13. Day-One Setup For A New Developer

Recommended sequence:

1. `npm install`
2. copy `jarvis.config.example.json` to `jarvis.config.json`
3. add `OPENAI_API_KEY`
4. keep `PERSISTENCE_DRIVER=memory` for the first run
5. run `npm test`
6. run `npm start`
7. verify `/health` or terminal startup

Do not start with Postgres, Telegram, and Zep all at once unless you are debugging those layers specifically.

## 14. Startup Checklist

Before expecting the runtime to work, verify:

- config source is correct
- `OPENAI_API_KEY` exists
- `PERSISTENCE_DRIVER` matches the intended environment
- `DATABASE_URL` exists if using Postgres
- `ZEP_API_KEY` exists if using `MEMORY_BACKEND=zep`
- `TELEGRAM_BOT_TOKEN` exists if Telegram is enabled

## 15. Shutdown Behavior

The process listens for:

- `SIGINT`
- `SIGTERM`

Normal shutdown:

- stops channels in reverse order
- stops persistence
- exits cleanly

Crash-path behavior:

- uncaught exceptions trigger runtime stop and exit
- unhandled promise rejections are logged

## 16. Troubleshooting By Symptom

### "Startup fails immediately"

Check:

- missing `OPENAI_API_KEY`
- missing `DATABASE_URL` with `PERSISTENCE_DRIVER=postgres`
- malformed env values
- invalid URLs in provider config

### "HTTP works but browser calls fail"

Check:

- `HTTP_ALLOWED_ORIGIN`
- `Authorization: Bearer <API_KEY>` if auth is enabled
- request body shape
- rate limits

### "Telegram bot is enabled but silent"

Check:

- valid `TELEGRAM_BOT_TOKEN`
- another process is not already polling
- group messages are actually addressing the bot
- logs for polling failures or `409` conflicts

### "Memory feels empty"

Check:

- `ENABLE_MEMORY=true`
- `AUTO_STORE_MEMORY=true`
- repeated requests use the same user id
- Postgres or local persistence is not being reset between runs
- for Zep mode, `ZEP_API_KEY` and `MEMORY_BACKEND=zep`

### "Zep mode is configured but behavior looks local"

Check:

- startup warnings about missing `ZEP_API_KEY`
- runtime warnings about Zep request failures
- whether local fallback is masking an external Zep outage

### "Command tools are not triggering"

Check:

- relevant `ENABLE_*` tool flag
- `ENABLE_TOOL_ROUTER` if you expect natural-language routing
- whether the message is an exact command or a routed command case

## 17. Safe Defaults For Development

For most developers, start with:

```bash
PERSISTENCE_DRIVER=memory
MEMORY_BACKEND=local
ENABLE_HTTP=true
ENABLE_TERMINAL=true
ENABLE_TELEGRAM=false
ENABLE_PGVECTOR=false
ENABLE_AUTOMATION=true
```

That gives the simplest working stack with the fewest moving parts.

## 18. Operational Maintenance Checklist

- Keep `jarvis.config.json` local.
- Keep `.env.example` and `jarvis.config.example.json` generic.
- Update docs when config shape changes.
- Run `npm test` after constructor or config changes.
- Treat warnings about memory backend fallback as operational signals, not cosmetic logs.
- Keep channel-specific secrets scoped to the channel actually in use.
