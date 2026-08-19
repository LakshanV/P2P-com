/**
 * K-02 Authentication — the PostgreSQL adapter (FND-004c).
 *
 * Implements the persistence port against `kernel_authentication`. It knows SQL and nothing else.
 *
 * Five properties are load-bearing:
 *
 *   - **`kernel_authentication` and nothing else.** No statement names another schema. K-02 depends
 *     on K-01 through an injected lookup — not a join, not a foreign key — for the reasons K-03's
 *     contract sets out: a cross-schema key makes two components one object that cannot be migrated
 *     or rolled back independently.
 *   - **No secret is ever a parameter.** The only session material that reaches SQL is a SHA-256.
 *     `tests/authentication-repository.test.ts` inspects every parameter of every statement the
 *     adapter issues and fails if a value looks like a token rather than a hash.
 *   - **Bindings and evidence are append-only**; sessions accept exactly two guarded updates. There
 *     is no `UPDATE … SET absolute_expires_at`, because a session that could have its hard stop
 *     moved has no hard stop.
 *   - **Guarded updates carry their guard in the `WHERE`.** A rotation matches on the hash it
 *     expects to replace; a revocation matches only a session that is not already revoked. A stale
 *     caller affects zero rows and is told so, rather than overwriting a winner.
 *   - **Timestamps are read as text and decoding is fail-closed**, against the same validators the
 *     service uses. A session decoded from a row is about to be treated as proof of who somebody
 *     is; a malformed one is refused rather than approximated.
 *
 * Owned by: K-02 Authentication.
 */

import { databaseErrorDetail } from '../../platform/db/client.ts';
import type { Database, DatabaseClient } from '../../platform/db/client.ts';
import { InvalidInstantError, parseInstant } from '../../platform/time/instant.ts';

import { sealBinding, sealEvidence, sealSession } from './immutable.ts';
import type {
  AuthenticationRepository,
  AuthenticationTransaction,
  RevocationCommand,
  RotationCommand,
} from './repository.ts';
import {
  AuthenticationError,
  type AuthenticationBinding,
  type AuthenticationEvidence,
  type AuthenticationErrorCode,
  type AuthenticationSession,
} from './types.ts';
import { inStoredRow, validateBinding, validateEvidence, validateSession } from './validate.ts';

export const AUTH_SCHEMA = 'kernel_authentication';
export const BINDING_TABLE = `${AUTH_SCHEMA}.authentication_binding`;
export const EVIDENCE_TABLE = `${AUTH_SCHEMA}.authentication_evidence`;
export const SESSION_TABLE = `${AUTH_SCHEMA}.authentication_session`;

const UNIQUE_VIOLATION = '23505';

const CONSTRAINT_MEANINGS: Readonly<
  Record<string, { readonly code: AuthenticationErrorCode; readonly explanation: string }>
> = {
  authentication_binding_pkey: {
    code: 'duplicate-binding',
    explanation: 'a binding with this id already exists, and a binding is never rewritten',
  },
  authentication_binding_reference_unique: {
    code: 'duplicate-binding',
    explanation:
      'this provider reference already authenticates a subject — one reference, one subject, ' +
      'or two parties would share a login',
  },
  authentication_binding_idempotency_unique: {
    code: 'idempotency-key-reuse',
    explanation: 'this idempotency key has already been used by a binding that got there first',
  },
  authentication_evidence_pkey: {
    code: 'malformed-record',
    explanation: 'an evidence record with this id already exists',
  },
  authentication_evidence_assertion_unique: {
    code: 'assertion-replayed',
    explanation:
      'this verifier assertion has already been consumed. An assertion authenticates once',
  },
  authentication_evidence_idempotency_unique: {
    code: 'idempotency-key-reuse',
    explanation: 'this idempotency key has already recorded an authentication',
  },
  authentication_session_pkey: {
    code: 'malformed-record',
    explanation: 'a session with this id already exists',
  },
  authentication_session_token_unique: {
    code: 'insufficient-entropy',
    explanation:
      'two sessions produced the same token hash, so the entropy source is repeating itself',
  },
  authentication_session_idempotency_unique: {
    code: 'idempotency-key-reuse',
    explanation: 'this idempotency key has already issued a session',
  },
};

function normalizeDatabaseError(error: unknown, operation: string): unknown {
  if (error instanceof AuthenticationError) return error;

  const detail = databaseErrorDetail(error);
  if (detail.code !== UNIQUE_VIOLATION) return error;

  const message = error instanceof Error ? error.message : String(error);
  const named =
    detail.constraint ??
    Object.keys(CONSTRAINT_MEANINGS).find((constraint) => message.includes(constraint));
  const meaning = named === undefined ? undefined : CONSTRAINT_MEANINGS[named];
  if (meaning === undefined) return error;

  return new AuthenticationError(meaning.code, `${operation} was refused: ${meaning.explanation}`);
}

const BINDING_COLUMNS = [
  'binding_id',
  'subject_id',
  'provider',
  'provider_reference',
  'created_at',
  'idempotency_key',
] as const;

const EVIDENCE_COLUMNS = [
  'evidence_id',
  'binding_id',
  'subject_id',
  'provider',
  'assertion_id',
  'factors',
  'assurance',
  'verified_at',
  'recorded_at',
  'idempotency_key',
] as const;

const SESSION_COLUMNS = [
  'session_id',
  'binding_id',
  'subject_id',
  'evidence_id',
  'assurance',
  'factors',
  'token_hash',
  'issued_at',
  'absolute_expires_at',
  'idle_expires_at',
  'rotation_count',
  'revoked_at',
  'revocation_reason',
  'idempotency_key',
] as const;

/** Every `timestamptz` in this schema. All are projected as text; nothing parses one as a Date. */
export const TIMESTAMP_COLUMNS = [
  'created_at',
  'verified_at',
  'recorded_at',
  'issued_at',
  'absolute_expires_at',
  'idle_expires_at',
  'revoked_at',
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

const BINDING_PROJECTION = projectionOf(BINDING_COLUMNS);
const EVIDENCE_PROJECTION = projectionOf(EVIDENCE_COLUMNS);
const SESSION_PROJECTION = projectionOf(SESSION_COLUMNS);

const STORED_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/;

function instant(value: unknown, column: string): string {
  if (typeof value !== 'string') {
    throw new AuthenticationError(
      'malformed-record',
      `${column} came back as ${value instanceof Date ? 'a Date' : typeof value} rather than ` +
        'text. Timestamps are projected through to_char precisely so the driver never parses them',
    );
  }
  const match = STORED_INSTANT.exec(value);
  if (match === null) {
    throw new AuthenticationError(
      'malformed-record',
      `${column} holds "${value}", which is not a finite UTC timestamp in the projected form`,
    );
  }
  try {
    parseInstant(value);
  } catch (error) {
    if (error instanceof InvalidInstantError) {
      throw new AuthenticationError('malformed-record', `${column}: ${error.message}`);
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
    throw new AuthenticationError(
      'malformed-record',
      `${column} is ${value === null ? 'null' : typeof value}; expected non-empty text`,
    );
  }
  return value;
}

/** `text[]` comes back as an array from the driver. Anything else is a row nobody here wrote. */
function factorArray(value: unknown, column: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new AuthenticationError(
      'malformed-record',
      `${column} came back as ${value === null ? 'null' : typeof value} rather than an array`,
    );
  }
  return value;
}

export function toBinding(row: Record<string, unknown>): AuthenticationBinding {
  return inStoredRow(() =>
    sealBinding(
      validateBinding(
        {
          bindingId: text(row.binding_id, 'binding_id'),
          subjectId: text(row.subject_id, 'subject_id'),
          provider: text(row.provider, 'provider'),
          providerReference: text(row.provider_reference, 'provider_reference'),
          createdAt: instant(row.created_at, 'created_at'),
          idempotencyKey: text(row.idempotency_key, 'idempotency_key'),
        },
        'stored row',
      ),
    ),
  );
}

export function toEvidence(row: Record<string, unknown>): AuthenticationEvidence {
  return inStoredRow(() =>
    sealEvidence(
      validateEvidence(
        {
          evidenceId: text(row.evidence_id, 'evidence_id'),
          bindingId: text(row.binding_id, 'binding_id'),
          subjectId: text(row.subject_id, 'subject_id'),
          provider: text(row.provider, 'provider'),
          assertionId: text(row.assertion_id, 'assertion_id'),
          factors: factorArray(row.factors, 'factors'),
          assurance: text(row.assurance, 'assurance'),
          verifiedAt: instant(row.verified_at, 'verified_at'),
          recordedAt: instant(row.recorded_at, 'recorded_at'),
          idempotencyKey: text(row.idempotency_key, 'idempotency_key'),
        },
        'stored row',
      ),
    ),
  );
}

export function toSession(row: Record<string, unknown>): AuthenticationSession {
  return inStoredRow(() =>
    sealSession(
      validateSession(
        {
          sessionId: text(row.session_id, 'session_id'),
          bindingId: text(row.binding_id, 'binding_id'),
          subjectId: text(row.subject_id, 'subject_id'),
          evidenceId: text(row.evidence_id, 'evidence_id'),
          assurance: text(row.assurance, 'assurance'),
          factors: factorArray(row.factors, 'factors'),
          tokenHash: text(row.token_hash, 'token_hash'),
          issuedAt: instant(row.issued_at, 'issued_at'),
          absoluteExpiresAt: instant(row.absolute_expires_at, 'absolute_expires_at'),
          idleExpiresAt: instant(row.idle_expires_at, 'idle_expires_at'),
          rotationCount: Number(row.rotation_count),
          revokedAt: optionalInstant(row.revoked_at, 'revoked_at'),
          revocationReason: row.revocation_reason ?? null,
          idempotencyKey: text(row.idempotency_key, 'idempotency_key'),
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
 * PostgreSQL has no nested transactions: a `COMMIT` from here would end the *caller's* transaction,
 * committing rows it had not finished writing.
 */
export function enlistedClient(client: DatabaseClient): DatabaseClient {
  return {
    query<QueryRow = Record<string, unknown>>(sql: string, params?: readonly unknown[]) {
      if (TRANSACTION_CONTROL.test(sql)) {
        return Promise.reject(
          new AuthenticationError(
            'nested-transaction',
            `an enlisted authentication write may not issue ` +
              `"${sql.trim().split(/\s+/, 2).join(' ')}". The transaction belongs to the caller`,
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
 * An authentication repository inside a transaction somebody else opened.
 *
 * What a future sign-in-and-provision path would need: a session issued in the same transaction as
 * whatever the caller writes alongside it. No unit uses this yet.
 */
export class EnlistedAuthenticationRepository implements AuthenticationRepository {
  readonly #client: DatabaseClient;

  constructor(client: DatabaseClient) {
    this.#client = enlistedClient(client);
  }

  withTransaction<T>(body: (tx: AuthenticationTransaction) => Promise<T>): Promise<T> {
    return body(new PostgresAuthenticationTransaction(this.#client));
  }
}

export class PostgresAuthenticationRepository implements AuthenticationRepository {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  static enlist(client: DatabaseClient): AuthenticationRepository {
    return new EnlistedAuthenticationRepository(client);
  }

  async withTransaction<T>(body: (tx: AuthenticationTransaction) => Promise<T>): Promise<T> {
    const client = await this.#database.connect();
    try {
      await client.query('BEGIN;');
      try {
        const result = await body(new PostgresAuthenticationTransaction(client));
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

class PostgresAuthenticationTransaction implements AuthenticationTransaction {
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

  findBindingById(bindingId: string): Promise<AuthenticationBinding | null> {
    return this.#one(
      `SELECT ${BINDING_PROJECTION} FROM ${BINDING_TABLE} WHERE binding_id = $1;`,
      [bindingId],
      toBinding,
    );
  }

  findBindingByReference(
    provider: string,
    providerReference: string,
  ): Promise<AuthenticationBinding | null> {
    return this.#one(
      `SELECT ${BINDING_PROJECTION} FROM ${BINDING_TABLE} WHERE provider = $1 AND provider_reference = $2;`,
      [provider, providerReference],
      toBinding,
    );
  }

  findBindingByIdempotencyKey(idempotencyKey: string): Promise<AuthenticationBinding | null> {
    return this.#one(
      `SELECT ${BINDING_PROJECTION} FROM ${BINDING_TABLE} WHERE idempotency_key = $1;`,
      [idempotencyKey],
      toBinding,
    );
  }

  async listBindingsForSubject(subjectId: string): Promise<readonly AuthenticationBinding[]> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${BINDING_PROJECTION} FROM ${BINDING_TABLE}
        WHERE subject_id = $1
        ORDER BY authentication_binding.created_at ASC, authentication_binding.binding_id ASC;`,
      [subjectId],
    );
    return Object.freeze(result.rows.map(toBinding));
  }

  async insertBinding(binding: AuthenticationBinding): Promise<void> {
    try {
      await this.#client.query(
        `INSERT INTO ${BINDING_TABLE} (${BINDING_COLUMNS.join(', ')})
         VALUES ($1, $2, $3, $4, $5, $6);`,
        [
          binding.bindingId,
          binding.subjectId,
          binding.provider,
          binding.providerReference,
          binding.createdAt,
          binding.idempotencyKey,
        ],
      );
    } catch (error) {
      throw normalizeDatabaseError(error, 'insertBinding');
    }
  }

  findEvidenceByAssertionId(
    provider: string,
    assertionId: string,
  ): Promise<AuthenticationEvidence | null> {
    return this.#one(
      `SELECT ${EVIDENCE_PROJECTION} FROM ${EVIDENCE_TABLE} WHERE provider = $1 AND assertion_id = $2;`,
      [provider, assertionId],
      toEvidence,
    );
  }

  findEvidenceByIdempotencyKey(idempotencyKey: string): Promise<AuthenticationEvidence | null> {
    return this.#one(
      `SELECT ${EVIDENCE_PROJECTION} FROM ${EVIDENCE_TABLE} WHERE idempotency_key = $1;`,
      [idempotencyKey],
      toEvidence,
    );
  }

  async insertEvidence(evidence: AuthenticationEvidence): Promise<void> {
    try {
      await this.#client.query(
        `INSERT INTO ${EVIDENCE_TABLE} (${EVIDENCE_COLUMNS.join(', ')})
         VALUES ($1, $2, $3, $4, $5, $6::text[], $7, $8, $9, $10);`,
        [
          evidence.evidenceId,
          evidence.bindingId,
          evidence.subjectId,
          evidence.provider,
          evidence.assertionId,
          [...evidence.factors],
          evidence.assurance,
          evidence.verifiedAt,
          evidence.recordedAt,
          evidence.idempotencyKey,
        ],
      );
    } catch (error) {
      throw normalizeDatabaseError(error, 'insertEvidence');
    }
  }

  findSessionById(sessionId: string): Promise<AuthenticationSession | null> {
    return this.#one(
      `SELECT ${SESSION_PROJECTION} FROM ${SESSION_TABLE} WHERE session_id = $1;`,
      [sessionId],
      toSession,
    );
  }

  findSessionByTokenHash(tokenHash: string): Promise<AuthenticationSession | null> {
    // By hash. There is no lookup by secret, because no secret is stored.
    return this.#one(
      `SELECT ${SESSION_PROJECTION} FROM ${SESSION_TABLE} WHERE token_hash = $1;`,
      [tokenHash],
      toSession,
    );
  }

  findSessionByIdempotencyKey(idempotencyKey: string): Promise<AuthenticationSession | null> {
    return this.#one(
      `SELECT ${SESSION_PROJECTION} FROM ${SESSION_TABLE} WHERE idempotency_key = $1;`,
      [idempotencyKey],
      toSession,
    );
  }

  async insertSession(session: AuthenticationSession): Promise<void> {
    try {
      await this.#client.query(
        `INSERT INTO ${SESSION_TABLE} (${SESSION_COLUMNS.join(', ')})
         VALUES ($1, $2, $3, $4, $5, $6::text[], $7, $8, $9, $10, $11, $12, $13, $14);`,
        [
          session.sessionId,
          session.bindingId,
          session.subjectId,
          session.evidenceId,
          session.assurance,
          [...session.factors],
          session.tokenHash,
          session.issuedAt,
          session.absoluteExpiresAt,
          session.idleExpiresAt,
          session.rotationCount,
          session.revokedAt,
          session.revocationReason,
          session.idempotencyKey,
        ],
      );
    } catch (error) {
      throw normalizeDatabaseError(error, 'insertSession');
    }
  }

  /**
   * Replace the secret, only if the session still holds the one being replaced.
   *
   * The `WHERE` carries the guard, so the decision is the database's and not a read this
   * transaction did earlier. Note what is not in the `SET`: `absolute_expires_at`. A rotation that
   * moved it would mean a session with no hard stop.
   */
  async rotateSession(command: RotationCommand): Promise<boolean> {
    const result = await this.#client.query(
      `UPDATE ${SESSION_TABLE}
          SET token_hash = $1, idle_expires_at = $2, rotation_count = $3
        WHERE session_id = $4 AND token_hash = $5 AND revoked_at IS NULL;`,
      [
        command.nextTokenHash,
        command.nextIdleExpiresAt,
        command.nextRotationCount,
        command.sessionId,
        command.expectedTokenHash,
      ],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /** Revoke, only if not revoked already. A second revocation affects no rows and says so. */
  async revokeSession(command: RevocationCommand): Promise<boolean> {
    const result = await this.#client.query(
      `UPDATE ${SESSION_TABLE}
          SET revoked_at = $1, revocation_reason = $2
        WHERE session_id = $3 AND revoked_at IS NULL;`,
      [command.revokedAt, command.reason, command.sessionId],
    );
    return (result.rowCount ?? 0) > 0;
  }
}
