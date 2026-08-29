/**
 * K-06 Policy Engine — the PostgreSQL adapter (FND-005b).
 *
 * Five properties this file exists to hold, none visible from the service:
 *
 *   - **Every instant is projected as UTC text** through `to_char`, never left to the driver's
 *     `Date` parser. K-05 lost microseconds that way (§11.13) and every component since has
 *     projected instead.
 *   - **Every decimal is stored and read as exact text.** Rules live in `jsonb` carrying the
 *     `{ units, scale }` form, so no rate ever passes through a double on the way to or from the
 *     database. `decimalFromText` refuses scientific notation, `Infinity` and `NaN` — none of them
 *     is a policy value, and any of them arriving means the row was written by something else.
 *   - **Decoding is fail-closed and runs the same validators the service runs.** A rule row written
 *     around this adapter is refused rather than evaluated: a malformed row that decoded cleanly
 *     would be a commission rate nobody authored, pinned into a financial record as though it had
 *     been reviewed.
 *   - **No statement names another unit's schema, and there is no foreign key out of
 *     `kernel_policy_engine`.** Seller and category handles are opaque, not joins. The cost — no
 *     database-level referential guarantee — is stated in the contract rather than glossed.
 *   - **The version in force is the end of the activation chain, not the newest row.** `ORDER BY
 *     activated_at DESC LIMIT 1` would be wrong: two activations can share an instant, and a clock
 *     is not a history. The query finds the activation nothing else supersedes.
 *
 * There is no `UPDATE` and no `DELETE` in this file. Not one. v3 §24 requires that changing future
 * policy must not rewrite historical economics, so the adapter has no statement that could rewrite
 * it even if a caller found a way to ask.
 *
 * Owned by: K-06 Policy Engine.
 */

import type { Database, DatabaseClient } from '../../platform/db/client.ts';
import type { OutboxEntry } from '../../platform/outbox/types.ts';
import { InvalidInstantError, parseInstant } from '../../platform/time/instant.ts';

import { sealActivation, sealDraft, sealRetirement, sealVersion } from './immutable.ts';
import type { PolicyRepository, PolicyTransaction } from './repository.ts';
import {
  PolicyError,
  type PolicyActivation,
  type PolicyDraft,
  type PolicyErrorCode,
  type PolicyRetirement,
  type PolicyVersion,
} from './types.ts';
import {
  inStoredRow,
  validateActivation,
  validatePolicyDraft,
  validatePolicyVersion,
  validateRetirement,
} from './validate.ts';

export const POLICY_SCHEMA = 'kernel_policy_engine';
export const DRAFT_TABLE = `${POLICY_SCHEMA}.policy_draft`;
export const VERSION_TABLE = `${POLICY_SCHEMA}.policy_version`;
export const ACTIVATION_TABLE = `${POLICY_SCHEMA}.policy_activation`;
export const RETIREMENT_TABLE = `${POLICY_SCHEMA}.policy_retirement`;
export const OUTBOX_TABLE = `${POLICY_SCHEMA}.outbox`;

const UNIQUE_VIOLATION = '23505';

const CONSTRAINT_MEANINGS: Readonly<
  Record<string, { readonly code: PolicyErrorCode; readonly explanation: string }>
> = {
  policy_draft_pkey: {
    code: 'duplicate-draft',
    explanation: 'a draft with this id already exists, and a draft is never rewritten',
  },
  policy_draft_idempotency_unique: {
    code: 'idempotency-key-reuse',
    explanation: 'this idempotency key has already written a draft',
  },
  policy_version_pkey: {
    code: 'duplicate-policy-version',
    explanation: 'a policy version with this id already exists, and a version is never rewritten',
  },
  policy_version_number_unique: {
    code: 'duplicate-policy-version',
    explanation:
      'this version number has already been published for this policy. Numbers order the ' +
      'history a historic decision is replayed against',
  },
  policy_version_idempotency_unique: {
    code: 'idempotency-key-reuse',
    explanation: 'this idempotency key has already published a policy version',
  },
  policy_activation_pkey: {
    code: 'duplicate-activation',
    explanation: 'an activation with this id already exists',
  },
  policy_activation_idempotency_unique: {
    code: 'idempotency-key-reuse',
    explanation: 'this idempotency key has already recorded an activation',
  },
  policy_activation_supersedes_unique: {
    code: 'stale-activation',
    explanation:
      'another activation already superseded that version, so this one lost the race. Re-read ' +
      'the version in force and decide again rather than overwriting somebody else',
  },
  policy_activation_first_unique: {
    code: 'stale-activation',
    explanation:
      'this policy already has a first activation, so an activation superseding nothing lost the race',
  },
  policy_retirement_pkey: {
    code: 'duplicate-retirement',
    explanation: 'a retirement with this id already exists',
  },
  policy_retirement_policy_unique: {
    code: 'duplicate-retirement',
    explanation:
      'this policy has already been retired, and the first record is when it actually stopped ' +
      'applying — which is what a historic decision is checked against',
  },
  policy_retirement_idempotency_unique: {
    code: 'idempotency-key-reuse',
    explanation: 'this idempotency key has already recorded a retirement',
  },
};

function databaseErrorDetail(error: unknown): { code?: string; constraint?: string } {
  if (error === null || typeof error !== 'object') return {};
  const candidate = error as { code?: unknown; constraint?: unknown };
  return {
    ...(typeof candidate.code === 'string' ? { code: candidate.code } : {}),
    ...(typeof candidate.constraint === 'string' ? { constraint: candidate.constraint } : {}),
  };
}

function normalizeDatabaseError(error: unknown, operation: string): unknown {
  if (error instanceof PolicyError) return error;

  const detail = databaseErrorDetail(error);
  if (detail.code !== UNIQUE_VIOLATION) return error;

  const message = error instanceof Error ? error.message : String(error);
  const named =
    detail.constraint ??
    Object.keys(CONSTRAINT_MEANINGS).find((constraint) => message.includes(constraint));
  const meaning = named === undefined ? undefined : CONSTRAINT_MEANINGS[named];
  if (meaning === undefined) return error;

  return new PolicyError(meaning.code, `${operation} was refused: ${meaning.explanation}`);
}

const DRAFT_COLUMNS = [
  'draft_id',
  'policy_key',
  'output_schema',
  'rules',
  'default_outputs',
  'notes',
  'drafted_at',
  'drafted_by_kind',
  'drafted_by_id',
  'idempotency_key',
  'request_fingerprint',
] as const;

const VERSION_COLUMNS = [
  'policy_version_id',
  'policy_key',
  'version',
  'draft_id',
  'output_schema',
  'rules',
  'default_outputs',
  'effective_from',
  'effective_until',
  'published_at',
  'published_by_kind',
  'published_by_id',
  'idempotency_key',
  'request_fingerprint',
] as const;

const ACTIVATION_COLUMNS = [
  'activation_id',
  'policy_key',
  'policy_version_id',
  'supersedes_version_id',
  'activated_at',
  'activated_by_kind',
  'activated_by_id',
  'idempotency_key',
  'request_fingerprint',
] as const;

const RETIREMENT_COLUMNS = [
  'retirement_id',
  'policy_key',
  'reason',
  'retired_at',
  'retired_by_kind',
  'retired_by_id',
  'idempotency_key',
  'request_fingerprint',
] as const;

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
export const OUTBOX_COLUMNS = OUTBOX_COLUMN_NAMES.join(', ');

/** Every `timestamptz` in this schema. All are projected as text; nothing parses one as a Date. */
export const TIMESTAMP_COLUMNS = [
  'drafted_at',
  'effective_from',
  'effective_until',
  'published_at',
  'activated_at',
  'retired_at',
] as const;

function utcText(column: string): string {
  return `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${column}`;
}

const projectionOf = (columns: readonly string[]): string =>
  columns
    .map((column) =>
      (TIMESTAMP_COLUMNS as readonly string[]).includes(column) ? utcText(column) : column,
    )
    .join(', ');

const DRAFT_PROJECTION = projectionOf(DRAFT_COLUMNS);
const VERSION_PROJECTION = projectionOf(VERSION_COLUMNS);
const ACTIVATION_PROJECTION = projectionOf(ACTIVATION_COLUMNS);
const RETIREMENT_PROJECTION = projectionOf(RETIREMENT_COLUMNS);

const STORED_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/;

function instant(value: unknown, column: string): string {
  if (typeof value !== 'string') {
    throw new PolicyError(
      'malformed-record',
      `${column} came back as ${value instanceof Date ? 'a Date' : typeof value} rather than ` +
        'text. Timestamps are projected through to_char precisely so the driver never parses them',
    );
  }
  const match = STORED_INSTANT.exec(value);
  if (match === null) {
    throw new PolicyError(
      'malformed-record',
      `${column} holds "${value}", which is not a finite UTC timestamp in the projected form`,
    );
  }
  try {
    parseInstant(value);
  } catch (error) {
    if (error instanceof InvalidInstantError) {
      throw new PolicyError('malformed-record', `${column}: ${error.message}`);
    }
    throw error;
  }
  const [, year, month, day, hour, minute, second, fraction = ''] = match;
  const digits = fraction.replace(/0+$/, '');
  return `${year}-${month}-${day}T${hour}:${minute}:${second}${digits === '' ? '' : `.${digits}`}Z`;
}

const optionalInstant = (value: unknown, column: string): string | null =>
  value === null || value === undefined ? null : instant(value, column);

function text(value: unknown, column: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new PolicyError(
      'malformed-record',
      `${column} is ${value === null ? 'null' : typeof value}; expected non-empty text`,
    );
  }
  return value;
}

const optionalText = (value: unknown, column: string): string | null =>
  value === null || value === undefined ? null : text(value, column);

/** `jsonb` comes back parsed. Anything else is a row nobody here wrote. */
function json(value: unknown, column: string): unknown {
  if (typeof value === 'string') {
    throw new PolicyError(
      'malformed-record',
      `${column} came back as text rather than parsed JSON; the column type is not what 0011 creates`,
    );
  }
  return value;
}

export function toPolicyDraft(row: Record<string, unknown>): PolicyDraft {
  return inStoredRow(() =>
    sealDraft(
      validatePolicyDraft(
        {
          draftId: text(row.draft_id, 'draft_id'),
          policyKey: text(row.policy_key, 'policy_key'),
          outputSchema: json(row.output_schema, 'output_schema'),
          rules: json(row.rules, 'rules'),
          defaultOutputs:
            row.default_outputs === null ? null : json(row.default_outputs, 'default_outputs'),
          notes: typeof row.notes === 'string' ? row.notes : '',
          draftedAt: instant(row.drafted_at, 'drafted_at'),
          draftedBy: { kind: row.drafted_by_kind, id: row.drafted_by_id },
          idempotencyKey: text(row.idempotency_key, 'idempotency_key'),
          requestFingerprint: text(row.request_fingerprint, 'request_fingerprint'),
        },
        'stored row',
      ),
    ),
  );
}

export function toPolicyVersion(row: Record<string, unknown>): PolicyVersion {
  return inStoredRow(() =>
    sealVersion(
      validatePolicyVersion(
        {
          policyVersionId: text(row.policy_version_id, 'policy_version_id'),
          policyKey: text(row.policy_key, 'policy_key'),
          version: Number(row.version),
          draftId: text(row.draft_id, 'draft_id'),
          outputSchema: json(row.output_schema, 'output_schema'),
          rules: json(row.rules, 'rules'),
          defaultOutputs:
            row.default_outputs === null ? null : json(row.default_outputs, 'default_outputs'),
          effectiveFrom: optionalInstant(row.effective_from, 'effective_from'),
          effectiveUntil: optionalInstant(row.effective_until, 'effective_until'),
          publishedAt: instant(row.published_at, 'published_at'),
          publishedBy: { kind: row.published_by_kind, id: row.published_by_id },
          idempotencyKey: text(row.idempotency_key, 'idempotency_key'),
          requestFingerprint: text(row.request_fingerprint, 'request_fingerprint'),
        },
        'stored row',
      ),
    ),
  );
}

export function toPolicyActivation(row: Record<string, unknown>): PolicyActivation {
  return inStoredRow(() =>
    sealActivation(
      validateActivation(
        {
          activationId: text(row.activation_id, 'activation_id'),
          policyKey: text(row.policy_key, 'policy_key'),
          policyVersionId: text(row.policy_version_id, 'policy_version_id'),
          supersedesVersionId: optionalText(row.supersedes_version_id, 'supersedes_version_id'),
          activatedAt: instant(row.activated_at, 'activated_at'),
          activatedBy: { kind: row.activated_by_kind, id: row.activated_by_id },
          idempotencyKey: text(row.idempotency_key, 'idempotency_key'),
          requestFingerprint: text(row.request_fingerprint, 'request_fingerprint'),
        },
        'stored row',
      ),
    ),
  );
}

export function toPolicyRetirement(row: Record<string, unknown>): PolicyRetirement {
  return inStoredRow(() =>
    sealRetirement(
      validateRetirement(
        {
          retirementId: text(row.retirement_id, 'retirement_id'),
          policyKey: text(row.policy_key, 'policy_key'),
          reason: text(row.reason, 'reason'),
          retiredAt: instant(row.retired_at, 'retired_at'),
          retiredBy: { kind: row.retired_by_kind, id: row.retired_by_id },
          idempotencyKey: text(row.idempotency_key, 'idempotency_key'),
          requestFingerprint: text(row.request_fingerprint, 'request_fingerprint'),
        },
        'stored row',
      ),
    ),
  );
}

const TRANSACTION_CONTROL =
  /^\s*(BEGIN|START\s+TRANSACTION|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE\s+SAVEPOINT)\b/i;

/**
 * A client that refuses transaction control and never releases the connection.
 *
 * An enlisted write belongs to the caller's transaction. A `COMMIT` issued from inside one would
 * commit rows its caller had not finished writing — here, a policy version activated while the
 * commercial approval that authorised it never landed.
 */
export function enlistedClient(client: DatabaseClient): DatabaseClient {
  return {
    query<QueryRow = Record<string, unknown>>(sql: string, params?: readonly unknown[]) {
      if (TRANSACTION_CONTROL.test(sql)) {
        return Promise.reject(
          new PolicyError(
            'nested-transaction',
            `an enlisted policy write may not issue "${sql.trim().split(/\s+/, 2).join(' ')}". ` +
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

/**
 * A policy repository inside a transaction somebody else opened.
 *
 * What a future approval path would need: a policy version activated in the same transaction as
 * whatever recorded the commercial sign-off for it. No unit uses this yet.
 */
export class EnlistedPolicyRepository implements PolicyRepository {
  readonly #client: DatabaseClient;

  constructor(client: DatabaseClient) {
    this.#client = enlistedClient(client);
  }

  withTransaction<T>(body: (tx: PolicyTransaction) => Promise<T>): Promise<T> {
    return body(new PostgresPolicyTransaction(this.#client));
  }
}

export class PostgresPolicyRepository implements PolicyRepository {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  static enlist(client: DatabaseClient): PolicyRepository {
    return new EnlistedPolicyRepository(client);
  }

  async withTransaction<T>(body: (tx: PolicyTransaction) => Promise<T>): Promise<T> {
    const client = await this.#database.connect();
    try {
      await client.query('BEGIN;');
      try {
        const result = await body(new PostgresPolicyTransaction(client));
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

class PostgresPolicyTransaction implements PolicyTransaction {
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

  async #one<T>(
    sql: string,
    params: readonly unknown[],
    decode: (row: Record<string, unknown>) => T,
  ): Promise<T | null> {
    const result = await this.#client.query<Record<string, unknown>>(sql, params);
    const row = result.rows[0];
    return row === undefined ? null : decode(row);
  }

  findDraftById(draftId: string): Promise<PolicyDraft | null> {
    return this.#one(
      `SELECT ${DRAFT_PROJECTION} FROM ${DRAFT_TABLE} WHERE draft_id = $1;`,
      [draftId],
      toPolicyDraft,
    );
  }

  findDraftByIdempotencyKey(idempotencyKey: string): Promise<PolicyDraft | null> {
    return this.#one(
      `SELECT ${DRAFT_PROJECTION} FROM ${DRAFT_TABLE} WHERE idempotency_key = $1;`,
      [idempotencyKey],
      toPolicyDraft,
    );
  }

  async insertDraft(draft: PolicyDraft): Promise<void> {
    try {
      await this.#client.query(
        `INSERT INTO ${DRAFT_TABLE} (${DRAFT_COLUMNS.join(', ')})
         VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6, $7, $8, $9, $10, $11);`,
        [
          draft.draftId,
          draft.policyKey,
          JSON.stringify(draft.outputSchema),
          JSON.stringify(draft.rules),
          draft.defaultOutputs === null ? null : JSON.stringify(draft.defaultOutputs),
          draft.notes,
          draft.draftedAt,
          draft.draftedBy.kind,
          draft.draftedBy.id,
          draft.idempotencyKey,
          draft.requestFingerprint,
        ],
      );
    } catch (error) {
      throw normalizeDatabaseError(error, 'insertDraft');
    }
  }

  findVersionById(policyVersionId: string): Promise<PolicyVersion | null> {
    return this.#one(
      `SELECT ${VERSION_PROJECTION} FROM ${VERSION_TABLE} WHERE policy_version_id = $1;`,
      [policyVersionId],
      toPolicyVersion,
    );
  }

  findVersionByIdempotencyKey(idempotencyKey: string): Promise<PolicyVersion | null> {
    return this.#one(
      `SELECT ${VERSION_PROJECTION} FROM ${VERSION_TABLE} WHERE idempotency_key = $1;`,
      [idempotencyKey],
      toPolicyVersion,
    );
  }

  async highestVersion(policyKey: string): Promise<number> {
    const result = await this.#client.query<{ highest: string | number | null }>(
      `SELECT coalesce(max(version), 0) AS highest FROM ${VERSION_TABLE} WHERE policy_key = $1;`,
      [policyKey],
    );
    return Number(result.rows[0]?.highest ?? 0);
  }

  async insertVersion(version: PolicyVersion): Promise<void> {
    try {
      await this.#client.query(
        `INSERT INTO ${VERSION_TABLE} (${VERSION_COLUMNS.join(', ')})
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9, $10, $11, $12, $13, $14);`,
        [
          version.policyVersionId,
          version.policyKey,
          version.version,
          version.draftId,
          JSON.stringify(version.outputSchema),
          JSON.stringify(version.rules),
          version.defaultOutputs === null ? null : JSON.stringify(version.defaultOutputs),
          version.effectiveFrom,
          version.effectiveUntil,
          version.publishedAt,
          version.publishedBy.kind,
          version.publishedBy.id,
          version.idempotencyKey,
          version.requestFingerprint,
        ],
      );
    } catch (error) {
      throw normalizeDatabaseError(error, 'insertVersion');
    }
  }

  /**
   * The activation nothing else supersedes.
   *
   * Not `ORDER BY activated_at DESC LIMIT 1`: two activations can share an instant, and the chain
   * is the history. An anti-join is also the query that stays correct if a clock ever goes
   * backwards, which is exactly when somebody most needs to know which policy was in force.
   */
  findCurrentActivation(policyKey: string): Promise<PolicyActivation | null> {
    return this.#one(
      `SELECT ${ACTIVATION_PROJECTION} FROM ${ACTIVATION_TABLE} current
        WHERE current.policy_key = $1
          AND NOT EXISTS (
            SELECT 1 FROM ${ACTIVATION_TABLE} later
             WHERE later.policy_key = current.policy_key
               AND later.supersedes_version_id = current.policy_version_id
          )
        LIMIT 1;`,
      [policyKey],
      toPolicyActivation,
    );
  }

  findActivationByIdempotencyKey(idempotencyKey: string): Promise<PolicyActivation | null> {
    return this.#one(
      `SELECT ${ACTIVATION_PROJECTION} FROM ${ACTIVATION_TABLE} WHERE idempotency_key = $1;`,
      [idempotencyKey],
      toPolicyActivation,
    );
  }

  async insertActivation(activation: PolicyActivation): Promise<void> {
    try {
      await this.#client.query(
        `INSERT INTO ${ACTIVATION_TABLE} (${ACTIVATION_COLUMNS.join(', ')})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9);`,
        [
          activation.activationId,
          activation.policyKey,
          activation.policyVersionId,
          activation.supersedesVersionId,
          activation.activatedAt,
          activation.activatedBy.kind,
          activation.activatedBy.id,
          activation.idempotencyKey,
          activation.requestFingerprint,
        ],
      );
    } catch (error) {
      throw normalizeDatabaseError(error, 'insertActivation');
    }
  }

  findRetirement(policyKey: string): Promise<PolicyRetirement | null> {
    return this.#one(
      `SELECT ${RETIREMENT_PROJECTION} FROM ${RETIREMENT_TABLE} WHERE policy_key = $1;`,
      [policyKey],
      toPolicyRetirement,
    );
  }

  findRetirementByIdempotencyKey(idempotencyKey: string): Promise<PolicyRetirement | null> {
    return this.#one(
      `SELECT ${RETIREMENT_PROJECTION} FROM ${RETIREMENT_TABLE} WHERE idempotency_key = $1;`,
      [idempotencyKey],
      toPolicyRetirement,
    );
  }

  async insertRetirement(retirement: PolicyRetirement): Promise<void> {
    try {
      await this.#client.query(
        `INSERT INTO ${RETIREMENT_TABLE} (${RETIREMENT_COLUMNS.join(', ')})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8);`,
        [
          retirement.retirementId,
          retirement.policyKey,
          retirement.reason,
          retirement.retiredAt,
          retirement.retiredBy.kind,
          retirement.retiredBy.id,
          retirement.idempotencyKey,
          retirement.requestFingerprint,
        ],
      );
    } catch (error) {
      throw normalizeDatabaseError(error, 'insertRetirement');
    }
  }
}
