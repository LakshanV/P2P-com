/**
 * PostgreSQL implementation of an outbox source.
 *
 * Each module owns its own outbox table, so the relay needs one source per schema. This adapter
 * claims from a single module-owned outbox table and marks rows processed, failed or dead-lettered.
 * It knows the column layout of the outbox contract and treats the payload as an opaque value.
 *
 * **`poll` claims; it does not read.** The rows are selected `FOR UPDATE SKIP LOCKED` inside a
 * transaction that immediately stamps `next_attempt_at` forward, so a second relay instance polling
 * the same table steps over them instead of being handed the same work. Without that, two relays
 * publish every fact twice, and a consumer that deduplicates is not something a relay may assume.
 *
 * Owned by: platform substrate.
 */

import type { Database } from '../db/client.ts';
import { formatInstant, parseInstant } from '../time/instant.ts';

import type { OutboxEntry, OutboxSource } from './types.ts';

export interface PostgresOutboxSourceOptions {
  readonly name: string;
  readonly schema: string;
  readonly database: Database;
  /**
   * How long a claimed row is held before another relay may take it, in milliseconds.
   *
   * This is a lease, not a lock: the claiming transaction commits immediately, so a relay that
   * crashes mid-dispatch does not hold the row for ever. The row simply becomes claimable again
   * when the lease expires. Long enough that an ordinary dispatch finishes first; short enough that
   * a crash does not strand the entry for an hour.
   */
  readonly leaseMillis?: number;
}

const DEFAULT_LEASE_MILLIS = 60_000;

/** Every column of the outbox contract, in one place so the projection and the decoder agree. */
const COLUMNS = [
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
  'next_attempt_at',
  'dead_lettered_at',
  'dead_letter_reason',
] as const;

function utcText(column: string, qualifier = ''): string {
  return (
    `to_char(${qualifier}${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') ` +
    `AS ${column}`
  );
}

/** The projection, optionally qualified by a table alias. */
function projection(qualifier = ''): string {
  return [
    `${qualifier}outbox_id`,
    `${qualifier}idempotency_key`,
    `${qualifier}kind`,
    `${qualifier}payload`,
    utcText('recorded_at', qualifier),
    `${qualifier}producer`,
    `${qualifier}correlation_id`,
    utcText('processed_at', qualifier),
    `${qualifier}retry_count`,
    `${qualifier}last_error`,
    utcText('next_attempt_at', qualifier),
    utcText('dead_lettered_at', qualifier),
    `${qualifier}dead_letter_reason`,
  ].join(', ');
}

const PROJECTION = projection();

/**
 * The same projection with every column qualified.
 *
 * `RETURNING` in an `UPDATE ... FROM claimed` sees both the target and the CTE, so a bare
 * `outbox_id` is ambiguous and PostgreSQL refuses the statement. Qualifying is the fix; the aliases
 * in `AS` stay bare so the decoder reads the same column names either way.
 */
const QUALIFIED_PROJECTION = projection('o.');

export class PostgresOutboxSource implements OutboxSource {
  readonly name: string;
  readonly schema: string;
  readonly #database: Database;
  readonly #table: string;
  readonly #leaseMillis: number;

  constructor(options: PostgresOutboxSourceOptions) {
    this.name = options.name;
    this.schema = options.schema;
    this.#database = options.database;
    this.#table = `${options.schema}.outbox`;
    this.#leaseMillis = options.leaseMillis ?? DEFAULT_LEASE_MILLIS;
  }

  /**
   * Claim up to `limit` due rows.
   *
   * One statement, one transaction. `SKIP LOCKED` is what makes two relays safe: the second does not
   * wait for rows the first is holding, it takes the next ones. The `UPDATE` pushes
   * `next_attempt_at` out by the lease so that even after this transaction commits — releasing the
   * row locks — another relay will not re-claim the same rows while the first is still dispatching
   * them.
   */
  async poll(limit: number, now: string): Promise<readonly OutboxEntry[]> {
    if (limit < 1) return [];

    const leaseUntil = formatInstant(
      parseInstant(now).epochMicros + BigInt(this.#leaseMillis) * 1000n,
    );

    const client = await this.#database.connect();
    try {
      await client.query('BEGIN;');
      try {
        const result = await client.query<Record<string, unknown>>(
          `WITH claimed AS (
             SELECT outbox_id
               FROM ${this.#table}
              WHERE processed_at IS NULL
                AND dead_lettered_at IS NULL
                AND (next_attempt_at IS NULL OR next_attempt_at <= $1::timestamptz)
              ORDER BY recorded_at ASC, outbox_id ASC
              LIMIT $2
                FOR UPDATE SKIP LOCKED
           )
           UPDATE ${this.#table} AS o
              SET next_attempt_at = $3::timestamptz
             FROM claimed
            WHERE o.outbox_id = claimed.outbox_id
        RETURNING ${QUALIFIED_PROJECTION};`,
          [now, limit, leaseUntil],
        );
        await client.query('COMMIT;');
        // Ordered here rather than in SQL: `RETURNING` has no defined order, and a relay that
        // dispatched a module's facts out of order would be a surprising thing to debug.
        return result.rows
          .map((row) => rowToEntry(row))
          .sort(
            (a, b) =>
              a.recordedAt.localeCompare(b.recordedAt) || a.outboxId.localeCompare(b.outboxId),
          );
      } catch (error) {
        await client.query('ROLLBACK;');
        throw error;
      }
    } finally {
      await client.release();
    }
  }

  /**
   * Mark a row dispatched.
   *
   * `processed_at IS NULL` in the `WHERE` clause makes this one-way: a second attempt to mark the
   * same row matches nothing instead of overwriting the instant at which it was actually published.
   */
  async markProcessed(outboxId: string, processedAt: string): Promise<void> {
    const client = await this.#database.connect();
    try {
      await client.query(
        `UPDATE ${this.#table}
            SET processed_at = $2::timestamptz,
                last_error = NULL,
                next_attempt_at = NULL
          WHERE outbox_id = $1 AND processed_at IS NULL;`,
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
    nextAttemptAt: string,
  ): Promise<void> {
    const client = await this.#database.connect();
    try {
      await client.query(
        `UPDATE ${this.#table}
            SET last_error = $2,
                retry_count = $3,
                next_attempt_at = $4::timestamptz
          WHERE outbox_id = $1 AND processed_at IS NULL;`,
        [outboxId, error, retryCount, nextAttemptAt],
      );
    } finally {
      await client.release();
    }
  }

  /**
   * Give up on a row.
   *
   * `processed_at` is left null and the database insists on it: a dead-lettered row was never
   * dispatched, and recording it as processed would tell every reader the opposite of what happened.
   */
  async markDeadLettered(
    outboxId: string,
    reason: string,
    retryCount: number,
    deadLetteredAt: string,
  ): Promise<void> {
    const client = await this.#database.connect();
    try {
      await client.query(
        `UPDATE ${this.#table}
            SET dead_lettered_at = $2::timestamptz,
                dead_letter_reason = $3,
                last_error = $3,
                retry_count = $4,
                next_attempt_at = NULL
          WHERE outbox_id = $1 AND processed_at IS NULL AND dead_lettered_at IS NULL;`,
        [outboxId, deadLetteredAt, reason, retryCount],
      );
    } finally {
      await client.release();
    }
  }

  /** Every row this source has given up on, for an operator or a read model. */
  async deadLettered(limit: number): Promise<readonly OutboxEntry[]> {
    const client = await this.#database.connect();
    try {
      const result = await client.query<Record<string, unknown>>(
        `SELECT ${PROJECTION} FROM ${this.#table}
          WHERE dead_lettered_at IS NOT NULL
          ORDER BY dead_lettered_at ASC, outbox_id ASC
          LIMIT $1;`,
        [limit],
      );
      return result.rows.map((row) => rowToEntry(row));
    } finally {
      await client.release();
    }
  }
}

/** The columns this adapter writes, exported so a test can assert the contract is complete. */
export const OUTBOX_COLUMNS: readonly string[] = COLUMNS;

function toNullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return null;
}

function rowToEntry(row: Record<string, unknown>): OutboxEntry {
  // A kind the contract does not define is **not** coerced to `event`. It used to be, and the
  // consequence was that an unrecognised row would be published to the event log as though it were
  // an event — while the relay's own branch for unknown kinds sat unreachable. Refusing here means
  // the relay sees the failure, records it, and eventually dead-letters the row.
  if (row.kind !== 'event' && row.kind !== 'audit') {
    throw new Error(
      `outbox row ${String(row.outbox_id)} has kind "${String(row.kind)}", which is neither ` +
        '"event" nor "audit". Guessing would publish it to the wrong log',
    );
  }

  return {
    outboxId: String(row.outbox_id),
    idempotencyKey: String(row.idempotency_key),
    kind: row.kind,
    payload: row.payload,
    recordedAt: String(row.recorded_at),
    producer: String(row.producer),
    correlationId: String(row.correlation_id),
    causationId: null,
    processedAt: toNullableString(row.processed_at),
    retryCount: Number(row.retry_count ?? 0),
    lastError: toNullableString(row.last_error),
    nextAttemptAt: toNullableString(row.next_attempt_at),
    deadLetteredAt: toNullableString(row.dead_lettered_at),
    deadLetterReason: toNullableString(row.dead_letter_reason),
  };
}
