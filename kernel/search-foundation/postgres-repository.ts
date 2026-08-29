/**
 * K-15 Search Foundation — the PostgreSQL adapter.
 *
 * Implements the persistence port against `kernel_search_foundation`. It knows SQL and nothing else:
 * no validation, no lifecycle, no cross-component existence checks. Those live in the service, where
 * they can be tested without a server.
 *
 * Every `timestamptz` is projected as UTC text. JSON objects are stored as `jsonb` and read as
 * objects. Full-text search uses a generated `tsv` column backed by a GIN index.
 *
 * No statement names another unit's schema, and there is no foreign key out of
 * `kernel_search_foundation`. The module's outbox table lives in the same schema.
 *
 * Owned by: K-15 Search Foundation.
 */

import { databaseErrorDetail } from '../../platform/db/client.ts';
import type { Database, DatabaseClient } from '../../platform/db/client.ts';
import type { OutboxEntry } from '../../platform/outbox/types.ts';

import { sealSearchDocument, sealSearchQueryLog } from './immutable.ts';
import type {
  SearchFilters,
  SearchOptions,
  SearchRepository,
  SearchResult,
  SearchTransaction,
} from './repository.ts';
import {
  SearchError,
  type SearchErrorCode,
  type SearchDocument,
  type SearchQueryLog,
} from './types.ts';
import { validateSearchDocument, validateSearchQueryLog } from './validate.ts';

export const SEARCH_SCHEMA = 'kernel_search_foundation';
export const DOCUMENT_TABLE = `${SEARCH_SCHEMA}.document`;
export const QUERY_LOG_TABLE = `${SEARCH_SCHEMA}.query_log`;
export const OUTBOX_TABLE = `${SEARCH_SCHEMA}.outbox`;

/** SQLSTATE 23505. The only driver code this adapter interprets. */
const UNIQUE_VIOLATION = '23505';

const CONSTRAINT_MEANINGS: Readonly<
  Record<string, { readonly code: SearchErrorCode; readonly explanation: string }>
> = {
  document_idempotency_unique: {
    code: 'idempotency-key-reuse',
    explanation: 'this idempotency key has already been used for a document',
  },
  query_log_pkey: {
    code: 'duplicate-query-id',
    explanation: 'a query with this id already exists, and a query log is never rewritten',
  },
  query_log_idempotency_unique: {
    code: 'idempotency-key-reuse',
    explanation: 'this idempotency key has already been used for a query',
  },
  outbox_pkey: {
    code: 'idempotency-key-reuse',
    explanation: 'this outbox id already exists',
  },
  outbox_idempotency_unique: {
    code: 'idempotency-key-reuse',
    explanation: 'this outbox idempotency key has already been used',
  },
};

function normalizeDatabaseError(error: unknown, operation: string): unknown {
  if (error instanceof SearchError) return error;

  const detail = databaseErrorDetail(error);
  if (detail.code !== UNIQUE_VIOLATION) return error;

  const message = error instanceof Error ? error.message : String(error);
  const named =
    detail.constraint ??
    Object.keys(CONSTRAINT_MEANINGS).find((constraint) => message.includes(constraint));
  const meaning = named === undefined ? undefined : CONSTRAINT_MEANINGS[named];
  if (meaning === undefined) return error;

  return new SearchError(meaning.code, `${operation} was refused: ${meaning.explanation}`);
}

const DOCUMENT_COLUMNS = [
  'document_id',
  'owner_type',
  'owner_id',
  'scope',
  'language',
  'title',
  'description',
  'keywords',
  'attributes',
  'vectors',
  'ranking',
  'created_at',
  'updated_at',
  'idempotency_key',
] as const;

const QUERY_LOG_COLUMNS = [
  'query_id',
  'query_text',
  'filters',
  'result_count',
  'executed_at',
  'correlation_id',
  'idempotency_key',
] as const;

function utcText(column: string): string {
  return `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${column}`;
}

const DOCUMENT_PROJECTION = [
  'document_id',
  'owner_type',
  'owner_id',
  'scope',
  'language',
  'title',
  'description',
  'keywords',
  'attributes',
  'vectors',
  'ranking',
  utcText('created_at'),
  utcText('updated_at'),
  'idempotency_key',
].join(', ');

const QUERY_LOG_PROJECTION = [
  'query_id',
  'query_text',
  'filters',
  'result_count',
  utcText('executed_at'),
  'correlation_id',
  'idempotency_key',
].join(', ');

const OUTBOX_COLUMN_NAMES = [
  'outbox_id',
  'idempotency_key',
  'kind',
  'payload',
  'recorded_at',
  'producer',
  'correlation_id',
  'processed_at',
  'retry_count',
  'last_error',
] as const;
const OUTBOX_COLUMNS = OUTBOX_COLUMN_NAMES.join(', ');

export const TIMESTAMP_COLUMNS = ['created_at', 'updated_at', 'executed_at'] as const;

/** Exactly what `utcText` emits, and nothing else. */
const STORED_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/;

function instant(value: unknown, column: string): string {
  if (typeof value !== 'string') {
    throw new SearchError(
      'malformed-record',
      `${column} came back as ${value instanceof Date ? 'a Date' : typeof value} rather than ` +
        'text. Timestamps are projected through to_char precisely so the driver never parses them',
    );
  }
  if (STORED_INSTANT.exec(value) === null) {
    throw new SearchError(
      'malformed-record',
      `${column} holds "${value}", which is not a finite UTC timestamp in the projected form ` +
        'YYYY-MM-DDTHH:MM:SS.ffffffZ',
    );
  }
  return value;
}

function text(value: unknown, column: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new SearchError(
      'malformed-record',
      `${column} is ${value === null ? 'null' : typeof value}; expected non-empty text`,
    );
  }
  return value;
}

function textArray(value: unknown, column: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new SearchError(
      'malformed-record',
      `${column} is ${value === null ? 'null' : typeof value}; expected a text array`,
    );
  }
  if (value.some((entry) => typeof entry !== 'string')) {
    throw new SearchError('malformed-record', `${column} contains a non-string entry`);
  }
  return value as readonly string[];
}

function jsonObject(value: unknown, column: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SearchError(
      'malformed-record',
      `${column} is ${value === null ? 'null' : typeof value}; expected a JSON object`,
    );
  }
  return value as Record<string, unknown>;
}

function nonNegativeInteger(value: unknown, column: string): number {
  const parsed =
    typeof value === 'string' && /^\d+$/.test(value)
      ? Number(value)
      : typeof value === 'number'
        ? value
        : NaN;
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new SearchError(
      'malformed-record',
      `${column} is ${JSON.stringify(value)}; expected a non-negative integer`,
    );
  }
  return parsed;
}

export function toDocument(row: Record<string, unknown>): SearchDocument {
  return sealSearchDocument(
    validateSearchDocument(
      {
        documentId: text(row.document_id, 'document_id'),
        ownerType: text(row.owner_type, 'owner_type'),
        ownerId: text(row.owner_id, 'owner_id'),
        scope: text(row.scope, 'scope'),
        language: text(row.language, 'language'),
        title: text(row.title, 'title'),
        description: text(row.description, 'description'),
        keywords: textArray(row.keywords, 'keywords'),
        attributes: jsonObject(row.attributes, 'attributes'),
        vectors: jsonObject(row.vectors, 'vectors'),
        ranking: jsonObject(row.ranking, 'ranking'),
        createdAt: instant(row.created_at, 'created_at'),
        updatedAt: instant(row.updated_at, 'updated_at'),
        idempotencyKey: text(row.idempotency_key, 'idempotency_key'),
      },
      'stored row',
    ),
  );
}

export function toQueryLog(row: Record<string, unknown>): SearchQueryLog {
  return sealSearchQueryLog(
    validateSearchQueryLog(
      {
        queryId: text(row.query_id, 'query_id'),
        queryText: text(row.query_text, 'query_text'),
        filters: jsonObject(row.filters, 'filters'),
        resultCount: nonNegativeInteger(row.result_count, 'result_count'),
        executedAt: instant(row.executed_at, 'executed_at'),
        correlationId: text(row.correlation_id, 'correlation_id'),
        idempotencyKey: text(row.idempotency_key, 'idempotency_key'),
      },
      'stored row',
    ),
  );
}

const TRANSACTION_CONTROL =
  /^\s*(BEGIN|START\s+TRANSACTION|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE\s+SAVEPOINT)\b/i;

export function enlistedClient(client: DatabaseClient): DatabaseClient {
  return {
    query<QueryRow = Record<string, unknown>>(sql: string, params?: readonly unknown[]) {
      if (TRANSACTION_CONTROL.test(sql)) {
        return Promise.reject(
          new SearchError(
            'nested-transaction',
            `an enlisted search write may not issue "${sql.trim().split(/\s+/, 2).join(' ')}". ` +
              'The transaction belongs to the caller',
          ),
        );
      }
      return client.query<QueryRow>(sql, params);
    },
    release(): Promise<void> {
      return Promise.resolve();
    },
  };
}

export class EnlistedSearchRepository implements SearchRepository {
  readonly #client: DatabaseClient;

  constructor(client: DatabaseClient) {
    this.#client = enlistedClient(client);
  }

  withTransaction<T>(body: (tx: SearchTransaction) => Promise<T>): Promise<T> {
    return body(new PostgresSearchTransaction(this.#client));
  }
}

export class PostgresSearchRepository implements SearchRepository {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  static enlist(client: DatabaseClient): SearchRepository {
    return new EnlistedSearchRepository(client);
  }

  async withTransaction<T>(body: (tx: SearchTransaction) => Promise<T>): Promise<T> {
    const client = await this.#database.connect();
    try {
      await client.query('BEGIN;');
      try {
        const result = await body(new PostgresSearchTransaction(client));
        await client.query('COMMIT;');
        return result;
      } catch (error) {
        await client.query('ROLLBACK;');
        throw error;
      }
    } finally {
      await client.release();
    }
  }
}

class PostgresSearchTransaction implements SearchTransaction {
  readonly #client: DatabaseClient;

  constructor(client: DatabaseClient) {
    this.#client = client;
  }

  async insertOutbox(entry: OutboxEntry): Promise<void> {
    await this.#client.query(
      `INSERT INTO ${OUTBOX_TABLE} (${OUTBOX_COLUMNS})
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10);`,
      [
        entry.outboxId,
        entry.idempotencyKey,
        entry.kind,
        JSON.stringify(entry.payload),
        entry.recordedAt,
        entry.producer,
        entry.correlationId,
        entry.processedAt,
        entry.retryCount,
        entry.lastError,
      ],
    );
  }

  async findDocumentById(documentId: string): Promise<SearchDocument | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${DOCUMENT_PROJECTION} FROM ${DOCUMENT_TABLE} WHERE document_id = $1;`,
      [documentId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toDocument(row);
  }

  async findDocumentByIdempotencyKey(idempotencyKey: string): Promise<SearchDocument | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${DOCUMENT_PROJECTION} FROM ${DOCUMENT_TABLE} WHERE idempotency_key = $1;`,
      [idempotencyKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : toDocument(row);
  }

  async insertDocument(document: SearchDocument): Promise<void> {
    const columns = DOCUMENT_COLUMNS.join(', ');
    const values = DOCUMENT_COLUMNS.map((_, index) => `$${index + 1}`).join(', ');
    const updates = DOCUMENT_COLUMNS.filter((column) => column !== 'document_id')
      .map((column) => `${column} = EXCLUDED.${column}`)
      .join(', ');

    try {
      await this.#client.query(
        `INSERT INTO ${DOCUMENT_TABLE} (${columns}) VALUES (${values})
         ON CONFLICT (document_id) DO UPDATE SET ${updates};`,
        [
          document.documentId,
          document.ownerType,
          document.ownerId,
          document.scope,
          document.language,
          document.title,
          document.description,
          document.keywords,
          JSON.stringify(document.attributes),
          JSON.stringify(document.vectors),
          JSON.stringify(document.ranking),
          document.createdAt,
          document.updatedAt,
          document.idempotencyKey,
        ],
      );
    } catch (error) {
      throw normalizeDatabaseError(error, 'insertDocument');
    }
  }

  async deleteDocument(documentId: string): Promise<void> {
    await this.#client.query(`DELETE FROM ${DOCUMENT_TABLE} WHERE document_id = $1;`, [documentId]);
  }

  async searchDocuments(
    queryText: string,
    filters: SearchFilters,
    options: SearchOptions,
  ): Promise<SearchResult> {
    const params: unknown[] = [];
    const where: string[] = [];

    if (queryText.trim() !== '') {
      params.push(queryText);
      where.push(`tsv @@ plainto_tsquery('english', $${params.length})`);
    }

    if (filters.ownerType !== undefined) {
      params.push(filters.ownerType);
      where.push(`owner_type = $${params.length}`);
    }
    if (filters.scope !== undefined) {
      params.push(filters.scope);
      where.push(`scope = $${params.length}`);
    }
    if (filters.language !== undefined) {
      params.push(filters.language);
      where.push(`language = $${params.length}`);
    }
    if (filters.attributes !== undefined && Object.keys(filters.attributes).length > 0) {
      params.push(JSON.stringify(filters.attributes));
      where.push(`attributes @> $${params.length}::jsonb`);
    }

    const whereClause = where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`;

    params.push(options.limit);
    const limitParam = `$${params.length}`;
    params.push(options.offset);
    const offsetParam = `$${params.length}`;

    const rankOrder =
      queryText.trim() === '' ? '' : `ts_rank_cd(tsv, plainto_tsquery('english', $1)) DESC, `;

    const sql = `SELECT ${DOCUMENT_PROJECTION}, count(*) OVER() AS total
      FROM ${DOCUMENT_TABLE}
      ${whereClause}
      ORDER BY ${rankOrder}updated_at DESC, document_id DESC
      LIMIT ${limitParam} OFFSET ${offsetParam};`;

    const result = await this.#client.query<Record<string, unknown>>(sql, params);
    const first = result.rows[0];
    const total = first !== undefined ? nonNegativeInteger(first.total, 'total') : 0;
    return {
      documents: Object.freeze(result.rows.map(toDocument)),
      total,
    };
  }

  async findQueryLogById(queryId: string): Promise<SearchQueryLog | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${QUERY_LOG_PROJECTION} FROM ${QUERY_LOG_TABLE} WHERE query_id = $1;`,
      [queryId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toQueryLog(row);
  }

  async findQueryLogByIdempotencyKey(idempotencyKey: string): Promise<SearchQueryLog | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${QUERY_LOG_PROJECTION} FROM ${QUERY_LOG_TABLE} WHERE idempotency_key = $1;`,
      [idempotencyKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : toQueryLog(row);
  }

  async insertQueryLog(log: SearchQueryLog): Promise<void> {
    try {
      await this.#client.query(
        `INSERT INTO ${QUERY_LOG_TABLE} (${QUERY_LOG_COLUMNS.join(', ')})
         VALUES ($1, $2, $3, $4, $5, $6, $7);`,
        [
          log.queryId,
          log.queryText,
          JSON.stringify(log.filters),
          log.resultCount,
          log.executedAt,
          log.correlationId,
          log.idempotencyKey,
        ],
      );
    } catch (error) {
      throw normalizeDatabaseError(error, 'insertQueryLog');
    }
  }
}
