# Jarvis

Jarvis is now structured as a local-first, provider-agnostic assistant runtime with clear boundaries between channels, orchestration, tools, providers, and memory.

## What is implemented

- `src/orchestrator/index.ts` is the central request hub.
- `src/channels/terminal/index.ts`, `src/server/http-server.ts`, and `src/channels/telegram/index.ts` are channel adapters.
- `src/models/registry.ts` selects providers/models and supports local, OpenAI, and OpenRouter adapters.
- `src/tools/web-search.ts` adds configurable web search.
- `src/memory/service.ts` handles retrieval, summarization, and durable preference/fact extraction.
- `src/db/in-memory.ts` provides the current runtime persistence adapter.
- `db/postgres/schema.sql` defines the target PostgreSQL + pgvector schema.

## Current persistence status

The runtime currently uses an in-memory persistence adapter so the project can run with the dependencies already present in the repo.

The production-oriented schema is included at `db/postgres/schema.sql` and is ready for a future Postgres repository implementation.

## Quick start

1. Copy `.env.example` to `.env`.
2. Set `DEFAULT_PROVIDER` to `local`, `openai`, or `openrouter`.
3. Add the matching API key if you use `openai` or `openrouter`.
4. Run `npm run build`.
5. Run `npm start`.

## HTTP API

- `GET /health`
- `GET /models`
- `POST /chat`
- `POST /chat/stream`
- `GET /conversations/:id`
- `GET /conversations/:id/messages`

## Terminal commands

- `/models`
- `/model <provider:model>`
- `/search <query>`
- `/new`
- `/exit`
