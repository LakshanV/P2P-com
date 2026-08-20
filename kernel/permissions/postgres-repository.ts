/**
 * K-04 Permissions — the PostgreSQL adapter (FND-004d).
 *
 * Three properties this file exists to hold, none of which is visible from the service:
 *
 *   - **Every instant is projected as UTC text** through `to_char`, never left to the driver's
 *     `Date` parser. K-05 lost microseconds that way (§11.13) and every component since has
 *     projected instead.
 *   - **Decoding is fail-closed and runs the same validators the service runs.** A grant row
 *     written around this adapter is refused rather than decided upon: a malformed row that
 *     decoded cleanly would be an authority nobody granted.
 *   - **No statement names another unit's schema, and there is no foreign key out of
 *     `kernel_permissions`.** `subject_id` and `account_id` are K-01's and K-03's handles, checked
 *     through their public contracts at write time, not joined to. The cost — no database-level
 *     referential guarantee — is stated in the contract rather than glossed.
 *
 * There is no `UPDATE` and no `DELETE` in this file. Not one. Authority history is append-only, so
 * the adapter has no statement that could rewrite it even if a caller found a way to ask.
 *
 * Owned by: K-04 Permissions.
 */

import type { Database, DatabaseClient } from '../../platform/db/client.ts';
import { InvalidInstantError, parseInstant } from '../../platform/time/instant.ts';

import { sealDecision, sealGrant, sealPolicyVersion, sealRevocation } from './immutable.ts';
import type { PermissionRepository, PermissionTransaction } from './repository.ts';
import {
  PermissionError,
  type Decision,
  type Grant,
  type PermissionErrorCode,
  type PolicyVersion,
  type Revocation,
} from './types.ts';
import {
  inStoredRow,
  validateDecision,
  validateGrant,
  validatePolicyVersion,
  validateRevocation,
} from './validate.ts';

export const PERMISSIONS_SCHEMA = 'kernel_permissions';
export const POLICY_TABLE = `${PERMISSIONS_SCHEMA}.permission_policy_version`;
export const GRANT_TABLE = `${PERMISSIONS_SCHEMA}.permission_grant`;
export const REVOCATION_TABLE = `${PERMISSIONS_SCHEMA}.permission_revocation`;
export const DECISION_TABLE = `${PERMISSIONS_SCHEMA}.permission_decision`;

const UNIQUE_VIOLATION = '23505';

const CONSTRAINT_MEANINGS: Readonly<
  Record<string, { readonly code: PermissionErrorCode; readonly explanation: string }>
> = {
  permission_policy_version_pkey: {
    code: 'malformed-record',
    explanation: 'a policy version with this id already exists, and a version is never rewritten',
  },
  permission_policy_version_number_unique: {
    code: 'duplicate-policy-version',
    explanation:
      'this policy version number has already been published. Numbers order authority history',
  },
  permission_policy_version_idempotency_unique: {
    code: 'idempotency-key-reuse',
    explanation: 'this idempotency key has already published a policy version',
  },
  permission_grant_pkey: {
    code: 'duplicate-grant',
    explanation: 'a grant with this id already exists, and a grant is never rewritten',
  },
  permission_grant_idempotency_unique: {
    code: 'idempotency-key-reuse',
    explanation: 'this idempotency key has already recorded a grant',
  },
  permission_revocation_pkey: {
    code: 'malformed-record',
    explanation: 'a revocation with this id already exists',
  },
  permission_revocation_grant_unique: {
    code: 'stale-revocation',
    explanation:
      'this grant has already been revoked, and the first revocation is when authority ended',
  },
  permission_revocation_idempotency_unique: {
    code: 'idempotency-key-reuse',
    explanation: 'this idempotency key has already recorded a revocation',
  },
  permission_decision_pkey: {
    code: 'malformed-record',
    explanation: 'a decision with this id already exists',
  },
  permission_decision_idempotency_unique: {
    code: 'idempotency-key-reuse',
    explanation: 'this idempotency key has already recorded a decision',
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
  if (error instanceof PermissionError) return error;

  const detail = databaseErrorDetail(error);
  if (detail.code !== UNIQUE_VIOLATION) return error;

  const message = error instanceof Error ? error.message : String(error);
  const named =
    detail.constraint ??
    Object.keys(CONSTRAINT_MEANINGS).find((constraint) => message.includes(constraint));
  const meaning = named === undefined ? undefined : CONSTRAINT_MEANINGS[named];
  if (meaning === undefined) return error;

  return new PermissionError(meaning.code, `${operation} was refused: ${meaning.explanation}`);
}

const POLICY_COLUMNS = [
  'policy_version_id',
  'version',
  'roles',
  'published_at',
  'published_by_kind',
  'published_by_id',
  'bootstrap',
  'idempotency_key',
  'request_fingerprint',
] as const;

const GRANT_COLUMNS = [
  'grant_id',
  'subject_id',
  'account_id',
  'role',
  'effect',
  'action',
  'resource_type',
  'resource_id',
  'purpose',
  'condition',
  'policy_version_id',
  'granted_at',
  'not_before',
  'expires_at',
  'granted_by_kind',
  'granted_by_id',
  'idempotency_key',
  'request_fingerprint',
] as const;

const REVOCATION_COLUMNS = [
  'revocation_id',
  'grant_id',
  'revoked_at',
  'reason',
  'revoked_by_kind',
  'revoked_by_id',
  'idempotency_key',
  'request_fingerprint',
] as const;

const DECISION_COLUMNS = [
  'decision_id',
  'subject_id',
  'account_id',
  'session_id',
  'action',
  'resource_type',
  'resource_id',
  'effect',
  'reason',
  'explanation',
  'deciding_grant_id',
  'policy_version_id',
  'purpose',
  'decided_at',
  'idempotency_key',
  'request_fingerprint',
] as const;

/** Every `timestamptz` in this schema. All are projected as text; nothing parses one as a Date. */
export const TIMESTAMP_COLUMNS = [
  'published_at',
  'granted_at',
  'not_before',
  'expires_at',
  'revoked_at',
  'decided_at',
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

const POLICY_PROJECTION = projectionOf(POLICY_COLUMNS);
const GRANT_PROJECTION = projectionOf(GRANT_COLUMNS);
const REVOCATION_PROJECTION = projectionOf(REVOCATION_COLUMNS);
const DECISION_PROJECTION = projectionOf(DECISION_COLUMNS);

const STORED_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/;

function instant(value: unknown, column: string): string {
  if (typeof value !== 'string') {
    throw new PermissionError(
      'malformed-record',
      `${column} came back as ${value instanceof Date ? 'a Date' : typeof value} rather than ` +
        'text. Timestamps are projected through to_char precisely so the driver never parses them',
    );
  }
  const match = STORED_INSTANT.exec(value);
  if (match === null) {
    throw new PermissionError(
      'malformed-record',
      `${column} holds "${value}", which is not a finite UTC timestamp in the projected form`,
    );
  }
  try {
    parseInstant(value);
  } catch (error) {
    if (error instanceof InvalidInstantError) {
      throw new PermissionError('malformed-record', `${column}: ${error.message}`);
    }
    throw error;
  }
  const [, year, month, day, hour, minute, second, fraction = ''] = match;
  const digits = fraction.replace(/0+$/, '');
  return `${year}-${month}-${day}T${hour}:${minute}:${second}${digits === '' ? '' : `.${digits}`}Z`;
}

function optionalInstant(value: unknown, column: string): string | null {
  return value === null || value === undefined ? null : instant(value, column);
}

function text(value: unknown, column: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new PermissionError(
      'malformed-record',
      `${column} is ${value === null ? 'null' : typeof value}; expected non-empty text`,
    );
  }
  return value;
}

function optionalText(value: unknown, column: string): string | null {
  return value === null || value === undefined ? null : text(value, column);
}

/** `jsonb` comes back parsed. Anything else is a row nobody here wrote. */
function json(value: unknown, column: string): unknown {
  if (typeof value === 'string') {
    // The driver hands back an object for jsonb. A string means the column is text, which is a
    // schema this component did not create.
    throw new PermissionError(
      'malformed-record',
      `${column} came back as text rather than parsed JSON; the column type is not what 0009 creates`,
    );
  }
  return value;
}

export function toPolicyVersion(row: Record<string, unknown>): PolicyVersion {
  return inStoredRow(() =>
    sealPolicyVersion(
      validatePolicyVersion(
        {
          policyVersionId: text(row.policy_version_id, 'policy_version_id'),
          version: Number(row.version),
          roles: json(row.roles, 'roles'),
          publishedAt: instant(row.published_at, 'published_at'),
          publishedBy: {
            kind: row.published_by_kind,
            id: row.published_by_id,
          },
          bootstrap: row.bootstrap,
          idempotencyKey: text(row.idempotency_key, 'idempotency_key'),
          requestFingerprint: text(row.request_fingerprint, 'request_fingerprint'),
        },
        'stored row',
      ),
    ),
  );
}

export function toGrant(row: Record<string, unknown>): Grant {
  return inStoredRow(() =>
    sealGrant(
      validateGrant(
        {
          grantId: text(row.grant_id, 'grant_id'),
          subjectId: text(row.subject_id, 'subject_id'),
          accountId: text(row.account_id, 'account_id'),
          role: row.role,
          effect: row.effect,
          action: row.action,
          resourceType: row.resource_type,
          resourceId: optionalText(row.resource_id, 'resource_id'),
          purpose: row.purpose ?? null,
          condition:
            row.condition === null || row.condition === undefined
              ? null
              : json(row.condition, 'condition'),
          policyVersionId: text(row.policy_version_id, 'policy_version_id'),
          grantedAt: instant(row.granted_at, 'granted_at'),
          notBefore: optionalInstant(row.not_before, 'not_before'),
          expiresAt: optionalInstant(row.expires_at, 'expires_at'),
          grantedBy: { kind: row.granted_by_kind, id: row.granted_by_id },
          idempotencyKey: text(row.idempotency_key, 'idempotency_key'),
          requestFingerprint: text(row.request_fingerprint, 'request_fingerprint'),
        },
        'stored row',
      ),
    ),
  );
}

export function toRevocation(row: Record<string, unknown>): Revocation {
  return inStoredRow(() =>
    sealRevocation(
      validateRevocation(
        {
          revocationId: text(row.revocation_id, 'revocation_id'),
          grantId: text(row.grant_id, 'grant_id'),
          revokedAt: instant(row.revoked_at, 'revoked_at'),
          reason: row.reason,
          revokedBy: { kind: row.revoked_by_kind, id: row.revoked_by_id },
          idempotencyKey: text(row.idempotency_key, 'idempotency_key'),
          requestFingerprint: text(row.request_fingerprint, 'request_fingerprint'),
        },
        'stored row',
      ),
    ),
  );
}

export function toDecision(row: Record<string, unknown>): Decision {
  return inStoredRow(() =>
    sealDecision(
      validateDecision(
        {
          decisionId: text(row.decision_id, 'decision_id'),
          subjectId: text(row.subject_id, 'subject_id'),
          accountId: text(row.account_id, 'account_id'),
          sessionId: text(row.session_id, 'session_id'),
          action: row.action,
          resourceType: row.resource_type,
          resourceId: optionalText(row.resource_id, 'resource_id'),
          effect: row.effect,
          reason: row.reason,
          explanation: text(row.explanation, 'explanation'),
          decidingGrantId: optionalText(row.deciding_grant_id, 'deciding_grant_id'),
          policyVersionId: text(row.policy_version_id, 'policy_version_id'),
          purpose: row.purpose ?? null,
          decidedAt: instant(row.decided_at, 'decided_at'),
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
 * commit rows its caller had not finished writing — and here that means committing a grant whose
 * accompanying business change never landed.
 */
export function enlistedClient(client: DatabaseClient): DatabaseClient {
  return {
    query<QueryRow = Record<string, unknown>>(sql: string, params?: readonly unknown[]) {
      if (TRANSACTION_CONTROL.test(sql)) {
        return Promise.reject(
          new PermissionError(
            'nested-transaction',
            `an enlisted permission write may not issue "${sql.trim().split(/\s+/, 2).join(' ')}". ` +
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
 * A permission repository inside a transaction somebody else opened.
 *
 * What a future provisioning path would need: a role granted in the same transaction as whatever
 * created the party it is granted to. No unit uses this yet.
 */
export class EnlistedPermissionRepository implements PermissionRepository {
  readonly #client: DatabaseClient;

  constructor(client: DatabaseClient) {
    this.#client = enlistedClient(client);
  }

  withTransaction<T>(body: (tx: PermissionTransaction) => Promise<T>): Promise<T> {
    return body(new PostgresPermissionTransaction(this.#client));
  }
}

export class PostgresPermissionRepository implements PermissionRepository {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  static enlist(client: DatabaseClient): PermissionRepository {
    return new EnlistedPermissionRepository(client);
  }

  async withTransaction<T>(body: (tx: PermissionTransaction) => Promise<T>): Promise<T> {
    const client = await this.#database.connect();
    try {
      await client.query('BEGIN;');
      try {
        const result = await body(new PostgresPermissionTransaction(client));
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

class PostgresPermissionTransaction implements PermissionTransaction {
  readonly #client: DatabaseClient;

  constructor(client: DatabaseClient) {
    this.#client = client;
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

  async #many<T>(
    sql: string,
    params: readonly unknown[],
    decode: (row: Record<string, unknown>) => T,
  ): Promise<readonly T[]> {
    const result = await this.#client.query<Record<string, unknown>>(sql, params);
    return Object.freeze(result.rows.map(decode));
  }

  findActivePolicy(): Promise<PolicyVersion | null> {
    // Highest version, not most recent write: the number is the ordering.
    return this.#one(
      `SELECT ${POLICY_PROJECTION} FROM ${POLICY_TABLE} ORDER BY version DESC LIMIT 1;`,
      [],
      toPolicyVersion,
    );
  }

  findPolicyById(policyVersionId: string): Promise<PolicyVersion | null> {
    return this.#one(
      `SELECT ${POLICY_PROJECTION} FROM ${POLICY_TABLE} WHERE policy_version_id = $1;`,
      [policyVersionId],
      toPolicyVersion,
    );
  }

  findPolicyByIdempotencyKey(idempotencyKey: string): Promise<PolicyVersion | null> {
    return this.#one(
      `SELECT ${POLICY_PROJECTION} FROM ${POLICY_TABLE} WHERE idempotency_key = $1;`,
      [idempotencyKey],
      toPolicyVersion,
    );
  }

  async insertPolicyVersion(policy: PolicyVersion): Promise<void> {
    try {
      await this.#client.query(
        `INSERT INTO ${POLICY_TABLE} (${POLICY_COLUMNS.join(', ')})
         VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9);`,
        [
          policy.policyVersionId,
          policy.version,
          JSON.stringify(policy.roles),
          policy.publishedAt,
          policy.publishedBy.kind,
          policy.publishedBy.id,
          policy.bootstrap,
          policy.idempotencyKey,
          policy.requestFingerprint,
        ],
      );
    } catch (error) {
      throw normalizeDatabaseError(error, 'insertPolicyVersion');
    }
  }

  findGrantById(grantId: string): Promise<Grant | null> {
    return this.#one(
      `SELECT ${GRANT_PROJECTION} FROM ${GRANT_TABLE} WHERE grant_id = $1;`,
      [grantId],
      toGrant,
    );
  }

  findGrantByIdempotencyKey(idempotencyKey: string): Promise<Grant | null> {
    return this.#one(
      `SELECT ${GRANT_PROJECTION} FROM ${GRANT_TABLE} WHERE idempotency_key = $1;`,
      [idempotencyKey],
      toGrant,
    );
  }

  listGrantsForSubject(subjectId: string, accountId: string): Promise<readonly Grant[]> {
    // Both, always. A query by subject alone would read another account's authority into a
    // decision about this one.
    return this.#many(
      `SELECT ${GRANT_PROJECTION} FROM ${GRANT_TABLE}
        WHERE subject_id = $1 AND account_id = $2 ORDER BY grant_id;`,
      [subjectId, accountId],
      toGrant,
    );
  }

  async insertGrant(grant: Grant): Promise<void> {
    try {
      await this.#client.query(
        `INSERT INTO ${GRANT_TABLE} (${GRANT_COLUMNS.join(', ')})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14, $15, $16, $17, $18);`,
        [
          grant.grantId,
          grant.subjectId,
          grant.accountId,
          grant.role,
          grant.effect,
          grant.action,
          grant.resourceType,
          grant.resourceId,
          grant.purpose,
          grant.condition === null ? null : JSON.stringify(grant.condition),
          grant.policyVersionId,
          grant.grantedAt,
          grant.notBefore,
          grant.expiresAt,
          grant.grantedBy.kind,
          grant.grantedBy.id,
          grant.idempotencyKey,
          grant.requestFingerprint,
        ],
      );
    } catch (error) {
      throw normalizeDatabaseError(error, 'insertGrant');
    }
  }

  findRevocationByGrantId(grantId: string): Promise<Revocation | null> {
    return this.#one(
      `SELECT ${REVOCATION_PROJECTION} FROM ${REVOCATION_TABLE} WHERE grant_id = $1;`,
      [grantId],
      toRevocation,
    );
  }

  findRevocationByIdempotencyKey(idempotencyKey: string): Promise<Revocation | null> {
    return this.#one(
      `SELECT ${REVOCATION_PROJECTION} FROM ${REVOCATION_TABLE} WHERE idempotency_key = $1;`,
      [idempotencyKey],
      toRevocation,
    );
  }

  listRevocationsForGrants(grantIds: readonly string[]): Promise<readonly Revocation[]> {
    if (grantIds.length === 0) return Promise.resolve(Object.freeze([]));
    return this.#many(
      `SELECT ${REVOCATION_PROJECTION} FROM ${REVOCATION_TABLE}
        WHERE grant_id = ANY($1::text[]) ORDER BY revocation_id;`,
      [[...grantIds]],
      toRevocation,
    );
  }

  async insertRevocation(revocation: Revocation): Promise<void> {
    try {
      await this.#client.query(
        `INSERT INTO ${REVOCATION_TABLE} (${REVOCATION_COLUMNS.join(', ')})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8);`,
        [
          revocation.revocationId,
          revocation.grantId,
          revocation.revokedAt,
          revocation.reason,
          revocation.revokedBy.kind,
          revocation.revokedBy.id,
          revocation.idempotencyKey,
          revocation.requestFingerprint,
        ],
      );
    } catch (error) {
      throw normalizeDatabaseError(error, 'insertRevocation');
    }
  }

  findDecisionById(decisionId: string): Promise<Decision | null> {
    return this.#one(
      `SELECT ${DECISION_PROJECTION} FROM ${DECISION_TABLE} WHERE decision_id = $1;`,
      [decisionId],
      toDecision,
    );
  }

  findDecisionByIdempotencyKey(idempotencyKey: string): Promise<Decision | null> {
    return this.#one(
      `SELECT ${DECISION_PROJECTION} FROM ${DECISION_TABLE} WHERE idempotency_key = $1;`,
      [idempotencyKey],
      toDecision,
    );
  }

  async insertDecision(decision: Decision): Promise<void> {
    try {
      await this.#client.query(
        `INSERT INTO ${DECISION_TABLE} (${DECISION_COLUMNS.join(', ')})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16);`,
        [
          decision.decisionId,
          decision.subjectId,
          decision.accountId,
          decision.sessionId,
          decision.action,
          decision.resourceType,
          decision.resourceId,
          decision.effect,
          decision.reason,
          decision.explanation,
          decision.decidingGrantId,
          decision.policyVersionId,
          decision.purpose,
          decision.decidedAt,
          decision.idempotencyKey,
          decision.requestFingerprint,
        ],
      );
    } catch (error) {
      throw normalizeDatabaseError(error, 'insertDecision');
    }
  }
}
