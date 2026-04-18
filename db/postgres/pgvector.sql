-- Optional: enable vector search in Postgres via pgvector.
-- Requires pgvector to be installed on your Postgres instance.

create extension if not exists vector;

-- Add an embedding column (dimension depends on your embedding model).
-- Example: OpenAI `text-embedding-3-small` => 1536 dims.
alter table memory_entries
    add column if not exists embedding vector(1536);

-- Optional indexes (choose ONE strategy; tune for your dataset).
-- IVFFlat (requires `ANALYZE` and tuning `lists`):
-- create index if not exists idx_memory_entries_embedding_ivfflat
--     on memory_entries using ivfflat (embedding vector_cosine_ops) with (lists = 100);
--
-- HNSW (better recall/latency for many workloads):
-- create index if not exists idx_memory_entries_embedding_hnsw
--     on memory_entries using hnsw (embedding vector_cosine_ops);
