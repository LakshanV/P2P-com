/**
 * K-10 Ledger Foundation — the PostgreSQL adapter.
 *
 * Implements the persistence port against `kernel_ledger`. It knows SQL and nothing else: no
 * validation, no lifecycle, no balance arithmetic. Those live in the service, where they can be
 * tested without a server.
 *
 * Every `timestamptz` is projected as UTC text. Amounts are stored as `bigint` and read as strings
 * from the driver, then converted back to `bigint` so the service never sees a floating-point value.
 *
 * No statement names another unit's schema, and there is no foreign key out of `kernel_ledger`. The
 * module's outbox table lives in the same schema.
 *
 * Owned by: K-10 Ledger Foundation.
 */

import { databaseErrorDetail } from '../../platform/db/client.ts';
import type { Database, DatabaseClient } from '../../platform/db/client.ts';
import { InvalidInstantError, parseInstant } from '../../platform/time/instant.ts';
import type { OutboxEntry } from '../../platform/outbox/types.ts';

import { sealAccount, sealAssetType, sealEntry, sealTransaction } from './immutable.ts';
import type { LedgerRepository, LedgerTransactionPort } from './repository.ts';
import { validateAccount, validateAssetType, validateTransaction } from './validate.ts';
import {
  LedgerError,
  type LedgerErrorCode,
  type AssetType,
  type BalanceState,
  type LedgerAccount,
  type LedgerEntry,
  type LedgerTransaction,
} from './types.ts';

export const LEDGER_SCHEMA = 'kernel_ledger_foundation';
export const ASSET_TYPE_TABLE = `${LEDGER_SCHEMA}.asset_type`;
export const ACCOUNT_TABLE = `${LEDGER_SCHEMA}.ledger_account`;
export const TRANSACTION_TABLE = `${LEDGER_SCHEMA}.ledger_transaction`;
export const ENTRY_TABLE = `${LEDGER_SCHEMA}.ledger_entry`;
export const OUTBOX_TABLE = `${LEDGER_SCHEMA}.outbox`;

/** SQLSTATE 23505. The only driver code this adapter interprets. */
const UNIQUE_VIOLATION = '23505';

const CONSTRAINT_MEANINGS: Readonly<
  Record<string, { readonly code: LedgerErrorCode; readonly explanation: string }>
> = {
  asset_type_pkey: {
    code: 'duplicate-asset-type-id',
    explanation:
      'an asset type with this id already exists, and an asset type is never overwritten',
  },
  ledger_account_pkey: {
    code: 'duplicate-account-id',
    explanation: 'an account with this id already exists, and a ledger account is never rewritten',
  },
  ledger_account_idempotency_unique: {
    code: 'idempotency-key-reuse',
    explanation: 'this idempotency key has already been used for an account',
  },
  ledger_transaction_pkey: {
    code: 'duplicate-transaction-id',
    explanation: 'a transaction with this id already exists, and a transaction is never rewritten',
  },
  ledger_transaction_idempotency_unique: {
    code: 'idempotency-key-reuse',
    explanation: 'this idempotency key has already been used for a transaction',
  },
  ledger_entry_pkey: {
    code: 'duplicate-transaction-id',
    explanation: 'a transaction with this id already exists',
  },
};

function normalizeDatabaseError(error: unknown, operation: string): unknown {
  if (error instanceof LedgerError) return error;

  const detail = databaseErrorDetail(error);
  if (detail.code !== UNIQUE_VIOLATION) return error;

  const message = error instanceof Error ? error.message : String(error);
  const named =
    detail.constraint ??
    Object.keys(CONSTRAINT_MEANINGS).find((constraint) => message.includes(constraint));
  const meaning = named === undefined ? undefined : CONSTRAINT_MEANINGS[named];
  if (meaning === undefined) return error;

  return new LedgerError(meaning.code, `${operation} was refused: ${meaning.explanation}`);
}

const ASSET_TYPE_COLUMNS = [
  'asset_type_id',
  'asset_class',
  'symbol',
  'precision',
  'transferability',
  'withdrawability',
  'valuation_source',
  'issuer',
  'unit',
  'redeemable',
  'convertible',
  'expiry_days',
  'restrictions',
  'custody_provider',
  'jurisdiction',
] as const;

const ACCOUNT_COLUMNS = [
  'account_id',
  'asset_type_id',
  'owner_id',
  'normal_balance',
  'created_at',
  'idempotency_key',
] as const;

const TRANSACTION_COLUMNS = [
  'transaction_id',
  'idempotency_key',
  'posted_at',
  'asset_type_id',
] as const;

const ENTRY_COLUMNS = ['transaction_id', 'account_id', 'side', 'balance_state', 'amount'] as const;

const ASSET_TYPE_PROJECTION = ASSET_TYPE_COLUMNS.join(', ');

const ACCOUNT_PROJECTION = [
  'account_id',
  'asset_type_id',
  'owner_id',
  'normal_balance',
  `to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at`,
  'idempotency_key',
].join(', ');

const TRANSACTION_PROJECTION = [
  'transaction_id',
  'idempotency_key',
  `to_char(posted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS posted_at`,
  'asset_type_id',
].join(', ');

const ENTRY_PROJECTION = [
  'transaction_id',
  'account_id',
  'side',
  'balance_state',
  'amount::text AS amount',
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

const STORED_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/;

function instant(value: unknown, column: string): string {
  if (typeof value !== 'string') {
    throw new LedgerError(
      'malformed-record',
      `${column} came back as ${value instanceof Date ? 'a Date' : typeof value} rather than ` +
        'text. Timestamps are projected through to_char precisely so the driver never parses them',
    );
  }
  const match = STORED_INSTANT.exec(value);
  if (match === null) {
    throw new LedgerError(
      'malformed-record',
      `${column} holds "${value}", which is not a finite UTC timestamp in the projected form ` +
        'YYYY-MM-DDTHH:MM:SS.ffffffZ',
    );
  }
  try {
    parseInstant(value);
  } catch (error) {
    if (error instanceof InvalidInstantError) {
      throw new LedgerError('malformed-record', `${column}: ${error.message}`);
    }
    throw error;
  }
  const [, year, month, day, hour, minute, second, fraction = ''] = match;
  const digits = fraction.replace(/0+$/, '');
  return `${year}-${month}-${day}T${hour}:${minute}:${second}${digits === '' ? '' : `.${digits}`}Z`;
}

function text(value: unknown, column: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new LedgerError(
      'malformed-record',
      `${column} is ${value === null ? 'null' : typeof value}; expected non-empty text`,
    );
  }
  return value;
}

function booleanFrom(value: unknown, column: string): boolean {
  if (typeof value === 'boolean') return value;
  if (value === null || value === undefined) {
    throw new LedgerError('malformed-record', `${column} is null; expected a boolean`);
  }
  throw new LedgerError('malformed-record', `${column} is ${typeof value}; expected a boolean`);
}

function integer(value: unknown, column: string): number {
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new LedgerError('malformed-record', `${column} is not an integer`);
    }
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (String(parsed) !== value) {
      throw new LedgerError('malformed-record', `${column} "${value}" is not a valid integer`);
    }
    return parsed;
  }
  throw new LedgerError(
    'malformed-record',
    `${column} is ${value === null ? 'null' : typeof value}; expected an integer`,
  );
}

/**
 * A `jsonb` column, as the driver hands it back.
 *
 * `pg` parses `jsonb` for us, so this is usually already an object. A string is accepted for the
 * case where the column was projected as text; anything else is a row this component did not write.
 */
function jsonObject(value: unknown, column: string): Readonly<Record<string, unknown>> {
  const parsed =
    typeof value === 'string'
      ? ((): unknown => {
          try {
            return JSON.parse(value);
          } catch {
            throw new LedgerError('malformed-record', `${column} is not valid JSON`);
          }
        })()
      : value;

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new LedgerError(
      'malformed-record',
      `${column} is ${parsed === null ? 'null' : typeof parsed}; expected a JSON object`,
    );
  }
  return parsed as Record<string, unknown>;
}

function amount(value: unknown, column: string): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'string') {
    if (!/^\d+$/.test(value)) {
      throw new LedgerError(
        'malformed-record',
        `${column} "${value}" is not a non-negative integer string`,
      );
    }
    return BigInt(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new LedgerError('malformed-record', `${column} is not a non-negative safe integer`);
    }
    return BigInt(value);
  }
  throw new LedgerError(
    'malformed-record',
    `${column} is ${value === null ? 'null' : typeof value}; expected a non-negative integer`,
  );
}

function toAssetType(row: Record<string, unknown>): AssetType {
  return sealAssetType(
    validateAssetType(
      {
        assetTypeId: text(row.asset_type_id, 'asset_type_id'),
        assetClass: text(row.asset_class, 'asset_class'),
        symbol: text(row.symbol, 'symbol'),
        precision: integer(row.precision, 'precision'),
        transferability: booleanFrom(row.transferability, 'transferability'),
        withdrawability: booleanFrom(row.withdrawability, 'withdrawability'),
        valuationSource: text(row.valuation_source, 'valuation_source'),
        issuer: text(row.issuer, 'issuer'),
        unit: text(row.unit, 'unit'),
        redeemable: booleanFrom(row.redeemable, 'redeemable'),
        convertible: booleanFrom(row.convertible, 'convertible'),
        expiryDays: row.expiry_days === null ? null : integer(row.expiry_days, 'expiry_days'),
        restrictions: jsonObject(row.restrictions, 'restrictions'),
        custodyProvider:
          row.custody_provider === null ? null : text(row.custody_provider, 'custody_provider'),
        jurisdiction: text(row.jurisdiction, 'jurisdiction'),
      },
      'stored row',
    ),
  );
}

function toAccount(row: Record<string, unknown>): LedgerAccount {
  return sealAccount(
    validateAccount(
      {
        accountId: text(row.account_id, 'account_id'),
        assetTypeId: text(row.asset_type_id, 'asset_type_id'),
        ownerId: text(row.owner_id, 'owner_id'),
        normalBalance: text(row.normal_balance, 'normal_balance'),
        createdAt: instant(row.created_at, 'created_at'),
        idempotencyKey: text(row.idempotency_key, 'idempotency_key'),
      },
      'stored row',
    ),
  );
}

function toTransaction(row: Record<string, unknown>): LedgerTransaction {
  return sealTransaction(
    validateTransaction(
      {
        transactionId: text(row.transaction_id, 'transaction_id'),
        idempotencyKey: text(row.idempotency_key, 'idempotency_key'),
        postedAt: instant(row.posted_at, 'posted_at'),
        assetTypeId: text(row.asset_type_id, 'asset_type_id'),
        entries: row.entries,
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
          new LedgerError(
            'nested-transaction',
            `an enlisted ledger write may not issue "${sql.trim().split(/\s+/, 2).join(' ')}". ` +
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

export class EnlistedLedgerRepository implements LedgerRepository {
  readonly #client: DatabaseClient;

  constructor(client: DatabaseClient) {
    this.#client = enlistedClient(client);
  }

  withTransaction<T>(body: (tx: LedgerTransactionPort) => Promise<T>): Promise<T> {
    return body(new PostgresLedgerTransaction(this.#client));
  }
}

export class PostgresLedgerRepository implements LedgerRepository {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  static enlist(client: DatabaseClient): LedgerRepository {
    return new EnlistedLedgerRepository(client);
  }

  async withTransaction<T>(body: (tx: LedgerTransactionPort) => Promise<T>): Promise<T> {
    const client = await this.#database.connect();
    try {
      await client.query('BEGIN;');
      try {
        const result = await body(new PostgresLedgerTransaction(client));
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

class PostgresLedgerTransaction implements LedgerTransactionPort {
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

  async findAssetTypeById(assetTypeId: string): Promise<AssetType | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${ASSET_TYPE_PROJECTION} FROM ${ASSET_TYPE_TABLE} WHERE asset_type_id = $1;`,
      [assetTypeId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toAssetType(row);
  }

  async insertAssetType(assetType: AssetType): Promise<void> {
    try {
      await this.#client.query(
        `INSERT INTO ${ASSET_TYPE_TABLE} (${ASSET_TYPE_COLUMNS.join(', ')})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15);`,
        [
          assetType.assetTypeId,
          assetType.assetClass,
          assetType.symbol,
          assetType.precision,
          assetType.transferability,
          assetType.withdrawability,
          assetType.valuationSource,
          assetType.issuer,
          assetType.unit,
          assetType.redeemable,
          assetType.convertible,
          assetType.expiryDays,
          JSON.stringify(assetType.restrictions),
          assetType.custodyProvider,
          assetType.jurisdiction,
        ],
      );
    } catch (error) {
      throw normalizeDatabaseError(error, 'insertAssetType');
    }
  }

  async findAccountById(accountId: string): Promise<LedgerAccount | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${ACCOUNT_PROJECTION} FROM ${ACCOUNT_TABLE} WHERE account_id = $1;`,
      [accountId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toAccount(row);
  }

  async findAccountByIdempotencyKey(idempotencyKey: string): Promise<LedgerAccount | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${ACCOUNT_PROJECTION} FROM ${ACCOUNT_TABLE} WHERE idempotency_key = $1;`,
      [idempotencyKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : toAccount(row);
  }

  async findAccountsById(
    accountIds: readonly string[],
  ): Promise<ReadonlyMap<string, LedgerAccount>> {
    if (accountIds.length === 0) return new Map();
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${ACCOUNT_PROJECTION} FROM ${ACCOUNT_TABLE} WHERE account_id = ANY($1);`,
      [accountIds],
    );
    const index = new Map<string, LedgerAccount>();
    for (const row of result.rows) {
      const account = toAccount(row);
      index.set(account.accountId, account);
    }
    return index;
  }

  async insertAccount(account: LedgerAccount): Promise<void> {
    try {
      await this.#client.query(
        `INSERT INTO ${ACCOUNT_TABLE} (${ACCOUNT_COLUMNS.join(', ')})
         VALUES ($1, $2, $3, $4, $5, $6);`,
        [
          account.accountId,
          account.assetTypeId,
          account.ownerId,
          account.normalBalance,
          account.createdAt,
          account.idempotencyKey,
        ],
      );
    } catch (error) {
      throw normalizeDatabaseError(error, 'insertAccount');
    }
  }

  async findTransactionById(transactionId: string): Promise<LedgerTransaction | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${TRANSACTION_PROJECTION} FROM ${TRANSACTION_TABLE} WHERE transaction_id = $1;`,
      [transactionId],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    const entries = await this.#findEntriesByTransactionId(transactionId);
    return toTransaction({ ...row, entries });
  }

  async findTransactionByIdempotencyKey(idempotencyKey: string): Promise<LedgerTransaction | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${TRANSACTION_PROJECTION} FROM ${TRANSACTION_TABLE} WHERE idempotency_key = $1;`,
      [idempotencyKey],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    const entries = await this.#findEntriesByTransactionId(
      text(row.transaction_id, 'transaction_id'),
    );
    return toTransaction({ ...row, entries });
  }

  async insertTransaction(transaction: LedgerTransaction): Promise<void> {
    try {
      await this.#client.query(
        `INSERT INTO ${TRANSACTION_TABLE} (${TRANSACTION_COLUMNS.join(', ')})
         VALUES ($1, $2, $3, $4);`,
        [
          transaction.transactionId,
          transaction.idempotencyKey,
          transaction.postedAt,
          transaction.assetTypeId,
        ],
      );

      for (const entry of transaction.entries) {
        await this.#client.query(
          `INSERT INTO ${ENTRY_TABLE} (${ENTRY_COLUMNS.join(', ')})
           VALUES ($1, $2, $3, $4, $5);`,
          [
            transaction.transactionId,
            entry.accountId,
            entry.side,
            entry.balanceState,
            entry.amount,
          ],
        );
      }
    } catch (error) {
      throw normalizeDatabaseError(error, 'insertTransaction');
    }
  }

  async findEntriesByAccountId(accountId: string): Promise<readonly LedgerEntry[]> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${ENTRY_PROJECTION} FROM ${ENTRY_TABLE} WHERE account_id = $1 ORDER BY transaction_id, side;`,
      [accountId],
    );
    return Object.freeze(
      result.rows.map((row) =>
        sealEntry({
          accountId: text(row.account_id, 'account_id'),
          side: text(row.side, 'side') as 'debit' | 'credit',
          balanceState: text(row.balance_state, 'balance_state') as BalanceState,
          amount: amount(row.amount, 'amount'),
        }),
      ),
    );
  }

  async #findEntriesByTransactionId(transactionId: string): Promise<readonly LedgerEntry[]> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${ENTRY_PROJECTION} FROM ${ENTRY_TABLE} WHERE transaction_id = $1 ORDER BY account_id, side;`,
      [transactionId],
    );
    return Object.freeze(
      result.rows.map((row) =>
        sealEntry({
          accountId: text(row.account_id, 'account_id'),
          side: text(row.side, 'side') as 'debit' | 'credit',
          balanceState: text(row.balance_state, 'balance_state') as BalanceState,
          amount: amount(row.amount, 'amount'),
        }),
      ),
    );
  }
}
