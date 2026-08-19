/**
 * K-01 Identity — the PostgreSQL adapter (FND-004a).
 *
 * Implements the persistence port against `kernel_identity`. It knows SQL and nothing else: no
 * validation, no kind registry, no lifecycle. Those live in the service, where they can be tested
 * without a server.
 *
 * Three properties are load-bearing and each is a decision:
 *
 *   - **No UPDATE, no DELETE.** Not anywhere in this file. Migration 0006 adds a trigger that
 *     refuses both at the database as well, so a write around this adapter still cannot rewrite an
 *     identity. Everything downstream references these ids; one that can change meaning silently
 *     reattributes history.
 *   - **Timestamps are read as text.** `created_at` is projected through
 *     `to_char(… AT TIME ZONE 'UTC', …)`, because the driver's default parser produces a `Date` and
 *     a `Date` holds milliseconds where the column holds microseconds. K-05 lost microseconds
 *     exactly this way (§11.13), and a creation instant is compared and recorded, not decorative.
 *   - **Decoding is fail-closed.** A row that does not decode is refused rather than approximated.
 *     A wrong identity is worse than a missing one: it is treated as a real party.
 *
 * Owned by: K-01 Identity.
 */

import { databaseErrorDetail } from '../../platform/db/client.ts';
import type { Database, DatabaseClient } from '../../platform/db/client.ts';
import { InvalidInstantError, parseInstant } from '../../platform/time/instant.ts';

import { sealSubject } from './immutable.ts';
import type { IdentityRepository, IdentityTransaction } from './repository.ts';
import { validateSubject } from './validate.ts';
import { IdentityError, type IdentityErrorCode, type IdentitySubject } from './types.ts';

export const IDENTITY_SCHEMA = 'kernel_identity';
export const IDENTITY_TABLE = `${IDENTITY_SCHEMA}.identity_subject`;

/** SQLSTATE 23505. The only driver code this adapter interprets. */
const UNIQUE_VIOLATION = '23505';

/** What a violation of each declared constraint actually means. */
const CONSTRAINT_MEANINGS: Readonly<
  Record<string, { readonly code: IdentityErrorCode; readonly explanation: string }>
> = {
  identity_subject_pkey: {
    code: 'duplicate-subject-id',
    explanation: 'a subject with this id already exists, and an identity is never rewritten',
  },
  identity_subject_idempotency_unique: {
    code: 'idempotency-key-reuse',
    explanation: 'this idempotency key has already been used by a creation that got there first',
  },
};

function normalizeDatabaseError(error: unknown, operation: string): unknown {
  if (error instanceof IdentityError) return error;

  const detail = databaseErrorDetail(error);
  if (detail.code !== UNIQUE_VIOLATION) return error;

  const message = error instanceof Error ? error.message : String(error);
  const named =
    detail.constraint ??
    Object.keys(CONSTRAINT_MEANINGS).find((constraint) => message.includes(constraint));
  const meaning = named === undefined ? undefined : CONSTRAINT_MEANINGS[named];
  if (meaning === undefined) return error;

  return new IdentityError(meaning.code, `${operation} was refused: ${meaning.explanation}`);
}

const COLUMN_NAMES = [
  'subject_id',
  'kind',
  'created_at',
  'origin_kind',
  'origin_id',
  'idempotency_key',
] as const;

/** The one `timestamptz` in this schema. It is projected as text; nothing parses it as a Date. */
export const TIMESTAMP_COLUMNS = ['created_at'] as const;

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
 * No fallback through `new Date(…)`. A creation instant orders identities against each other and
 * against everything that references them; approximating one would silently reorder that.
 */
function instant(value: unknown, column: string): string {
  if (typeof value !== 'string') {
    throw new IdentityError(
      'malformed-record',
      `${column} came back as ${value instanceof Date ? 'a Date' : typeof value} rather than ` +
        'text. Timestamps are projected through to_char precisely so the driver never parses them',
    );
  }
  const match = STORED_INSTANT.exec(value);
  if (match === null) {
    throw new IdentityError(
      'malformed-record',
      `${column} holds "${value}", which is not a finite UTC timestamp in the projected form ` +
        'YYYY-MM-DDTHH:MM:SS.ffffffZ',
    );
  }
  try {
    parseInstant(value);
  } catch (error) {
    if (error instanceof InvalidInstantError) {
      throw new IdentityError('malformed-record', `${column}: ${error.message}`);
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
    throw new IdentityError(
      'malformed-record',
      `${column} is ${value === null ? 'null' : typeof value}; expected non-empty text`,
    );
  }
  return value;
}

interface Row {
  readonly subject_id: unknown;
  readonly kind: unknown;
  readonly created_at: unknown;
  readonly origin_kind: unknown;
  readonly origin_id: unknown;
  readonly idempotency_key: unknown;
}

/**
 * Decode one row into a subject, or refuse.
 *
 * Two stages, and the split is the point.
 *
 * **Shape** is this file's job, because only the adapter knows what the driver hands back: is the
 * column text at all, and is `created_at` exactly what the `to_char` projection emits. Nothing else
 * in the component can ask those questions.
 *
 * **Domain** is `validateSubject`'s job, and it is the *same function the service calls on the way
 * in*. That is the correction FND-004a needed: the first revision asked only whether each column
 * was non-empty text and whether two of them held a known enum value, so a row written around the
 * adapter — by hand, by a restore, by a migration script — decoded cleanly and came back as a real
 * party while holding exactly the natural key, personal name or credential that creation refuses.
 * A row that would not have been accepted as a request is not accepted as a subject.
 */
export function toSubject(row: Row): IdentitySubject {
  const decoded = {
    subjectId: text(row.subject_id, 'subject_id'),
    // Not narrowed here. Membership of the kind registry and of ORIGIN_KINDS is a domain question,
    // and asking it twice in two places is how the two answers drift apart.
    kind: text(row.kind, 'kind'),
    createdAt: instant(row.created_at, 'created_at'),
    origin: { kind: text(row.origin_kind, 'origin_kind'), id: text(row.origin_id, 'origin_id') },
    idempotencyKey: text(row.idempotency_key, 'idempotency_key'),
  };

  return sealSubject(validateSubject(decoded, 'stored row'));
}

/** Statements that begin, end or subdivide a transaction. An enlisted path may issue none of them. */
const TRANSACTION_CONTROL =
  /^\s*(BEGIN|START\s+TRANSACTION|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE\s+SAVEPOINT)\b/i;

/**
 * A client that refuses transaction control and never releases the connection.
 *
 * PostgreSQL has no nested transactions: a `BEGIN` inside an open one warns and is ignored, and a
 * `COMMIT` ends the *caller's* transaction — committing rows it had not finished writing and making
 * its later `ROLLBACK` silently roll back nothing. The connection belongs to the caller too, so
 * releasing it would abort work this component knows nothing about.
 *
 * A guard rather than a convention: a future refactor that added a `BEGIN` to a shared path fails
 * loudly here instead of corrupting a caller's transaction boundary.
 */
export function enlistedClient(client: DatabaseClient): DatabaseClient {
  return {
    query<QueryRow = Record<string, unknown>>(sql: string, params?: readonly unknown[]) {
      if (TRANSACTION_CONTROL.test(sql)) {
        return Promise.reject(
          new IdentityError(
            'nested-transaction',
            `an enlisted identity write may not issue "${sql.trim().split(/\s+/, 2).join(' ')}". ` +
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
 * An identity repository that runs inside a transaction somebody else opened.
 *
 * This is what will let K-03 create an account and its subject together: either both commit or
 * neither does. Creating the subject before the caller's commit leaves an orphan identity if the
 * caller rolls back; creating it after loses it if the process dies in between. Only sharing the
 * transaction avoids both.
 *
 * Failures propagate — the caller's `ROLLBACK` is what must undo the insert. Swallowing one here
 * would commit an account with no subject, which is the outcome this exists to prevent.
 *
 * No unit uses this yet. It is the capability, not an integration.
 */
export class EnlistedIdentityRepository implements IdentityRepository {
  readonly #client: DatabaseClient;

  constructor(client: DatabaseClient) {
    this.#client = enlistedClient(client);
  }

  withTransaction<T>(body: (tx: IdentityTransaction) => Promise<T>): Promise<T> {
    return body(new PostgresIdentityTransaction(this.#client));
  }
}

export class PostgresIdentityRepository implements IdentityRepository {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  /**
   * An identity repository enlisted in a transaction the caller already opened.
   *
   * Named on this class so the two paths are read together: this one composes with a caller's
   * transaction, `withTransaction` below owns its own. Both write through the same
   * `PostgresIdentityTransaction`, so there is one implementation of every statement.
   */
  static enlist(client: DatabaseClient): IdentityRepository {
    return new EnlistedIdentityRepository(client);
  }

  async withTransaction<T>(body: (tx: IdentityTransaction) => Promise<T>): Promise<T> {
    const client = await this.#database.connect();
    try {
      await client.query('BEGIN;');
      try {
        const result = await body(new PostgresIdentityTransaction(client));
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

class PostgresIdentityTransaction implements IdentityTransaction {
  readonly #client: DatabaseClient;

  constructor(client: DatabaseClient) {
    this.#client = client;
  }

  async findSubjectById(subjectId: string): Promise<IdentitySubject | null> {
    const result = await this.#client.query<Row>(
      `SELECT ${PROJECTION} FROM ${IDENTITY_TABLE} WHERE subject_id = $1;`,
      [subjectId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toSubject(row);
  }

  async findSubjectByIdempotencyKey(idempotencyKey: string): Promise<IdentitySubject | null> {
    const result = await this.#client.query<Row>(
      `SELECT ${PROJECTION} FROM ${IDENTITY_TABLE} WHERE idempotency_key = $1;`,
      [idempotencyKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : toSubject(row);
  }

  async insertSubject(subject: IdentitySubject): Promise<void> {
    try {
      await this.#client.query(
        `INSERT INTO ${IDENTITY_TABLE} (${COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6);`,
        [
          subject.subjectId,
          subject.kind,
          subject.createdAt,
          subject.origin.kind,
          subject.origin.id,
          subject.idempotencyKey,
        ],
      );
    } catch (error) {
      throw normalizeDatabaseError(error, 'insertSubject');
    }
  }
}
