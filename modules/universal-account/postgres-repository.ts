/**
 * M-01 Universal Account — the PostgreSQL adapter.
 *
 * Implements the persistence port against `module_universal_account`. It knows SQL and nothing else:
 * no validation, no lifecycle, no referential check. Those live in the service, where they can be
 * tested without a server.
 *
 * Every `timestamptz` is projected as UTC text. JSON objects are stored as `jsonb` and read as
 * objects.
 *
 * No statement names another unit's schema, and there is no foreign key out of
 * `module_universal_account`. The module's outbox table lives in the same schema.
 *
 * Owned by: M-01 Universal Account.
 */

import { databaseErrorDetail } from '../../platform/db/client.ts';
import type { Database, DatabaseClient } from '../../platform/db/client.ts';
import type { OutboxEntry } from '../../platform/outbox/types.ts';

import { sealAccountCapability, sealCapabilityState } from './immutable.ts';
import type { UniversalAccountRepository, UniversalAccountTransaction } from './repository.ts';
import {
  UniversalAccountError,
  type AccountCapability,
  type CapabilityState,
  type UniversalAccountErrorCode,
} from './types.ts';
import { validateAccountCapability, validateCapabilityState } from './validate.ts';

export const UNIVERSAL_ACCOUNT_SCHEMA = 'module_universal_account';
export const ACCOUNT_CAPABILITY_TABLE = `${UNIVERSAL_ACCOUNT_SCHEMA}.account_capability`;
export const CAPABILITY_STATE_TABLE = `${UNIVERSAL_ACCOUNT_SCHEMA}.capability_state`;
export const OUTBOX_TABLE = `${UNIVERSAL_ACCOUNT_SCHEMA}.outbox`;

/** SQLSTATE 23505. The only driver code this adapter interprets. */
const UNIQUE_VIOLATION = '23505';

const CONSTRAINT_MEANINGS: Readonly<
  Record<string, { readonly code: UniversalAccountErrorCode; readonly explanation: string }>
> = {
  account_capability_pkey: {
    code: 'duplicate-capability-id',
    explanation: 'a capability with this id already exists, and a capability is never overwritten',
  },
  account_capability_idempotency_unique: {
    code: 'idempotency-key-reuse',
    explanation: 'this idempotency key has already been used for a capability',
  },
  account_capability_account_capability_unique: {
    code: 'capability-already-active',
    explanation: 'this account already holds an active capability for this role',
  },
  capability_state_pkey: {
    code: 'duplicate-state-id',
    explanation:
      'a capability state with this id already exists, and a state row is never rewritten',
  },
  capability_state_idempotency_unique: {
    code: 'idempotency-key-reuse',
    explanation: 'this idempotency key has already been used for a capability state',
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
  if (error instanceof UniversalAccountError) return error;

  const detail = databaseErrorDetail(error);
  if (detail.code !== UNIQUE_VIOLATION) return error;

  const message = error instanceof Error ? error.message : String(error);
  const named =
    detail.constraint ??
    Object.keys(CONSTRAINT_MEANINGS).find((constraint) => message.includes(constraint));
  const meaning = named === undefined ? undefined : CONSTRAINT_MEANINGS[named];
  if (meaning === undefined) return error;

  return new UniversalAccountError(
    meaning.code,
    `${operation} was refused: ${meaning.explanation}`,
  );
}

const ACCOUNT_CAPABILITY_COLUMNS = [
  'capability_id',
  'account_id',
  'capability',
  'status',
  'activated_at',
  'deactivated_at',
  'attributes',
  'created_at',
  'updated_at',
  'correlation_id',
  'idempotency_key',
] as const;

const CAPABILITY_STATE_COLUMNS = [
  'state_id',
  'capability_id',
  'account_id',
  'from_status',
  'to_status',
  'reason',
  'occurred_at',
  'correlation_id',
  'idempotency_key',
] as const;

function utcText(column: string): string {
  return `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${column}`;
}

const ACCOUNT_CAPABILITY_PROJECTION = [
  'capability_id',
  'account_id',
  'capability',
  'status',
  utcText('activated_at'),
  utcText('deactivated_at'),
  'attributes',
  utcText('created_at'),
  utcText('updated_at'),
  'correlation_id',
  'idempotency_key',
].join(', ');

const CAPABILITY_STATE_PROJECTION = [
  'state_id',
  'capability_id',
  'account_id',
  'from_status',
  'to_status',
  'reason',
  utcText('occurred_at'),
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

function text(value: unknown, column: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new UniversalAccountError(
      'malformed-record',
      `${column} is ${value === null ? 'null' : typeof value}; expected non-empty text`,
    );
  }
  return value;
}

function optionalText(value: unknown, column: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new UniversalAccountError(
      'malformed-record',
      `${column} is ${typeof value}; expected text or null`,
    );
  }
  return value === '' ? null : value;
}

function jsonObject(value: unknown, column: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new UniversalAccountError(
      'malformed-record',
      `${column} is ${value === null ? 'null' : typeof value}; expected a JSON object`,
    );
  }
  return value as Record<string, unknown>;
}

export function toAccountCapability(row: Record<string, unknown>): AccountCapability {
  return sealAccountCapability(
    validateAccountCapability(
      {
        capabilityId: text(row.capability_id, 'capability_id'),
        accountId: text(row.account_id, 'account_id'),
        capability: text(row.capability, 'capability'),
        status: text(row.status, 'status'),
        activatedAt: text(row.activated_at, 'activated_at'),
        deactivatedAt: optionalText(row.deactivated_at, 'deactivated_at'),
        attributes: jsonObject(row.attributes, 'attributes'),
        createdAt: text(row.created_at, 'created_at'),
        updatedAt: text(row.updated_at, 'updated_at'),
        correlationId: text(row.correlation_id, 'correlation_id'),
        idempotencyKey: text(row.idempotency_key, 'idempotency_key'),
      },
      'stored row',
    ),
  );
}

export function toCapabilityState(row: Record<string, unknown>): CapabilityState {
  return sealCapabilityState(
    validateCapabilityState(
      {
        stateId: text(row.state_id, 'state_id'),
        capabilityId: text(row.capability_id, 'capability_id'),
        accountId: text(row.account_id, 'account_id'),
        fromStatus: optionalText(row.from_status, 'from_status'),
        toStatus: text(row.to_status, 'to_status'),
        reason: text(row.reason, 'reason'),
        occurredAt: text(row.occurred_at, 'occurred_at'),
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
          new UniversalAccountError(
            'nested-transaction',
            `an enlisted universal-account write may not issue "${sql.trim().split(/\s+/, 2).join(' ')}". ` +
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

export class EnlistedUniversalAccountRepository implements UniversalAccountRepository {
  readonly #client: DatabaseClient;

  constructor(client: DatabaseClient) {
    this.#client = enlistedClient(client);
  }

  withTransaction<T>(body: (tx: UniversalAccountTransaction) => Promise<T>): Promise<T> {
    return body(new PostgresUniversalAccountTransaction(this.#client));
  }
}

export class PostgresUniversalAccountRepository implements UniversalAccountRepository {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  static enlist(client: DatabaseClient): UniversalAccountRepository {
    return new EnlistedUniversalAccountRepository(client);
  }

  async withTransaction<T>(body: (tx: UniversalAccountTransaction) => Promise<T>): Promise<T> {
    const client = await this.#database.connect();
    try {
      await client.query('BEGIN;');
      try {
        const result = await body(new PostgresUniversalAccountTransaction(client));
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

export const TIMESTAMP_COLUMNS = [
  'activated_at',
  'deactivated_at',
  'created_at',
  'updated_at',
  'occurred_at',
] as const;

class PostgresUniversalAccountTransaction implements UniversalAccountTransaction {
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

  async findCapabilityById(capabilityId: string): Promise<AccountCapability | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${ACCOUNT_CAPABILITY_PROJECTION} FROM ${ACCOUNT_CAPABILITY_TABLE} WHERE capability_id = $1;`,
      [capabilityId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toAccountCapability(row);
  }

  async findCapabilityByIdempotencyKey(idempotencyKey: string): Promise<AccountCapability | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${ACCOUNT_CAPABILITY_PROJECTION} FROM ${ACCOUNT_CAPABILITY_TABLE} WHERE idempotency_key = $1;`,
      [idempotencyKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : toAccountCapability(row);
  }

  async findCapabilitiesByAccountId(accountId: string): Promise<readonly AccountCapability[]> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${ACCOUNT_CAPABILITY_PROJECTION} FROM ${ACCOUNT_CAPABILITY_TABLE} WHERE account_id = $1 ORDER BY capability ASC;`,
      [accountId],
    );
    return Object.freeze(result.rows.map(toAccountCapability));
  }

  async insertCapability(capability: AccountCapability): Promise<void> {
    try {
      await this.#client.query(
        `INSERT INTO ${ACCOUNT_CAPABILITY_TABLE} (${ACCOUNT_CAPABILITY_COLUMNS.join(', ')})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11);`,
        [
          capability.capabilityId,
          capability.accountId,
          capability.capability,
          capability.status,
          capability.activatedAt,
          capability.deactivatedAt,
          JSON.stringify(capability.attributes),
          capability.createdAt,
          capability.updatedAt,
          capability.correlationId,
          capability.idempotencyKey,
        ],
      );
    } catch (error) {
      throw normalizeDatabaseError(error, 'insertCapability');
    }
  }

  async updateCapability(capability: AccountCapability): Promise<void> {
    await this.#client.query(
      `UPDATE ${ACCOUNT_CAPABILITY_TABLE}
       SET status = $1, activated_at = $2, deactivated_at = $3, updated_at = $4
       WHERE capability_id = $5;`,
      [
        capability.status,
        capability.activatedAt,
        capability.deactivatedAt,
        capability.updatedAt,
        capability.capabilityId,
      ],
    );
  }

  async findStateById(stateId: string): Promise<CapabilityState | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${CAPABILITY_STATE_PROJECTION} FROM ${CAPABILITY_STATE_TABLE} WHERE state_id = $1;`,
      [stateId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toCapabilityState(row);
  }

  async findStateByIdempotencyKey(idempotencyKey: string): Promise<CapabilityState | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${CAPABILITY_STATE_PROJECTION} FROM ${CAPABILITY_STATE_TABLE} WHERE idempotency_key = $1;`,
      [idempotencyKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : toCapabilityState(row);
  }

  async findStatesByCapabilityId(capabilityId: string): Promise<readonly CapabilityState[]> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${CAPABILITY_STATE_PROJECTION} FROM ${CAPABILITY_STATE_TABLE} WHERE capability_id = $1 ORDER BY occurred_at ASC, state_id ASC;`,
      [capabilityId],
    );
    return Object.freeze(result.rows.map(toCapabilityState));
  }

  async insertState(state: CapabilityState): Promise<void> {
    try {
      await this.#client.query(
        `INSERT INTO ${CAPABILITY_STATE_TABLE} (${CAPABILITY_STATE_COLUMNS.join(', ')})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9);`,
        [
          state.stateId,
          state.capabilityId,
          state.accountId,
          state.fromStatus,
          state.toStatus,
          state.reason,
          state.occurredAt,
          state.correlationId,
          state.idempotencyKey,
        ],
      );
    } catch (error) {
      throw normalizeDatabaseError(error, 'insertState');
    }
  }
}
