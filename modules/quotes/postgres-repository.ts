/**
 * M-10 Quotes — the PostgreSQL adapter.
 *
 * Implements the persistence port against `module_quotes`. It knows SQL and nothing else: no
 * validation, no lifecycle, no invitation check. Those live in the service, where they can be tested
 * without a server.
 *
 * Two properties of this file are load-bearing.
 *
 * **The UPDATE statement sets four columns.** Status, when it closed, why, and `updated_at`. The
 * price, the quantity, the lead time, the terms and the validity are not in the SET list, and the
 * `quote_terms_are_immutable` trigger refuses an UPDATE that changes them anyway. Two layers on
 * purpose: this one makes the intent readable, and the trigger survives somebody editing this one.
 *
 * **Every `timestamptz` is projected as UTC text** through `to_char`, never handed to the driver as
 * a `Date`. A `Date` has millisecond resolution and a local time zone; the column has microsecond
 * resolution and none. Letting the driver parse one silently truncates the instant and moves it —
 * and here that instant is when an offer stops binding.
 *
 * `quantity`, `unit_price_minor` and `total_minor` are `bigint` columns and come back as digit
 * strings, which is one of the three forms every amount in this repository accepts. They are never
 * read through `Number`: a double cannot hold every amount the platform can express, and a price
 * rounded on the way out is a price somebody is charged.
 *
 * No statement names another unit's schema, and there is no foreign key out of `module_quotes`.
 *
 * Owned by: M-10 Quotes.
 */

import { databaseErrorDetail } from '../../platform/db/client.ts';
import type { Database, DatabaseClient } from '../../platform/db/client.ts';
import type { OutboxEntry } from '../../platform/outbox/types.ts';

import { sealQuote } from './immutable.ts';
import type { QuoteRepository, QuoteTransaction } from './repository.ts';
import { QuoteError, type Quote, type QuoteErrorCode } from './types.ts';
import { validateQuote } from './validate.ts';

export const QUOTES_SCHEMA = 'module_quotes';
export const QUOTE_TABLE = `${QUOTES_SCHEMA}.quote`;
export const OUTBOX_TABLE = `${QUOTES_SCHEMA}.outbox`;

/** SQLSTATE 23505. The only driver code this adapter interprets. */
const UNIQUE_VIOLATION = '23505';

/**
 * What each unique constraint means, in M-10's vocabulary.
 *
 * Translated rather than passed through, because a driver error names a constraint and a caller
 * needs to know what it did wrong. Anything not in this table is re-thrown untouched: inventing a
 * meaning for a constraint nobody mapped would be a guess presented as a diagnosis.
 */
const CONSTRAINT_MEANINGS: Readonly<
  Record<string, { readonly code: QuoteErrorCode; readonly explanation: string }>
> = {
  quote_pkey: {
    code: 'duplicate-quote-id',
    explanation: 'an offer with this id already exists, and an offer is never overwritten',
  },
  quote_idempotency_unique: {
    code: 'idempotency-key-reuse',
    explanation: 'this idempotency key has already been used for an offer',
  },
};

function normalizeDatabaseError(error: unknown): unknown {
  if (error instanceof QuoteError) return error;

  const detail = databaseErrorDetail(error);
  if (detail.code !== UNIQUE_VIOLATION) return error;

  const message = error instanceof Error ? error.message : String(error);
  const named =
    detail.constraint ??
    Object.keys(CONSTRAINT_MEANINGS).find((constraint) => message.includes(constraint));
  const meaning = named === undefined ? undefined : CONSTRAINT_MEANINGS[named];
  if (meaning === undefined) return error;

  return new QuoteError(meaning.code, meaning.explanation);
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

const QUOTE_PROJECTION = [
  'quote_id',
  'rfq_id',
  'supplier_account_id',
  'kind',
  'status',
  // bigint columns. The driver returns these as digit strings, and they stay strings until the
  // validator turns them into bigints. Nothing here goes through Number.
  'quantity',
  'unit_price_minor',
  'total_minor',
  'currency',
  'lead_time_days',
  'delivery_terms',
  utcText('valid_until'),
  'substitution_note',
  'evidence_references',
  utcText('submitted_at'),
  utcText('updated_at'),
  utcText('closed_at'),
  'closure_reason',
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

function toQuote(row: Record<string, unknown>): Quote {
  return sealQuote(
    validateQuote(
      {
        quoteId: row.quote_id,
        rfqId: row.rfq_id,
        supplierAccountId: row.supplier_account_id,
        kind: row.kind,
        status: row.status,
        quantity: row.quantity,
        unitPriceMinor: row.unit_price_minor,
        totalMinor: row.total_minor,
        currency: row.currency,
        leadTimeDays: row.lead_time_days,
        deliveryTerms: row.delivery_terms,
        validUntil: row.valid_until,
        substitutionNote: row.substitution_note ?? null,
        evidenceReferences: row.evidence_references,
        submittedAt: row.submitted_at,
        updatedAt: row.updated_at,
        closedAt: row.closed_at ?? null,
        closureReason: row.closure_reason ?? null,
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
 * Used when M-10 is enlisted in somebody else's transaction — an order opened from an accepted
 * offer, say. A producing module writing its outbox inside a caller's transaction must not be able
 * to commit it early: the whole value of the outbox is that the fact and its publication share one
 * transaction.
 */
export function enlistedClient(client: DatabaseClient): DatabaseClient {
  return {
    query<QueryRow = Record<string, unknown>>(sql: string, params?: readonly unknown[]) {
      if (TRANSACTION_CONTROL.test(sql)) {
        return Promise.reject(
          new QuoteError(
            'malformed-record',
            `an enlisted quote write may not issue "${sql.trim().split(/\s+/, 2).join(' ')}". ` +
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

class PostgresQuoteTransaction implements QuoteTransaction {
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

  async findQuoteById(quoteId: string): Promise<Quote | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${QUOTE_PROJECTION} FROM ${QUOTE_TABLE} WHERE quote_id = $1;`,
      [quoteId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toQuote(row);
  }

  async findQuoteByIdempotencyKey(idempotencyKey: string): Promise<Quote | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${QUOTE_PROJECTION} FROM ${QUOTE_TABLE} WHERE idempotency_key = $1;`,
      [idempotencyKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : toQuote(row);
  }

  /** Every offer against one tender, whatever its status. A buyer sees the withdrawn ones too. */
  async findQuotesByRfqId(rfqId: string): Promise<readonly Quote[]> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${QUOTE_PROJECTION} FROM ${QUOTE_TABLE}
       WHERE rfq_id = $1
       ORDER BY submitted_at, quote_id;`,
      [rfqId],
    );
    return Object.freeze(result.rows.map(toQuote));
  }

  async findQuotesBySupplier(supplierAccountId: string): Promise<readonly Quote[]> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${QUOTE_PROJECTION} FROM ${QUOTE_TABLE}
       WHERE supplier_account_id = $1
       ORDER BY submitted_at DESC, quote_id;`,
      [supplierAccountId],
    );
    return Object.freeze(result.rows.map(toQuote));
  }

  async insertQuote(quote: Quote): Promise<void> {
    try {
      await this.#client.query(
        `INSERT INTO ${QUOTE_TABLE}
           (quote_id, rfq_id, supplier_account_id, kind, status, quantity, unit_price_minor,
            total_minor, currency, lead_time_days, delivery_terms, valid_until, substitution_note,
            evidence_references, submitted_at, updated_at, closed_at, closure_reason,
            correlation_id, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
                 $19, $20);`,
        [
          quote.quoteId,
          quote.rfqId,
          quote.supplierAccountId,
          quote.kind,
          quote.status,
          // As decimal text, because the driver has no bigint parameter form and a double would
          // round an amount this platform can express.
          quote.quantity.toString(),
          quote.unitPriceMinor.toString(),
          quote.totalMinor.toString(),
          quote.currency,
          quote.leadTimeDays,
          quote.deliveryTerms,
          quote.validUntil,
          quote.substitutionNote,
          JSON.stringify(quote.evidenceReferences),
          quote.submittedAt,
          quote.updatedAt,
          quote.closedAt,
          quote.closureReason,
          quote.correlationId,
          quote.idempotencyKey,
        ],
      );
    } catch (error) {
      throw normalizeDatabaseError(error);
    }
  }

  /**
   * Close an offer.
   *
   * Four columns, and no more. An offer binds, so the terms are not in the SET list — and the
   * `quote_terms_are_immutable` trigger refuses an UPDATE that changes them anyway.
   */
  async updateQuote(quote: Quote): Promise<void> {
    try {
      const result = await this.#client.query(
        `UPDATE ${QUOTE_TABLE}
            SET status = $2,
                updated_at = $3,
                closed_at = $4,
                closure_reason = $5
          WHERE quote_id = $1;`,
        [quote.quoteId, quote.status, quote.updatedAt, quote.closedAt, quote.closureReason],
      );
      if (result.rowCount === 0) {
        throw new QuoteError('quote-not-found', `quote ${quote.quoteId} does not exist`);
      }
    } catch (error) {
      throw normalizeDatabaseError(error);
    }
  }
}

/** M-10 enlisted in a transaction somebody else opened. */
export class EnlistedQuoteRepository implements QuoteRepository {
  readonly #client: DatabaseClient;

  constructor(client: DatabaseClient) {
    this.#client = enlistedClient(client);
  }

  withTransaction<T>(body: (tx: QuoteTransaction) => Promise<T>): Promise<T> {
    return body(new PostgresQuoteTransaction(this.#client));
  }
}

export class PostgresQuoteRepository implements QuoteRepository {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  static enlist(client: DatabaseClient): QuoteRepository {
    return new EnlistedQuoteRepository(client);
  }

  async withTransaction<T>(body: (tx: QuoteTransaction) => Promise<T>): Promise<T> {
    const client = await this.#database.connect();
    try {
      await client.query('BEGIN;');
      try {
        const result = await body(new PostgresQuoteTransaction(client));
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

export { toQuote };
