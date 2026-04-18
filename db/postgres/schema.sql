create extension if not exists pgcrypto;
create extension if not exists vector;

create table if not exists users (
    id uuid primary key default gen_random_uuid(),
    external_id text unique not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists channel_accounts (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references users(id) on delete cascade,
    channel text not null,
    external_account_id text not null,
    metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    unique (channel, external_account_id)
);

create table if not exists conversations (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references users(id) on delete cascade,
    channel text not null,
    title text not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists messages (
    id uuid primary key default gen_random_uuid(),
    conversation_id uuid not null references conversations(id) on delete cascade,
    role text not null,
    content text not null,
    provider text,
    model text,
    tool_name text,
    created_at timestamptz not null default now()
);

create table if not exists assistant_runs (
    id uuid primary key default gen_random_uuid(),
    request_id text not null,
    conversation_id uuid not null references conversations(id) on delete cascade,
    provider text,
    model text,
    status text not null,
    error text,
    started_at timestamptz not null default now(),
    completed_at timestamptz
);

create table if not exists tool_calls (
    id uuid primary key default gen_random_uuid(),
    run_id uuid not null references assistant_runs(id) on delete cascade,
    tool_name text not null,
    input_text text not null,
    output_text text not null,
    success boolean not null,
    created_at timestamptz not null default now()
);

create table if not exists memory_entries (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references users(id) on delete cascade,
    conversation_id uuid references conversations(id) on delete set null,
    kind text not null,
    content text not null,
    keywords text[] not null default '{}',
    confidence numeric(4,3) not null,
    embedding vector(1536),
    source_message_id uuid references messages(id) on delete set null,
    created_at timestamptz not null default now(),
    last_accessed_at timestamptz not null default now()
);

create table if not exists conversation_summaries (
    id uuid primary key default gen_random_uuid(),
    conversation_id uuid not null references conversations(id) on delete cascade,
    content text not null,
    source_message_ids uuid[] not null default '{}',
    embedding vector(1536),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index if not exists idx_messages_conversation_id_created_at on messages (conversation_id, created_at);
create index if not exists idx_runs_conversation_id on assistant_runs (conversation_id);
create index if not exists idx_memory_entries_user_id on memory_entries (user_id, created_at desc);
create index if not exists idx_memory_entries_embedding on memory_entries using ivfflat (embedding vector_cosine_ops);
create index if not exists idx_conversation_summaries_embedding on conversation_summaries using ivfflat (embedding vector_cosine_ops);
