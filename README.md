# Jarvis

Jarvis is now structured as a local-first, provider-agnostic assistant runtime with clear boundaries between channels, orchestration, tools, providers, and memory.

## Frontend

Jarvis now also includes a dedicated React frontend in `web/`.

- `web/` is a separate Vite + React + TypeScript application.
- The backend remains API-first and no longer serves the branded site shell.
- The frontend talks to the existing Jarvis HTTP routes: `/health`, `/models`, `/chat`, `/chat/stream`, `/conversations/:id`, and `/conversations/:id/messages`.
- During local development, the Vite dev server proxies API requests to the backend on `http://localhost:3000`.

## What is implemented

- `src/orchestrator/index.ts` is the central request hub.
- `src/channels/terminal/index.ts`, `src/server/http-server.ts`, and `src/channels/telegram/index.ts` are channel adapters.
- `src/models/registry.ts` selects providers/models and supports local, OpenAI, and OpenRouter adapters.
- `src/tools/web-search.ts` adds configurable web search.
- `src/memory/service.ts` handles retrieval, summarization, and durable preference/fact extraction.
- `src/db/in-memory.ts` and `src/db/postgres/persistence.ts` provide persistence adapters (memory or Postgres).
- `db/postgres/schema.sql` is the reference schema for Postgres (text IDs; pgvector optional).

Further docs:
- `docs/JARVIS-ARCHITECTURE.md`
- `docs/TOOLS.md`

## Current persistence status

Persistence is selected via `PERSISTENCE_DRIVER`:

- `memory` (default): local-only, no external dependencies.
- `postgres`: durable storage for conversations/messages/runs/memory in Postgres via `pg`.

When `PERSISTENCE_DRIVER=postgres`, `DATABASE_URL` must be set and the runtime will auto-create the target database (for example `jarvis`) and apply the schema on startup.

## Quick start

1. Copy `.env.example` to `.env`.
2. Set `DEFAULT_PROVIDER` to `local`, `openai`, or `openrouter`.
3. Add the matching API key if you use `openai` (`OPENAI_API_KEY`) or `openrouter` (`OPENROUTER_API_KEY`).
4. (Optional) Set `PERSISTENCE_DRIVER=memory` if you do not want Postgres.
5. Set `WEB_APP_ORIGIN=http://localhost:5173` if you will run the dedicated web app locally.
6. Run `npm run build`.
7. Run `npm start`.

## Frontend quick start

1. In one terminal, run the backend with `npm run dev` or `npm start`.
2. In another terminal, install frontend dependencies with `npm install --prefix web`.
3. Run the frontend with `npm run dev:web`.
4. Open `http://localhost:5173`.

Frontend build:

- `npm run build:web` builds the dedicated React app.
- `npm run build:all` builds both the backend and frontend.

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
