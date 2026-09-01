/**
 * M-12 Payments — PostgreSQL adapter.
 *
 * Implements the persistence port against `module_payments`. It knows SQL and nothing else: no
 * validation, no lifecycle, no provider. Those live in the service, where they can be tested without
 * a server.
 *
 * Every `timestamptz` is projected as UTC text through `to_char`, so the driver never parses a
 * timestamp and never hands back a `Date` in the process's own timezone. Money is `bigint` minor
 * units and comes back as a string, which the validator accepts as one of its three forms.
 *
 * `updatePaymentIfUnchanged` is the reason this adapter matters. It is a conditional `UPDATE` whose
 * `WHERE` clause repeats what the caller read, so two transactions racing to capture the same
 * payment cannot both succeed: the second blocks on the row, re-evaluates the clause after the first
 * commits, updates nothing, and reports false. The service then refuses — with the attempt row
 * already written, so a provider call that may have moved money is never left unrecorded.
 *
 * No statement names another unit's schema, and there is no foreign key out of `module_payments`.
 *
 * Owned by: M-12 Payments.
 */

import { databaseErrorDetail } from '../../platform/db/client.ts';
import type { Database, DatabaseClient } from '../../platform/db/client.ts';
import type { OutboxEntry } from '../../platform/outbox/types.ts';

import { sealPayment, sealPaymentAttempt, sealRefund, sealWebhookReceipt } from './immutable.ts';
import type { PaymentGuard, PaymentRepository, PaymentTransaction } from './repository.ts';
import {
  PaymentError,
  type Payment,
  type PaymentAttempt,
  type PaymentErrorCode,
  type Refund,
  type WebhookReceipt,
} from './types.ts';
import {
  validatePayment,
  validatePaymentAttempt,
  validateRefund,
  validateWebhookReceipt,
} from './validate.ts';

export const PAYMENTS_SCHEMA = 'module_payments';
export const PAYMENT_TABLE = `${PAYMENTS_SCHEMA}.payment`;
export const PAYMENT_ATTEMPT_TABLE = `${PAYMENTS_SCHEMA}.payment_attempt`;
export const REFUND_TABLE = `${PAYMENTS_SCHEMA}.refund`;
export const WEBHOOK_RECEIPT_TABLE = `${PAYMENTS_SCHEMA}.webhook_receipt`;
export const OUTBOX_TABLE = `${PAYMENTS_SCHEMA}.outbox`;

/** SQLSTATE 23505. The only driver code this adapter interprets. */
const UNIQUE_VIOLATION = '23505';

const CONSTRAINT_MEANINGS: Readonly<
  Record<string, { readonly code: PaymentErrorCode; readonly explanation: string }>
> = {
  payment_pkey: {
    code: 'duplicate-payment-id',
    explanation: 'a payment with this id already exists, and a payment is never overwritten',
  },
  payment_idempotency_unique: {
    code: 'idempotency-key-reuse',
    explanation: 'this idempotency key has already been used for a payment',
  },
  payment_attempt_pkey: {
    code: 'duplicate-attempt-id',
    explanation: 'an attempt with this id already exists, and an attempt is never rewritten',
  },
  payment_attempt_idempotency_unique: {
    code: 'idempotency-key-reuse',
    explanation: 'this idempotency key has already been used for an attempt',
  },
  refund_pkey: {
    code: 'duplicate-refund-id',
    explanation: 'a refund with this id already exists, and a refund is never rewritten',
  },
  refund_idempotency_unique: {
    code: 'idempotency-key-reuse',
    explanation: 'this idempotency key has already been used for a refund',
  },
  webhook_receipt_pkey: {
    code: 'malformed-record',
    explanation: 'a receipt with this id already exists',
  },
  webhook_receipt_idempotency_unique: {
    code: 'idempotency-key-reuse',
    explanation: 'this idempotency key has already been used for a receipt',
  },
  webhook_receipt_provider_event_unique: {
    code: 'duplicate-webhook',
    explanation:
      'this provider event has already been received. A redelivery takes effect exactly once',
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
  if (error instanceof PaymentError) return error;

  const detail = databaseErrorDetail(error);
  if (detail.code !== UNIQUE_VIOLATION) return error;

  const message = error instanceof Error ? error.message : String(error);
  const named =
    detail.constraint ??
    Object.keys(CONSTRAINT_MEANINGS).find((constraint) => message.includes(constraint));
  const meaning = named === undefined ? undefined : CONSTRAINT_MEANINGS[named];
  if (meaning === undefined) return error;

  return new PaymentError(meaning.code, `${operation} was refused: ${meaning.explanation}`);
}

const PAYMENT_COLUMNS = [
  'payment_id',
  'order_id',
  'payer_account_id',
  'payee_account_id',
  'status',
  'provider',
  'rail',
  'instrument_token',
  'asset_code',
  'asset_scale',
  'amount_minor',
  'captured_minor',
  'refunded_minor',
  'provider_reference',
  'authorised_at',
  'captured_at',
  'failed_at',
  'cancelled_at',
  'failure_code',
  'created_at',
  'updated_at',
  'correlation_id',
  'idempotency_key',
] as const;

const PAYMENT_ATTEMPT_COLUMNS = [
  'attempt_id',
  'payment_id',
  'kind',
  'outcome',
  'amount_minor',
  'provider_reference',
  'failure_code',
  'attempted_at',
  'correlation_id',
  'idempotency_key',
] as const;

const REFUND_COLUMNS = [
  'refund_id',
  'payment_id',
  'amount_minor',
  'reason',
  'provider_reference',
  'refunded_at',
  'correlation_id',
  'idempotency_key',
] as const;

const WEBHOOK_RECEIPT_COLUMNS = [
  'receipt_id',
  'provider',
  'provider_event_id',
  'payment_id',
  'kind',
  'signature_verified',
  'payload',
  'received_at',
  'processed_at',
  'correlation_id',
  'idempotency_key',
] as const;

function utcText(column: string): string {
  return `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${column}`;
}

const PAYMENT_PROJECTION = [
  'payment_id',
  'order_id',
  'payer_account_id',
  'payee_account_id',
  'status',
  'provider',
  'rail',
  'instrument_token',
  'asset_code',
  'asset_scale',
  'amount_minor',
  'captured_minor',
  'refunded_minor',
  'provider_reference',
  utcText('authorised_at'),
  utcText('captured_at'),
  utcText('failed_at'),
  utcText('cancelled_at'),
  'failure_code',
  utcText('created_at'),
  utcText('updated_at'),
  'correlation_id',
  'idempotency_key',
].join(', ');

const PAYMENT_ATTEMPT_PROJECTION = [
  'attempt_id',
  'payment_id',
  'kind',
  'outcome',
  'amount_minor',
  'provider_reference',
  'failure_code',
  utcText('attempted_at'),
  'correlation_id',
  'idempotency_key',
].join(', ');

const REFUND_PROJECTION = [
  'refund_id',
  'payment_id',
  'amount_minor',
  'reason',
  'provider_reference',
  utcText('refunded_at'),
  'correlation_id',
  'idempotency_key',
].join(', ');

const WEBHOOK_RECEIPT_PROJECTION = [
  'receipt_id',
  'provider',
  'provider_event_id',
  'payment_id',
  'kind',
  'signature_verified',
  'payload',
  utcText('received_at'),
  utcText('processed_at'),
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
    throw new PaymentError(
      'malformed-record',
      `${column} is ${value === null ? 'null' : typeof value}; expected non-empty text`,
    );
  }
  return value;
}

function optionalText(value: unknown, column: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new PaymentError(
      'malformed-record',
      `${column} is ${typeof value}; expected text or null`,
    );
  }
  return value === '' ? null : value;
}

function jsonObject(value: unknown, column: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new PaymentError(
      'malformed-record',
      `${column} is ${value === null ? 'null' : typeof value}; expected a JSON object`,
    );
  }
  return value as Record<string, unknown>;
}

function booleanValue(value: unknown, column: string): boolean {
  if (typeof value !== 'boolean') {
    throw new PaymentError(
      'malformed-record',
      `${column} is ${value === null ? 'null' : typeof value}; expected a boolean`,
    );
  }
  return value;
}

function integerValue(value: unknown, column: string): number {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  throw new PaymentError(
    'malformed-record',
    `${column} is ${value === null ? 'null' : typeof value}; expected an integer`,
  );
}

/**
 * A `bigint` column, as PostgreSQL returns it.
 *
 * The driver hands back a string for `bigint` precisely so nothing above 2^53 is quietly rounded,
 * and this keeps it exact all the way into the record.
 */
function bigintValue(value: unknown, column: string): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'string') {
    if (!/^-?\d+$/.test(value)) {
      throw new PaymentError('malformed-record', `${column} "${value}" is not an integer string`);
    }
    return BigInt(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new PaymentError(
        'malformed-record',
        `${column} is ${String(value)}; expected a safe integer`,
      );
    }
    return BigInt(value);
  }
  throw new PaymentError(
    'malformed-record',
    `${column} is ${value === null ? 'null' : typeof value}; expected an integer`,
  );
}

export function toPayment(row: Record<string, unknown>): Payment {
  return sealPayment(
    validatePayment(
      {
        paymentId: text(row.payment_id, 'payment_id'),
        orderId: text(row.order_id, 'order_id'),
        payerAccountId: text(row.payer_account_id, 'payer_account_id'),
        payeeAccountId: text(row.payee_account_id, 'payee_account_id'),
        status: text(row.status, 'status'),
        provider: text(row.provider, 'provider'),
        rail: text(row.rail, 'rail'),
        instrumentToken: text(row.instrument_token, 'instrument_token'),
        assetCode: text(row.asset_code, 'asset_code'),
        assetScale: integerValue(row.asset_scale, 'asset_scale'),
        amountMinor: bigintValue(row.amount_minor, 'amount_minor'),
        capturedMinor: bigintValue(row.captured_minor, 'captured_minor'),
        refundedMinor: bigintValue(row.refunded_minor, 'refunded_minor'),
        providerReference: optionalText(row.provider_reference, 'provider_reference'),
        authorisedAt: optionalText(row.authorised_at, 'authorised_at'),
        capturedAt: optionalText(row.captured_at, 'captured_at'),
        failedAt: optionalText(row.failed_at, 'failed_at'),
        cancelledAt: optionalText(row.cancelled_at, 'cancelled_at'),
        failureCode: optionalText(row.failure_code, 'failure_code'),
        createdAt: text(row.created_at, 'created_at'),
        updatedAt: text(row.updated_at, 'updated_at'),
        correlationId: text(row.correlation_id, 'correlation_id'),
        idempotencyKey: text(row.idempotency_key, 'idempotency_key'),
      },
      'stored row',
    ),
  );
}

export function toPaymentAttempt(row: Record<string, unknown>): PaymentAttempt {
  return sealPaymentAttempt(
    validatePaymentAttempt(
      {
        attemptId: text(row.attempt_id, 'attempt_id'),
        paymentId: text(row.payment_id, 'payment_id'),
        kind: text(row.kind, 'kind'),
        outcome: text(row.outcome, 'outcome'),
        amountMinor: bigintValue(row.amount_minor, 'amount_minor'),
        providerReference: optionalText(row.provider_reference, 'provider_reference'),
        failureCode: optionalText(row.failure_code, 'failure_code'),
        attemptedAt: text(row.attempted_at, 'attempted_at'),
        correlationId: text(row.correlation_id, 'correlation_id'),
        idempotencyKey: text(row.idempotency_key, 'idempotency_key'),
      },
      'stored row',
    ),
  );
}

export function toRefund(row: Record<string, unknown>): Refund {
  return sealRefund(
    validateRefund(
      {
        refundId: text(row.refund_id, 'refund_id'),
        paymentId: text(row.payment_id, 'payment_id'),
        amountMinor: bigintValue(row.amount_minor, 'amount_minor'),
        reason: text(row.reason, 'reason'),
        providerReference: optionalText(row.provider_reference, 'provider_reference'),
        refundedAt: text(row.refunded_at, 'refunded_at'),
        correlationId: text(row.correlation_id, 'correlation_id'),
        idempotencyKey: text(row.idempotency_key, 'idempotency_key'),
      },
      'stored row',
    ),
  );
}

export function toWebhookReceipt(row: Record<string, unknown>): WebhookReceipt {
  return sealWebhookReceipt(
    validateWebhookReceipt(
      {
        receiptId: text(row.receipt_id, 'receipt_id'),
        provider: text(row.provider, 'provider'),
        providerEventId: text(row.provider_event_id, 'provider_event_id'),
        paymentId: optionalText(row.payment_id, 'payment_id'),
        kind: text(row.kind, 'kind'),
        signatureVerified: booleanValue(row.signature_verified, 'signature_verified'),
        payload: jsonObject(row.payload, 'payload'),
        receivedAt: text(row.received_at, 'received_at'),
        processedAt: optionalText(row.processed_at, 'processed_at'),
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
          new PaymentError(
            'nested-transaction',
            `an enlisted payment write may not issue "${sql.trim().split(/\s+/, 2).join(' ')}". ` +
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

export class EnlistedPaymentRepository implements PaymentRepository {
  readonly #client: DatabaseClient;

  constructor(client: DatabaseClient) {
    this.#client = enlistedClient(client);
  }

  withTransaction<T>(body: (tx: PaymentTransaction) => Promise<T>): Promise<T> {
    return body(new PostgresPaymentTransaction(this.#client));
  }
}

export class PostgresPaymentRepository implements PaymentRepository {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  static enlist(client: DatabaseClient): PaymentRepository {
    return new EnlistedPaymentRepository(client);
  }

  async withTransaction<T>(body: (tx: PaymentTransaction) => Promise<T>): Promise<T> {
    const client = await this.#database.connect();
    try {
      await client.query('BEGIN;');
      try {
        const result = await body(new PostgresPaymentTransaction(client));
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
  'created_at',
  'updated_at',
  'authorised_at',
  'captured_at',
  'failed_at',
  'cancelled_at',
  'attempted_at',
  'refunded_at',
  'received_at',
  'processed_at',
] as const;

class PostgresPaymentTransaction implements PaymentTransaction {
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
  // Payment
  // -------------------------------------------------------------------------

  async findPaymentById(paymentId: string): Promise<Payment | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${PAYMENT_PROJECTION} FROM ${PAYMENT_TABLE} WHERE payment_id = $1;`,
      [paymentId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toPayment(row);
  }

  async findPaymentByIdempotencyKey(idempotencyKey: string): Promise<Payment | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${PAYMENT_PROJECTION} FROM ${PAYMENT_TABLE} WHERE idempotency_key = $1;`,
      [idempotencyKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : toPayment(row);
  }

  async findPaymentsByOrderId(orderId: string): Promise<readonly Payment[]> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${PAYMENT_PROJECTION} FROM ${PAYMENT_TABLE}
       WHERE order_id = $1 ORDER BY created_at ASC, payment_id ASC;`,
      [orderId],
    );
    return Object.freeze(result.rows.map(toPayment));
  }

  async findPaymentsByPayerAccountId(payerAccountId: string): Promise<readonly Payment[]> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${PAYMENT_PROJECTION} FROM ${PAYMENT_TABLE}
       WHERE payer_account_id = $1 ORDER BY created_at ASC, payment_id ASC;`,
      [payerAccountId],
    );
    return Object.freeze(result.rows.map(toPayment));
  }

  async insertPayment(payment: Payment): Promise<void> {
    try {
      await this.#client.query(
        `INSERT INTO ${PAYMENT_TABLE} (${PAYMENT_COLUMNS.join(', ')})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
                 $19, $20, $21, $22, $23);`,
        paymentParameters(payment),
      );
    } catch (error) {
      throw normalizeDatabaseError(error, `inserting payment ${payment.paymentId}`);
    }
  }

  async updatePayment(payment: Payment): Promise<void> {
    const result = await this.#client.query(
      `UPDATE ${PAYMENT_TABLE} SET ${paymentAssignments()} WHERE payment_id = $1;`,
      paymentParameters(payment),
    );
    if ((result.rowCount ?? 0) === 0) {
      throw new PaymentError('payment-not-found', `payment ${payment.paymentId} does not exist`);
    }
  }

  /**
   * The conditional update.
   *
   * The `WHERE` clause repeats what the caller read, so a second transaction racing this one blocks
   * on the row, re-evaluates the clause once the first commits, matches nothing, and reports false.
   * The status alone would not be enough: two concurrent partial refunds both leave the status
   * where it was, and only the running totals distinguish them.
   */
  async updatePaymentIfUnchanged(payment: Payment, expected: PaymentGuard): Promise<boolean> {
    const result = await this.#client.query(
      `UPDATE ${PAYMENT_TABLE} SET ${paymentAssignments()}
       WHERE payment_id = $1 AND status = $24 AND captured_minor = $25 AND refunded_minor = $26;`,
      [
        ...paymentParameters(payment),
        expected.status,
        expected.capturedMinor,
        expected.refundedMinor,
      ],
    );
    return (result.rowCount ?? 0) > 0;
  }

  // -------------------------------------------------------------------------
  // Attempt
  // -------------------------------------------------------------------------

  async findAttemptById(attemptId: string): Promise<PaymentAttempt | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${PAYMENT_ATTEMPT_PROJECTION} FROM ${PAYMENT_ATTEMPT_TABLE} WHERE attempt_id = $1;`,
      [attemptId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toPaymentAttempt(row);
  }

  async findAttemptByIdempotencyKey(idempotencyKey: string): Promise<PaymentAttempt | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${PAYMENT_ATTEMPT_PROJECTION} FROM ${PAYMENT_ATTEMPT_TABLE}
       WHERE idempotency_key = $1;`,
      [idempotencyKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : toPaymentAttempt(row);
  }

  async findAttemptsByPaymentId(paymentId: string): Promise<readonly PaymentAttempt[]> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${PAYMENT_ATTEMPT_PROJECTION} FROM ${PAYMENT_ATTEMPT_TABLE}
       WHERE payment_id = $1 ORDER BY attempted_at ASC, attempt_id ASC;`,
      [paymentId],
    );
    return Object.freeze(result.rows.map(toPaymentAttempt));
  }

  async insertAttempt(attempt: PaymentAttempt): Promise<void> {
    try {
      await this.#client.query(
        `INSERT INTO ${PAYMENT_ATTEMPT_TABLE} (${PAYMENT_ATTEMPT_COLUMNS.join(', ')})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10);`,
        [
          attempt.attemptId,
          attempt.paymentId,
          attempt.kind,
          attempt.outcome,
          attempt.amountMinor,
          attempt.providerReference,
          attempt.failureCode,
          attempt.attemptedAt,
          attempt.correlationId,
          attempt.idempotencyKey,
        ],
      );
    } catch (error) {
      throw normalizeDatabaseError(error, `inserting attempt ${attempt.attemptId}`);
    }
  }

  // -------------------------------------------------------------------------
  // Refund
  // -------------------------------------------------------------------------

  async findRefundById(refundId: string): Promise<Refund | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${REFUND_PROJECTION} FROM ${REFUND_TABLE} WHERE refund_id = $1;`,
      [refundId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toRefund(row);
  }

  async findRefundByIdempotencyKey(idempotencyKey: string): Promise<Refund | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${REFUND_PROJECTION} FROM ${REFUND_TABLE} WHERE idempotency_key = $1;`,
      [idempotencyKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : toRefund(row);
  }

  async findRefundsByPaymentId(paymentId: string): Promise<readonly Refund[]> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${REFUND_PROJECTION} FROM ${REFUND_TABLE}
       WHERE payment_id = $1 ORDER BY refunded_at ASC, refund_id ASC;`,
      [paymentId],
    );
    return Object.freeze(result.rows.map(toRefund));
  }

  async insertRefund(refund: Refund): Promise<void> {
    try {
      await this.#client.query(
        `INSERT INTO ${REFUND_TABLE} (${REFUND_COLUMNS.join(', ')})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8);`,
        [
          refund.refundId,
          refund.paymentId,
          refund.amountMinor,
          refund.reason,
          refund.providerReference,
          refund.refundedAt,
          refund.correlationId,
          refund.idempotencyKey,
        ],
      );
    } catch (error) {
      throw normalizeDatabaseError(error, `inserting refund ${refund.refundId}`);
    }
  }

  // -------------------------------------------------------------------------
  // Webhook receipt
  // -------------------------------------------------------------------------

  async findReceiptById(receiptId: string): Promise<WebhookReceipt | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${WEBHOOK_RECEIPT_PROJECTION} FROM ${WEBHOOK_RECEIPT_TABLE} WHERE receipt_id = $1;`,
      [receiptId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toWebhookReceipt(row);
  }

  async findReceiptByProviderEvent(
    provider: string,
    providerEventId: string,
  ): Promise<WebhookReceipt | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${WEBHOOK_RECEIPT_PROJECTION} FROM ${WEBHOOK_RECEIPT_TABLE}
       WHERE provider = $1 AND provider_event_id = $2;`,
      [provider, providerEventId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toWebhookReceipt(row);
  }

  async findReceiptsByPaymentId(paymentId: string): Promise<readonly WebhookReceipt[]> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${WEBHOOK_RECEIPT_PROJECTION} FROM ${WEBHOOK_RECEIPT_TABLE}
       WHERE payment_id = $1 ORDER BY received_at ASC, receipt_id ASC;`,
      [paymentId],
    );
    return Object.freeze(result.rows.map(toWebhookReceipt));
  }

  async insertReceipt(receipt: WebhookReceipt): Promise<void> {
    try {
      await this.#client.query(
        `INSERT INTO ${WEBHOOK_RECEIPT_TABLE} (${WEBHOOK_RECEIPT_COLUMNS.join(', ')})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11);`,
        [
          receipt.receiptId,
          receipt.provider,
          receipt.providerEventId,
          receipt.paymentId,
          receipt.kind,
          receipt.signatureVerified,
          JSON.stringify(receipt.payload),
          receipt.receivedAt,
          receipt.processedAt,
          receipt.correlationId,
          receipt.idempotencyKey,
        ],
      );
    } catch (error) {
      throw normalizeDatabaseError(error, `recording webhook ${receipt.receiptId}`);
    }
  }

  /**
   * Stamp the receipt processed.
   *
   * `processed_at IS NULL` in the `WHERE` clause makes the stamp one-way in SQL as well as in the
   * trigger: a second stamp matches no row rather than raising, which is what a redelivery racing
   * itself should do.
   */
  async markReceiptProcessed(receiptId: string, processedAt: string): Promise<void> {
    const result = await this.#client.query(
      `UPDATE ${WEBHOOK_RECEIPT_TABLE} SET processed_at = $2
       WHERE receipt_id = $1 AND processed_at IS NULL;`,
      [receiptId, processedAt],
    );
    if ((result.rowCount ?? 0) === 0) {
      const existing = await this.findReceiptById(receiptId);
      if (existing === null) {
        throw new PaymentError('malformed-record', `receipt ${receiptId} does not exist`);
      }
      // Already stamped. Not an error: the delivery was dealt with, which is what the caller wanted.
    }
  }
}

/** `SET` clauses for every column but the primary key, numbered to match `paymentParameters`. */
function paymentAssignments(): string {
  return PAYMENT_COLUMNS.slice(1)
    .map((column, index) => `${column} = $${String(index + 2)}`)
    .join(', ');
}

/** Parameters in `PAYMENT_COLUMNS` order, so `$1` is always the payment id. */
function paymentParameters(payment: Payment): readonly unknown[] {
  return [
    payment.paymentId,
    payment.orderId,
    payment.payerAccountId,
    payment.payeeAccountId,
    payment.status,
    payment.provider,
    payment.rail,
    payment.instrumentToken,
    payment.assetCode,
    payment.assetScale,
    payment.amountMinor,
    payment.capturedMinor,
    payment.refundedMinor,
    payment.providerReference,
    payment.authorisedAt,
    payment.capturedAt,
    payment.failedAt,
    payment.cancelledAt,
    payment.failureCode,
    payment.createdAt,
    payment.updatedAt,
    payment.correlationId,
    payment.idempotencyKey,
  ];
}
