/**
 * K-09 Audit Foundation — the PostgreSQL adapter (FND-003c).
 *
 * Implements the persistence port against `kernel_audit_foundation`. It knows SQL and nothing else:
 * no validation, no classification rules, no lifecycle. Those live in the service, where they can
 * be tested without a server.
 *
 * Three properties are load-bearing and each is a decision:
 *
 *   - **No UPDATE, no DELETE.** Not anywhere in this file. The migration adds a trigger that
 *     refuses both at the database as well, so a write around this adapter still cannot edit
 *     history. An audit trail that can be amended is not evidence.
 *   - **Timestamps are read as text.** Every `timestamptz` is projected through
 *     `to_char(… AT TIME ZONE 'UTC', …)`, because the driver's default parser produces a `Date` and
 *     a `Date` holds milliseconds where the column holds microseconds. Ordering and pagination both
 *     compare instants; precision lost in the driver would make two records that were distinct
 *     collide, and a paginated read then skips or repeats rows.
 *   - **Decoding is fail-closed.** A row that does not decode is refused rather than approximated.
 *     A wrong audit record is worse than a missing one: it is read as fact.
 *
 * Owned by: K-09 Audit Foundation.
 */

import { databaseErrorDetail } from '../../platform/db/client.ts';
import type { Database, DatabaseClient } from '../../platform/db/client.ts';
import { InvalidInstantError, parseInstant } from '../../platform/time/instant.ts';

import { fingerprintRecord } from './fingerprint.ts';
import { sealRecord } from './immutable.ts';

import type {
  AuditCursor,
  AuditPage,
  AuditQuery,
  AuditRepository,
  AuditTransaction,
} from './repository.ts';
import {
  AuditError,
  type AuditErrorCode,
  type AuditEvidence,
  type AuditRecord,
  type AuditOutcome,
  type ActorKind,
  type AuthenticationMethod,
  type EvidenceValue,
} from './types.ts';

export const AUDIT_SCHEMA = 'kernel_audit_foundation';
export const AUDIT_TABLE = `${AUDIT_SCHEMA}.audit_record`;

/** SQLSTATE 23505. The only driver code this adapter interprets. */
const UNIQUE_VIOLATION = '23505';

/** What a violation of each declared constraint actually means. */
const CONSTRAINT_MEANINGS: Readonly<
  Record<string, { readonly code: AuditErrorCode; readonly explanation: string }>
> = {
  audit_record_pkey: {
    code: 'duplicate-record-id',
    explanation: 'a record with this id already exists, and an audit record is never rewritten',
  },
  audit_record_idempotency_unique: {
    code: 'idempotency-key-reuse',
    explanation: 'this idempotency key has already been used by a recording that got there first',
  },
};

function normalizeDatabaseError(error: unknown, operation: string): unknown {
  if (error instanceof AuditError) return error;

  const detail = databaseErrorDetail(error);
  if (detail.code !== UNIQUE_VIOLATION) return error;

  const message = error instanceof Error ? error.message : String(error);
  const named =
    detail.constraint ??
    Object.keys(CONSTRAINT_MEANINGS).find((constraint) => message.includes(constraint));
  const meaning = named === undefined ? undefined : CONSTRAINT_MEANINGS[named];
  if (meaning === undefined) return error;

  return new AuditError(meaning.code, `${operation} was refused: ${meaning.explanation}`);
}

const COLUMN_NAMES = [
  'record_id',
  'action',
  'recorded_at',
  'actor_kind',
  'actor_id',
  'actor_authentication',
  'actor_session_id',
  'resource_owner',
  'resource_type',
  'resource_id',
  'outcome',
  'reason',
  'correlation_id',
  'causation_id',
  'evidence',
  'content_fingerprint',
  'idempotency_key',
] as const;

/** The one `timestamptz` in this schema. It is projected as text; nothing parses it as a Date. */
export const TIMESTAMP_COLUMNS = ['recorded_at'] as const;

/** Deterministic UTC text: no session TimeZone, no locale field, six fractional digits. */
function utcText(column: string): string {
  return `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${column}`;
}

const COLUMNS = COLUMN_NAMES.join(', ');
const PROJECTION = COLUMN_NAMES.map((column) =>
  (TIMESTAMP_COLUMNS as readonly string[]).includes(column) ? utcText(column) : column,
).join(', ');

/** Exactly what `utcText` emits, and nothing else. */
const STORED_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/;

/**
 * Decode a stored instant, or refuse.
 *
 * No fallback through `new Date(…)`. This instant decides a record's position in the log and the
 * boundary of every page; approximating one would silently reorder history.
 */
function instant(value: unknown, column: string): string {
  if (typeof value !== 'string') {
    throw new AuditError(
      'malformed-record',
      `${column} came back as ${value instanceof Date ? 'a Date' : typeof value} rather than text. ` +
        'Timestamps are projected through to_char precisely so the driver never parses them',
    );
  }
  const match = STORED_INSTANT.exec(value);
  if (match === null) {
    throw new AuditError(
      'malformed-record',
      `${column} holds "${value}", which is not a finite UTC timestamp in the projected form ` +
        'YYYY-MM-DDTHH:MM:SS.ffffffZ',
    );
  }
  try {
    parseInstant(value);
  } catch (error) {
    if (error instanceof InvalidInstantError) {
      throw new AuditError('malformed-record', `${column}: ${error.message}`);
    }
    throw error;
  }
  const [, year, month, day, hour, minute, second, fraction = ''] = match;
  const digits = fraction.replace(/0+$/, '');
  return `${year}-${month}-${day}T${hour}:${minute}:${second}${digits === '' ? '' : `.${digits}`}Z`;
}

/** A required text column, or a refusal naming it. */
function text(value: unknown, column: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new AuditError(
      'malformed-record',
      `${column} is ${value === null ? 'null' : typeof value}; expected non-empty text`,
    );
  }
  return value;
}

function optionalText(value: unknown, column: string): string | null {
  if (value === null || value === undefined) return null;
  return text(value, column);
}

function oneOf<T extends string>(value: unknown, permitted: readonly T[], column: string): T {
  const candidate = text(value, column);
  if (!(permitted as readonly string[]).includes(candidate)) {
    throw new AuditError(
      'malformed-record',
      `${column} holds "${candidate}"; expected one of ${permitted.join(', ')}`,
    );
  }
  return candidate as T;
}

/**
 * Evidence is stored as `jsonb` and decoded back to a flat scalar map.
 *
 * The registry permits only flat scalars, so anything nested in a stored row was written around
 * this component — refused rather than passed through, because a reader has no declaration to
 * check it against.
 */
export function decodeEvidence(value: unknown, recordId: string): AuditEvidence {
  const parsed = typeof value === 'string' ? safeParse(value, recordId) : value;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AuditError(
      'invalid-evidence',
      `record ${recordId} has evidence that is not a JSON object`,
    );
  }
  const out: Record<string, EvidenceValue> = {};
  for (const [key, entry] of Object.entries(parsed as Record<string, unknown>)) {
    if (
      entry !== null &&
      typeof entry !== 'string' &&
      typeof entry !== 'number' &&
      typeof entry !== 'boolean'
    ) {
      throw new AuditError(
        'invalid-evidence',
        `record ${recordId} evidence field "${key}" is ${typeof entry}; only flat scalars are ` +
          'declarable, so a nested value was never validated against any registered action',
      );
    }
    out[key] = entry;
  }
  return Object.freeze(out);
}

function safeParse(value: string, recordId: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new AuditError(
      'invalid-evidence',
      `record ${recordId} has evidence that is not valid JSON`,
    );
  }
}

interface Row {
  readonly record_id: unknown;
  readonly action: unknown;
  readonly recorded_at: unknown;
  readonly actor_kind: unknown;
  readonly actor_id: unknown;
  readonly actor_authentication: unknown;
  readonly actor_session_id: unknown;
  readonly resource_owner: unknown;
  readonly resource_type: unknown;
  readonly resource_id: unknown;
  readonly outcome: unknown;
  readonly reason: unknown;
  readonly correlation_id: unknown;
  readonly causation_id: unknown;
  readonly evidence: unknown;
  readonly content_fingerprint: unknown;
  readonly idempotency_key: unknown;
}

const FINGERPRINT = /^[0-9a-f]{64}$/;

export function toRecord(row: Row): AuditRecord {
  const recordId = text(row.record_id, 'record_id');
  const fingerprint = text(row.content_fingerprint, 'content_fingerprint');
  if (!FINGERPRINT.test(fingerprint)) {
    throw new AuditError(
      'malformed-record',
      `record ${recordId} has content_fingerprint "${fingerprint}", which is not a SHA-256`,
    );
  }

  const decoded: Omit<AuditRecord, 'contentFingerprint'> = {
    recordId,
    action: text(row.action, 'action'),
    recordedAt: instant(row.recorded_at, 'recorded_at'),
    actor: {
      kind: oneOf<ActorKind>(row.actor_kind, ['human', 'system', 'ai'], 'actor_kind'),
      id: text(row.actor_id, 'actor_id'),
      authentication: oneOf<AuthenticationMethod>(
        row.actor_authentication,
        ['unauthenticated', 'session', 'service-credential'],
        'actor_authentication',
      ),
      sessionId: optionalText(row.actor_session_id, 'actor_session_id'),
    },
    resource: {
      owner: text(row.resource_owner, 'resource_owner'),
      type: text(row.resource_type, 'resource_type'),
      id: text(row.resource_id, 'resource_id'),
    },
    outcome: oneOf<AuditOutcome>(row.outcome, ['succeeded', 'failed', 'denied'], 'outcome'),
    reason: text(row.reason, 'reason'),
    correlationId: text(row.correlation_id, 'correlation_id'),
    causationId: optionalText(row.causation_id, 'causation_id'),
    evidence: decodeEvidence(row.evidence, recordId),
    idempotencyKey: text(row.idempotency_key, 'idempotency_key'),
  };

  // Recomputed from the *fully decoded* record, not trusted from the column.
  //
  // Every other check here asks whether a field is well formed. This one asks whether the record
  // still says what it said when it was written — which is the only question an audit trail is
  // ultimately for. A row can pass every constraint the schema declares and still have had its
  // reason, its actor or one evidence field changed by something that reached the table another
  // way; the append-only trigger is the first defence and this is what catches a row that got past
  // it, or that was restored from a doctored backup.
  //
  // Fail closed rather than warn. A record whose evidence contradicts itself is worse than a
  // missing one, because it is read as fact.
  const recomputed = fingerprintRecord(decoded);
  if (recomputed !== fingerprint) {
    throw new AuditError(
      'malformed-record',
      `record ${recordId} declares content_fingerprint ${fingerprint} but its stored content ` +
        `hashes to ${recomputed}. The row has been altered since it was written, or was never ` +
        'written by this component. Refusing to return it rather than presenting altered evidence',
    );
  }

  return sealRecord({ ...decoded, contentFingerprint: fingerprint });
}

/** Statements that begin, end or subdivide a transaction. An enlisted path may issue none of them. */
const TRANSACTION_CONTROL =
  /^\s*(BEGIN|START\s+TRANSACTION|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE\s+SAVEPOINT)\b/i;

/**
 * A client that refuses transaction control and never releases the connection.
 *
 * PostgreSQL has no nested transactions: a `BEGIN` inside an open one warns and is ignored, and a
 * `COMMIT` ends the *caller's* transaction — committing domain rows it had not finished writing and
 * making its later `ROLLBACK` silently roll back nothing. The connection belongs to the caller too,
 * so releasing it would abort work this component knows nothing about.
 *
 * A guard rather than a convention: a future refactor that added a `BEGIN` to a shared path fails
 * loudly here instead of corrupting a caller's transaction boundary.
 */
export function enlistedClient(client: DatabaseClient): DatabaseClient {
  return {
    query<QueryRow = Record<string, unknown>>(sql: string, params?: readonly unknown[]) {
      if (TRANSACTION_CONTROL.test(sql)) {
        return Promise.reject(
          new AuditError(
            'nested-transaction',
            `an enlisted audit append may not issue "${sql.trim().split(/\s+/, 2).join(' ')}". ` +
              'The transaction belongs to the caller: PostgreSQL has no nested transactions, so ' +
              "this would end the caller's transaction rather than a nested one",
          ),
        );
      }
      return client.query<QueryRow>(sql, params);
    },
    release(): Promise<void> {
      // Deliberately nothing. The caller opened this connection and will close it.
      return Promise.resolve();
    },
  };
}

/**
 * An audit repository that runs inside a transaction somebody else opened.
 *
 * This is what lets a producing unit write its domain rows and its audit record together: either
 * both commit or neither does. Recording after the caller's commit loses the record if the process
 * dies in between; recording before it attests to something that may still roll back. Only sharing
 * the transaction avoids both.
 *
 * Failures propagate — the caller's `ROLLBACK` is what must undo the append. Swallowing one here
 * would commit domain state with no audit record, which is the outcome this exists to prevent.
 *
 * No unit uses this yet. It is the capability, not an integration.
 */
export class EnlistedAuditRepository implements AuditRepository {
  readonly #client: DatabaseClient;

  constructor(client: DatabaseClient) {
    this.#client = enlistedClient(client);
  }

  withTransaction<T>(body: (tx: AuditTransaction) => Promise<T>): Promise<T> {
    return body(new PostgresAuditTransaction(this.#client));
  }
}

export class PostgresAuditRepository implements AuditRepository {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  /**
   * An audit repository enlisted in a transaction the caller already opened.
   *
   * Named on this class so the two paths are read together: this one composes with a caller's
   * transaction, `withTransaction` below owns its own. Both write through the same
   * `PostgresAuditTransaction`, so there is one implementation of every statement.
   */
  static enlist(client: DatabaseClient): AuditRepository {
    return new EnlistedAuditRepository(client);
  }

  async withTransaction<T>(body: (tx: AuditTransaction) => Promise<T>): Promise<T> {
    const client = await this.#database.connect();
    try {
      await client.query('BEGIN;');
      try {
        const result = await body(new PostgresAuditTransaction(client));
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

class PostgresAuditTransaction implements AuditTransaction {
  readonly #client: DatabaseClient;

  constructor(client: DatabaseClient) {
    this.#client = client;
  }

  async findRecordById(recordId: string): Promise<AuditRecord | null> {
    const result = await this.#client.query<Row>(
      `SELECT ${PROJECTION} FROM ${AUDIT_TABLE} WHERE record_id = $1;`,
      [recordId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toRecord(row);
  }

  async findRecordByIdempotencyKey(idempotencyKey: string): Promise<AuditRecord | null> {
    const result = await this.#client.query<Row>(
      `SELECT ${PROJECTION} FROM ${AUDIT_TABLE} WHERE idempotency_key = $1;`,
      [idempotencyKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : toRecord(row);
  }

  async insertRecord(record: AuditRecord): Promise<void> {
    try {
      await this.#client.query(
        `INSERT INTO ${AUDIT_TABLE} (${COLUMNS})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16, $17);`,
        [
          record.recordId,
          record.action,
          record.recordedAt,
          record.actor.kind,
          record.actor.id,
          record.actor.authentication,
          record.actor.sessionId,
          record.resource.owner,
          record.resource.type,
          record.resource.id,
          record.outcome,
          record.reason,
          record.correlationId,
          record.causationId,
          JSON.stringify(record.evidence),
          record.contentFingerprint,
          record.idempotencyKey,
        ],
      );
    } catch (error) {
      throw normalizeDatabaseError(error, 'insertRecord');
    }
  }

  /**
   * A page of records, filtered and ordered by `(recorded_at, record_id)`.
   *
   * The compound ORDER BY and the compound cursor predicate go together: with equal instants, an
   * order on time alone leaves the tie broken by whatever the planner returns, so a cursor built
   * from one page cannot reliably resume the next. `ORDER BY` names the *columns*, qualified, so it
   * binds to the timestamp rather than to the projected text.
   *
   * One row is fetched beyond the limit to decide whether a next page exists, rather than issuing a
   * second `count(*)` over the same predicate.
   */
  async queryRecords(query: AuditQuery): Promise<AuditPage> {
    if (!Number.isSafeInteger(query.limit) || query.limit < 1) {
      throw new AuditError(
        'invalid-query',
        `limit must be a positive integer, got ${String(query.limit)}`,
      );
    }

    const conditions: string[] = [];
    const params: unknown[] = [];
    const bind = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };

    if (query.action !== undefined) conditions.push(`action = ${bind(query.action)}`);
    if (query.actorId !== undefined) conditions.push(`actor_id = ${bind(query.actorId)}`);
    if (query.resourceOwner !== undefined) {
      conditions.push(`resource_owner = ${bind(query.resourceOwner)}`);
    }
    if (query.resourceType !== undefined) {
      conditions.push(`resource_type = ${bind(query.resourceType)}`);
    }
    if (query.resourceId !== undefined) conditions.push(`resource_id = ${bind(query.resourceId)}`);
    if (query.outcome !== undefined) conditions.push(`outcome = ${bind(query.outcome)}`);
    if (query.correlationId !== undefined) {
      conditions.push(`correlation_id = ${bind(query.correlationId)}`);
    }
    if (query.from !== undefined) conditions.push(`recorded_at >= ${bind(query.from)}`);
    if (query.before !== undefined) conditions.push(`recorded_at < ${bind(query.before)}`);
    if (query.after !== undefined) {
      const at = bind(query.after.recordedAt);
      const id = bind(query.after.recordId);
      conditions.push(`(recorded_at, record_id) > (${at}::timestamptz, ${id})`);
    }

    const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}\n        `;
    const limit = bind(query.limit + 1);

    const result = await this.#client.query<Row>(
      `SELECT ${PROJECTION} FROM ${AUDIT_TABLE}
        ${where}ORDER BY audit_record.recorded_at ASC, audit_record.record_id ASC
        LIMIT ${limit};`,
      params,
    );

    const rows = result.rows.map(toRecord);
    const records = rows.slice(0, query.limit);
    const last = records[records.length - 1];
    const next: AuditCursor | null =
      rows.length > query.limit && last !== undefined
        ? { recordedAt: last.recordedAt, recordId: last.recordId }
        : null;

    return { records, next };
  }
}
