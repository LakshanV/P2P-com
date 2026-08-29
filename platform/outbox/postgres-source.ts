/**
 * PostgreSQL implementation of an outbox source (FND-003d).
 *
 * Each module owns its own outbox table, so the relay needs one source per schema. This adapter
 * polls a single module-owned outbox table and marks rows as processed or failed. It knows the
 * column layout of the outbox contract but interprets the payload only as an opaque value.
 *
 * Owned by: platform substrate.
 */

import type { Database } from '../db/client.ts';
import type { OutboxEntry, OutboxSource } from './types.ts';

export interface PostgresOutboxSourceOptions {
  readonly name: string;
  readonly schema: string;
  readonly database: Database;
}

export class PostgresOutboxSource implements OutboxSource {
  readonly name: string;
  readonly schema: string;
  readonly #database: Database;
  readonly #table: string;

  constructor(options: PostgresOutboxSourceOptions) {
    this.name = options.name;
    this.schema = options.schema;
    this.#database = options.database;
    this.#table = `${options.schema}.outbox`;
  }

  async poll(limit: number, _now: string): Promise<readonly OutboxEntry[]> {
    const client = await this.#database.connect();
    try {
      const result = await client.query<Record<string, unknown>>(
        `SELECT outbox_id,
                idempotency_key,
                kind,
                payload,
                recorded_at,
                producer,
                correlation_id,
                processed_at,
                retry_count,
                last_error
         FROM ${this.#table}
         WHERE processed_at IS NULL
         ORDER BY recorded_at ASC, outbox_id ASC
         LIMIT $1;`,
        [limit],
      );
      return result.rows.map((row) => rowToEntry(row));
    } finally {
      await client.release();
    }
  }

  async markProcessed(outboxId: string, processedAt: string): Promise<void> {
    const client = await this.#database.connect();
    try {
      await client.query(
        `UPDATE ${this.#table}
         SET processed_at = $2,
             last_error = NULL
         WHERE outbox_id = $1;`,
        [outboxId, processedAt],
      );
    } finally {
      await client.release();
    }
  }

  async markError(
    outboxId: string,
    error: string,
    retryCount: number,
    _now: string,
  ): Promise<void> {
    const client = await this.#database.connect();
    try {
      await client.query(
        `UPDATE ${this.#table}
         SET last_error = $2,
             retry_count = $3
         WHERE outbox_id = $1;`,
        [outboxId, error, retryCount],
      );
    } finally {
      await client.release();
    }
  }
}

function toNullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return null;
}

function rowToEntry(row: Record<string, unknown>): OutboxEntry {
  const kind = row.kind === 'event' || row.kind === 'audit' ? row.kind : 'event';
  return {
    outboxId: String(row.outbox_id),
    idempotencyKey: String(row.idempotency_key),
    kind,
    payload: row.payload,
    recordedAt:
      row.recorded_at instanceof Date ? row.recorded_at.toISOString() : String(row.recorded_at),
    producer: String(row.producer),
    correlationId: String(row.correlation_id),
    causationId: null,
    processedAt: toNullableString(row.processed_at),
    retryCount: Number(row.retry_count ?? 0),
    lastError: toNullableString(row.last_error),
  };
}
