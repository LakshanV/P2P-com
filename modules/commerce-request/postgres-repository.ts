/**
 * M-03 Commerce Request — the PostgreSQL adapter.
 *
 * Implements the persistence port against `module_commerce_request`. It knows SQL and nothing else:
 * no validation, no lifecycle, no referential check. Those live in the service, where they can be
 * tested without a server.
 *
 * Every `timestamptz` is projected as UTC **text** through `to_char`, never handed to the driver as
 * a `Date`. A `Date` has millisecond resolution and a local time zone; the column has microsecond
 * resolution and none. Letting the driver parse one silently truncates the instant and moves it.
 *
 * `structured` is `jsonb` and comes back as an object. `raw_text` is `text` and comes back exactly
 * as it went in — no trim, no normalisation, no collation-dependent comparison anywhere near it.
 *
 * No statement names another unit's schema, and there is no foreign key out of
 * `module_commerce_request`. The module's outbox table lives in the same schema.
 *
 * Owned by: M-03 Commerce Request.
 */

import { databaseErrorDetail } from '../../platform/db/client.ts';
import type { Database, DatabaseClient } from '../../platform/db/client.ts';
import type { OutboxEntry } from '../../platform/outbox/types.ts';

import {
  sealCommerceRequest,
  sealInterpretation,
  sealRequestEvent,
  sealRequestMedia,
} from './immutable.ts';
import type { CommerceRequestRepository, CommerceRequestTransaction } from './repository.ts';
import {
  CommerceRequestError,
  type CommerceRequest,
  type CommerceRequestErrorCode,
  type RequestEvent,
  type RequestInterpretation,
  type RequestMedia,
} from './types.ts';
import {
  validateCommerceRequest,
  validateInterpretation,
  validateRequestEvent,
  validateRequestMedia,
} from './validate.ts';

export const COMMERCE_REQUEST_SCHEMA = 'module_commerce_request';
export const REQUEST_TABLE = `${COMMERCE_REQUEST_SCHEMA}.request`;
export const INTERPRETATION_TABLE = `${COMMERCE_REQUEST_SCHEMA}.request_interpretation`;
export const MEDIA_TABLE = `${COMMERCE_REQUEST_SCHEMA}.request_media`;
export const EVENT_TABLE = `${COMMERCE_REQUEST_SCHEMA}.request_event`;
export const OUTBOX_TABLE = `${COMMERCE_REQUEST_SCHEMA}.outbox`;

/** SQLSTATE 23505. The only driver code this adapter interprets. */
const UNIQUE_VIOLATION = '23505';

/**
 * What each unique constraint means, in M-03's vocabulary.
 *
 * Translated rather than passed through, because a driver error names a constraint and a caller
 * needs to know what it did wrong. Anything not in this table is re-thrown untouched: inventing a
 * meaning for a constraint nobody mapped would be a guess presented as a diagnosis.
 */
const CONSTRAINT_MEANINGS: Readonly<
  Record<string, { readonly code: CommerceRequestErrorCode; readonly explanation: string }>
> = {
  request_pkey: {
    code: 'duplicate-request-id',
    explanation: 'a Need with this id already exists, and a Need is never overwritten',
  },
  request_idempotency_unique: {
    code: 'idempotency-key-reuse',
    explanation: 'this idempotency key has already been used for a Need',
  },
  request_interpretation_pkey: {
    code: 'duplicate-interpretation-id',
    explanation: 'an interpretation with this id already exists',
  },
  request_interpretation_idempotency_unique: {
    code: 'idempotency-key-reuse',
    explanation: 'this idempotency key has already been used for an interpretation',
  },
  request_interpretation_version_unique: {
    code: 'duplicate-interpretation-id',
    explanation:
      'this Need already has an interpretation at that version. Versions are how the history is ' +
      'ordered, so two readings claiming the same one would make the sequence unreadable',
  },
  request_media_pkey: {
    code: 'duplicate-media-id',
    explanation: 'media with this id already exists',
  },
  request_media_idempotency_unique: {
    code: 'idempotency-key-reuse',
    explanation: 'this idempotency key has already been used for media',
  },
  request_event_pkey: {
    code: 'malformed-record',
    explanation: 'a transition with this id has already been recorded',
  },
};

function normalizeDatabaseError(error: unknown): unknown {
  if (error instanceof CommerceRequestError) return error;

  const detail = databaseErrorDetail(error);
  if (detail.code !== UNIQUE_VIOLATION) return error;

  const message = error instanceof Error ? error.message : String(error);
  const named =
    detail.constraint ??
    Object.keys(CONSTRAINT_MEANINGS).find((constraint) => message.includes(constraint));
  const meaning = named === undefined ? undefined : CONSTRAINT_MEANINGS[named];
  if (meaning === undefined) return error;

  return new CommerceRequestError(meaning.code, meaning.explanation);
}

/**
 * Project a timestamp as UTC text.
 *
 * Microsecond precision and an explicit `Z`. The alternative — letting the driver return a `Date` —
 * loses the microseconds and applies a time zone the column does not have.
 */
function utcText(column: string): string {
  return `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${column}`;
}

const REQUEST_PROJECTION = [
  'request_id',
  'account_id',
  'channel',
  'raw_text',
  'conversation_id',
  'status',
  'current_interpretation_id',
  utcText('captured_at'),
  utcText('updated_at'),
  utcText('needed_by'),
  utcText('closed_at'),
  'closure_reason',
  'correlation_id',
  'idempotency_key',
].join(', ');

const INTERPRETATION_PROJECTION = [
  'interpretation_id',
  'request_id',
  'version',
  'origin',
  'confidence_per_mille',
  'structured',
  'ai_run_id',
  'rationale',
  'supersedes_interpretation_id',
  utcText('interpreted_at'),
  'correlation_id',
  'idempotency_key',
].join(', ');

const MEDIA_PROJECTION = [
  'media_id',
  'request_id',
  'kind',
  'reference',
  'position',
  'caption',
  utcText('added_at'),
  'correlation_id',
  'idempotency_key',
].join(', ');

const EVENT_PROJECTION = [
  'event_id',
  'request_id',
  'from_status',
  'to_status',
  'reason',
  utcText('occurred_at'),
  'correlation_id',
  'idempotency_key',
].join(', ');

const OUTBOX_COLUMNS = [
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
].join(', ');

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

function toCommerceRequest(row: Record<string, unknown>): CommerceRequest {
  return sealCommerceRequest(
    validateCommerceRequest(
      {
        requestId: row.request_id,
        accountId: row.account_id,
        channel: row.channel,
        // Exactly as stored. Not trimmed on the way out any more than on the way in.
        rawText: row.raw_text,
        conversationId: row.conversation_id ?? null,
        status: row.status,
        currentInterpretationId: row.current_interpretation_id ?? null,
        capturedAt: row.captured_at,
        updatedAt: row.updated_at,
        neededBy: row.needed_by ?? null,
        closedAt: row.closed_at ?? null,
        closureReason: row.closure_reason ?? null,
        correlationId: row.correlation_id,
        idempotencyKey: row.idempotency_key,
      },
      'stored row',
    ),
  );
}

function toInterpretation(row: Record<string, unknown>): RequestInterpretation {
  return sealInterpretation(
    validateInterpretation(
      {
        interpretationId: row.interpretation_id,
        requestId: row.request_id,
        version: row.version,
        origin: row.origin,
        confidencePerMille: row.confidence_per_mille,
        structured: row.structured,
        aiRunId: row.ai_run_id ?? null,
        rationale: row.rationale,
        supersedesInterpretationId: row.supersedes_interpretation_id ?? null,
        interpretedAt: row.interpreted_at,
        correlationId: row.correlation_id,
        idempotencyKey: row.idempotency_key,
      },
      'stored row',
    ),
  );
}

function toRequestMedia(row: Record<string, unknown>): RequestMedia {
  return sealRequestMedia(
    validateRequestMedia(
      {
        mediaId: row.media_id,
        requestId: row.request_id,
        kind: row.kind,
        reference: row.reference,
        position: row.position,
        caption: row.caption,
        addedAt: row.added_at,
        correlationId: row.correlation_id,
        idempotencyKey: row.idempotency_key,
      },
      'stored row',
    ),
  );
}

function toRequestEvent(row: Record<string, unknown>): RequestEvent {
  return sealRequestEvent(
    validateRequestEvent(
      {
        eventId: row.event_id,
        requestId: row.request_id,
        fromStatus: row.from_status ?? null,
        toStatus: row.to_status,
        reason: row.reason,
        occurredAt: row.occurred_at,
        correlationId: row.correlation_id,
        idempotencyKey: row.idempotency_key,
      },
      'stored row',
    ),
  );
}

const TRANSACTION_CONTROL = /^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|START\s+TRANSACTION)\b/i;

/**
 * A client that refuses to open, commit or roll back a transaction.
 *
 * Used when M-03 is enlisted in somebody else's transaction. The point is that a producing module
 * writing its outbox inside a caller's transaction must not be able to commit it early — the whole
 * value of the outbox is that the fact and its publication share one transaction.
 */
export function enlistedClient(client: DatabaseClient): DatabaseClient {
  return {
    query<QueryRow = Record<string, unknown>>(sql: string, params?: readonly unknown[]) {
      if (TRANSACTION_CONTROL.test(sql)) {
        return Promise.reject(
          new CommerceRequestError(
            'malformed-record',
            `an enlisted commerce-request write may not issue "${sql.trim().split(/\s+/, 2).join(' ')}". ` +
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

class PostgresCommerceRequestTransaction implements CommerceRequestTransaction {
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

  async findRequestById(requestId: string): Promise<CommerceRequest | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${REQUEST_PROJECTION} FROM ${REQUEST_TABLE} WHERE request_id = $1;`,
      [requestId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toCommerceRequest(row);
  }

  async findRequestByIdempotencyKey(idempotencyKey: string): Promise<CommerceRequest | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${REQUEST_PROJECTION} FROM ${REQUEST_TABLE} WHERE idempotency_key = $1;`,
      [idempotencyKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : toCommerceRequest(row);
  }

  async findRequestsByAccountId(accountId: string): Promise<readonly CommerceRequest[]> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${REQUEST_PROJECTION} FROM ${REQUEST_TABLE}
       WHERE account_id = $1
       ORDER BY captured_at DESC, request_id;`,
      [accountId],
    );
    return Object.freeze(result.rows.map(toCommerceRequest));
  }

  async insertRequest(request: CommerceRequest): Promise<void> {
    try {
      await this.#client.query(
        `INSERT INTO ${REQUEST_TABLE}
           (request_id, account_id, channel, raw_text, conversation_id, status,
            current_interpretation_id, captured_at, updated_at, needed_by, closed_at,
            closure_reason, correlation_id, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14);`,
        [
          request.requestId,
          request.accountId,
          request.channel,
          request.rawText,
          request.conversationId,
          request.status,
          request.currentInterpretationId,
          request.capturedAt,
          request.updatedAt,
          request.neededBy,
          request.closedAt,
          request.closureReason,
          request.correlationId,
          request.idempotencyKey,
        ],
      );
    } catch (error) {
      throw normalizeDatabaseError(error);
    }
  }

  /**
   * Update the mutable part of a Need.
   *
   * `raw_text`, `account_id` and `captured_at` are deliberately **not** in the SET list, and a
   * trigger refuses an UPDATE that changes them anyway. Two layers on purpose: this one makes the
   * intent readable, and the trigger survives somebody editing this one.
   */
  async updateRequest(request: CommerceRequest): Promise<void> {
    try {
      const result = await this.#client.query(
        `UPDATE ${REQUEST_TABLE}
            SET status = $2,
                current_interpretation_id = $3,
                updated_at = $4,
                needed_by = $5,
                closed_at = $6,
                closure_reason = $7
          WHERE request_id = $1;`,
        [
          request.requestId,
          request.status,
          request.currentInterpretationId,
          request.updatedAt,
          request.neededBy,
          request.closedAt,
          request.closureReason,
        ],
      );
      if (result.rowCount === 0) {
        throw new CommerceRequestError(
          'request-not-found',
          `request ${request.requestId} does not exist`,
        );
      }
    } catch (error) {
      throw normalizeDatabaseError(error);
    }
  }

  async findInterpretationById(interpretationId: string): Promise<RequestInterpretation | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${INTERPRETATION_PROJECTION} FROM ${INTERPRETATION_TABLE}
       WHERE interpretation_id = $1;`,
      [interpretationId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toInterpretation(row);
  }

  async findInterpretationByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<RequestInterpretation | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${INTERPRETATION_PROJECTION} FROM ${INTERPRETATION_TABLE}
       WHERE idempotency_key = $1;`,
      [idempotencyKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : toInterpretation(row);
  }

  async findInterpretationsByRequestId(
    requestId: string,
  ): Promise<readonly RequestInterpretation[]> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${INTERPRETATION_PROJECTION} FROM ${INTERPRETATION_TABLE}
       WHERE request_id = $1
       ORDER BY version;`,
      [requestId],
    );
    return Object.freeze(result.rows.map(toInterpretation));
  }

  async insertInterpretation(interpretation: RequestInterpretation): Promise<void> {
    try {
      await this.#client.query(
        `INSERT INTO ${INTERPRETATION_TABLE}
           (interpretation_id, request_id, version, origin, confidence_per_mille, structured,
            ai_run_id, rationale, supersedes_interpretation_id, interpreted_at, correlation_id,
            idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12);`,
        [
          interpretation.interpretationId,
          interpretation.requestId,
          interpretation.version,
          interpretation.origin,
          interpretation.confidencePerMille,
          JSON.stringify(interpretation.structured),
          interpretation.aiRunId,
          interpretation.rationale,
          interpretation.supersedesInterpretationId,
          interpretation.interpretedAt,
          interpretation.correlationId,
          interpretation.idempotencyKey,
        ],
      );
    } catch (error) {
      throw normalizeDatabaseError(error);
    }
  }

  async findMediaById(mediaId: string): Promise<RequestMedia | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${MEDIA_PROJECTION} FROM ${MEDIA_TABLE} WHERE media_id = $1;`,
      [mediaId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toRequestMedia(row);
  }

  async findMediaByIdempotencyKey(idempotencyKey: string): Promise<RequestMedia | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${MEDIA_PROJECTION} FROM ${MEDIA_TABLE} WHERE idempotency_key = $1;`,
      [idempotencyKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : toRequestMedia(row);
  }

  async findMediaByRequestId(requestId: string): Promise<readonly RequestMedia[]> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${MEDIA_PROJECTION} FROM ${MEDIA_TABLE}
       WHERE request_id = $1
       ORDER BY position, media_id;`,
      [requestId],
    );
    return Object.freeze(result.rows.map(toRequestMedia));
  }

  async insertMedia(media: RequestMedia): Promise<void> {
    try {
      await this.#client.query(
        `INSERT INTO ${MEDIA_TABLE}
           (media_id, request_id, kind, reference, position, caption, added_at, correlation_id,
            idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9);`,
        [
          media.mediaId,
          media.requestId,
          media.kind,
          media.reference,
          media.position,
          media.caption,
          media.addedAt,
          media.correlationId,
          media.idempotencyKey,
        ],
      );
    } catch (error) {
      throw normalizeDatabaseError(error);
    }
  }

  async findEventsByRequestId(requestId: string): Promise<readonly RequestEvent[]> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${EVENT_PROJECTION} FROM ${EVENT_TABLE}
       WHERE request_id = $1
       ORDER BY occurred_at, event_id;`,
      [requestId],
    );
    return Object.freeze(result.rows.map(toRequestEvent));
  }

  /**
   * Record a transition.
   *
   * `ON CONFLICT DO NOTHING`, because a replayed transition writes the same row and the log is a
   * record of what happened rather than of how many times somebody asked. The in-memory
   * implementation does the same thing, so the two agree.
   */
  async insertEvent(event: RequestEvent): Promise<void> {
    try {
      await this.#client.query(
        `INSERT INTO ${EVENT_TABLE}
           (event_id, request_id, from_status, to_status, reason, occurred_at, correlation_id,
            idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (event_id) DO NOTHING;`,
        [
          event.eventId,
          event.requestId,
          event.fromStatus,
          event.toStatus,
          event.reason,
          event.occurredAt,
          event.correlationId,
          event.idempotencyKey,
        ],
      );
    } catch (error) {
      throw normalizeDatabaseError(error);
    }
  }
}

/** M-03 enlisted in a transaction somebody else opened. */
export class EnlistedCommerceRequestRepository implements CommerceRequestRepository {
  readonly #client: DatabaseClient;

  constructor(client: DatabaseClient) {
    this.#client = enlistedClient(client);
  }

  withTransaction<T>(body: (tx: CommerceRequestTransaction) => Promise<T>): Promise<T> {
    return body(new PostgresCommerceRequestTransaction(this.#client));
  }
}

export class PostgresCommerceRequestRepository implements CommerceRequestRepository {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  static enlist(client: DatabaseClient): CommerceRequestRepository {
    return new EnlistedCommerceRequestRepository(client);
  }

  async withTransaction<T>(body: (tx: CommerceRequestTransaction) => Promise<T>): Promise<T> {
    const client = await this.#database.connect();
    try {
      await client.query('BEGIN;');
      try {
        const result = await body(new PostgresCommerceRequestTransaction(client));
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

export { toCommerceRequest, toInterpretation, toRequestEvent, toRequestMedia };
