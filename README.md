# Jarvis

Jarvis is a local-first assistant runtime with clear boundaries between channels, orchestration, tools, providers, and memory.

## Frontend

Jarvis now also includes a dedicated React frontend in `web/`.

- `web/` is a separate Vite + React + TypeScript application.
- The backend remains API-first and no longer serves the branded site shell.
- The frontend talks to the existing Jarvis HTTP routes: `/health`, `/models`, `/chat`, `/chat/stream`, `/conversations/:id`, and `/conversations/:id/messages`.
- During local development, the Vite dev server proxies API requests to the backend on `http://localhost:3000`.

## What is implemented

- `src/orchestrator/index.ts` is the central request hub.
- `src/channels/terminal/index.ts`, `src/server/http-server.ts`, and `src/channels/telegram/index.ts` are channel adapters.
- `src/models/registry.ts` selects models via the OpenAI-compatible provider.
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

### pgvector (optional)

To store embeddings and enable vector search in Postgres:

- Install pgvector on your Postgres instance.
- Set ENABLE_PGVECTOR=true and PGVECTOR_DIMENSIONS to match your embedding model (default 1536).

On startup, Jarvis will attempt to create the ector extension and add memory_entries.embedding.
You can also apply db/postgres/pgvector.sql manually.

## Quick start

1. Copy `.env.example` to `.env`.
2. Set `OPENAI_API_KEY` (supports OpenAI-compatible APIs via `OPENAI_BASE_URL`).
3. (Optional) Set `PERSISTENCE_DRIVER=memory` if you do not want Postgres.
4. Set `WEB_APP_ORIGIN=http://localhost:5173` if you will run the dedicated web app locally.
5. Run `npm run build`.
6. Run `npm start`.

## Frontend quick start

1. Install frontend dependencies with `npm install --prefix web`.
2. Run both the API and frontend together with `npm run dev:all`.
3. Open `http://localhost:5173`.

If you prefer to run them separately:

1. Run the backend with `npm run dev` or `npm start`.
2. In another terminal, run the frontend with `npm run dev:web`.
3. `dev:web` expects the Jarvis API to be reachable at `http://127.0.0.1:3000` by default.
4. Override the proxy target with `web/.env.example` if your API runs elsewhere.

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
