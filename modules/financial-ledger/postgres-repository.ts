/**
 * M-13 Financial Ledger — PostgreSQL adapter.
 *
 * Implements the persistence port against `module_financial_ledger`. It knows SQL and nothing else:
 * no arithmetic, no lifecycle, no journal. Those live in the service, where they can be tested
 * without a server.
 *
 * Every `timestamptz` is projected as UTC text through `to_char`, so the driver never parses a
 * timestamp. Money is `bigint` minor units and comes back as a string, which the validator accepts.
 *
 * A rate is stored as two `bigint` columns and reassembled here. There is no decimal rate column
 * anywhere, and there is nothing in this file that divides.
 *
 * No statement names another unit's schema, and there is no foreign key out of
 * `module_financial_ledger`.
 *
 * Owned by: M-13 Financial Ledger.
 */

import { databaseErrorDetail } from '../../platform/db/client.ts';
import type { Database, DatabaseClient } from '../../platform/db/client.ts';
import type { OutboxEntry } from '../../platform/outbox/types.ts';

import { sealValueLeg, sealValuePlan, sealWallet, sealWalletState } from './immutable.ts';
import type { FinancialLedgerRepository, FinancialLedgerTransaction } from './repository.ts';
import {
  FinancialLedgerError,
  type FinancialLedgerErrorCode,
  type LegStatus,
  type PlanStatus,
  type ValueLeg,
  type ValuePlan,
  type Wallet,
  type WalletPurpose,
  type WalletStateRecord,
  type WalletStatus,
} from './types.ts';
import {
  validateValueLeg,
  validateValuePlan,
  validateWallet,
  validateWalletState,
} from './validate.ts';

export const FINANCIAL_LEDGER_SCHEMA = 'module_financial_ledger';
export const WALLET_TABLE = `${FINANCIAL_LEDGER_SCHEMA}.wallet`;
export const WALLET_STATE_TABLE = `${FINANCIAL_LEDGER_SCHEMA}.wallet_state`;
export const VALUE_PLAN_TABLE = `${FINANCIAL_LEDGER_SCHEMA}.value_plan`;
export const VALUE_LEG_TABLE = `${FINANCIAL_LEDGER_SCHEMA}.value_leg`;
export const OUTBOX_TABLE = `${FINANCIAL_LEDGER_SCHEMA}.outbox`;

/** SQLSTATE 23505 unique violation, 23514 check violation. */
const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';

const CONSTRAINT_MEANINGS: Readonly<
  Record<string, { readonly code: FinancialLedgerErrorCode; readonly explanation: string }>
> = {
  wallet_pkey: {
    code: 'duplicate-wallet-id',
    explanation: 'a wallet with this id already exists',
  },
  wallet_idempotency_unique: {
    code: 'idempotency-key-reuse',
    explanation: 'this idempotency key has already been used for a wallet',
  },
  wallet_position_unique: {
    code: 'wallet-exists',
    explanation:
      'this party already holds a wallet for that asset type and purpose. Two would split the ' +
      'same money in half with nothing to say which half is theirs',
  },
  wallet_ledger_account_unique: {
    code: 'wallet-exists',
    explanation:
      'another wallet already names that K-10 account. Two would each report the whole balance ' +
      'as their own',
  },
  wallet_state_pkey: {
    code: 'malformed-record',
    explanation: 'a wallet state record with this id already exists',
  },
  wallet_state_idempotency_unique: {
    code: 'idempotency-key-reuse',
    explanation: 'this idempotency key has already been used for a wallet state record',
  },
  value_plan_pkey: {
    code: 'duplicate-plan-id',
    explanation: 'a plan with this id already exists',
  },
  value_plan_idempotency_unique: {
    code: 'idempotency-key-reuse',
    explanation: 'this idempotency key has already been used for a plan',
  },
  value_plan_live_obligation_idx: {
    code: 'duplicate-plan-id',
    explanation:
      'this obligation already has a live plan. Two would be the same thing paid for twice, and ' +
      'downstream it would look like two ordinary payments',
  },
  value_plan_legs_sum_to_target: {
    code: 'allocation-mismatch',
    explanation:
      'the legs do not sum to what is owed. Under-covering is a payment somebody is still owed; ' +
      'over-covering takes value for nothing',
  },
  value_leg_pkey: {
    code: 'duplicate-leg-id',
    explanation: 'a leg with this id already exists',
  },
  value_leg_idempotency_unique: {
    code: 'idempotency-key-reuse',
    explanation: 'this idempotency key has already been used for a leg',
  },
  value_leg_rate_is_exact: {
    code: 'rate-mismatch',
    explanation:
      'the amount at its stated rate is not the settlement equivalent. The check is a ' +
      'cross-multiplication, so a rate that does not divide evenly is refused rather than rounded',
  },
  outbox_pkey: { code: 'idempotency-key-reuse', explanation: 'this outbox id already exists' },
  outbox_idempotency_unique: {
    code: 'idempotency-key-reuse',
    explanation: 'this outbox idempotency key has already been used',
  },
};

function normalizeDatabaseError(error: unknown, operation: string): unknown {
  if (error instanceof FinancialLedgerError) return error;

  const detail = databaseErrorDetail(error);
  if (detail.code !== UNIQUE_VIOLATION && detail.code !== CHECK_VIOLATION) return error;

  const message = error instanceof Error ? error.message : String(error);
  const named =
    detail.constraint ??
    Object.keys(CONSTRAINT_MEANINGS).find((constraint) => message.includes(constraint));
  const meaning = named === undefined ? undefined : CONSTRAINT_MEANINGS[named];
  if (meaning === undefined) return error;

  return new FinancialLedgerError(meaning.code, `${operation} was refused: ${meaning.explanation}`);
}

function utcText(column: string): string {
  return `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${column}`;
}

const WALLET_COLUMNS = [
  'wallet_id',
  'owner_account_id',
  'asset_type_id',
  'purpose',
  'ledger_account_id',
  'status',
  'created_at',
  'updated_at',
  'correlation_id',
  'idempotency_key',
] as const;

const WALLET_PROJECTION = [
  'wallet_id',
  'owner_account_id',
  'asset_type_id',
  'purpose',
  'ledger_account_id',
  'status',
  utcText('created_at'),
  utcText('updated_at'),
  'correlation_id',
  'idempotency_key',
].join(', ');

const WALLET_STATE_COLUMNS = [
  'state_id',
  'wallet_id',
  'from_status',
  'to_status',
  'reason',
  'occurred_at',
  'correlation_id',
  'idempotency_key',
] as const;

const WALLET_STATE_PROJECTION = [
  'state_id',
  'wallet_id',
  'from_status',
  'to_status',
  'reason',
  utcText('occurred_at'),
  'correlation_id',
  'idempotency_key',
].join(', ');

const PLAN_COLUMNS = [
  'plan_id',
  'obligation_id',
  'obligation_kind',
  'payer_account_id',
  'payee_account_id',
  'status',
  'settlement_asset_type_id',
  'target_amount_minor',
  'committed_at',
  'settled_at',
  'cancelled_at',
  'cancellation_reason',
  'created_at',
  'updated_at',
  'correlation_id',
  'idempotency_key',
] as const;

const PLAN_PROJECTION = [
  'plan_id',
  'obligation_id',
  'obligation_kind',
  'payer_account_id',
  'payee_account_id',
  'status',
  'settlement_asset_type_id',
  'target_amount_minor',
  utcText('committed_at'),
  utcText('settled_at'),
  utcText('cancelled_at'),
  'cancellation_reason',
  utcText('created_at'),
  utcText('updated_at'),
  'correlation_id',
  'idempotency_key',
].join(', ');

const LEG_COLUMNS = [
  'leg_id',
  'plan_id',
  'kind',
  'status',
  'asset_type_id',
  'source_wallet_id',
  'destination_wallet_id',
  'amount_minor',
  'rate_numerator',
  'rate_denominator',
  'settlement_equivalent_minor',
  'ledger_transaction_id',
  'reversal_transaction_id',
  'external_reference',
  'created_at',
  'updated_at',
  'correlation_id',
  'idempotency_key',
] as const;

const LEG_PROJECTION = [
  'leg_id',
  'plan_id',
  'kind',
  'status',
  'asset_type_id',
  'source_wallet_id',
  'destination_wallet_id',
  'amount_minor',
  'rate_numerator',
  'rate_denominator',
  'settlement_equivalent_minor',
  'ledger_transaction_id',
  'reversal_transaction_id',
  'external_reference',
  utcText('created_at'),
  utcText('updated_at'),
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

function text(value: unknown, column: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new FinancialLedgerError(
      'malformed-record',
      `${column} is ${value === null ? 'null' : typeof value}; expected non-empty text`,
    );
  }
  return value;
}

function optionalText(value: unknown, column: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new FinancialLedgerError(
      'malformed-record',
      `${column} is ${typeof value}; expected text or null`,
    );
  }
  return value === '' ? null : value;
}

/** A `bigint` column, as PostgreSQL returns it: a string, so nothing above 2^53 is rounded. */
function bigintValue(value: unknown, column: string): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'string') {
    if (!/^-?\d+$/.test(value)) {
      throw new FinancialLedgerError(
        'malformed-record',
        `${column} "${value}" is not an integer string`,
      );
    }
    return BigInt(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new FinancialLedgerError(
        'malformed-record',
        `${column} is ${String(value)}; expected a safe integer`,
      );
    }
    return BigInt(value);
  }
  throw new FinancialLedgerError(
    'malformed-record',
    `${column} is ${value === null ? 'null' : typeof value}; expected an integer`,
  );
}

export function toWallet(row: Record<string, unknown>): Wallet {
  return sealWallet(
    validateWallet(
      {
        walletId: text(row.wallet_id, 'wallet_id'),
        ownerAccountId: text(row.owner_account_id, 'owner_account_id'),
        assetTypeId: text(row.asset_type_id, 'asset_type_id'),
        purpose: text(row.purpose, 'purpose'),
        ledgerAccountId: text(row.ledger_account_id, 'ledger_account_id'),
        status: text(row.status, 'status'),
        createdAt: text(row.created_at, 'created_at'),
        updatedAt: text(row.updated_at, 'updated_at'),
        correlationId: text(row.correlation_id, 'correlation_id'),
        idempotencyKey: text(row.idempotency_key, 'idempotency_key'),
      },
      'stored row',
    ),
  );
}

export function toWalletState(row: Record<string, unknown>): WalletStateRecord {
  return sealWalletState(
    validateWalletState(
      {
        stateId: text(row.state_id, 'state_id'),
        walletId: text(row.wallet_id, 'wallet_id'),
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

export function toValuePlan(row: Record<string, unknown>): ValuePlan {
  return sealValuePlan(
    validateValuePlan(
      {
        planId: text(row.plan_id, 'plan_id'),
        obligationId: text(row.obligation_id, 'obligation_id'),
        obligationKind: text(row.obligation_kind, 'obligation_kind'),
        payerAccountId: text(row.payer_account_id, 'payer_account_id'),
        payeeAccountId: text(row.payee_account_id, 'payee_account_id'),
        status: text(row.status, 'status'),
        settlementAssetTypeId: text(row.settlement_asset_type_id, 'settlement_asset_type_id'),
        targetAmountMinor: bigintValue(row.target_amount_minor, 'target_amount_minor'),
        committedAt: optionalText(row.committed_at, 'committed_at'),
        settledAt: optionalText(row.settled_at, 'settled_at'),
        cancelledAt: optionalText(row.cancelled_at, 'cancelled_at'),
        cancellationReason: optionalText(row.cancellation_reason, 'cancellation_reason'),
        createdAt: text(row.created_at, 'created_at'),
        updatedAt: text(row.updated_at, 'updated_at'),
        correlationId: text(row.correlation_id, 'correlation_id'),
        idempotencyKey: text(row.idempotency_key, 'idempotency_key'),
      },
      'stored row',
    ),
  );
}

export function toValueLeg(row: Record<string, unknown>): ValueLeg {
  return sealValueLeg(
    validateValueLeg(
      {
        legId: text(row.leg_id, 'leg_id'),
        planId: text(row.plan_id, 'plan_id'),
        kind: text(row.kind, 'kind'),
        status: text(row.status, 'status'),
        assetTypeId: text(row.asset_type_id, 'asset_type_id'),
        sourceWalletId: optionalText(row.source_wallet_id, 'source_wallet_id'),
        destinationWalletId: text(row.destination_wallet_id, 'destination_wallet_id'),
        amountMinor: bigintValue(row.amount_minor, 'amount_minor'),
        // Two columns in, one rate out. There is no decimal rate anywhere and nothing here divides.
        rate: {
          numerator: bigintValue(row.rate_numerator, 'rate_numerator'),
          denominator: bigintValue(row.rate_denominator, 'rate_denominator'),
        },
        settlementEquivalentMinor: bigintValue(
          row.settlement_equivalent_minor,
          'settlement_equivalent_minor',
        ),
        ledgerTransactionId: optionalText(row.ledger_transaction_id, 'ledger_transaction_id'),
        reversalTransactionId: optionalText(row.reversal_transaction_id, 'reversal_transaction_id'),
        externalReference: optionalText(row.external_reference, 'external_reference'),
        createdAt: text(row.created_at, 'created_at'),
        updatedAt: text(row.updated_at, 'updated_at'),
        correlationId: text(row.correlation_id, 'correlation_id'),
        idempotencyKey: text(row.idempotency_key, 'idempotency_key'),
      },
      'stored row',
    ),
  );
}

/** Statements a write enlisted in somebody else's transaction may not issue. */
const TRANSACTION_CONTROL =
  /^\s*(BEGIN|START\s+TRANSACTION|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE\s+SAVEPOINT)\b/i;

export function enlistedClient(client: DatabaseClient): DatabaseClient {
  return {
    query<QueryRow = Record<string, unknown>>(sql: string, params?: readonly unknown[]) {
      if (TRANSACTION_CONTROL.test(sql)) {
        return Promise.reject(
          new FinancialLedgerError(
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

export class EnlistedFinancialLedgerRepository implements FinancialLedgerRepository {
  readonly #client: DatabaseClient;

  constructor(client: DatabaseClient) {
    this.#client = enlistedClient(client);
  }

  withTransaction<T>(body: (tx: FinancialLedgerTransaction) => Promise<T>): Promise<T> {
    return body(new PostgresFinancialLedgerTransaction(this.#client));
  }
}

export class PostgresFinancialLedgerRepository implements FinancialLedgerRepository {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  static enlist(client: DatabaseClient): FinancialLedgerRepository {
    return new EnlistedFinancialLedgerRepository(client);
  }

  async withTransaction<T>(body: (tx: FinancialLedgerTransaction) => Promise<T>): Promise<T> {
    const client = await this.#database.connect();
    try {
      await client.query('BEGIN;');
      try {
        const result = await body(new PostgresFinancialLedgerTransaction(client));
        // The allocation invariant is a deferred constraint trigger, so it fires here rather than at
        // the INSERT. A COMMIT can therefore fail with a check violation, and that failure has to be
        // translated like any other rather than escaping as a raw driver error.
        await client.query('COMMIT;');
        return result;
      } catch (error) {
        await client.query('ROLLBACK;');
        throw normalizeDatabaseError(error, 'the transaction');
      }
    } finally {
      await client.release();
    }
  }
}

export const TIMESTAMP_COLUMNS = [
  'created_at',
  'updated_at',
  'occurred_at',
  'committed_at',
  'settled_at',
  'cancelled_at',
] as const;

class PostgresFinancialLedgerTransaction implements FinancialLedgerTransaction {
  readonly #client: DatabaseClient;

  constructor(client: DatabaseClient) {
    this.#client = client;
  }

  async insertOutbox(entry: OutboxEntry): Promise<void> {
    try {
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
    } catch (error) {
      throw normalizeDatabaseError(error, 'inserting an outbox entry');
    }
  }

  // -------------------------------------------------------------------------
  // Wallets
  // -------------------------------------------------------------------------

  async findWalletById(walletId: string): Promise<Wallet | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${WALLET_PROJECTION} FROM ${WALLET_TABLE} WHERE wallet_id = $1;`,
      [walletId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toWallet(row);
  }

  async findWalletByIdempotencyKey(idempotencyKey: string): Promise<Wallet | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${WALLET_PROJECTION} FROM ${WALLET_TABLE} WHERE idempotency_key = $1;`,
      [idempotencyKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : toWallet(row);
  }

  async findWalletByPosition(
    ownerAccountId: string,
    assetTypeId: string,
    purpose: WalletPurpose,
  ): Promise<Wallet | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${WALLET_PROJECTION} FROM ${WALLET_TABLE}
       WHERE owner_account_id = $1 AND asset_type_id = $2 AND purpose = $3;`,
      [ownerAccountId, assetTypeId, purpose],
    );
    const row = result.rows[0];
    return row === undefined ? null : toWallet(row);
  }

  async findWalletsByOwner(ownerAccountId: string): Promise<readonly Wallet[]> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${WALLET_PROJECTION} FROM ${WALLET_TABLE}
       WHERE owner_account_id = $1 ORDER BY created_at ASC, wallet_id ASC;`,
      [ownerAccountId],
    );
    return Object.freeze(result.rows.map(toWallet));
  }

  async insertWallet(wallet: Wallet): Promise<void> {
    try {
      await this.#client.query(
        `INSERT INTO ${WALLET_TABLE} (${WALLET_COLUMNS.join(', ')})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10);`,
        [
          wallet.walletId,
          wallet.ownerAccountId,
          wallet.assetTypeId,
          wallet.purpose,
          wallet.ledgerAccountId,
          wallet.status,
          wallet.createdAt,
          wallet.updatedAt,
          wallet.correlationId,
          wallet.idempotencyKey,
        ],
      );
    } catch (error) {
      throw normalizeDatabaseError(error, `opening wallet ${wallet.walletId}`);
    }
  }

  /** The conditional update: the status must still be what the caller read. */
  async updateWalletIfStatus(wallet: Wallet, expectedStatus: WalletStatus): Promise<boolean> {
    const result = await this.#client.query(
      `UPDATE ${WALLET_TABLE}
          SET owner_account_id = $2, asset_type_id = $3, purpose = $4, ledger_account_id = $5,
              status = $6, created_at = $7, updated_at = $8, correlation_id = $9,
              idempotency_key = $10
        WHERE wallet_id = $1 AND status = $11;`,
      [
        wallet.walletId,
        wallet.ownerAccountId,
        wallet.assetTypeId,
        wallet.purpose,
        wallet.ledgerAccountId,
        wallet.status,
        wallet.createdAt,
        wallet.updatedAt,
        wallet.correlationId,
        wallet.idempotencyKey,
        expectedStatus,
      ],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async findWalletStateByIdempotencyKey(idempotencyKey: string): Promise<WalletStateRecord | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${WALLET_STATE_PROJECTION} FROM ${WALLET_STATE_TABLE} WHERE idempotency_key = $1;`,
      [idempotencyKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : toWalletState(row);
  }

  async findWalletStatesByWalletId(walletId: string): Promise<readonly WalletStateRecord[]> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${WALLET_STATE_PROJECTION} FROM ${WALLET_STATE_TABLE}
       WHERE wallet_id = $1 ORDER BY occurred_at ASC, state_id ASC;`,
      [walletId],
    );
    return Object.freeze(result.rows.map(toWalletState));
  }

  async insertWalletState(record: WalletStateRecord): Promise<void> {
    try {
      await this.#client.query(
        `INSERT INTO ${WALLET_STATE_TABLE} (${WALLET_STATE_COLUMNS.join(', ')})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8);`,
        [
          record.stateId,
          record.walletId,
          record.fromStatus,
          record.toStatus,
          record.reason,
          record.occurredAt,
          record.correlationId,
          record.idempotencyKey,
        ],
      );
    } catch (error) {
      throw normalizeDatabaseError(error, `recording wallet state ${record.stateId}`);
    }
  }

  // -------------------------------------------------------------------------
  // Plans
  // -------------------------------------------------------------------------

  async findPlanById(planId: string): Promise<ValuePlan | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${PLAN_PROJECTION} FROM ${VALUE_PLAN_TABLE} WHERE plan_id = $1;`,
      [planId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toValuePlan(row);
  }

  async findPlanByIdempotencyKey(idempotencyKey: string): Promise<ValuePlan | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${PLAN_PROJECTION} FROM ${VALUE_PLAN_TABLE} WHERE idempotency_key = $1;`,
      [idempotencyKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : toValuePlan(row);
  }

  async findLivePlanByObligation(obligationId: string): Promise<ValuePlan | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${PLAN_PROJECTION} FROM ${VALUE_PLAN_TABLE}
       WHERE obligation_id = $1 AND status <> 'cancelled';`,
      [obligationId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toValuePlan(row);
  }

  async findPlansByObligation(obligationId: string): Promise<readonly ValuePlan[]> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${PLAN_PROJECTION} FROM ${VALUE_PLAN_TABLE}
       WHERE obligation_id = $1 ORDER BY created_at ASC, plan_id ASC;`,
      [obligationId],
    );
    return Object.freeze(result.rows.map(toValuePlan));
  }

  async findPlansByPayer(payerAccountId: string): Promise<readonly ValuePlan[]> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${PLAN_PROJECTION} FROM ${VALUE_PLAN_TABLE}
       WHERE payer_account_id = $1 ORDER BY created_at ASC, plan_id ASC;`,
      [payerAccountId],
    );
    return Object.freeze(result.rows.map(toValuePlan));
  }

  async insertPlan(plan: ValuePlan): Promise<void> {
    try {
      await this.#client.query(
        `INSERT INTO ${VALUE_PLAN_TABLE} (${PLAN_COLUMNS.join(', ')})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16);`,
        planParameters(plan),
      );
    } catch (error) {
      throw normalizeDatabaseError(error, `allocating plan ${plan.planId}`);
    }
  }

  async updatePlanIfStatus(plan: ValuePlan, expectedStatus: PlanStatus): Promise<boolean> {
    const assignments = PLAN_COLUMNS.slice(1)
      .map((column, index) => `${column} = $${String(index + 2)}`)
      .join(', ');
    const result = await this.#client.query(
      `UPDATE ${VALUE_PLAN_TABLE} SET ${assignments} WHERE plan_id = $1 AND status = $17;`,
      [...planParameters(plan), expectedStatus],
    );
    return (result.rowCount ?? 0) > 0;
  }

  // -------------------------------------------------------------------------
  // Legs
  // -------------------------------------------------------------------------

  async findLegById(legId: string): Promise<ValueLeg | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${LEG_PROJECTION} FROM ${VALUE_LEG_TABLE} WHERE leg_id = $1;`,
      [legId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toValueLeg(row);
  }

  async findLegByIdempotencyKey(idempotencyKey: string): Promise<ValueLeg | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${LEG_PROJECTION} FROM ${VALUE_LEG_TABLE} WHERE idempotency_key = $1;`,
      [idempotencyKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : toValueLeg(row);
  }

  async findLegsByPlanId(planId: string): Promise<readonly ValueLeg[]> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${LEG_PROJECTION} FROM ${VALUE_LEG_TABLE}
       WHERE plan_id = $1 ORDER BY created_at ASC, leg_id ASC;`,
      [planId],
    );
    return Object.freeze(result.rows.map(toValueLeg));
  }

  async insertLeg(leg: ValueLeg): Promise<void> {
    try {
      await this.#client.query(
        `INSERT INTO ${VALUE_LEG_TABLE} (${LEG_COLUMNS.join(', ')})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18);`,
        legParameters(leg),
      );
    } catch (error) {
      throw normalizeDatabaseError(error, `adding leg ${leg.legId}`);
    }
  }

  async updateLegIfStatus(leg: ValueLeg, expectedStatus: LegStatus): Promise<boolean> {
    const assignments = LEG_COLUMNS.slice(1)
      .map((column, index) => `${column} = $${String(index + 2)}`)
      .join(', ');
    try {
      const result = await this.#client.query(
        `UPDATE ${VALUE_LEG_TABLE} SET ${assignments} WHERE leg_id = $1 AND status = $19;`,
        [...legParameters(leg), expectedStatus],
      );
      return (result.rowCount ?? 0) > 0;
    } catch (error) {
      throw normalizeDatabaseError(error, `posting leg ${leg.legId}`);
    }
  }
}

function planParameters(plan: ValuePlan): readonly unknown[] {
  return [
    plan.planId,
    plan.obligationId,
    plan.obligationKind,
    plan.payerAccountId,
    plan.payeeAccountId,
    plan.status,
    plan.settlementAssetTypeId,
    plan.targetAmountMinor,
    plan.committedAt,
    plan.settledAt,
    plan.cancelledAt,
    plan.cancellationReason,
    plan.createdAt,
    plan.updatedAt,
    plan.correlationId,
    plan.idempotencyKey,
  ];
}

function legParameters(leg: ValueLeg): readonly unknown[] {
  return [
    leg.legId,
    leg.planId,
    leg.kind,
    leg.status,
    leg.assetTypeId,
    leg.sourceWalletId,
    leg.destinationWalletId,
    leg.amountMinor,
    leg.rate.numerator,
    leg.rate.denominator,
    leg.settlementEquivalentMinor,
    leg.ledgerTransactionId,
    leg.reversalTransactionId,
    leg.externalReference,
    leg.createdAt,
    leg.updatedAt,
    leg.correlationId,
    leg.idempotencyKey,
  ];
}
