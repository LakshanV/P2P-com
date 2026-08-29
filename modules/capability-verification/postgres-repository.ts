/**
 * M-02 Capability & Verification — the PostgreSQL adapter.
 *
 * Implements the persistence port against `module_capability_verification`. It knows SQL and nothing
 * else: no validation, no lifecycle, no referential check. Those live in the service, where they can
 * be tested without a server.
 *
 * Every `timestamptz` is projected as UTC text. JSON objects are stored as `jsonb` and read as
 * objects.
 *
 * No statement names another unit's schema, and there is no foreign key out of
 * `module_capability_verification`. The module's outbox table lives in the same schema.
 *
 * Owned by: M-02 Capability & Verification.
 */

import { databaseErrorDetail } from '../../platform/db/client.ts';
import type { Database, DatabaseClient } from '../../platform/db/client.ts';
import type { OutboxEntry } from '../../platform/outbox/types.ts';

import { sealEvidence, sealLevelRecord, sealVerificationCase } from './immutable.ts';
import type {
  CapabilityVerificationRepository,
  CapabilityVerificationTransaction,
} from './repository.ts';
import {
  CapabilityVerificationError,
  type CapabilityVerificationErrorCode,
  type Evidence,
  type LevelRecord,
  type VerificationCase,
} from './types.ts';
import { validateEvidence, validateLevelRecord, validateVerificationCase } from './validate.ts';

export const CAPABILITY_VERIFICATION_SCHEMA = 'module_capability_verification';
export const VERIFICATION_CASE_TABLE = `${CAPABILITY_VERIFICATION_SCHEMA}.verification_case`;
export const EVIDENCE_TABLE = `${CAPABILITY_VERIFICATION_SCHEMA}.evidence`;
export const LEVEL_RECORD_TABLE = `${CAPABILITY_VERIFICATION_SCHEMA}.level_record`;
export const OUTBOX_TABLE = `${CAPABILITY_VERIFICATION_SCHEMA}.outbox`;

/** SQLSTATE 23505. The only driver code this adapter interprets. */
const UNIQUE_VIOLATION = '23505';

const CONSTRAINT_MEANINGS: Readonly<
  Record<string, { readonly code: CapabilityVerificationErrorCode; readonly explanation: string }>
> = {
  verification_case_pkey: {
    code: 'duplicate-case-id',
    explanation: 'a case with this id already exists, and a case is never overwritten',
  },
  verification_case_idempotency_unique: {
    code: 'idempotency-key-reuse',
    explanation: 'this idempotency key has already been used for a case',
  },
  verification_case_account_purpose_open_unique: {
    code: 'case-already-open',
    explanation: 'this account already has an open case for this purpose',
  },
  evidence_pkey: {
    code: 'duplicate-evidence-id',
    explanation:
      'an evidence row with this id already exists, and an evidence row is never rewritten',
  },
  evidence_idempotency_unique: {
    code: 'idempotency-key-reuse',
    explanation: 'this idempotency key has already been used for an evidence row',
  },
  level_record_pkey: {
    code: 'duplicate-record-id',
    explanation:
      'a level record with this id already exists, and a level record is never rewritten',
  },
  level_record_idempotency_unique: {
    code: 'idempotency-key-reuse',
    explanation: 'this idempotency key has already been used for a level record',
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
  if (error instanceof CapabilityVerificationError) return error;

  const detail = databaseErrorDetail(error);
  if (detail.code !== UNIQUE_VIOLATION) return error;

  const message = error instanceof Error ? error.message : String(error);
  const named =
    detail.constraint ??
    Object.keys(CONSTRAINT_MEANINGS).find((constraint) => message.includes(constraint));
  const meaning = named === undefined ? undefined : CONSTRAINT_MEANINGS[named];
  if (meaning === undefined) return error;

  return new CapabilityVerificationError(
    meaning.code,
    `${operation} was refused: ${meaning.explanation}`,
  );
}

const VERIFICATION_CASE_COLUMNS = [
  'case_id',
  'account_id',
  'purpose',
  'status',
  'requested_level',
  'achieved_level',
  'opened_at',
  'decided_at',
  'attributes',
  'created_at',
  'updated_at',
  'correlation_id',
  'idempotency_key',
] as const;

const EVIDENCE_COLUMNS = [
  'evidence_id',
  'case_id',
  'account_id',
  'kind',
  'status',
  'reference',
  'note',
  'submitted_at',
  'correlation_id',
  'idempotency_key',
] as const;

const LEVEL_RECORD_COLUMNS = [
  'record_id',
  'case_id',
  'account_id',
  'from_level',
  'to_level',
  'reason',
  'occurred_at',
  'correlation_id',
  'idempotency_key',
] as const;

function utcText(column: string): string {
  return `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${column}`;
}

const VERIFICATION_CASE_PROJECTION = [
  'case_id',
  'account_id',
  'purpose',
  'status',
  'requested_level',
  'achieved_level',
  utcText('opened_at'),
  utcText('decided_at'),
  'attributes',
  utcText('created_at'),
  utcText('updated_at'),
  'correlation_id',
  'idempotency_key',
].join(', ');

const EVIDENCE_PROJECTION = [
  'evidence_id',
  'case_id',
  'account_id',
  'kind',
  'status',
  'reference',
  'note',
  utcText('submitted_at'),
  'correlation_id',
  'idempotency_key',
].join(', ');

const LEVEL_RECORD_PROJECTION = [
  'record_id',
  'case_id',
  'account_id',
  'from_level',
  'to_level',
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
    throw new CapabilityVerificationError(
      'malformed-record',
      `${column} is ${value === null ? 'null' : typeof value}; expected non-empty text`,
    );
  }
  return value;
}

function optionalText(value: unknown, column: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new CapabilityVerificationError(
      'malformed-record',
      `${column} is ${typeof value}; expected text or null`,
    );
  }
  return value === '' ? null : value;
}

function jsonObject(value: unknown, column: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new CapabilityVerificationError(
      'malformed-record',
      `${column} is ${value === null ? 'null' : typeof value}; expected a JSON object`,
    );
  }
  return value as Record<string, unknown>;
}

export function toVerificationCase(row: Record<string, unknown>): VerificationCase {
  return sealVerificationCase(
    validateVerificationCase(
      {
        caseId: text(row.case_id, 'case_id'),
        accountId: text(row.account_id, 'account_id'),
        purpose: text(row.purpose, 'purpose'),
        status: text(row.status, 'status'),
        requestedLevel: text(row.requested_level, 'requested_level'),
        achievedLevel: text(row.achieved_level, 'achieved_level'),
        openedAt: text(row.opened_at, 'opened_at'),
        decidedAt: optionalText(row.decided_at, 'decided_at'),
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

export function toEvidence(row: Record<string, unknown>): Evidence {
  return sealEvidence(
    validateEvidence(
      {
        evidenceId: text(row.evidence_id, 'evidence_id'),
        caseId: text(row.case_id, 'case_id'),
        accountId: text(row.account_id, 'account_id'),
        kind: text(row.kind, 'kind'),
        status: text(row.status, 'status'),
        reference: text(row.reference, 'reference'),
        note: text(row.note, 'note'),
        submittedAt: text(row.submitted_at, 'submitted_at'),
        correlationId: text(row.correlation_id, 'correlation_id'),
        idempotencyKey: text(row.idempotency_key, 'idempotency_key'),
      },
      'stored row',
    ),
  );
}

export function toLevelRecord(row: Record<string, unknown>): LevelRecord {
  return sealLevelRecord(
    validateLevelRecord(
      {
        recordId: text(row.record_id, 'record_id'),
        caseId: text(row.case_id, 'case_id'),
        accountId: text(row.account_id, 'account_id'),
        fromLevel: optionalText(row.from_level, 'from_level'),
        toLevel: text(row.to_level, 'to_level'),
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
          new CapabilityVerificationError(
            'nested-transaction',
            `an enlisted capability-verification write may not issue "${sql.trim().split(/\s+/, 2).join(' ')}". ` +
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

export class EnlistedCapabilityVerificationRepository implements CapabilityVerificationRepository {
  readonly #client: DatabaseClient;

  constructor(client: DatabaseClient) {
    this.#client = enlistedClient(client);
  }

  withTransaction<T>(body: (tx: CapabilityVerificationTransaction) => Promise<T>): Promise<T> {
    return body(new PostgresCapabilityVerificationTransaction(this.#client));
  }
}

export class PostgresCapabilityVerificationRepository implements CapabilityVerificationRepository {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  static enlist(client: DatabaseClient): CapabilityVerificationRepository {
    return new EnlistedCapabilityVerificationRepository(client);
  }

  async withTransaction<T>(
    body: (tx: CapabilityVerificationTransaction) => Promise<T>,
  ): Promise<T> {
    const client = await this.#database.connect();
    try {
      await client.query('BEGIN;');
      try {
        const result = await body(new PostgresCapabilityVerificationTransaction(client));
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
  'opened_at',
  'decided_at',
  'created_at',
  'updated_at',
  'submitted_at',
  'occurred_at',
] as const;

class PostgresCapabilityVerificationTransaction implements CapabilityVerificationTransaction {
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

  async findCaseById(caseId: string): Promise<VerificationCase | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${VERIFICATION_CASE_PROJECTION} FROM ${VERIFICATION_CASE_TABLE} WHERE case_id = $1;`,
      [caseId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toVerificationCase(row);
  }

  async findCaseByIdempotencyKey(idempotencyKey: string): Promise<VerificationCase | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${VERIFICATION_CASE_PROJECTION} FROM ${VERIFICATION_CASE_TABLE} WHERE idempotency_key = $1;`,
      [idempotencyKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : toVerificationCase(row);
  }

  async findCasesByAccountId(accountId: string): Promise<readonly VerificationCase[]> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${VERIFICATION_CASE_PROJECTION} FROM ${VERIFICATION_CASE_TABLE}
       WHERE account_id = $1 ORDER BY opened_at ASC, case_id ASC;`,
      [accountId],
    );
    return Object.freeze(result.rows.map(toVerificationCase));
  }

  async findOpenCaseByAccountAndPurpose(
    accountId: string,
    purpose: string,
  ): Promise<VerificationCase | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${VERIFICATION_CASE_PROJECTION} FROM ${VERIFICATION_CASE_TABLE}
       WHERE account_id = $1 AND purpose = $2
         AND status NOT IN ('approved', 'rejected', 'withdrawn');`,
      [accountId, purpose],
    );
    const row = result.rows[0];
    return row === undefined ? null : toVerificationCase(row);
  }

  async insertCase(verificationCase: VerificationCase): Promise<void> {
    try {
      await this.#client.query(
        `INSERT INTO ${VERIFICATION_CASE_TABLE} (${VERIFICATION_CASE_COLUMNS.join(', ')})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13);`,
        [
          verificationCase.caseId,
          verificationCase.accountId,
          verificationCase.purpose,
          verificationCase.status,
          verificationCase.requestedLevel,
          verificationCase.achievedLevel,
          verificationCase.openedAt,
          verificationCase.decidedAt,
          JSON.stringify(verificationCase.attributes),
          verificationCase.createdAt,
          verificationCase.updatedAt,
          verificationCase.correlationId,
          verificationCase.idempotencyKey,
        ],
      );
    } catch (error) {
      throw normalizeDatabaseError(error, 'insertCase');
    }
  }

  async updateCase(verificationCase: VerificationCase): Promise<void> {
    await this.#client.query(
      `UPDATE ${VERIFICATION_CASE_TABLE}
       SET status = $1, requested_level = $2, achieved_level = $3, opened_at = $4,
           decided_at = $5, attributes = $6, created_at = $7, updated_at = $8,
           correlation_id = $9, idempotency_key = $10
       WHERE case_id = $11;`,
      [
        verificationCase.status,
        verificationCase.requestedLevel,
        verificationCase.achievedLevel,
        verificationCase.openedAt,
        verificationCase.decidedAt,
        JSON.stringify(verificationCase.attributes),
        verificationCase.createdAt,
        verificationCase.updatedAt,
        verificationCase.correlationId,
        verificationCase.idempotencyKey,
        verificationCase.caseId,
      ],
    );
  }

  async findEvidenceById(evidenceId: string): Promise<Evidence | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${EVIDENCE_PROJECTION} FROM ${EVIDENCE_TABLE} WHERE evidence_id = $1;`,
      [evidenceId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toEvidence(row);
  }

  async findEvidenceByIdempotencyKey(idempotencyKey: string): Promise<Evidence | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${EVIDENCE_PROJECTION} FROM ${EVIDENCE_TABLE} WHERE idempotency_key = $1;`,
      [idempotencyKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : toEvidence(row);
  }

  async findEvidenceByCaseId(caseId: string): Promise<readonly Evidence[]> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${EVIDENCE_PROJECTION} FROM ${EVIDENCE_TABLE}
       WHERE case_id = $1 ORDER BY submitted_at ASC, evidence_id ASC;`,
      [caseId],
    );
    return Object.freeze(result.rows.map(toEvidence));
  }

  async insertEvidence(evidence: Evidence): Promise<void> {
    try {
      await this.#client.query(
        `INSERT INTO ${EVIDENCE_TABLE} (${EVIDENCE_COLUMNS.join(', ')})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10);`,
        [
          evidence.evidenceId,
          evidence.caseId,
          evidence.accountId,
          evidence.kind,
          evidence.status,
          evidence.reference,
          evidence.note,
          evidence.submittedAt,
          evidence.correlationId,
          evidence.idempotencyKey,
        ],
      );
    } catch (error) {
      throw normalizeDatabaseError(error, 'insertEvidence');
    }
  }

  async findLevelRecordById(recordId: string): Promise<LevelRecord | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${LEVEL_RECORD_PROJECTION} FROM ${LEVEL_RECORD_TABLE} WHERE record_id = $1;`,
      [recordId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toLevelRecord(row);
  }

  async findLevelRecordByIdempotencyKey(idempotencyKey: string): Promise<LevelRecord | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${LEVEL_RECORD_PROJECTION} FROM ${LEVEL_RECORD_TABLE} WHERE idempotency_key = $1;`,
      [idempotencyKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : toLevelRecord(row);
  }

  async findLevelRecordsByCaseId(caseId: string): Promise<readonly LevelRecord[]> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${LEVEL_RECORD_PROJECTION} FROM ${LEVEL_RECORD_TABLE}
       WHERE case_id = $1 ORDER BY occurred_at ASC, record_id ASC;`,
      [caseId],
    );
    return Object.freeze(result.rows.map(toLevelRecord));
  }

  async findLevelRecordsByAccountId(accountId: string): Promise<readonly LevelRecord[]> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${LEVEL_RECORD_PROJECTION} FROM ${LEVEL_RECORD_TABLE}
       WHERE account_id = $1 ORDER BY occurred_at ASC, record_id ASC;`,
      [accountId],
    );
    return Object.freeze(result.rows.map(toLevelRecord));
  }

  async insertLevelRecord(record: LevelRecord): Promise<void> {
    try {
      await this.#client.query(
        `INSERT INTO ${LEVEL_RECORD_TABLE} (${LEVEL_RECORD_COLUMNS.join(', ')})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9);`,
        [
          record.recordId,
          record.caseId,
          record.accountId,
          record.fromLevel,
          record.toLevel,
          record.reason,
          record.occurredAt,
          record.correlationId,
          record.idempotencyKey,
        ],
      );
    } catch (error) {
      throw normalizeDatabaseError(error, 'insertLevelRecord');
    }
  }
}
