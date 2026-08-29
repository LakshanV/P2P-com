/**
 * K-05 Configuration — the PostgreSQL adapter (FND-003a).
 *
 * Implements the persistence port against `kernel_configuration.config_version`. It knows about
 * SQL and about nothing else: no validation, no precedence, no lifecycle rules. Those live in the
 * service, where they can be tested without a server.
 *
 * Every `withTransaction` is a real `BEGIN … COMMIT`, and any rejection rolls back — so a caller
 * that sees a publication fail can rely on nothing having been written, which is exactly what the
 * "no two active versions" invariant depends on.
 *
 * The value is stored as text alongside its kind, rather than as `jsonb`. A configuration value is
 * a scalar of a declared schema; storing it as JSON would invite structure the schema does not
 * describe, and the round-trip below is total for the kinds the registry permits.
 *
 * **Timestamps are read as text, not as values.** Every `timestamptz` column is projected through
 * `to_char(… AT TIME ZONE 'UTC', …)` and decoded here, because the driver's default parser produces
 * a `Date` and a `Date` cannot hold what the column holds. That is a correctness concern rather
 * than a formatting one: effective time decides which version answers a question, and precision
 * lost in the driver is lost before anything can notice. See `utcText` and `instant` below.
 *
 * Owned by: K-05 Configuration.
 */

import { databaseErrorDetail } from '../../platform/db/client.ts';
import type { Database, DatabaseClient } from '../../platform/db/client.ts';
import type { OutboxEntry } from '../../platform/outbox/types.ts';
import { parseInstant } from './instant.ts';
import type { ConfigurationRepository, ConfigurationTransaction } from './repository.ts';
import {
  ConfigurationError,
  type ConfigurationErrorCode,
  type ConfigurationValue,
  type ConfigurationVersion,
  type PublicationOrigin,
  type Scope,
  type ScopeLevel,
  type VersionStatus,
} from './types.ts';

export const CONFIG_SCHEMA = 'kernel_configuration';
export const CONFIG_TABLE = `${CONFIG_SCHEMA}.config_version`;
export const OUTBOX_TABLE = `${CONFIG_SCHEMA}.outbox`;

/** SQLSTATE 23505. The only driver code this adapter interprets. */
const UNIQUE_VIOLATION = '23505';

/**
 * The constraints the migration declares, and what a violation of each one actually means.
 *
 * Without this table a race surfaces as a raw driver error — `duplicate key value violates unique
 * constraint "config_version_one_active_per_scope"` — which no caller can act on. It is not a
 * `ConfigurationError`, so it carries no code, cannot be matched against the refusal table, and
 * tells an operator about an index rather than about what happened. What happened is that someone
 * else published first.
 *
 * The one-active-row case is reported as a race rather than as an ordering mistake because the
 * database cannot tell the two apart: it sees a second active row and nothing about who put the
 * first one there. The service supersedes before activating on every path, so the reachable cause
 * in production is a competing transaction. The in-memory reference implementation *can* tell them
 * apart, and reports an ordering mistake as `ambiguous-active-version` when the statement runs —
 * which is where that class of bug gets caught, long before this code is reached.
 */
const CONSTRAINT_MEANINGS: Readonly<
  Record<string, { readonly code: ConfigurationErrorCode; readonly explanation: string }>
> = {
  config_version_one_active_per_scope: {
    code: 'concurrent-modification',
    explanation:
      'another publication activated a version for this key and scope first. One active row is ' +
      'permitted, so this publication is refused and rolled back rather than committed alongside ' +
      'it. Re-read the active version and retry',
  },
  config_version_idempotency_unique: {
    code: 'idempotency-key-reuse',
    explanation: 'this idempotency key has already been used by a publication that got there first',
  },
  config_version_pkey: {
    code: 'immutable-version',
    explanation: 'a version with this id already exists, and a version is never rewritten',
  },
};

/**
 * Turn a driver failure into a refusal the caller can act on, or rethrow it untouched.
 *
 * Rethrowing is the default on purpose: an unrecognised failure must not be dressed up as a
 * domain refusal, because a caller that retries a `concurrent-modification` would then retry a
 * disk error forever.
 */
function normalizeDatabaseError(error: unknown, operation: string): unknown {
  if (error instanceof ConfigurationError) return error;

  const detail = databaseErrorDetail(error);
  if (detail.code !== UNIQUE_VIOLATION) return error;

  const message = error instanceof Error ? error.message : String(error);
  const named =
    detail.constraint ??
    Object.keys(CONSTRAINT_MEANINGS).find((constraint) => message.includes(constraint));
  const meaning = named === undefined ? undefined : CONSTRAINT_MEANINGS[named];
  if (meaning === undefined) return error;

  return new ConfigurationError(meaning.code, `${operation} was refused: ${meaning.explanation}`);
}

const COLUMN_NAMES = [
  'version_id',
  'config_key',
  'scope_level',
  'scope_id',
  'value_kind',
  'value_text',
  'effective_from',
  'status',
  'created_at',
  'published_at',
  'superseded_at',
  'previous_version_id',
  'idempotency_key',
  'origin',
] as const;

/** The four `timestamptz` columns. Every one of them is projected as text, never as a value. */
export const TIMESTAMP_COLUMNS = [
  'effective_from',
  'created_at',
  'published_at',
  'superseded_at',
] as const;

/** Bare column names, for the INSERT target list. */
const COLUMNS = COLUMN_NAMES.join(', ');

/**
 * Render a `timestamptz` as deterministic UTC text, inside the database.
 *
 * `pg` parses `timestamptz` into a JavaScript `Date` by default, and a `Date` holds milliseconds
 * where the column holds microseconds. Selecting the column bare therefore truncates before this
 * process ever sees the value: two versions whose effective times differ by 300µs come back as one
 * instant, and two versions that share an instant cannot be ordered — reintroducing on the way out
 * the ambiguity publication refuses on the way in. Nothing downstream can detect that, because by
 * then the digits are gone.
 *
 * `to_char` avoids the parser entirely by making the server produce the text. The pattern contains
 * no locale-dependent field — no month or day name — so `lc_time` cannot change it, and `DateStyle`
 * does not apply to `to_char` at all. `AT TIME ZONE 'UTC'` fixes the offset regardless of the
 * session's `TimeZone`, so the same row reads identically from any session. `US` is six fractional
 * digits, which is exactly the precision `timestamptz` stores.
 *
 * A NULL stays NULL: `to_char(NULL, …)` is NULL, so `published_at` and `superseded_at` keep saying
 * "not yet" rather than acquiring a value.
 */
function utcText(column: string): string {
  return `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${column}`;
}

/** The SELECT list: ordinary columns as themselves, timestamps as UTC text. */
const PROJECTION = COLUMN_NAMES.map((column) =>
  (TIMESTAMP_COLUMNS as readonly string[]).includes(column) ? utcText(column) : column,
).join(', ');

interface Row {
  readonly version_id: string;
  readonly config_key: string;
  readonly scope_level: string;
  readonly scope_id: string;
  readonly value_kind: string;
  readonly value_text: string;
  readonly effective_from: unknown;
  readonly status: string;
  readonly created_at: unknown;
  readonly published_at: unknown;
  readonly superseded_at: unknown;
  readonly previous_version_id: string | null;
  readonly idempotency_key: string;
  readonly origin: string;
}

/**
 * Exactly what `utcText` produces, and nothing else: six fractional digits, `T` and `Z` literal.
 *
 * Deliberately narrow. This pattern is the read half of a contract whose write half is the
 * projection a few lines above, and anything that does not match it did not come from that
 * projection.
 */
const STORED_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/;

/**
 * Decode a stored instant, or refuse.
 *
 * There is no fallback. An earlier revision ended with `new Date(value)`, which turned anything it
 * did not recognise into an approximation — silently discarding microseconds, and reading a
 * malformed value as *some* instant rather than as a problem. A wrong instant is worse than a
 * failed read here, because a wrong instant decides which version answered a question and leaves no
 * trace of having been wrong.
 *
 * So the three ways this can fail all raise `invalid-value`:
 *
 *   - not text at all — a `Date` means the projection was bypassed and precision is already lost;
 *   - text in another shape — `infinity`, `-infinity`, a bare date, a session-formatted timestamp;
 *   - text in the right shape that the calendar does not contain, which `instant.ts` catches.
 *
 * Trailing zeros are trimmed afterwards so one moment has one spelling. Comparison is canonical
 * regardless (see `instant.ts`), so that part is presentation rather than correctness.
 */
function instant(value: unknown, column: string): string {
  if (typeof value !== 'string') {
    throw new ConfigurationError(
      'invalid-value',
      `${column} came back as ${value instanceof Date ? 'a Date' : typeof value} rather than ` +
        'text. Timestamps are projected through to_char precisely so the driver never parses ' +
        'them into a Date, which holds milliseconds where the column holds microseconds — a ' +
        'value that arrived as a Date has already lost precision this adapter cannot recover',
    );
  }

  const match = STORED_INSTANT.exec(value);
  if (match === null) {
    throw new ConfigurationError(
      'invalid-value',
      `${column} holds "${value}", which is not a finite UTC timestamp in the projected form ` +
        'YYYY-MM-DDTHH:MM:SS.ffffffZ. Infinite and malformed stored timestamps are refused rather ' +
        'than approximated',
    );
  }

  // The calendar check as well as the shape check: `to_char` cannot emit 30 February, but this
  // decoder is the last point at which a stored value is trusted, and it does not assume the
  // value reached the column through this component.
  const [, year, month, day, hour, minute, second, fraction = ''] = match;
  parseInstant(value, column);

  const digits = fraction.replace(/0+$/, '');
  const suffix = digits === '' ? '' : `.${digits}`;
  return `${year}-${month}-${day}T${hour}:${minute}:${second}${suffix}Z`;
}

/** A nullable timestamp column. NULL means "not yet", and stays NULL. */
function optionalInstant(value: unknown, column: string): string | null {
  return value === null || value === undefined ? null : instant(value, column);
}

/** Store the kind alongside the text so the value survives the round trip unambiguously. */
export function encodeValue(value: ConfigurationValue): { kind: string; text: string } {
  if (typeof value === 'boolean') return { kind: 'boolean', text: value ? 'true' : 'false' };
  if (typeof value === 'number') return { kind: 'integer', text: String(value) };
  return { kind: 'string', text: value };
}

export function decodeValue(kind: string, text: string): ConfigurationValue {
  switch (kind) {
    case 'boolean':
      return text === 'true';
    case 'integer':
    case 'duration-seconds':
      return Number.parseInt(text, 10);
    case 'string':
    case 'enum':
      return text;
    default:
      throw new ConfigurationError('invalid-value', `unsupported stored value kind "${kind}"`);
  }
}

function toVersion(row: Row): ConfigurationVersion {
  return {
    versionId: row.version_id,
    key: row.config_key,
    scope: { level: row.scope_level as ScopeLevel, id: row.scope_id },
    value: decodeValue(row.value_kind, row.value_text),
    effectiveFrom: instant(row.effective_from, 'effective_from'),
    status: row.status as VersionStatus,
    createdAt: instant(row.created_at, 'created_at'),
    publishedAt: optionalInstant(row.published_at, 'published_at'),
    supersededAt: optionalInstant(row.superseded_at, 'superseded_at'),
    previousVersionId: row.previous_version_id,
    idempotencyKey: row.idempotency_key,
    origin: row.origin as PublicationOrigin,
  };
}

export class PostgresConfigurationRepository implements ConfigurationRepository {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  async withTransaction<T>(body: (tx: ConfigurationTransaction) => Promise<T>): Promise<T> {
    const client = await this.#database.connect();
    try {
      await client.query('BEGIN;');
      try {
        const result = await body(new PostgresTransaction(client));
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

class PostgresTransaction implements ConfigurationTransaction {
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

  /**
   * Run a mutation, translating the constraint violations this schema can produce.
   *
   * Only the writes go through here. A failing SELECT has no constraint to violate, so wrapping
   * reads would add a layer that could only ever pass its error straight through.
   */
  async #run<T>(operation: string, body: () => Promise<T>): Promise<T> {
    try {
      return await body();
    } catch (error) {
      throw normalizeDatabaseError(error, operation);
    }
  }

  async findVersionById(versionId: string): Promise<ConfigurationVersion | null> {
    const result = await this.#client.query<Row>(
      `SELECT ${PROJECTION} FROM ${CONFIG_TABLE} WHERE version_id = $1;`,
      [versionId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toVersion(row);
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<ConfigurationVersion | null> {
    const result = await this.#client.query<Row>(
      `SELECT ${PROJECTION} FROM ${CONFIG_TABLE} WHERE idempotency_key = $1;`,
      [idempotencyKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : toVersion(row);
  }

  async findVersions(
    key: string,
    scopes: readonly Scope[],
  ): Promise<readonly ConfigurationVersion[]> {
    if (scopes.length === 0) return [];
    const levels = scopes.map((scope) => scope.level);
    const ids = scopes.map((scope) => scope.id);

    // Pairs rather than a cross-product: (level, id) must match together, or a tenant id could
    // be matched against the region level.
    const result = await this.#client.query<Row>(
      `SELECT ${PROJECTION} FROM ${CONFIG_TABLE}
        WHERE config_key = $1
          AND (scope_level, scope_id) IN (SELECT * FROM unnest($2::text[], $3::text[]))
        ORDER BY config_version.effective_from ASC, version_id ASC;`,
      [key, levels, ids],
    );
    return result.rows.map(toVersion);
  }

  async insertDraft(version: ConfigurationVersion): Promise<void> {
    if (version.status !== 'draft') {
      throw new ConfigurationError(
        'immutable-version',
        `insertDraft was given a ${version.status} version — a version is created as a draft and ` +
          'activated separately, never inserted already active. Inserting an active row while the ' +
          'incumbent is still active is exactly what the partial unique index refuses',
      );
    }
    const encoded = encodeValue(version.value);
    await this.#run('insertDraft', () =>
      this.#client.query(
        `INSERT INTO ${CONFIG_TABLE} (${COLUMNS})
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14);`,
        [
          version.versionId,
          version.key,
          version.scope.level,
          version.scope.id,
          encoded.kind,
          encoded.text,
          version.effectiveFrom,
          version.status,
          version.createdAt,
          version.publishedAt,
          version.supersededAt,
          version.previousVersionId,
          version.idempotencyKey,
          version.origin,
        ],
      ),
    );
  }

  /**
   * Take the incumbent out of the partial unique index.
   *
   * `status = 'active'` in the predicate is the concurrency check: if another transaction
   * superseded this version first, zero rows change and this publication is refused rather than
   * overwriting the winner. This runs *before* the draft is activated, so the index is never asked
   * to hold two active rows for one key and scope.
   */
  async supersedeActiveVersion(versionId: string, supersededAt: string): Promise<void> {
    const result = await this.#run('supersedeActiveVersion', () =>
      this.#client.query(
        `UPDATE ${CONFIG_TABLE}
          SET status = 'superseded', superseded_at = $2
        WHERE version_id = $1 AND status = 'active';`,
        [versionId, supersededAt],
      ),
    );
    if (result.rowCount === 0) {
      throw new ConfigurationError(
        'concurrent-modification',
        `version ${versionId} was not active when this publication tried to supersede it — it ` +
          'changed underneath the transaction',
      );
    }
  }

  /**
   * Bring the replacement into the index, stamping when it was published and what it replaced.
   *
   * `status = 'draft'` in the predicate is the second half of the concurrency control: a draft
   * that someone else already activated changes zero rows here, and the loser is refused.
   */
  async activateDraft(
    draftId: string,
    publishedAt: string,
    previousVersionId: string | null,
  ): Promise<void> {
    const result = await this.#run('activateDraft', () =>
      this.#client.query(
        `UPDATE ${CONFIG_TABLE}
          SET status = 'active', published_at = $2, previous_version_id = $3
        WHERE version_id = $1 AND status = 'draft';`,
        [draftId, publishedAt, previousVersionId],
      ),
    );
    if (result.rowCount === 0) {
      throw new ConfigurationError(
        'concurrent-modification',
        `version ${draftId} was not a draft when this publication tried to activate it — it was ` +
          'activated or superseded underneath the transaction',
      );
    }
  }
}
