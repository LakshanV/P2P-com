/**
 * M-09 RFQ — the PostgreSQL adapter.
 *
 * Implements the persistence port against `module_rfq`. It knows SQL and nothing else: no
 * validation, no lifecycle, no privacy rule. Those live in the service and the specification
 * builder, where they can be tested without a server.
 *
 * The specification is stored **flattened across columns** rather than as one `jsonb` blob. That is
 * deliberate and it is the privacy decision made physical: a blob column would be a place a
 * customer's own words could be pasted and nobody would notice, whereas `item_description` is
 * `text` capped at 500 characters and every other field has a name and a type. A schema with no
 * hiding place is the version of this rule that survives somebody editing the builder.
 *
 * Every `timestamptz` is projected as UTC text through `to_char`, never handed to the driver as a
 * `Date`. A `Date` has millisecond resolution and a local time zone; the column has microsecond
 * resolution and none.
 *
 * `quantity` is a `bigint` column and comes back as a digit string, which the validator accepts.
 * It is never read through `Number`.
 *
 * No statement names another unit's schema, and there is no foreign key out of `module_rfq`.
 *
 * Owned by: M-09 RFQ.
 */

import { databaseErrorDetail } from '../../platform/db/client.ts';
import type { Database, DatabaseClient } from '../../platform/db/client.ts';
import type { OutboxEntry } from '../../platform/outbox/types.ts';

import { sealInvitation, sealRfq, sealRfqEvent } from './immutable.ts';
import type { RfqRepository, RfqTransaction } from './repository.ts';
import {
  RfqError,
  type Rfq,
  type RfqErrorCode,
  type RfqEvent,
  type RfqInvitation,
} from './types.ts';
import { validateInvitation, validateRfq, validateRfqEvent } from './validate.ts';

export const RFQ_SCHEMA = 'module_rfq';
export const RFQ_TABLE = `${RFQ_SCHEMA}.rfq`;
export const INVITATION_TABLE = `${RFQ_SCHEMA}.rfq_invitation`;
export const EVENT_TABLE = `${RFQ_SCHEMA}.rfq_event`;
export const OUTBOX_TABLE = `${RFQ_SCHEMA}.outbox`;

/** SQLSTATE 23505. The only driver code this adapter interprets. */
const UNIQUE_VIOLATION = '23505';

const CONSTRAINT_MEANINGS: Readonly<
  Record<string, { readonly code: RfqErrorCode; readonly explanation: string }>
> = {
  rfq_pkey: {
    code: 'duplicate-rfq-id',
    explanation: 'a tender with this id already exists',
  },
  rfq_idempotency_unique: {
    code: 'idempotency-key-reuse',
    explanation: 'this idempotency key has already been used for a tender',
  },
  rfq_invitation_pkey: {
    code: 'duplicate-invitation',
    explanation: 'an invitation with this id already exists',
  },
  rfq_invitation_once_per_supplier: {
    code: 'duplicate-invitation',
    explanation:
      'this supplier has already been invited to this tender. Inviting somebody twice is not a ' +
      'second invitation, it is a duplicate email',
  },
  rfq_event_pkey: {
    code: 'malformed-record',
    explanation: 'a transition with this id has already been recorded',
  },
};

function normalizeDatabaseError(error: unknown): unknown {
  if (error instanceof RfqError) return error;

  const detail = databaseErrorDetail(error);
  if (detail.code !== UNIQUE_VIOLATION) return error;

  const message = error instanceof Error ? error.message : String(error);
  const named =
    detail.constraint ??
    Object.keys(CONSTRAINT_MEANINGS).find((constraint) => message.includes(constraint));
  const meaning = named === undefined ? undefined : CONSTRAINT_MEANINGS[named];
  if (meaning === undefined) return error;

  return new RfqError(meaning.code, meaning.explanation);
}

function utcText(column: string): string {
  return `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${column}`;
}

const RFQ_PROJECTION = [
  'rfq_id',
  'request_id',
  'account_id',
  'match_run_id',
  'status',
  'visibility',
  'category',
  'item_description',
  'quantity',
  'unit',
  'attributes',
  'delivery_district',
  utcText('required_by'),
  'condition',
  'quality_requirements',
  'substitution_policy',
  'attachment_references',
  utcText('closes_at'),
  utcText('opened_at'),
  utcText('updated_at'),
  utcText('closed_at'),
  'awarded_quote_id',
  'closure_reason',
  'correlation_id',
  'idempotency_key',
].join(', ');

const INVITATION_PROJECTION = [
  'invitation_id',
  'rfq_id',
  'supplier_account_id',
  'source_rung',
  'reason',
  'score_per_mille',
  utcText('invited_at'),
  'correlation_id',
  'idempotency_key',
].join(', ');

const EVENT_PROJECTION = [
  'event_id',
  'rfq_id',
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

function toRfq(row: Record<string, unknown>): Rfq {
  return sealRfq(
    validateRfq(
      {
        rfqId: row.rfq_id,
        requestId: row.request_id,
        accountId: row.account_id,
        matchRunId: row.match_run_id ?? null,
        status: row.status,
        visibility: row.visibility,
        specification: {
          category: row.category,
          itemDescription: row.item_description,
          quantity: row.quantity,
          unit: row.unit,
          attributes: row.attributes,
          deliveryDistrict: row.delivery_district ?? null,
          requiredBy: row.required_by ?? null,
          condition: row.condition ?? null,
          qualityRequirements: row.quality_requirements,
          substitutionPolicy: row.substitution_policy,
          attachmentReferences: row.attachment_references,
        },
        closesAt: row.closes_at,
        openedAt: row.opened_at,
        updatedAt: row.updated_at,
        closedAt: row.closed_at ?? null,
        awardedQuoteId: row.awarded_quote_id ?? null,
        closureReason: row.closure_reason ?? null,
        correlationId: row.correlation_id,
        idempotencyKey: row.idempotency_key,
      },
      'stored row',
    ),
  );
}

function toInvitation(row: Record<string, unknown>): RfqInvitation {
  return sealInvitation(
    validateInvitation(
      {
        invitationId: row.invitation_id,
        rfqId: row.rfq_id,
        supplierAccountId: row.supplier_account_id,
        sourceRung: row.source_rung ?? null,
        reason: row.reason,
        scorePerMille: row.score_per_mille ?? null,
        invitedAt: row.invited_at,
        correlationId: row.correlation_id,
        idempotencyKey: row.idempotency_key,
      },
      'stored row',
    ),
  );
}

function toRfqEvent(row: Record<string, unknown>): RfqEvent {
  return sealRfqEvent(
    validateRfqEvent(
      {
        eventId: row.event_id,
        rfqId: row.rfq_id,
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
 * Used when M-09 is enlisted in somebody else's transaction. A producing module writing its outbox
 * inside a caller's transaction must not be able to commit it early: the whole value of the outbox
 * is that the fact and its publication share one transaction.
 */
export function enlistedClient(client: DatabaseClient): DatabaseClient {
  return {
    query<QueryRow = Record<string, unknown>>(sql: string, params?: readonly unknown[]) {
      if (TRANSACTION_CONTROL.test(sql)) {
        return Promise.reject(
          new RfqError(
            'malformed-record',
            `an enlisted RFQ write may not issue "${sql.trim().split(/\s+/, 2).join(' ')}". ` +
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

class PostgresRfqTransaction implements RfqTransaction {
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

  async findRfqById(rfqId: string): Promise<Rfq | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${RFQ_PROJECTION} FROM ${RFQ_TABLE} WHERE rfq_id = $1;`,
      [rfqId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toRfq(row);
  }

  async findRfqByIdempotencyKey(idempotencyKey: string): Promise<Rfq | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${RFQ_PROJECTION} FROM ${RFQ_TABLE} WHERE idempotency_key = $1;`,
      [idempotencyKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : toRfq(row);
  }

  async findRfqsForAccount(accountId: string): Promise<readonly Rfq[]> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${RFQ_PROJECTION} FROM ${RFQ_TABLE}
       WHERE account_id = $1
       ORDER BY opened_at DESC, rfq_id;`,
      [accountId],
    );
    return Object.freeze(result.rows.map(toRfq));
  }

  async findRfqsForRequest(requestId: string): Promise<readonly Rfq[]> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${RFQ_PROJECTION} FROM ${RFQ_TABLE}
       WHERE request_id = $1
       ORDER BY opened_at, rfq_id;`,
      [requestId],
    );
    return Object.freeze(result.rows.map(toRfq));
  }

  async insertRfq(rfq: Rfq): Promise<void> {
    try {
      await this.#client.query(
        `INSERT INTO ${RFQ_TABLE}
           (rfq_id, request_id, account_id, match_run_id, status, visibility, category,
            item_description, quantity, unit, attributes, delivery_district, required_by,
            condition, quality_requirements, substitution_policy, attachment_references,
            closes_at, opened_at, updated_at, closed_at, awarded_quote_id, closure_reason,
            correlation_id, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
                 $19, $20, $21, $22, $23, $24, $25);`,
        [
          rfq.rfqId,
          rfq.requestId,
          rfq.accountId,
          rfq.matchRunId,
          rfq.status,
          rfq.visibility,
          rfq.specification.category,
          rfq.specification.itemDescription,
          // As decimal text: the driver has no bigint parameter form, and a double would round a
          // quantity this platform can express.
          rfq.specification.quantity.toString(),
          rfq.specification.unit,
          JSON.stringify(rfq.specification.attributes),
          rfq.specification.deliveryDistrict,
          rfq.specification.requiredBy,
          rfq.specification.condition,
          JSON.stringify(rfq.specification.qualityRequirements),
          rfq.specification.substitutionPolicy,
          JSON.stringify(rfq.specification.attachmentReferences),
          rfq.closesAt,
          rfq.openedAt,
          rfq.updatedAt,
          rfq.closedAt,
          rfq.awardedQuoteId,
          rfq.closureReason,
          rfq.correlationId,
          rfq.idempotencyKey,
        ],
      );
    } catch (error) {
      throw normalizeDatabaseError(error);
    }
  }

  /**
   * Move a tender to its next status.
   *
   * The specification is not in the SET list. A tender whose requirement changed after suppliers
   * quoted would make every offer an answer to a question nobody can now see; changing what is
   * wanted means cancelling and opening a new one.
   */
  async updateRfq(rfq: Rfq): Promise<void> {
    try {
      const result = await this.#client.query(
        `UPDATE ${RFQ_TABLE}
            SET status = $2,
                updated_at = $3,
                closed_at = $4,
                awarded_quote_id = $5,
                closure_reason = $6
          WHERE rfq_id = $1;`,
        [rfq.rfqId, rfq.status, rfq.updatedAt, rfq.closedAt, rfq.awardedQuoteId, rfq.closureReason],
      );
      if (result.rowCount === 0) {
        throw new RfqError('rfq-not-found', `rfq ${rfq.rfqId} does not exist`);
      }
    } catch (error) {
      throw normalizeDatabaseError(error);
    }
  }

  async findInvitationsByRfqId(rfqId: string): Promise<readonly RfqInvitation[]> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${INVITATION_PROJECTION} FROM ${INVITATION_TABLE}
       WHERE rfq_id = $1
       ORDER BY score_per_mille DESC NULLS LAST, invitation_id;`,
      [rfqId],
    );
    return Object.freeze(result.rows.map(toInvitation));
  }

  async findInvitationsForSupplier(supplierAccountId: string): Promise<readonly RfqInvitation[]> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${INVITATION_PROJECTION} FROM ${INVITATION_TABLE}
       WHERE supplier_account_id = $1
       ORDER BY invited_at DESC, invitation_id;`,
      [supplierAccountId],
    );
    return Object.freeze(result.rows.map(toInvitation));
  }

  async insertInvitation(invitation: RfqInvitation): Promise<void> {
    try {
      await this.#client.query(
        `INSERT INTO ${INVITATION_TABLE}
           (invitation_id, rfq_id, supplier_account_id, source_rung, reason, score_per_mille,
            invited_at, correlation_id, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9);`,
        [
          invitation.invitationId,
          invitation.rfqId,
          invitation.supplierAccountId,
          invitation.sourceRung,
          invitation.reason,
          invitation.scorePerMille,
          invitation.invitedAt,
          invitation.correlationId,
          invitation.idempotencyKey,
        ],
      );
    } catch (error) {
      throw normalizeDatabaseError(error);
    }
  }

  async findEventsByRfqId(rfqId: string): Promise<readonly RfqEvent[]> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${EVENT_PROJECTION} FROM ${EVENT_TABLE}
       WHERE rfq_id = $1
       ORDER BY occurred_at, event_id;`,
      [rfqId],
    );
    return Object.freeze(result.rows.map(toRfqEvent));
  }

  /**
   * Record a transition.
   *
   * `ON CONFLICT DO NOTHING`, because a replayed transition writes the same row and the log is a
   * record of what happened rather than of how many times somebody asked.
   */
  async insertEvent(event: RfqEvent): Promise<void> {
    try {
      await this.#client.query(
        `INSERT INTO ${EVENT_TABLE}
           (event_id, rfq_id, from_status, to_status, reason, occurred_at, correlation_id,
            idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (event_id) DO NOTHING;`,
        [
          event.eventId,
          event.rfqId,
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

/** M-09 enlisted in a transaction somebody else opened. */
export class EnlistedRfqRepository implements RfqRepository {
  readonly #client: DatabaseClient;

  constructor(client: DatabaseClient) {
    this.#client = enlistedClient(client);
  }

  withTransaction<T>(body: (tx: RfqTransaction) => Promise<T>): Promise<T> {
    return body(new PostgresRfqTransaction(this.#client));
  }
}

export class PostgresRfqRepository implements RfqRepository {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  static enlist(client: DatabaseClient): RfqRepository {
    return new EnlistedRfqRepository(client);
  }

  async withTransaction<T>(body: (tx: RfqTransaction) => Promise<T>): Promise<T> {
    const client = await this.#database.connect();
    try {
      await client.query('BEGIN;');
      try {
        const result = await body(new PostgresRfqTransaction(client));
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

export { toInvitation, toRfq, toRfqEvent };
