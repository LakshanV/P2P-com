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
 * Owned by: K-05 Configuration.
 */

import type { Database, DatabaseClient } from '../../platform/db/client.ts';
import type { ConfigurationRepository, ConfigurationTransaction } from './repository.ts';
import {
  ConfigurationError,
  type ConfigurationValue,
  type ConfigurationVersion,
  type PublicationOrigin,
  type Scope,
  type ScopeLevel,
  type VersionStatus,
} from './types.ts';

export const CONFIG_SCHEMA = 'kernel_configuration';
export const CONFIG_TABLE = `${CONFIG_SCHEMA}.config_version`;

const COLUMNS = [
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
].join(', ');

interface Row {
  readonly version_id: string;
  readonly config_key: string;
  readonly scope_level: string;
  readonly scope_id: string;
  readonly value_kind: string;
  readonly value_text: string;
  readonly effective_from: Date | string;
  readonly status: string;
  readonly created_at: Date | string;
  readonly published_at: Date | string | null;
  readonly superseded_at: Date | string | null;
  readonly previous_version_id: string | null;
  readonly idempotency_key: string;
  readonly origin: string;
}

/** Instants are compared as strings everywhere above this layer, so normalise on the way out. */
function instant(value: Date | string): string {
  return (value instanceof Date ? value.toISOString() : new Date(value).toISOString()).replace(
    /\.000Z$/,
    'Z',
  );
}

function optionalInstant(value: Date | string | null): string | null {
  return value === null ? null : instant(value);
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
    effectiveFrom: instant(row.effective_from),
    status: row.status as VersionStatus,
    createdAt: instant(row.created_at),
    publishedAt: optionalInstant(row.published_at),
    supersededAt: optionalInstant(row.superseded_at),
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

class PostgresTransaction implements ConfigurationTransaction {
  readonly #client: DatabaseClient;

  constructor(client: DatabaseClient) {
    this.#client = client;
  }

  async findVersionById(versionId: string): Promise<ConfigurationVersion | null> {
    const result = await this.#client.query<Row>(
      `SELECT ${COLUMNS} FROM ${CONFIG_TABLE} WHERE version_id = $1;`,
      [versionId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toVersion(row);
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<ConfigurationVersion | null> {
    const result = await this.#client.query<Row>(
      `SELECT ${COLUMNS} FROM ${CONFIG_TABLE} WHERE idempotency_key = $1;`,
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
      `SELECT ${COLUMNS} FROM ${CONFIG_TABLE}
        WHERE config_key = $1
          AND (scope_level, scope_id) IN (SELECT * FROM unnest($2::text[], $3::text[]))
        ORDER BY effective_from ASC, version_id ASC;`,
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
    await this.#client.query(
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
    const result = await this.#client.query(
      `UPDATE ${CONFIG_TABLE}
          SET status = 'superseded', superseded_at = $2
        WHERE version_id = $1 AND status = 'active';`,
      [versionId, supersededAt],
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
    const result = await this.#client.query(
      `UPDATE ${CONFIG_TABLE}
          SET status = 'active', published_at = $2, previous_version_id = $3
        WHERE version_id = $1 AND status = 'draft';`,
      [draftId, publishedAt, previousVersionId],
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
