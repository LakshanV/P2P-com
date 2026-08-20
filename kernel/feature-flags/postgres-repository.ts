/**
 * K-07 Feature Flags — the PostgreSQL adapter (FND-004e).
 *
 * Four properties this file exists to hold, none of which is visible from the service:
 *
 *   - **Every instant is projected as UTC text** through `to_char`, never left to the driver's
 *     `Date` parser. K-05 lost microseconds that way (§11.13) and every component since has
 *     projected instead.
 *   - **Decoding is fail-closed and runs the same validators the service runs.** A flag version
 *     row written around this adapter is refused rather than evaluated: a malformed row that
 *     decoded cleanly would decide which code paths run.
 *   - **No statement names another unit's schema, and there is no foreign key out of
 *     `kernel_feature_flags`.** Scope ids and subject keys are opaque handles, not joins. The cost
 *     — no database-level referential guarantee — is stated in the contract rather than glossed.
 *   - **The current version is the end of the activation chain, not the newest row.** `ORDER BY
 *     activated_at DESC LIMIT 1` would be wrong: two activations can share an instant, and a clock
 *     is not a history. The query finds the activation nothing else supersedes.
 *
 * There is no `UPDATE` and no `DELETE` in this file. Not one. Flag history is append-only, so the
 * adapter has no statement that could rewrite it even if a caller found a way to ask.
 *
 * Owned by: K-07 Feature Flags.
 */

import type { Database, DatabaseClient } from '../../platform/db/client.ts';
import { InvalidInstantError, parseInstant } from '../../platform/time/instant.ts';

import { sealActivation, sealFlagVersion, sealLifecycleEvent } from './immutable.ts';
import type { FeatureFlagRepository, FeatureFlagTransaction } from './repository.ts';
import {
  FeatureFlagError,
  type Activation,
  type FeatureFlagErrorCode,
  type FlagVersion,
  type LifecycleEvent,
} from './types.ts';
import {
  inStoredRow,
  validateActivation,
  validateFlagVersion,
  validateLifecycleEvent,
} from './validate.ts';

export const FEATURE_FLAGS_SCHEMA = 'kernel_feature_flags';
export const VERSION_TABLE = `${FEATURE_FLAGS_SCHEMA}.feature_flag_version`;
export const ACTIVATION_TABLE = `${FEATURE_FLAGS_SCHEMA}.feature_flag_activation`;
export const LIFECYCLE_TABLE = `${FEATURE_FLAGS_SCHEMA}.feature_flag_lifecycle`;

const UNIQUE_VIOLATION = '23505';

const CONSTRAINT_MEANINGS: Readonly<
  Record<string, { readonly code: FeatureFlagErrorCode; readonly explanation: string }>
> = {
  feature_flag_version_pkey: {
    code: 'duplicate-flag-version',
    explanation: 'a flag version with this id already exists, and a version is never rewritten',
  },
  feature_flag_version_number_unique: {
    code: 'duplicate-flag-version',
    explanation:
      'this version number has already been published for this flag. Numbers order its history',
  },
  feature_flag_version_idempotency_unique: {
    code: 'idempotency-key-reuse',
    explanation: 'this idempotency key has already published a flag version',
  },
  feature_flag_activation_pkey: {
    code: 'duplicate-activation',
    explanation: 'an activation with this id already exists',
  },
  feature_flag_activation_idempotency_unique: {
    code: 'idempotency-key-reuse',
    explanation: 'this idempotency key has already recorded an activation',
  },
  feature_flag_activation_supersedes_unique: {
    code: 'stale-activation',
    explanation:
      'another activation already superseded that version, so this one lost the race. Re-read ' +
      'the current version and decide again rather than overwriting somebody else',
  },
  feature_flag_activation_first_unique: {
    code: 'stale-activation',
    explanation:
      'this flag already has a first activation, so an activation superseding nothing lost the race',
  },
  feature_flag_lifecycle_pkey: {
    code: 'duplicate-lifecycle-event',
    explanation: 'a lifecycle event with this id already exists',
  },
  feature_flag_lifecycle_kind_unique: {
    code: 'duplicate-lifecycle-event',
    explanation:
      'this flag has already been killed or retired in this way, and the first record is when ' +
      'the feature actually stopped',
  },
  feature_flag_lifecycle_idempotency_unique: {
    code: 'idempotency-key-reuse',
    explanation: 'this idempotency key has already recorded a lifecycle event',
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
  if (error instanceof FeatureFlagError) return error;

  const detail = databaseErrorDetail(error);
  if (detail.code !== UNIQUE_VIOLATION) return error;

  const message = error instanceof Error ? error.message : String(error);
  const named =
    detail.constraint ??
    Object.keys(CONSTRAINT_MEANINGS).find((constraint) => message.includes(constraint));
  const meaning = named === undefined ? undefined : CONSTRAINT_MEANINGS[named];
  if (meaning === undefined) return error;

  return new FeatureFlagError(meaning.code, `${operation} was refused: ${meaning.explanation}`);
}

const VERSION_COLUMNS = [
  'flag_version_id',
  'flag_key',
  'version',
  'state',
  'supported_scopes',
  'rules',
  'percentage',
  'rollout_salt',
  'not_before',
  'not_after',
  'published_at',
  'published_by_kind',
  'published_by_id',
  'idempotency_key',
  'request_fingerprint',
] as const;

const ACTIVATION_COLUMNS = [
  'activation_id',
  'flag_key',
  'flag_version_id',
  'supersedes_version_id',
  'activated_at',
  'activated_by_kind',
  'activated_by_id',
  'idempotency_key',
  'request_fingerprint',
] as const;

const LIFECYCLE_COLUMNS = [
  'event_id',
  'flag_key',
  'kind',
  'reason',
  'recorded_at',
  'recorded_by_kind',
  'recorded_by_id',
  'idempotency_key',
  'request_fingerprint',
] as const;

/** Every `timestamptz` in this schema. All are projected as text; nothing parses one as a Date. */
export const TIMESTAMP_COLUMNS = [
  'not_before',
  'not_after',
  'published_at',
  'activated_at',
  'recorded_at',
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

const VERSION_PROJECTION = projectionOf(VERSION_COLUMNS);
const ACTIVATION_PROJECTION = projectionOf(ACTIVATION_COLUMNS);
const LIFECYCLE_PROJECTION = projectionOf(LIFECYCLE_COLUMNS);

const STORED_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/;

function instant(value: unknown, column: string): string {
  if (typeof value !== 'string') {
    throw new FeatureFlagError(
      'malformed-record',
      `${column} came back as ${value instanceof Date ? 'a Date' : typeof value} rather than ` +
        'text. Timestamps are projected through to_char precisely so the driver never parses them',
    );
  }
  const match = STORED_INSTANT.exec(value);
  if (match === null) {
    throw new FeatureFlagError(
      'malformed-record',
      `${column} holds "${value}", which is not a finite UTC timestamp in the projected form`,
    );
  }
  try {
    parseInstant(value);
  } catch (error) {
    if (error instanceof InvalidInstantError) {
      throw new FeatureFlagError('malformed-record', `${column}: ${error.message}`);
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
    throw new FeatureFlagError(
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
    throw new FeatureFlagError(
      'malformed-record',
      `${column} came back as text rather than parsed JSON; the column type is not what 0010 creates`,
    );
  }
  return value;
}

export function toFlagVersion(row: Record<string, unknown>): FlagVersion {
  return inStoredRow(() =>
    sealFlagVersion(
      validateFlagVersion(
        {
          flagVersionId: text(row.flag_version_id, 'flag_version_id'),
          flagKey: text(row.flag_key, 'flag_key'),
          version: Number(row.version),
          state: row.state,
          supportedScopes: json(row.supported_scopes, 'supported_scopes'),
          rules: json(row.rules, 'rules'),
          percentage: Number(row.percentage),
          rolloutSalt: text(row.rollout_salt, 'rollout_salt'),
          notBefore: optionalInstant(row.not_before, 'not_before'),
          notAfter: optionalInstant(row.not_after, 'not_after'),
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

export function toActivation(row: Record<string, unknown>): Activation {
  return inStoredRow(() =>
    sealActivation(
      validateActivation(
        {
          activationId: text(row.activation_id, 'activation_id'),
          flagKey: text(row.flag_key, 'flag_key'),
          flagVersionId: text(row.flag_version_id, 'flag_version_id'),
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

export function toLifecycleEvent(row: Record<string, unknown>): LifecycleEvent {
  return inStoredRow(() =>
    sealLifecycleEvent(
      validateLifecycleEvent(
        {
          eventId: text(row.event_id, 'event_id'),
          flagKey: text(row.flag_key, 'flag_key'),
          kind: row.kind,
          reason: text(row.reason, 'reason'),
          recordedAt: instant(row.recorded_at, 'recorded_at'),
          recordedBy: { kind: row.recorded_by_kind, id: row.recorded_by_id },
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
 * commit rows its caller had not finished writing — and here that means committing an activation
 * whose accompanying deployment change never landed, so a flag turns on for code that is not there.
 */
export function enlistedClient(client: DatabaseClient): DatabaseClient {
  return {
    query<QueryRow = Record<string, unknown>>(sql: string, params?: readonly unknown[]) {
      if (TRANSACTION_CONTROL.test(sql)) {
        return Promise.reject(
          new FeatureFlagError(
            'nested-transaction',
            `an enlisted feature-flag write may not issue "${sql.trim().split(/\s+/, 2).join(' ')}". ` +
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
 * A feature-flag repository inside a transaction somebody else opened.
 *
 * What a future release path would need: a flag activated in the same transaction as whatever
 * recorded the deploy that made the code available. No unit uses this yet.
 */
export class EnlistedFeatureFlagRepository implements FeatureFlagRepository {
  readonly #client: DatabaseClient;

  constructor(client: DatabaseClient) {
    this.#client = enlistedClient(client);
  }

  withTransaction<T>(body: (tx: FeatureFlagTransaction) => Promise<T>): Promise<T> {
    return body(new PostgresFeatureFlagTransaction(this.#client));
  }
}

export class PostgresFeatureFlagRepository implements FeatureFlagRepository {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  static enlist(client: DatabaseClient): FeatureFlagRepository {
    return new EnlistedFeatureFlagRepository(client);
  }

  async withTransaction<T>(body: (tx: FeatureFlagTransaction) => Promise<T>): Promise<T> {
    const client = await this.#database.connect();
    try {
      await client.query('BEGIN;');
      try {
        const result = await body(new PostgresFeatureFlagTransaction(client));
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

class PostgresFeatureFlagTransaction implements FeatureFlagTransaction {
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

  findVersionById(flagVersionId: string): Promise<FlagVersion | null> {
    return this.#one(
      `SELECT ${VERSION_PROJECTION} FROM ${VERSION_TABLE} WHERE flag_version_id = $1;`,
      [flagVersionId],
      toFlagVersion,
    );
  }

  findVersionByIdempotencyKey(idempotencyKey: string): Promise<FlagVersion | null> {
    return this.#one(
      `SELECT ${VERSION_PROJECTION} FROM ${VERSION_TABLE} WHERE idempotency_key = $1;`,
      [idempotencyKey],
      toFlagVersion,
    );
  }

  async highestVersion(flagKey: string): Promise<number> {
    const result = await this.#client.query<{ highest: string | number | null }>(
      `SELECT coalesce(max(version), 0) AS highest FROM ${VERSION_TABLE} WHERE flag_key = $1;`,
      [flagKey],
    );
    return Number(result.rows[0]?.highest ?? 0);
  }

  async insertVersion(version: FlagVersion): Promise<void> {
    try {
      await this.#client.query(
        `INSERT INTO ${VERSION_TABLE} (${VERSION_COLUMNS.join(', ')})
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10, $11, $12, $13, $14, $15);`,
        [
          version.flagVersionId,
          version.flagKey,
          version.version,
          version.state,
          JSON.stringify(version.supportedScopes),
          JSON.stringify(version.rules),
          version.percentage,
          version.rolloutSalt,
          version.notBefore,
          version.notAfter,
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
   * backwards, which is exactly the situation an operator is in when they most need this answer.
   */
  findCurrentActivation(flagKey: string): Promise<Activation | null> {
    return this.#one(
      `SELECT ${ACTIVATION_PROJECTION} FROM ${ACTIVATION_TABLE} current
        WHERE current.flag_key = $1
          AND NOT EXISTS (
            SELECT 1 FROM ${ACTIVATION_TABLE} later
             WHERE later.flag_key = current.flag_key
               AND later.supersedes_version_id = current.flag_version_id
          )
        LIMIT 1;`,
      [flagKey],
      toActivation,
    );
  }

  findActivationByIdempotencyKey(idempotencyKey: string): Promise<Activation | null> {
    return this.#one(
      `SELECT ${ACTIVATION_PROJECTION} FROM ${ACTIVATION_TABLE} WHERE idempotency_key = $1;`,
      [idempotencyKey],
      toActivation,
    );
  }

  async insertActivation(activation: Activation): Promise<void> {
    try {
      await this.#client.query(
        `INSERT INTO ${ACTIVATION_TABLE} (${ACTIVATION_COLUMNS.join(', ')})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9);`,
        [
          activation.activationId,
          activation.flagKey,
          activation.flagVersionId,
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

  listLifecycleEvents(flagKey: string): Promise<readonly LifecycleEvent[]> {
    return this.#many(
      `SELECT ${LIFECYCLE_PROJECTION} FROM ${LIFECYCLE_TABLE}
        WHERE flag_key = $1 ORDER BY event_id;`,
      [flagKey],
      toLifecycleEvent,
    );
  }

  findLifecycleEventByIdempotencyKey(idempotencyKey: string): Promise<LifecycleEvent | null> {
    return this.#one(
      `SELECT ${LIFECYCLE_PROJECTION} FROM ${LIFECYCLE_TABLE} WHERE idempotency_key = $1;`,
      [idempotencyKey],
      toLifecycleEvent,
    );
  }

  async insertLifecycleEvent(event: LifecycleEvent): Promise<void> {
    try {
      await this.#client.query(
        `INSERT INTO ${LIFECYCLE_TABLE} (${LIFECYCLE_COLUMNS.join(', ')})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9);`,
        [
          event.eventId,
          event.flagKey,
          event.kind,
          event.reason,
          event.recordedAt,
          event.recordedBy.kind,
          event.recordedBy.id,
          event.idempotencyKey,
          event.requestFingerprint,
        ],
      );
    } catch (error) {
      throw normalizeDatabaseError(error, 'insertLifecycleEvent');
    }
  }
}
