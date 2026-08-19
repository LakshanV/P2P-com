/**
 * K-03 Accounts — the PostgreSQL adapter (FND-004b).
 *
 * Implements the persistence port against `kernel_accounts`. It knows SQL and nothing else: no
 * validation, no lifecycle, no referential check. Those live in the service, where they can be
 * tested without a server.
 *
 * Four properties are load-bearing and each is a decision:
 *
 *   - **`kernel_accounts` and nothing else.** No statement in this file names another schema. K-03
 *     depends on K-01, and it does so through an injected `SubjectLookup` — not a join, not a
 *     foreign key. `tests/accounts-repository.test.ts` scans this file against every schema the
 *     platform knows about and fails on any other.
 *   - **No UPDATE, no DELETE.** Not anywhere. Migration 0007 adds a trigger that refuses both at
 *     the database too, so a write around this adapter still cannot relink or remove an account.
 *   - **Timestamps are read as text.** `created_at` is projected through
 *     `to_char(… AT TIME ZONE 'UTC', …)`, because the driver's default parser produces a `Date` and
 *     a `Date` holds milliseconds where the column holds microseconds (K-05 lost them exactly this
 *     way, §11.13).
 *   - **Decoding is fail-closed, against the creation rules.** Every row goes through the same
 *     `validateAccount` the service calls, so a row written around the adapter is refused rather
 *     than returned. K-01 needed a correction to reach this (§11.22); K-03 starts here.
 *
 * Owned by: K-03 Accounts.
 */

import { databaseErrorDetail } from '../../platform/db/client.ts';
import type { Database, DatabaseClient } from '../../platform/db/client.ts';
import { InvalidInstantError, parseInstant } from '../../platform/time/instant.ts';

import { sealAccount } from './immutable.ts';
import type { AccountRepository, AccountTransaction } from './repository.ts';
import { validateAccount } from './validate.ts';
import { AccountError, type AccountErrorCode, type UniversalAccount } from './types.ts';

export const ACCOUNT_SCHEMA = 'kernel_accounts';
export const ACCOUNT_TABLE = `${ACCOUNT_SCHEMA}.universal_account`;

/** SQLSTATE 23505. The only driver code this adapter interprets. */
const UNIQUE_VIOLATION = '23505';

/** What a violation of each declared constraint actually means. */
const CONSTRAINT_MEANINGS: Readonly<
  Record<string, { readonly code: AccountErrorCode; readonly explanation: string }>
> = {
  universal_account_pkey: {
    code: 'duplicate-account-id',
    explanation: 'an account with this id already exists, and an account is never rewritten',
  },
  universal_account_subject_unique: {
    code: 'subject-already-has-account',
    explanation:
      'this party already holds a universal account, and a party has exactly one — a second ' +
      'would split the same person across two histories',
  },
  universal_account_idempotency_unique: {
    code: 'idempotency-key-reuse',
    explanation: 'this idempotency key has already been used by an opening that got there first',
  },
};

function normalizeDatabaseError(error: unknown, operation: string): unknown {
  if (error instanceof AccountError) return error;

  const detail = databaseErrorDetail(error);
  if (detail.code !== UNIQUE_VIOLATION) return error;

  const message = error instanceof Error ? error.message : String(error);
  const named =
    detail.constraint ??
    Object.keys(CONSTRAINT_MEANINGS).find((constraint) => message.includes(constraint));
  const meaning = named === undefined ? undefined : CONSTRAINT_MEANINGS[named];
  if (meaning === undefined) return error;

  return new AccountError(meaning.code, `${operation} was refused: ${meaning.explanation}`);
}

const COLUMN_NAMES = [
  'account_id',
  'subject_id',
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
 * No fallback through `new Date(…)`. A creation instant orders accounts against each other and
 * against everything that references them; approximating one would silently reorder that.
 */
function instant(value: unknown, column: string): string {
  if (typeof value !== 'string') {
    throw new AccountError(
      'malformed-record',
      `${column} came back as ${value instanceof Date ? 'a Date' : typeof value} rather than ` +
        'text. Timestamps are projected through to_char precisely so the driver never parses them',
    );
  }
  const match = STORED_INSTANT.exec(value);
  if (match === null) {
    throw new AccountError(
      'malformed-record',
      `${column} holds "${value}", which is not a finite UTC timestamp in the projected form ` +
        'YYYY-MM-DDTHH:MM:SS.ffffffZ',
    );
  }
  try {
    parseInstant(value);
  } catch (error) {
    if (error instanceof InvalidInstantError) {
      throw new AccountError('malformed-record', `${column}: ${error.message}`);
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
    throw new AccountError(
      'malformed-record',
      `${column} is ${value === null ? 'null' : typeof value}; expected non-empty text`,
    );
  }
  return value;
}

interface Row {
  readonly account_id: unknown;
  readonly subject_id: unknown;
  readonly created_at: unknown;
  readonly origin_kind: unknown;
  readonly origin_id: unknown;
  readonly idempotency_key: unknown;
}

/**
 * Decode one row into an account, or refuse.
 *
 * Two stages. **Shape** is this file's job, because only the adapter knows what the driver hands
 * back. **Domain** is `validateAccount`'s — the same function the service calls on the way in — so
 * a row that would not have been accepted as a request is not accepted as an account.
 */
export function toAccount(row: Row): UniversalAccount {
  const decoded = {
    accountId: text(row.account_id, 'account_id'),
    subjectId: text(row.subject_id, 'subject_id'),
    createdAt: instant(row.created_at, 'created_at'),
    origin: { kind: text(row.origin_kind, 'origin_kind'), id: text(row.origin_id, 'origin_id') },
    idempotencyKey: text(row.idempotency_key, 'idempotency_key'),
  };

  return sealAccount(validateAccount(decoded, 'stored row'));
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
 */
export function enlistedClient(client: DatabaseClient): DatabaseClient {
  return {
    query<QueryRow = Record<string, unknown>>(sql: string, params?: readonly unknown[]) {
      if (TRANSACTION_CONTROL.test(sql)) {
        return Promise.reject(
          new AccountError(
            'nested-transaction',
            `an enlisted account write may not issue "${sql.trim().split(/\s+/, 2).join(' ')}". ` +
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
 * An account repository that runs inside a transaction somebody else opened.
 *
 * The registration path this component exists to make possible: a caller creates the K-01 subject
 * and opens the K-03 account in one transaction, so a party is never left with an identity and no
 * account, or an account and no identity. Both components expose an enlisted path and both refuse
 * transaction control, so the caller owns the boundary and neither component can end it.
 *
 * Failures propagate — the caller's `ROLLBACK` is what must undo the insert.
 *
 * No unit uses this yet. It is the capability, not an integration.
 */
export class EnlistedAccountRepository implements AccountRepository {
  readonly #client: DatabaseClient;

  constructor(client: DatabaseClient) {
    this.#client = enlistedClient(client);
  }

  withTransaction<T>(body: (tx: AccountTransaction) => Promise<T>): Promise<T> {
    return body(new PostgresAccountTransaction(this.#client));
  }
}

export class PostgresAccountRepository implements AccountRepository {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  /**
   * An account repository enlisted in a transaction the caller already opened.
   *
   * Named on this class so the two paths are read together: this one composes with a caller's
   * transaction, `withTransaction` below owns its own. Both write through the same
   * `PostgresAccountTransaction`, so there is one implementation of every statement.
   */
  static enlist(client: DatabaseClient): AccountRepository {
    return new EnlistedAccountRepository(client);
  }

  async withTransaction<T>(body: (tx: AccountTransaction) => Promise<T>): Promise<T> {
    const client = await this.#database.connect();
    try {
      await client.query('BEGIN;');
      try {
        const result = await body(new PostgresAccountTransaction(client));
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

class PostgresAccountTransaction implements AccountTransaction {
  readonly #client: DatabaseClient;

  constructor(client: DatabaseClient) {
    this.#client = client;
  }

  findAccountById(accountId: string): Promise<UniversalAccount | null> {
    return this.#findBy('account_id', accountId);
  }

  findAccountBySubjectId(subjectId: string): Promise<UniversalAccount | null> {
    return this.#findBy('subject_id', subjectId);
  }

  findAccountByIdempotencyKey(idempotencyKey: string): Promise<UniversalAccount | null> {
    return this.#findBy('idempotency_key', idempotencyKey);
  }

  /**
   * The three reads differ only by column, and the column is one of three literals chosen here
   * rather than anywhere a caller can reach — so there is one statement shape and no interpolation
   * of anything a caller supplied.
   */
  async #findBy(
    column: 'account_id' | 'subject_id' | 'idempotency_key',
    value: string,
  ): Promise<UniversalAccount | null> {
    const result = await this.#client.query<Row>(
      `SELECT ${PROJECTION} FROM ${ACCOUNT_TABLE} WHERE ${column} = $1;`,
      [value],
    );
    const row = result.rows[0];
    return row === undefined ? null : toAccount(row);
  }

  async insertAccount(account: UniversalAccount): Promise<void> {
    try {
      await this.#client.query(
        `INSERT INTO ${ACCOUNT_TABLE} (${COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6);`,
        [
          account.accountId,
          account.subjectId,
          account.createdAt,
          account.origin.kind,
          account.origin.id,
          account.idempotencyKey,
        ],
      );
    } catch (error) {
      throw normalizeDatabaseError(error, 'insertAccount');
    }
  }
}
