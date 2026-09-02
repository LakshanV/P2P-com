/**
 * M-07 Matching — the PostgreSQL adapter.
 *
 * Implements the persistence port against `module_matching`. It knows SQL and nothing else: no
 * ladder, no threshold, no rung. Those live in the service, where they can be tested without a
 * server.
 *
 * Every record here is **append-only**, and there is deliberately no update statement in this file.
 * Re-running the ladder writes a new run; comparing two runs is how anybody answers "why did this
 * find nothing on Tuesday and something on Thursday", and an adapter that could rewrite the Tuesday
 * one would destroy the only evidence of the change.
 *
 * Every `timestamptz` is projected as UTC text through `to_char`, never handed to the driver as a
 * `Date`. Scores are `integer` per mille; nothing here is a float, because a score stored as a
 * double compares unequal to itself across a round trip and a threshold built on one drifts without
 * anybody editing it.
 *
 * No statement names another unit's schema, and there is no foreign key out of `module_matching`.
 *
 * Owned by: M-07 Matching.
 */

import { databaseErrorDetail } from '../../platform/db/client.ts';
import type { Database, DatabaseClient } from '../../platform/db/client.ts';
import type { OutboxEntry } from '../../platform/outbox/types.ts';

import { sealCandidate, sealMatchRun, sealRungAttempt } from './immutable.ts';
import type { MatchingRepository, MatchingTransaction } from './repository.ts';
import {
  MatchingError,
  type MatchCandidate,
  type MatchRun,
  type MatchingErrorCode,
  type RungAttempt,
} from './types.ts';
import { validateCandidate, validateMatchRun, validateRungAttempt } from './validate.ts';

export const MATCHING_SCHEMA = 'module_matching';
export const MATCH_RUN_TABLE = `${MATCHING_SCHEMA}.match_run`;
export const RUNG_ATTEMPT_TABLE = `${MATCHING_SCHEMA}.rung_attempt`;
export const MATCH_CANDIDATE_TABLE = `${MATCHING_SCHEMA}.match_candidate`;
export const OUTBOX_TABLE = `${MATCHING_SCHEMA}.outbox`;

/** SQLSTATE 23505. The only driver code this adapter interprets. */
const UNIQUE_VIOLATION = '23505';

const CONSTRAINT_MEANINGS: Readonly<
  Record<string, { readonly code: MatchingErrorCode; readonly explanation: string }>
> = {
  match_run_pkey: {
    code: 'duplicate-run-id',
    explanation: 'a run with this id already exists, and a run is never rewritten',
  },
  match_run_idempotency_unique: {
    code: 'idempotency-key-reuse',
    explanation: 'this idempotency key has already been used for a run',
  },
  rung_attempt_pkey: {
    code: 'malformed-record',
    explanation: 'an attempt with this id has already been recorded',
  },
  rung_attempt_run_rung_unique: {
    code: 'malformed-record',
    explanation:
      'this run already recorded that rung. A rung is attempted once per run, so a second row ' +
      'would make the sequence unreadable',
  },
  match_candidate_pkey: {
    code: 'duplicate-candidate-id',
    explanation: 'a candidate with this id already exists',
  },
  match_candidate_idempotency_unique: {
    code: 'idempotency-key-reuse',
    explanation: 'this idempotency key has already been used for a candidate',
  },
};

function normalizeDatabaseError(error: unknown): unknown {
  if (error instanceof MatchingError) return error;

  const detail = databaseErrorDetail(error);
  if (detail.code !== UNIQUE_VIOLATION) return error;

  const message = error instanceof Error ? error.message : String(error);
  const named =
    detail.constraint ??
    Object.keys(CONSTRAINT_MEANINGS).find((constraint) => message.includes(constraint));
  const meaning = named === undefined ? undefined : CONSTRAINT_MEANINGS[named];
  if (meaning === undefined) return error;

  return new MatchingError(meaning.code, meaning.explanation);
}

function utcText(column: string): string {
  return `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${column}`;
}

const RUN_PROJECTION = [
  'run_id',
  'request_id',
  'account_id',
  'interpretation_id',
  'outcome',
  'satisfied_by',
  'sufficiency_per_mille',
  utcText('started_at'),
  utcText('completed_at'),
  'correlation_id',
  'idempotency_key',
].join(', ');

const ATTEMPT_PROJECTION = [
  'attempt_id',
  'run_id',
  'rung',
  'position',
  'outcome',
  'candidates_found',
  'best_score_per_mille',
  'reason',
  utcText('attempted_at'),
  'correlation_id',
  'idempotency_key',
].join(', ');

const CANDIDATE_PROJECTION = [
  'candidate_id',
  'run_id',
  'rung',
  'kind',
  'listing_id',
  'version_id',
  'supplier_account_id',
  'score_per_mille',
  'explanation',
  'evidence',
  utcText('found_at'),
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

function toMatchRun(row: Record<string, unknown>): MatchRun {
  return sealMatchRun(
    validateMatchRun(
      {
        runId: row.run_id,
        requestId: row.request_id,
        accountId: row.account_id,
        interpretationId: row.interpretation_id ?? null,
        outcome: row.outcome,
        satisfiedBy: row.satisfied_by ?? null,
        sufficiencyPerMille: row.sufficiency_per_mille,
        startedAt: row.started_at,
        completedAt: row.completed_at,
        correlationId: row.correlation_id,
        idempotencyKey: row.idempotency_key,
      },
      'stored row',
    ),
  );
}

function toRungAttempt(row: Record<string, unknown>): RungAttempt {
  return sealRungAttempt(
    validateRungAttempt(
      {
        attemptId: row.attempt_id,
        runId: row.run_id,
        rung: row.rung,
        position: row.position,
        outcome: row.outcome,
        candidatesFound: row.candidates_found,
        bestScorePerMille: row.best_score_per_mille ?? null,
        reason: row.reason,
        attemptedAt: row.attempted_at,
        correlationId: row.correlation_id,
        idempotencyKey: row.idempotency_key,
      },
      'stored row',
    ),
  );
}

function toCandidate(row: Record<string, unknown>): MatchCandidate {
  return sealCandidate(
    validateCandidate(
      {
        candidateId: row.candidate_id,
        runId: row.run_id,
        rung: row.rung,
        kind: row.kind,
        listingId: row.listing_id ?? null,
        versionId: row.version_id ?? null,
        supplierAccountId: row.supplier_account_id,
        scorePerMille: row.score_per_mille,
        explanation: row.explanation,
        evidence: row.evidence,
        foundAt: row.found_at,
        correlationId: row.correlation_id,
        idempotencyKey: row.idempotency_key,
      },
      'stored row',
    ),
  );
}

const TRANSACTION_CONTROL = /^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|START\s+TRANSACTION)\b/i;

/** A client that refuses to open, commit or roll back a transaction. */
export function enlistedClient(client: DatabaseClient): DatabaseClient {
  return {
    query<QueryRow = Record<string, unknown>>(sql: string, params?: readonly unknown[]) {
      if (TRANSACTION_CONTROL.test(sql)) {
        return Promise.reject(
          new MatchingError(
            'malformed-record',
            `an enlisted matching write may not issue "${sql.trim().split(/\s+/, 2).join(' ')}". ` +
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

class PostgresMatchingTransaction implements MatchingTransaction {
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

  async findRunById(runId: string): Promise<MatchRun | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${RUN_PROJECTION} FROM ${MATCH_RUN_TABLE} WHERE run_id = $1;`,
      [runId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toMatchRun(row);
  }

  async findRunByIdempotencyKey(idempotencyKey: string): Promise<MatchRun | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${RUN_PROJECTION} FROM ${MATCH_RUN_TABLE} WHERE idempotency_key = $1;`,
      [idempotencyKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : toMatchRun(row);
  }

  /** Every run for one Need, newest first: comparing two is the point of keeping both. */
  async findRunsByRequestId(requestId: string): Promise<readonly MatchRun[]> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${RUN_PROJECTION} FROM ${MATCH_RUN_TABLE}
       WHERE request_id = $1
       ORDER BY started_at DESC, run_id;`,
      [requestId],
    );
    return Object.freeze(result.rows.map(toMatchRun));
  }

  async insertRun(run: MatchRun): Promise<void> {
    try {
      await this.#client.query(
        `INSERT INTO ${MATCH_RUN_TABLE}
           (run_id, request_id, account_id, interpretation_id, outcome, satisfied_by,
            sufficiency_per_mille, started_at, completed_at, correlation_id, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11);`,
        [
          run.runId,
          run.requestId,
          run.accountId,
          run.interpretationId,
          run.outcome,
          run.satisfiedBy,
          run.sufficiencyPerMille,
          run.startedAt,
          run.completedAt,
          run.correlationId,
          run.idempotencyKey,
        ],
      );
    } catch (error) {
      throw normalizeDatabaseError(error);
    }
  }

  /** In ladder order, so the sequence reads without joining to the vocabulary. */
  async findAttemptsByRunId(runId: string): Promise<readonly RungAttempt[]> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${ATTEMPT_PROJECTION} FROM ${RUNG_ATTEMPT_TABLE}
       WHERE run_id = $1
       ORDER BY position;`,
      [runId],
    );
    return Object.freeze(result.rows.map(toRungAttempt));
  }

  async insertAttempt(attempt: RungAttempt): Promise<void> {
    try {
      await this.#client.query(
        `INSERT INTO ${RUNG_ATTEMPT_TABLE}
           (attempt_id, run_id, rung, position, outcome, candidates_found, best_score_per_mille,
            reason, attempted_at, correlation_id, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11);`,
        [
          attempt.attemptId,
          attempt.runId,
          attempt.rung,
          attempt.position,
          attempt.outcome,
          attempt.candidatesFound,
          attempt.bestScorePerMille,
          attempt.reason,
          attempt.attemptedAt,
          attempt.correlationId,
          attempt.idempotencyKey,
        ],
      );
    } catch (error) {
      throw normalizeDatabaseError(error);
    }
  }

  /** Best first: what a customer is shown, in the order they should read it. */
  async findCandidatesByRunId(runId: string): Promise<readonly MatchCandidate[]> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${CANDIDATE_PROJECTION} FROM ${MATCH_CANDIDATE_TABLE}
       WHERE run_id = $1
       ORDER BY score_per_mille DESC, candidate_id;`,
      [runId],
    );
    return Object.freeze(result.rows.map(toCandidate));
  }

  async insertCandidate(candidate: MatchCandidate): Promise<void> {
    try {
      await this.#client.query(
        `INSERT INTO ${MATCH_CANDIDATE_TABLE}
           (candidate_id, run_id, rung, kind, listing_id, version_id, supplier_account_id,
            score_per_mille, explanation, evidence, found_at, correlation_id, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13);`,
        [
          candidate.candidateId,
          candidate.runId,
          candidate.rung,
          candidate.kind,
          candidate.listingId,
          candidate.versionId,
          candidate.supplierAccountId,
          candidate.scorePerMille,
          candidate.explanation,
          JSON.stringify(candidate.evidence),
          candidate.foundAt,
          candidate.correlationId,
          candidate.idempotencyKey,
        ],
      );
    } catch (error) {
      throw normalizeDatabaseError(error);
    }
  }
}

/** M-07 enlisted in a transaction somebody else opened. */
export class EnlistedMatchingRepository implements MatchingRepository {
  readonly #client: DatabaseClient;

  constructor(client: DatabaseClient) {
    this.#client = enlistedClient(client);
  }

  withTransaction<T>(body: (tx: MatchingTransaction) => Promise<T>): Promise<T> {
    return body(new PostgresMatchingTransaction(this.#client));
  }
}

export class PostgresMatchingRepository implements MatchingRepository {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  static enlist(client: DatabaseClient): MatchingRepository {
    return new EnlistedMatchingRepository(client);
  }

  async withTransaction<T>(body: (tx: MatchingTransaction) => Promise<T>): Promise<T> {
    const client = await this.#database.connect();
    try {
      await client.query('BEGIN;');
      try {
        const result = await body(new PostgresMatchingTransaction(client));
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

export { toCandidate, toMatchRun, toRungAttempt };
