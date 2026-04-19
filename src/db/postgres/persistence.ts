import { Pool } from "pg";
import type { AppConfig } from "../../config/index.js";
import type { Logger } from "../../observability/logger.js";
import type {
    ConversationRecord,
    ConversationSummary,
    MemoryEntry,
    MessageRecord,
    ProviderKind,
    RunRecord,
} from "../../types/core.js";
import { createId } from "../../utils/id.js";
import type { ConversationRepository, MemoryRepository, RunRepository } from "../contracts.js";

const SCHEMA_SQL = `
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
`;

interface CreatePostgresPersistenceInput {
    config: AppConfig;
    logger: Logger;
}

function parseDatabaseUrl(databaseUrl: string): { databaseName: string; adminUrl: string } {
    const url = new URL(databaseUrl);
    const databaseName = decodeURIComponent(url.pathname.replace(/^\/+/, ""));

    if (!databaseName) {
        throw new Error("DATABASE_URL must include a database name in the path.");
    }

    if (!/^[a-zA-Z0-9_]+$/.test(databaseName)) {
        throw new Error(
            `Refusing to use unsafe database name '${databaseName}'. Use only letters, numbers, and underscores.`,
        );
    }

    const admin = new URL(url.toString());
    admin.pathname = "/postgres";

    return { databaseName, adminUrl: admin.toString() };
}

async function ensureDatabaseExists(databaseUrl: string, logger: Logger): Promise<void> {
    const { databaseName, adminUrl } = parseDatabaseUrl(databaseUrl);

    if (databaseName === "postgres") {
        return;
    }

    const pool = new Pool({ connectionString: adminUrl });

    try {
        const exists = await pool.query("select 1 from pg_database where datname = $1", [databaseName]);

        if (exists.rowCount && exists.rowCount > 0) {
            return;
        }

        // Database identifiers cannot be parameterized; validate in parseDatabaseUrl().
        await pool.query(`create database "${databaseName}"`);
        logger.info("Created Postgres database", { database: databaseName });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        // Ignore duplicate-database errors in case another process created it.
        if (/already exists/i.test(message)) {
            return;
        }

        throw error;
    } finally {
        await pool.end();
    }
}

async function migrate(pool: Pool, logger: Logger, config: AppConfig): Promise<void> {
    await pool.query(SCHEMA_SQL);

    if (config.persistence.pgvector.enabled) {
        const dimensions = config.persistence.pgvector.dimensions;
        if (!Number.isInteger(dimensions) || dimensions <= 0 || dimensions > 8192) {
            throw new Error('PGVECTOR_DIMENSIONS must be an integer between 1 and 8192 (received ' + String(dimensions) + ').');
        }

        try {
            await pool.query('create extension if not exists vector');
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(
                'pgvector is enabled (ENABLE_PGVECTOR=true) but Postgres could not create the vector extension. ' +
                    'Install pgvector on your Postgres instance or disable ENABLE_PGVECTOR. Original error: ' +
                    message,
            );
        }

        await pool.query(
            'alter table memory_entries add column if not exists embedding vector(' + String(dimensions) + ')',
        );
        logger.info('pgvector is enabled', { dimensions });
    }

    logger.info('Postgres schema is ready');
}

function toDate(value: unknown): Date {
    if (value instanceof Date) {
        return value;
    }

    return new Date(String(value));
}

export class PostgresConversationRepository implements ConversationRepository {
    private readonly pool: Pool;

    public constructor(pool: Pool) {
        this.pool = pool;
    }

    public async ensureConversation(input: {
        conversationId?: string;
        userId: string;
        channel: ConversationRecord["channel"];
        title: string;
    }): Promise<ConversationRecord> {
        const now = new Date();
        const conversationId = input.conversationId ?? createId("conv");

        const result = await this.pool.query(
            `
            insert into conversations (id, user_id, channel, title, created_at, updated_at)
            values ($1, $2, $3, $4, $5, $5)
            on conflict (id) do update
            set updated_at = excluded.updated_at
            returning id, user_id, channel, title, created_at, updated_at
            `,
            [conversationId, input.userId, input.channel, input.title, now],
        );

        const row = result.rows[0] as {
            id: string;
            user_id: string;
            channel: ConversationRecord["channel"];
            title: string;
            created_at: string;
            updated_at: string;
        };

        return {
            id: row.id,
            userId: row.user_id,
            channel: row.channel,
            title: row.title,
            createdAt: toDate(row.created_at),
            updatedAt: toDate(row.updated_at),
        };
    }

    public async getConversation(conversationId: string): Promise<ConversationRecord | null> {
        const result = await this.pool.query(
            `
            select id, user_id, channel, title, created_at, updated_at
            from conversations
            where id = $1
            `,
            [conversationId],
        );

        if (result.rowCount === 0) {
            return null;
        }

        const row = result.rows[0] as {
            id: string;
            user_id: string;
            channel: ConversationRecord["channel"];
            title: string;
            created_at: string;
            updated_at: string;
        };

        return {
            id: row.id,
            userId: row.user_id,
            channel: row.channel,
            title: row.title,
            createdAt: toDate(row.created_at),
            updatedAt: toDate(row.updated_at),
        };
    }

    public async appendMessage(message: MessageRecord): Promise<void> {
        await this.pool.query(
            `
            insert into messages
                (id, conversation_id, role, content, channel, user_id, provider, model, tool_name, created_at)
            values
                ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            `,
            [
                message.id,
                message.conversationId,
                message.role,
                message.content,
                message.channel,
                message.userId,
                message.provider ?? null,
                message.model ?? null,
                message.toolName ?? null,
                message.createdAt,
            ],
        );

        await this.pool.query(`update conversations set updated_at = $2 where id = $1`, [
            message.conversationId,
            message.createdAt,
        ]);
    }

    public async countMessages(conversationId: string): Promise<number> {
        const result = await this.pool.query(
            `
            select count(*) as count
            from messages
            where conversation_id = $1
            `,
            [conversationId],
        );

        const row = result.rows[0] as { count?: string | number } | undefined;
        return Number(row?.count ?? 0);
    }

    public async listRecentMessages(conversationId: string, limit: number): Promise<MessageRecord[]> {
        if (limit <= 0) {
            return [];
        }

        const result = await this.pool.query(
            `
            select id, conversation_id, role, content, channel, user_id, provider, model, tool_name, created_at
            from messages
            where conversation_id = $1
            order by created_at desc
            limit $2
            `,
            [conversationId, limit],
        );

        const mapped = result.rows.map((row): MessageRecord => {
            const typed = row as {
                id: string;
                conversation_id: string;
                role: MessageRecord['role'];
                content: string;
                channel: MessageRecord['channel'];
                user_id: string;
                provider: string | null;
                model: string | null;
                tool_name: string | null;
                created_at: string;
            };

            const message: MessageRecord = {
                id: typed.id,
                conversationId: typed.conversation_id,
                role: typed.role,
                content: typed.content,
                channel: typed.channel,
                userId: typed.user_id,
                createdAt: toDate(typed.created_at),
            };

            if (typed.provider) {
                message.provider = typed.provider as ProviderKind;
            }

            if (typed.model) {
                message.model = typed.model;
            }

            if (typed.tool_name) {
                message.toolName = typed.tool_name;
            }

            return message;
        });

        return mapped.reverse();
    }

    public async listMessages(conversationId: string): Promise<MessageRecord[]> {
        const result = await this.pool.query(
            `
            select id, conversation_id, role, content, channel, user_id, provider, model, tool_name, created_at
            from messages
            where conversation_id = $1
            order by created_at asc
            `,
            [conversationId],
        );

        return result.rows.map((row): MessageRecord => {
            const typed = row as {
                id: string;
                conversation_id: string;
                role: MessageRecord["role"];
                content: string;
                channel: MessageRecord["channel"];
                user_id: string;
                provider: string | null;
                model: string | null;
                tool_name: string | null;
                created_at: string;
            };

            const message: MessageRecord = {
                id: typed.id,
                conversationId: typed.conversation_id,
                role: typed.role,
                content: typed.content,
                channel: typed.channel,
                userId: typed.user_id,
                createdAt: toDate(typed.created_at),
            };

            if (typed.provider) {
                message.provider = typed.provider as ProviderKind;
            }

            if (typed.model) {
                message.model = typed.model;
            }

            if (typed.tool_name) {
                message.toolName = typed.tool_name;
            }

            return message;
        });
    }

    public async saveSummary(summary: ConversationSummary): Promise<void> {
        await this.pool.query(
            `
            insert into conversation_summaries
                (conversation_id, id, content, source_message_ids, created_at, updated_at)
            values
                ($1, $2, $3, $4, $5, $6)
            on conflict (conversation_id) do update
            set content = excluded.content,
                source_message_ids = excluded.source_message_ids,
                updated_at = excluded.updated_at
            `,
            [
                summary.conversationId,
                summary.id,
                summary.content,
                summary.sourceMessageIds,
                summary.createdAt,
                summary.updatedAt,
            ],
        );
    }

    public async getLatestSummary(conversationId: string): Promise<ConversationSummary | null> {
        const result = await this.pool.query(
            `
            select conversation_id, id, content, source_message_ids, created_at, updated_at
            from conversation_summaries
            where conversation_id = $1
            `,
            [conversationId],
        );

        if (result.rowCount === 0) {
            return null;
        }

        const row = result.rows[0] as {
            conversation_id: string;
            id: string;
            content: string;
            source_message_ids: string[];
            created_at: string;
            updated_at: string;
        };

        return {
            id: row.id,
            conversationId: row.conversation_id,
            content: row.content,
            sourceMessageIds: row.source_message_ids ?? [],
            createdAt: toDate(row.created_at),
            updatedAt: toDate(row.updated_at),
        };
    }
}

export class PostgresRunRepository implements RunRepository {
    private readonly pool: Pool;

    public constructor(pool: Pool) {
        this.pool = pool;
    }

    public async create(run: RunRecord): Promise<void> {
        await this.pool.query(
            `
            insert into assistant_runs
                (id, request_id, conversation_id, user_id, channel, provider, model, status, error, started_at, completed_at)
            values
                ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            `,
            [
                run.id,
                run.requestId,
                run.conversationId,
                run.userId,
                run.channel,
                run.provider ?? null,
                run.model ?? null,
                run.status,
                run.error ?? null,
                run.startedAt,
                run.completedAt ?? null,
            ],
        );
    }

    public async complete(
        runId: string,
        patch: {
            status: RunRecord["status"];
            completedAt: Date;
            provider?: RunRecord["provider"];
            model?: string;
            error?: string;
        },
    ): Promise<void> {
        await this.pool.query(
            `
            update assistant_runs
            set status = $2,
                completed_at = $3,
                provider = $4,
                model = $5,
                error = $6
            where id = $1
            `,
            [
                runId,
                patch.status,
                patch.completedAt,
                patch.provider ?? null,
                patch.model ?? null,
                patch.error ?? null,
            ],
        );
    }
}

export class PostgresMemoryRepository implements MemoryRepository {
    private readonly pool: Pool;

    public constructor(pool: Pool) {
        this.pool = pool;
    }

    public async save(entry: MemoryEntry, embedding?: number[]): Promise<void> {
        if (embedding && embedding.length > 0) {
            const embeddingLiteral = `[${embedding.join(",")}]`;
            await this.pool.query(
                `
                insert into memory_entries
                    (id, user_id, conversation_id, source_message_id, kind, content, keywords, confidence, created_at, last_accessed_at, embedding)
                values
                    ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::vector)
                on conflict (id) do update
                set kind = excluded.kind,
                    content = excluded.content,
                    keywords = excluded.keywords,
                    confidence = excluded.confidence,
                    last_accessed_at = excluded.last_accessed_at,
                    embedding = excluded.embedding
                `,
                [
                    entry.id,
                    entry.userId,
                    entry.conversationId ?? null,
                    entry.sourceMessageId ?? null,
                    entry.kind,
                    entry.content,
                    entry.keywords,
                    entry.confidence,
                    entry.createdAt,
                    entry.lastAccessedAt,
                    embeddingLiteral,
                ],
            );
        } else {
            await this.pool.query(
                `
                insert into memory_entries
                    (id, user_id, conversation_id, source_message_id, kind, content, keywords, confidence, created_at, last_accessed_at)
                values
                    ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                on conflict (id) do update
                set kind = excluded.kind,
                    content = excluded.content,
                    keywords = excluded.keywords,
                    confidence = excluded.confidence,
                    last_accessed_at = excluded.last_accessed_at
                `,
                [
                    entry.id,
                    entry.userId,
                    entry.conversationId ?? null,
                    entry.sourceMessageId ?? null,
                    entry.kind,
                    entry.content,
                    entry.keywords,
                    entry.confidence,
                    entry.createdAt,
                    entry.lastAccessedAt,
                ],
            );
        }
    }

    public async searchByEmbedding(userId: string, embedding: number[], limit: number): Promise<Array<{ entry: MemoryEntry; similarity: number }>> {
        const embeddingLiteral = `[${embedding.join(",")}]`;
        const result = await this.pool.query(
            `
            select id, user_id, conversation_id, source_message_id, kind, content, keywords, confidence, created_at, last_accessed_at,
                   1 - (embedding <=> $1::vector) as similarity
            from memory_entries
            where user_id = $2 and embedding is not null
            order by embedding <=> $1::vector
            limit $3
            `,
            [embeddingLiteral, userId, limit],
        );

        return result.rows.map((row: Record<string, unknown>) => ({
            entry: this.mapMemoryRow(row),
            similarity: Number(row.similarity),
        }));
    }

    public async listByUser(userId: string): Promise<MemoryEntry[]> {
        const result = await this.pool.query(
            `
            select id, user_id, conversation_id, source_message_id, kind, content, keywords, confidence, created_at, last_accessed_at
            from memory_entries
            where user_id = $1
            order by created_at desc
            `,
            [userId],
        );

        return result.rows.map((row: Record<string, unknown>) => this.mapMemoryRow(row));
    }

    private mapMemoryRow(row: Record<string, unknown>): MemoryEntry {
        const typed = row as {
            id: string;
            user_id: string;
            conversation_id: string | null;
            source_message_id: string | null;
            kind: MemoryEntry["kind"];
            content: string;
            keywords: string[];
            confidence: number;
            created_at: string;
            last_accessed_at: string;
        };

        const entry: MemoryEntry = {
            id: typed.id,
            userId: typed.user_id,
            kind: typed.kind,
            content: typed.content,
            keywords: typed.keywords ?? [],
            confidence: Number(typed.confidence),
            createdAt: toDate(typed.created_at),
            lastAccessedAt: toDate(typed.last_accessed_at),
        };

        if (typed.conversation_id) {
            entry.conversationId = typed.conversation_id;
        }

        if (typed.source_message_id) {
            entry.sourceMessageId = typed.source_message_id;
        }

        return entry;
    }

    public async touch(memoryId: string, accessedAt: Date): Promise<void> {
        await this.pool.query(
            `
            update memory_entries
            set last_accessed_at = $2
            where id = $1
            `,
            [memoryId, accessedAt],
        );
    }
}

export class PostgresPersistence {
    private readonly pool: Pool;
    public readonly conversations: ConversationRepository;
    public readonly runs: RunRepository;
    public readonly memories: MemoryRepository;

    public constructor(pool: Pool) {
        this.pool = pool;
        this.conversations = new PostgresConversationRepository(pool);
        this.runs = new PostgresRunRepository(pool);
        this.memories = new PostgresMemoryRepository(pool);
    }

    public async stop(): Promise<void> {
        await this.pool.end();
    }
}

export async function createPostgresPersistence(input: CreatePostgresPersistenceInput): Promise<PostgresPersistence> {
    const databaseUrl = input.config.persistence.databaseUrl;

    if (!databaseUrl) {
        throw new Error("DATABASE_URL is required when using postgres persistence.");
    }

    await ensureDatabaseExists(databaseUrl, input.logger);

    const pool = new Pool({ connectionString: databaseUrl });
    await migrate(pool, input.logger, input.config);

    return new PostgresPersistence(pool);
}

