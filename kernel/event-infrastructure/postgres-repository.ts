/**
 * K-08 Event Infrastructure — the PostgreSQL adapter (FND-003b).
 *
 * Implements the persistence port against `kernel_event_infrastructure`. It knows SQL and nothing
 * else: no validation, no retry policy, no lifecycle rules. Those live in the service, where they
 * can be tested without a server.
 *
 * PostgreSQL is the transport here, not merely the store. That is deliberate for a foundation
 * slice: a table with `FOR UPDATE SKIP LOCKED` gives durable at-least-once delivery, and — far more
 * importantly — it lets a producing module append its domain rows and its events **in the same
 * transaction**. No broker can offer that, and every "we published the event but the write rolled
 * back" incident comes from pretending otherwise. Swapping in a broker later means writing another
 * implementation of the port, not changing a caller.
 *
 * **Timestamps are read as text, not as values.** Every `timestamptz` is projected through
 * `to_char(… AT TIME ZONE 'UTC', …)`, because the driver's default parser produces a `Date` and a
 * `Date` holds milliseconds where the column holds microseconds. Lease expiry and retry due-times
 * are comparisons; precision silently lost in the driver is precision lost before anything here
 * can notice. Same reasoning, and the same projection, as K-05's adapter.
 *
 * Owned by: K-08 Event Infrastructure.
 */

import { databaseErrorDetail } from '../../platform/db/client.ts';
import type { Database, DatabaseClient } from '../../platform/db/client.ts';
import { InvalidInstantError, parseInstant } from '../../platform/time/instant.ts';

import type { ClaimRequest, EventRepository, EventTransaction } from './repository.ts';
import {
  EventError,
  type ConsumerReceipt,
  type Delivery,
  type DeliveryStatus,
  type EventErrorCode,
  type EventEnvelope,
  type EventOrigin,
  type EventPayload,
  type JsonScalar,
} from './types.ts';

export const EVENT_SCHEMA = 'kernel_event_infrastructure';
export const EVENT_TABLE = `${EVENT_SCHEMA}.event`;
export const DELIVERY_TABLE = `${EVENT_SCHEMA}.event_delivery`;
export const RECEIPT_TABLE = `${EVENT_SCHEMA}.event_receipt`;

/** SQLSTATE 23505. The only driver code this adapter interprets. */
const UNIQUE_VIOLATION = '23505';

/**
 * What a violation of each declared constraint actually means.
 *
 * Without this, a race surfaces as `duplicate key value violates unique constraint "…"` — an error
 * with no code, absent from the refusal table, naming an index rather than saying what happened.
 */
const CONSTRAINT_MEANINGS: Readonly<
  Record<string, { readonly code: EventErrorCode; readonly explanation: string }>
> = {
  event_pkey: {
    code: 'duplicate-event-id',
    explanation: 'an event with this id already exists, and an event is never rewritten',
  },
  event_idempotency_unique: {
    code: 'idempotency-key-reuse',
    explanation: 'this idempotency key has already been used by a publication that got there first',
  },
  event_delivery_pkey: {
    code: 'concurrent-modification',
    explanation: 'a delivery with this id already exists',
  },
  event_delivery_generation_unique: {
    code: 'concurrent-modification',
    explanation:
      'this subscription already has a delivery at this generation for this event — a replay ' +
      'appends the next generation rather than reusing one, so another replay got there first',
  },
  event_delivery_claim_token_unique: {
    code: 'claim-token-reuse',
    explanation: 'this claim token is already held; a token identifies one claim and is not reused',
  },
  event_receipt_pkey: {
    code: 'concurrent-modification',
    explanation:
      'this subscription has already recorded a receipt for this event — another worker ' +
      'acknowledged it first, so this one has lost the race and must not acknowledge as well',
  },
};

function normalizeDatabaseError(error: unknown, operation: string): unknown {
  if (error instanceof EventError) return error;

  const detail = databaseErrorDetail(error);
  if (detail.code !== UNIQUE_VIOLATION) return error;

  const message = error instanceof Error ? error.message : String(error);
  const named =
    detail.constraint ??
    Object.keys(CONSTRAINT_MEANINGS).find((constraint) => message.includes(constraint));
  const meaning = named === undefined ? undefined : CONSTRAINT_MEANINGS[named];
  if (meaning === undefined) return error;

  return new EventError(meaning.code, `${operation} was refused: ${meaning.explanation}`);
}

const EVENT_COLUMN_NAMES = [
  'event_id',
  'event_type',
  'schema_version',
  'occurred_at',
  'recorded_at',
  'producer',
  'correlation_id',
  'causation_id',
  'payload',
  'payload_fingerprint',
  'idempotency_key',
  'origin',
] as const;

const DELIVERY_COLUMN_NAMES = [
  'delivery_id',
  'event_id',
  'subscription',
  'generation',
  'status',
  'attempts',
  'next_attempt_at',
  'claimed_by',
  'claim_token',
  'claim_expires_at',
  'last_error',
  'completed_at',
  'created_at',
  'replay_of',
  'replay_reason',
] as const;

const RECEIPT_COLUMN_NAMES = ['subscription', 'event_id', 'delivery_id', 'processed_at'] as const;

/** Every `timestamptz` in this schema. All are projected as text; none reaches the Date parser. */
export const TIMESTAMP_COLUMNS = [
  'occurred_at',
  'recorded_at',
  'next_attempt_at',
  'claim_expires_at',
  'completed_at',
  'created_at',
  'processed_at',
] as const;

/** Deterministic UTC text: no session TimeZone, no locale field, six fractional digits. */
function utcText(column: string): string {
  return `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${column}`;
}

const project = (columns: readonly string[]): string =>
  columns
    .map((column) =>
      (TIMESTAMP_COLUMNS as readonly string[]).includes(column) ? utcText(column) : column,
    )
    .join(', ');

const EVENT_COLUMNS = EVENT_COLUMN_NAMES.join(', ');
const EVENT_PROJECTION = project(EVENT_COLUMN_NAMES);
const DELIVERY_COLUMNS = DELIVERY_COLUMN_NAMES.join(', ');
const DELIVERY_PROJECTION = project(DELIVERY_COLUMN_NAMES);
const RECEIPT_COLUMNS = RECEIPT_COLUMN_NAMES.join(', ');
const RECEIPT_PROJECTION = project(RECEIPT_COLUMN_NAMES);

/** Exactly what `utcText` emits, and nothing else. */
const STORED_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/;

/**
 * Decode a stored instant, or refuse.
 *
 * No fallback through `new Date(…)`. A wrong instant here decides whether a lease has expired and
 * whether a retry is due; approximating one silently would hand the same delivery to two workers.
 */
function instant(value: unknown, column: string): string {
  if (typeof value !== 'string') {
    throw new EventError(
      'malformed-envelope',
      `${column} came back as ${value instanceof Date ? 'a Date' : typeof value} rather than ` +
        'text. Timestamps are projected through to_char precisely so the driver never parses them',
    );
  }
  const match = STORED_INSTANT.exec(value);
  if (match === null) {
    throw new EventError(
      'malformed-envelope',
      `${column} holds "${value}", which is not a finite UTC timestamp in the projected form ` +
        'YYYY-MM-DDTHH:MM:SS.ffffffZ',
    );
  }
  try {
    parseInstant(value);
  } catch (error) {
    if (error instanceof InvalidInstantError) {
      throw new EventError('malformed-envelope', `${column}: ${error.message}`);
    }
    throw error;
  }
  const [, year, month, day, hour, minute, second, fraction = ''] = match;
  const digits = fraction.replace(/0+$/, '');
  return `${year}-${month}-${day}T${hour}:${minute}:${second}${digits === '' ? '' : `.${digits}`}Z`;
}

function optionalInstant(value: unknown, column: string): string | null {
  return value === null || value === undefined ? null : instant(value, column);
}

/**
 * Payloads are stored as `jsonb` and decoded back to a flat scalar map.
 *
 * The registry permits only flat scalars, so anything nested in a stored row was written around
 * this component. Refused rather than passed through: a consumer that receives a shape the
 * registry never declared has no contract to validate it against.
 */
export function decodePayload(value: unknown, eventId: string): EventPayload {
  const parsed = typeof value === 'string' ? safeParse(value, eventId) : value;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new EventError(
      'invalid-payload',
      `event ${eventId} has a payload that is not a JSON object`,
    );
  }
  const out: Record<string, JsonScalar> = {};
  for (const [key, entry] of Object.entries(parsed as Record<string, unknown>)) {
    if (
      entry !== null &&
      typeof entry !== 'string' &&
      typeof entry !== 'number' &&
      typeof entry !== 'boolean'
    ) {
      throw new EventError(
        'invalid-payload',
        `event ${eventId} payload field "${key}" is ${typeof entry}; only flat scalars are ` +
          'declarable, so a nested value cannot have been validated against any registered schema',
      );
    }
    out[key] = entry;
  }
  return Object.freeze(out);
}

function safeParse(text: string, eventId: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new EventError(
      'invalid-payload',
      `event ${eventId} has a payload that is not valid JSON`,
    );
  }
}

interface EventRow {
  readonly event_id: string;
  readonly event_type: string;
  readonly schema_version: number | string;
  readonly occurred_at: unknown;
  readonly recorded_at: unknown;
  readonly producer: string;
  readonly correlation_id: string;
  readonly causation_id: string | null;
  readonly payload: unknown;
  readonly payload_fingerprint: string;
  readonly idempotency_key: string;
  readonly origin: string;
}

interface DeliveryRow {
  readonly delivery_id: string;
  readonly event_id: string;
  readonly subscription: string;
  readonly generation: number | string;
  readonly status: string;
  readonly attempts: number | string;
  readonly next_attempt_at: unknown;
  readonly claimed_by: string | null;
  readonly claim_token: string | null;
  readonly claim_expires_at: unknown;
  readonly last_error: string | null;
  readonly completed_at: unknown;
  readonly created_at: unknown;
  readonly replay_of: string | null;
  readonly replay_reason: string | null;
}

interface ReceiptRow {
  readonly subscription: string;
  readonly event_id: string;
  readonly delivery_id: string;
  readonly processed_at: unknown;
}

/** `bigint` and `numeric` come back as text from the driver; counts must still be numbers. */
function count(value: number | string, column: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new EventError('malformed-envelope', `${column} holds ${String(value)}, not an integer`);
  }
  return parsed;
}

export function toEnvelope(row: EventRow): EventEnvelope {
  return {
    eventId: row.event_id,
    type: row.event_type,
    schemaVersion: count(row.schema_version, 'schema_version'),
    occurredAt: instant(row.occurred_at, 'occurred_at'),
    recordedAt: instant(row.recorded_at, 'recorded_at'),
    producer: row.producer,
    correlationId: row.correlation_id,
    causationId: row.causation_id,
    payload: decodePayload(row.payload, row.event_id),
    payloadFingerprint: row.payload_fingerprint,
    idempotencyKey: row.idempotency_key,
    origin: row.origin as EventOrigin,
  };
}

export function toDelivery(row: DeliveryRow): Delivery {
  return {
    deliveryId: row.delivery_id,
    eventId: row.event_id,
    subscription: row.subscription,
    generation: count(row.generation, 'generation'),
    status: row.status as DeliveryStatus,
    attempts: count(row.attempts, 'attempts'),
    nextAttemptAt: instant(row.next_attempt_at, 'next_attempt_at'),
    claimedBy: row.claimed_by,
    claimToken: row.claim_token,
    claimExpiresAt: optionalInstant(row.claim_expires_at, 'claim_expires_at'),
    lastError: row.last_error,
    completedAt: optionalInstant(row.completed_at, 'completed_at'),
    createdAt: instant(row.created_at, 'created_at'),
    replayOf: row.replay_of,
    replayReason: row.replay_reason,
  };
}

export function toReceipt(row: ReceiptRow): ConsumerReceipt {
  return {
    subscription: row.subscription,
    eventId: row.event_id,
    deliveryId: row.delivery_id,
    processedAt: instant(row.processed_at, 'processed_at'),
  };
}

/** Statements that begin, end or subdivide a transaction. An enlisted path may issue none of them. */
const TRANSACTION_CONTROL =
  /^\s*(BEGIN|START\s+TRANSACTION|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE\s+SAVEPOINT)\b/i;

/**
 * A client that refuses transaction control and never releases the connection.
 *
 * Both halves matter, and both protect the caller rather than this component:
 *
 *   - **No transaction control.** PostgreSQL has no true nested transactions. A `BEGIN` inside an
 *     open transaction warns and is ignored; a `COMMIT` ends the *caller's* transaction, so the
 *     domain rows the caller had not finished writing are committed early and its later `ROLLBACK`
 *     silently rolls back nothing. That failure is invisible at the point it happens and surfaces
 *     as inexplicable partial writes much later.
 *   - **No release.** The connection belongs to the caller. Releasing it mid-transaction would
 *     abort work this component knows nothing about.
 *
 * This is a guard rather than a convention: a future refactor that added a `BEGIN` to a shared code
 * path would fail loudly here instead of corrupting a caller's transaction boundary.
 */
export function enlistedClient(client: DatabaseClient): DatabaseClient {
  return {
    query<Row = Record<string, unknown>>(sql: string, params?: readonly unknown[]) {
      if (TRANSACTION_CONTROL.test(sql)) {
        return Promise.reject(
          new EventError(
            'nested-transaction',
            `an enlisted event append may not issue "${sql.trim().split(/\s+/, 2).join(' ')}". ` +
              'The transaction belongs to the caller: PostgreSQL has no nested transactions, so ' +
              "this would end the caller's transaction rather than a nested one, committing " +
              'domain writes it had not finished making',
          ),
        );
      }
      return client.query<Row>(sql, params);
    },
    release(): Promise<void> {
      // Deliberately nothing. The caller opened this connection and will close it.
      return Promise.resolve();
    },
  };
}

/**
 * An event repository that runs inside a transaction somebody else opened.
 *
 * This is the mechanism CONTRACT.md §4 describes: a producing module opens one transaction, writes
 * its domain rows and appends its event through this, and the two commit together or not at all.
 * Publishing after the caller's commit loses the event if the process dies in between; publishing
 * before it announces something that may still roll back. Only sharing the transaction avoids both.
 *
 * `withTransaction` here does not open a transaction — it runs the body against the caller's
 * client and lets every failure propagate, because the caller's `ROLLBACK` is what must undo the
 * append. Swallowing an error here would commit domain state with no event, which is the exact
 * outcome this exists to prevent.
 *
 * No business module uses this yet; K-08 has no producer. It is the capability, not an integration.
 */
export class EnlistedEventRepository implements EventRepository {
  readonly #client: DatabaseClient;

  constructor(client: DatabaseClient) {
    this.#client = enlistedClient(client);
  }

  withTransaction<T>(body: (tx: EventTransaction) => Promise<T>): Promise<T> {
    return body(new PostgresEventTransaction(this.#client));
  }
}

export class PostgresEventRepository implements EventRepository {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  /**
   * An event repository enlisted in a transaction the caller already opened.
   *
   * Named on this class so that the two paths are read together: this one composes with a caller's
   * transaction, `withTransaction` below owns its own. Both write through the same
   * `PostgresEventTransaction`, so there is one implementation of every statement and no second
   * copy to keep in step.
   */
  static enlist(client: DatabaseClient): EventRepository {
    return new EnlistedEventRepository(client);
  }

  async withTransaction<T>(body: (tx: EventTransaction) => Promise<T>): Promise<T> {
    const client = await this.#database.connect();
    try {
      await client.query('BEGIN;');
      try {
        const result = await body(new PostgresEventTransaction(client));
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

class PostgresEventTransaction implements EventTransaction {
  readonly #client: DatabaseClient;

  constructor(client: DatabaseClient) {
    this.#client = client;
  }

  /** Run a mutation, translating the constraint violations this schema can produce. */
  async #run<T>(operation: string, body: () => Promise<T>): Promise<T> {
    try {
      return await body();
    } catch (error) {
      throw normalizeDatabaseError(error, operation);
    }
  }

  async findEventById(eventId: string): Promise<EventEnvelope | null> {
    const result = await this.#client.query<EventRow>(
      `SELECT ${EVENT_PROJECTION} FROM ${EVENT_TABLE} WHERE event_id = $1;`,
      [eventId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toEnvelope(row);
  }

  async findEventByIdempotencyKey(idempotencyKey: string): Promise<EventEnvelope | null> {
    const result = await this.#client.query<EventRow>(
      `SELECT ${EVENT_PROJECTION} FROM ${EVENT_TABLE} WHERE idempotency_key = $1;`,
      [idempotencyKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : toEnvelope(row);
  }

  async insertEvent(envelope: EventEnvelope): Promise<void> {
    await this.#run('insertEvent', () =>
      this.#client.query(
        `INSERT INTO ${EVENT_TABLE} (${EVENT_COLUMNS})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12);`,
        [
          envelope.eventId,
          envelope.type,
          envelope.schemaVersion,
          envelope.occurredAt,
          envelope.recordedAt,
          envelope.producer,
          envelope.correlationId,
          envelope.causationId,
          JSON.stringify(envelope.payload),
          envelope.payloadFingerprint,
          envelope.idempotencyKey,
          envelope.origin,
        ],
      ),
    );
  }

  async findDeliveryById(deliveryId: string): Promise<Delivery | null> {
    const result = await this.#client.query<DeliveryRow>(
      `SELECT ${DELIVERY_PROJECTION} FROM ${DELIVERY_TABLE} WHERE delivery_id = $1;`,
      [deliveryId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toDelivery(row);
  }

  async findDeliveriesForEvent(eventId: string): Promise<readonly Delivery[]> {
    const result = await this.#client.query<DeliveryRow>(
      `SELECT ${DELIVERY_PROJECTION} FROM ${DELIVERY_TABLE}
        WHERE event_id = $1
        ORDER BY event_delivery.generation ASC, event_delivery.subscription ASC;`,
      [eventId],
    );
    return result.rows.map(toDelivery);
  }

  async findLatestDelivery(eventId: string, subscription: string): Promise<Delivery | null> {
    const result = await this.#client.query<DeliveryRow>(
      `SELECT ${DELIVERY_PROJECTION} FROM ${DELIVERY_TABLE}
        WHERE event_id = $1 AND subscription = $2
        ORDER BY event_delivery.generation DESC
        LIMIT 1;`,
      [eventId, subscription],
    );
    const row = result.rows[0];
    return row === undefined ? null : toDelivery(row);
  }

  async insertDelivery(delivery: Delivery): Promise<void> {
    await this.#run('insertDelivery', () =>
      this.#client.query(
        `INSERT INTO ${DELIVERY_TABLE} (${DELIVERY_COLUMNS})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15);`,
        [
          delivery.deliveryId,
          delivery.eventId,
          delivery.subscription,
          delivery.generation,
          delivery.status,
          delivery.attempts,
          delivery.nextAttemptAt,
          delivery.claimedBy,
          delivery.claimToken,
          delivery.claimExpiresAt,
          delivery.lastError,
          delivery.completedAt,
          delivery.createdAt,
          delivery.replayOf,
          delivery.replayReason,
        ],
      ),
    );
  }

  /**
   * Claim due work atomically.
   *
   * `FOR UPDATE SKIP LOCKED` in the sub-select is what makes two workers running this statement at
   * the same instant take *different* rows rather than blocking on each other or taking the same
   * one. The `UPDATE … WHERE delivery_id IN (…)` then stamps the claim, so selection and
   * acquisition are one statement and there is no window between them.
   *
   * The predicate is the definition of "due": pending and ready, or in-flight with a dead lease —
   * the second is how a crashed worker's delivery returns to the pool without an operator.
   */
  async claimDueDeliveries(request: ClaimRequest): Promise<readonly Delivery[]> {
    const result = await this.#run('claimDueDeliveries', () =>
      this.#client.query<DeliveryRow>(
        `UPDATE ${DELIVERY_TABLE} AS target
            SET status = 'in-flight',
                attempts = target.attempts + 1,
                claimed_by = $4,
                claim_token = $5,
                claim_expires_at = $6
          WHERE target.delivery_id IN (
                SELECT due.delivery_id FROM ${DELIVERY_TABLE} AS due
                 WHERE due.subscription = $1
                   AND ((due.status = 'pending' AND due.next_attempt_at <= $2)
                     OR (due.status = 'in-flight' AND due.claim_expires_at <= $2))
                 ORDER BY due.next_attempt_at ASC, due.delivery_id ASC
                 LIMIT $3
                   FOR UPDATE SKIP LOCKED)
      RETURNING ${DELIVERY_PROJECTION};`,
        [
          request.subscription,
          request.now,
          request.limit,
          request.worker,
          request.claimToken,
          request.claimExpiresAt,
        ],
      ),
    );
    return result.rows.map(toDelivery);
  }

  async completeDelivery(
    deliveryId: string,
    claimToken: string,
    completedAt: string,
  ): Promise<void> {
    await this.#guarded(
      'completeDelivery',
      deliveryId,
      claimToken,
      `UPDATE ${DELIVERY_TABLE}
          SET status = 'delivered', completed_at = $3,
              claimed_by = NULL, claim_token = NULL, claim_expires_at = NULL
        WHERE delivery_id = $1 AND claim_token = $2 AND status = 'in-flight';`,
      [deliveryId, claimToken, completedAt],
    );
  }

  async rescheduleDelivery(
    deliveryId: string,
    claimToken: string,
    nextAttemptAt: string,
    lastError: string,
  ): Promise<void> {
    await this.#guarded(
      'rescheduleDelivery',
      deliveryId,
      claimToken,
      `UPDATE ${DELIVERY_TABLE}
          SET status = 'pending', next_attempt_at = $3, last_error = $4,
              claimed_by = NULL, claim_token = NULL, claim_expires_at = NULL
        WHERE delivery_id = $1 AND claim_token = $2 AND status = 'in-flight';`,
      [deliveryId, claimToken, nextAttemptAt, lastError],
    );
  }

  async deadLetterDelivery(
    deliveryId: string,
    claimToken: string,
    at: string,
    lastError: string,
  ): Promise<void> {
    await this.#guarded(
      'deadLetterDelivery',
      deliveryId,
      claimToken,
      `UPDATE ${DELIVERY_TABLE}
          SET status = 'dead-lettered', completed_at = $3, last_error = $4,
              claimed_by = NULL, claim_token = NULL, claim_expires_at = NULL
        WHERE delivery_id = $1 AND claim_token = $2 AND status = 'in-flight';`,
      [deliveryId, claimToken, at, lastError],
    );
  }

  /**
   * Every terminal transition, guarded identically and diagnosed identically.
   *
   * When the guarded UPDATE changes nothing, a second read says *why* — gone, already terminal, or
   * claimed by somebody else. Without it every lost race reports "0 rows", which tells an operator
   * nothing and tells the service too little to decide whether to rethrow.
   */
  async #guarded(
    operation: string,
    deliveryId: string,
    claimToken: string,
    sql: string,
    params: readonly unknown[],
  ): Promise<void> {
    const result = await this.#run(operation, () => this.#client.query(sql, params));
    if (result.rowCount > 0) return;

    const current = await this.findDeliveryById(deliveryId);
    if (current === null) {
      throw new EventError('no-such-delivery', `no delivery ${deliveryId} to ${operation}`);
    }
    if (current.status === 'delivered' || current.status === 'dead-lettered') {
      throw new EventError(
        'obsolete-delivery',
        `delivery ${deliveryId} is already ${current.status}. A terminal delivery is never ` +
          'reopened; a replay appends a new generation instead',
      );
    }
    throw new EventError(
      'stale-claim',
      `delivery ${deliveryId} is ${current.status} holding ${current.claimToken ?? 'no claim'}, ` +
        `not claim "${claimToken}". The lease was lost and another worker owns this delivery`,
    );
  }

  async findReceipt(subscription: string, eventId: string): Promise<ConsumerReceipt | null> {
    const result = await this.#client.query<ReceiptRow>(
      `SELECT ${RECEIPT_PROJECTION} FROM ${RECEIPT_TABLE}
        WHERE subscription = $1 AND event_id = $2;`,
      [subscription, eventId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toReceipt(row);
  }

  async insertReceipt(receipt: ConsumerReceipt): Promise<void> {
    await this.#run('insertReceipt', () =>
      this.#client.query(
        `INSERT INTO ${RECEIPT_TABLE} (${RECEIPT_COLUMNS}) VALUES ($1, $2, $3, $4);`,
        [receipt.subscription, receipt.eventId, receipt.deliveryId, receipt.processedAt],
      ),
    );
  }

  async deleteReceipt(subscription: string, eventId: string): Promise<boolean> {
    const result = await this.#run('deleteReceipt', () =>
      this.#client.query(
        `DELETE FROM ${RECEIPT_TABLE} WHERE subscription = $1 AND event_id = $2;`,
        [subscription, eventId],
      ),
    );
    return result.rowCount > 0;
  }
}
