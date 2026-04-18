-- Jarvis Postgres schema (no pgvector required).
-- IDs are stored as text because Jarvis uses prefixed IDs (e.g. conv_*, msg_*).

create table if not exists conversations (
    id text primary key,
    user_id text not null,
    channel text not null,
    title text not null,
    created_at timestamptz not null,
    updated_at timestamptz not null
);

create table if not exists messages (
    id text primary key,
    conversation_id text not null references conversations(id) on delete cascade,
    role text not null,
    content text not null,
    channel text not null,
    user_id text not null,
    provider text,
    model text,
    tool_name text,
    created_at timestamptz not null
);

create index if not exists idx_messages_conversation_created_at on messages (conversation_id, created_at);

create table if not exists assistant_runs (
    id text primary key,
    request_id text not null,
    conversation_id text not null references conversations(id) on delete cascade,
    user_id text not null,
    channel text not null,
    provider text,
    model text,
    status text not null,
    error text,
    started_at timestamptz not null,
    completed_at timestamptz
);

create index if not exists idx_assistant_runs_conversation_id on assistant_runs (conversation_id);

create table if not exists conversation_summaries (
    conversation_id text primary key references conversations(id) on delete cascade,
    id text not null,
    content text not null,
    source_message_ids text[] not null,
    created_at timestamptz not null,
    updated_at timestamptz not null
);

create table if not exists memory_entries (
    id text primary key,
    user_id text not null,
    conversation_id text references conversations(id) on delete set null,
    source_message_id text references messages(id) on delete set null,
    kind text not null,
    content text not null,
    keywords text[] not null,
    confidence double precision not null,
    created_at timestamptz not null,
    last_accessed_at timestamptz not null
);

create index if not exists idx_memory_entries_user_created_at on memory_entries (user_id, created_at desc);
