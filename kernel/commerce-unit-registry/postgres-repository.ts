/**
 * K-11 Commerce Unit Registry — the PostgreSQL adapter (FND-005c).
 *
 * Four properties this file exists to hold, none visible from the service:
 *
 *   - **Every instant is projected as UTC text** through `to_char`, never left to the driver's
 *     `Date` parser. K-05 lost microseconds that way (§11.13) and every component since projects.
 *   - **Decoding is fail-closed and runs the same validators the service runs.** A type row written
 *     around this adapter is refused rather than resolved: a malformed row that decoded cleanly
 *     would be a category nobody registered, copied into every listing created under it.
 *   - **No statement names another unit's schema, and there is no foreign key out of
 *     `kernel_commerce_unit_registry`.** Tenant handles are opaque, not joins — the isolation rule
 *     is enforced in the service and in the shape of the data, not by a key into K-03.
 *   - **The version in force is the end of the activation chain, not the newest row.** `ORDER BY
 *     activated_at DESC LIMIT 1` would be wrong: two activations can share an instant, and a clock
 *     is not a history. The query finds the activation nothing else supersedes — and if the store
 *     holds *two* such activations for one type, this adapter says so rather than picking one.
 *     `LIMIT 1` over an ambiguous chain is a coin toss reported as a fact, and the fact it reports
 *     is which definition described every listing created since.
 *
 * There is no `UPDATE` and no `DELETE` in this file. Not one. A type is referenced by every record
 * ever created under it, so the adapter has no statement that could rewrite one even if a caller
 * found a way to ask.
 *
 * Owned by: K-11 Commerce Unit Registry.
 */

import type { Database, DatabaseClient } from '../../platform/db/client.ts';
import { InvalidInstantError, parseInstant } from '../../platform/time/instant.ts';
import type { OutboxEntry } from '../../platform/outbox/types.ts';

import { sealActivation, sealRetirement, sealVersion } from './immutable.ts';
import type { CommerceUnitRepository, CommerceUnitTransaction } from './repository.ts';
import {
  CommerceUnitError,
  type CommerceUnitErrorCode,
  type UnitTypeActivation,
  type UnitTypeRetirement,
  type UnitTypeVersion,
} from './types.ts';
import {
  inStoredRow,
  validateActivation,
  validateRetirement,
  validateUnitTypeVersion,
} from './validate.ts';

export const COMMERCE_UNIT_SCHEMA = 'kernel_commerce_unit_registry';
export const VERSION_TABLE = `${COMMERCE_UNIT_SCHEMA}.commerce_unit_type_version`;
export const ACTIVATION_TABLE = `${COMMERCE_UNIT_SCHEMA}.commerce_unit_type_activation`;
export const RETIREMENT_TABLE = `${COMMERCE_UNIT_SCHEMA}.commerce_unit_type_retirement`;
export const OUTBOX_TABLE = `${COMMERCE_UNIT_SCHEMA}.outbox`;

const UNIQUE_VIOLATION = '23505';

const CONSTRAINT_MEANINGS: Readonly<
  Record<string, { readonly code: CommerceUnitErrorCode; readonly explanation: string }>
> = {
  commerce_unit_type_version_pkey: {
    code: 'duplicate-type-version',
    explanation: 'a type version with this id already exists, and a version is never rewritten',
  },
  commerce_unit_type_version_number_unique: {
    code: 'duplicate-type-version',
    explanation:
      'this version number has already been published for this type. Numbers order the history ' +
      'every listing created under it refers back to',
  },
  commerce_unit_type_version_idempotency_unique: {
    code: 'idempotency-key-reuse',
    explanation: 'this idempotency key has already published a type version',
  },
  commerce_unit_type_activation_pkey: {
    code: 'duplicate-activation',
    explanation: 'an activation with this id already exists',
  },
  commerce_unit_type_activation_idempotency_unique: {
    code: 'idempotency-key-reuse',
    explanation: 'this idempotency key has already recorded an activation',
  },
  commerce_unit_type_activation_supersedes_unique: {
    code: 'stale-activation',
    explanation:
      'another activation already superseded that version, so this one lost the race. Re-read ' +
      'the version in force and decide again rather than overwriting somebody else',
  },
  commerce_unit_type_activation_first_unique: {
    code: 'stale-activation',
    explanation:
      'this type already has a first activation, so an activation superseding nothing lost the race',
  },
  commerce_unit_type_retirement_pkey: {
    code: 'duplicate-retirement',
    explanation: 'a retirement with this id already exists',
  },
  commerce_unit_type_retirement_type_unique: {
    code: 'duplicate-retirement',
    explanation:
      'this type has already been retired, and the first record is when it actually stopped ' +
      'accepting listings',
  },
  commerce_unit_type_retirement_idempotency_unique: {
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
  if (error instanceof CommerceUnitError) return error;

  const detail = databaseErrorDetail(error);
  if (detail.code !== UNIQUE_VIOLATION) return error;

  const message = error instanceof Error ? error.message : String(error);
  const named =
    detail.constraint ??
    Object.keys(CONSTRAINT_MEANINGS).find((constraint) => message.includes(constraint));
  const meaning = named === undefined ? undefined : CONSTRAINT_MEANINGS[named];
  if (meaning === undefined) return error;

  return new CommerceUnitError(meaning.code, `${operation} was refused: ${meaning.explanation}`);
}

const VERSION_COLUMNS = [
  'type_version_id',
  'type_key',
  'version',
  'kind',
  'owner_kind',
  'owner_tenant_id',
  'parent_type_key',
  'measures',
  'risk_policy_key',
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
  'type_key',
  'type_version_id',
  'supersedes_version_id',
  'risk_policy_version_id',
  'activated_at',
  'activated_by_kind',
  'activated_by_id',
  'idempotency_key',
  'request_fingerprint',
] as const;

const RETIREMENT_COLUMNS = [
  'retirement_id',
  'type_key',
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
const OUTBOX_COLUMNS = OUTBOX_COLUMN_NAMES.join(', ');

/** Every `timestamptz` in this schema. All are projected as text; nothing parses one as a Date. */
export const TIMESTAMP_COLUMNS = [
  'effective_from',
  'effective_until',
  'published_at',
  'activated_at',
  'retired_at',
] as const;

function utcText(column: string, qualifier = ''): string {
  const reference = qualifier === '' ? column : `${qualifier}.${column}`;
  return `to_char(${reference} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${column}`;
}

const projectionOf = (columns: readonly string[], qualifier = ''): string =>
  columns
    .map((column) => {
      if ((TIMESTAMP_COLUMNS as readonly string[]).includes(column))
        return utcText(column, qualifier);
      return qualifier === '' ? column : `${qualifier}.${column}`;
    })
    .join(', ');

const VERSION_PROJECTION = projectionOf(VERSION_COLUMNS);
const ACTIVATION_PROJECTION = projectionOf(ACTIVATION_COLUMNS);
const RETIREMENT_PROJECTION = projectionOf(RETIREMENT_COLUMNS);

const STORED_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/;

function instant(value: unknown, column: string): string {
  if (typeof value !== 'string') {
    throw new CommerceUnitError(
      'malformed-record',
      `${column} came back as ${value instanceof Date ? 'a Date' : typeof value} rather than ` +
        'text. Timestamps are projected through to_char precisely so the driver never parses them',
    );
  }
  const match = STORED_INSTANT.exec(value);
  if (match === null) {
    throw new CommerceUnitError(
      'malformed-record',
      `${column} holds "${value}", which is not a finite UTC timestamp in the projected form`,
    );
  }
  try {
    parseInstant(value);
  } catch (error) {
    if (error instanceof InvalidInstantError) {
      throw new CommerceUnitError('malformed-record', `${column}: ${error.message}`);
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
    throw new CommerceUnitError(
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
    throw new CommerceUnitError(
      'malformed-record',
      `${column} came back as text rather than parsed JSON; the column type is not what 0012 creates`,
    );
  }
  return value;
}

/** Ownership is two columns because the isolation rule has to be a database `CHECK`, not a shape. */
function owner(row: Record<string, unknown>): unknown {
  return row.owner_kind === 'platform'
    ? { kind: 'platform' }
    : { kind: row.owner_kind, tenantId: row.owner_tenant_id };
}

export function toUnitTypeVersion(row: Record<string, unknown>): UnitTypeVersion {
  return inStoredRow(() =>
    sealVersion(
      validateUnitTypeVersion(
        {
          typeVersionId: text(row.type_version_id, 'type_version_id'),
          typeKey: text(row.type_key, 'type_key'),
          version: Number(row.version),
          kind: row.kind,
          owner: owner(row),
          parentTypeKey: optionalText(row.parent_type_key, 'parent_type_key'),
          measures: json(row.measures, 'measures'),
          riskPolicyKey: optionalText(row.risk_policy_key, 'risk_policy_key'),
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

export function toUnitTypeActivation(row: Record<string, unknown>): UnitTypeActivation {
  return inStoredRow(() =>
    sealActivation(
      validateActivation(
        {
          activationId: text(row.activation_id, 'activation_id'),
          typeKey: text(row.type_key, 'type_key'),
          typeVersionId: text(row.type_version_id, 'type_version_id'),
          supersedesVersionId: optionalText(row.supersedes_version_id, 'supersedes_version_id'),
          riskPolicyVersionId: optionalText(row.risk_policy_version_id, 'risk_policy_version_id'),
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

export function toUnitTypeRetirement(row: Record<string, unknown>): UnitTypeRetirement {
  return inStoredRow(() =>
    sealRetirement(
      validateRetirement(
        {
          retirementId: text(row.retirement_id, 'retirement_id'),
          typeKey: text(row.type_key, 'type_key'),
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

/**
 * An identifier read straight off a row, for a message about a row too broken to decode.
 *
 * A refusal that cannot name the rows it is refusing sends whoever reads it back to the table with
 * nothing to search for, so the id is quoted as it stands — including when what stands there is
 * not text.
 */
function rawIdentifier(value: unknown, column: string): string {
  if (typeof value === 'string' && value !== '') return value;
  return `<unreadable ${column}>`;
}

/**
 * Two activations at the end of one chain, which is a question with no answer.
 *
 * The two partial unique indexes in migration 0012 make this unreachable through the service: an
 * activation either supersedes a version nobody else has superseded, or is the one first
 * activation for the key. Reaching it means a row was written around them — a restored dump, a
 * hand-run `INSERT`, an index dropped during maintenance.
 *
 * `LIMIT 1` would resolve it by whichever row the plan happened to reach first. That is not a
 * repair: both activations name a version, both versions describe listings, and the adapter has no
 * basis whatsoever for preferring one. Refusing keeps the disagreement visible in the one place
 * that can still fix it — the store — instead of settling it silently on every read.
 */
function refuseAmbiguousChain(typeKey: string, activationIds: readonly string[]): never {
  throw new CommerceUnitError(
    'malformed-record',
    `${typeKey} has more than one activation that nothing supersedes ` +
      `(${activationIds.join(', ')}), so which version is in force has no answer. The partial ` +
      'unique indexes on the activation table make this impossible through this component, so ' +
      'the chain was written around it. Refusing rather than picking one: every listing created ' +
      'since names one of these versions, and choosing here would decide which, invisibly',
  );
}

const TRANSACTION_CONTROL =
  /^\s*(BEGIN|START\s+TRANSACTION|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE\s+SAVEPOINT)\b/i;

/**
 * A client that refuses transaction control and never releases the connection.
 *
 * An enlisted write belongs to the caller's transaction. A `COMMIT` from inside one would commit
 * rows its caller had not finished writing — here, a category activated while the catalogue import
 * that needed it never landed.
 */
export function enlistedClient(client: DatabaseClient): DatabaseClient {
  return {
    query<QueryRow = Record<string, unknown>>(sql: string, params?: readonly unknown[]) {
      if (TRANSACTION_CONTROL.test(sql)) {
        return Promise.reject(
          new CommerceUnitError(
            'nested-transaction',
            `an enlisted registry write may not issue "${sql.trim().split(/\s+/, 2).join(' ')}". ` +
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
 * A registry inside a transaction somebody else opened.
 *
 * What a future catalogue import would need: a type activated in the same transaction as whatever
 * created the listings that use it. No unit uses this yet.
 */
export class EnlistedCommerceUnitRepository implements CommerceUnitRepository {
  readonly #client: DatabaseClient;

  constructor(client: DatabaseClient) {
    this.#client = enlistedClient(client);
  }

  withTransaction<T>(body: (tx: CommerceUnitTransaction) => Promise<T>): Promise<T> {
    return body(new PostgresCommerceUnitTransaction(this.#client));
  }
}

export class PostgresCommerceUnitRepository implements CommerceUnitRepository {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  static enlist(client: DatabaseClient): CommerceUnitRepository {
    return new EnlistedCommerceUnitRepository(client);
  }

  async withTransaction<T>(body: (tx: CommerceUnitTransaction) => Promise<T>): Promise<T> {
    const client = await this.#database.connect();
    try {
      await client.query('BEGIN;');
      try {
        const result = await body(new PostgresCommerceUnitTransaction(client));
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

class PostgresCommerceUnitTransaction implements CommerceUnitTransaction {
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

  findVersionById(typeVersionId: string): Promise<UnitTypeVersion | null> {
    return this.#one(
      `SELECT ${VERSION_PROJECTION} FROM ${VERSION_TABLE} WHERE type_version_id = $1;`,
      [typeVersionId],
      toUnitTypeVersion,
    );
  }

  findVersionByIdempotencyKey(idempotencyKey: string): Promise<UnitTypeVersion | null> {
    return this.#one(
      `SELECT ${VERSION_PROJECTION} FROM ${VERSION_TABLE} WHERE idempotency_key = $1;`,
      [idempotencyKey],
      toUnitTypeVersion,
    );
  }

  async highestVersion(typeKey: string): Promise<number> {
    const result = await this.#client.query<{ highest: string | number | null }>(
      `SELECT coalesce(max(version), 0) AS highest FROM ${VERSION_TABLE} WHERE type_key = $1;`,
      [typeKey],
    );
    return Number(result.rows[0]?.highest ?? 0);
  }

  async insertVersion(version: UnitTypeVersion): Promise<void> {
    try {
      await this.#client.query(
        `INSERT INTO ${VERSION_TABLE} (${VERSION_COLUMNS.join(', ')})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14, $15, $16);`,
        [
          version.typeVersionId,
          version.typeKey,
          version.version,
          version.kind,
          version.owner.kind,
          version.owner.kind === 'tenant' ? version.owner.tenantId : null,
          version.parentTypeKey,
          JSON.stringify(version.measures),
          version.riskPolicyKey,
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
   * backwards, which is exactly when somebody most needs to know which version described a listing.
   *
   * `LIMIT 2` rather than `LIMIT 1`, and it is not a limit on the answer — it is one row more than
   * an answer is allowed to be. A well-formed chain has exactly one end, so a second row is the
   * store contradicting itself and is reported as that (`refuseAmbiguousChain`). The bound is kept
   * so a broken table cannot make this read drag an unbounded set back on a path every listing
   * read goes through.
   */
  async findCurrentActivation(typeKey: string): Promise<UnitTypeActivation | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${ACTIVATION_PROJECTION} FROM ${ACTIVATION_TABLE} current
        WHERE current.type_key = $1
          AND NOT EXISTS (
            SELECT 1 FROM ${ACTIVATION_TABLE} later
             WHERE later.type_key = current.type_key
               AND later.supersedes_version_id = current.type_version_id
          )
        ORDER BY current.activation_id
        LIMIT 2;`,
      [typeKey],
    );

    const [first, second] = result.rows;
    if (first === undefined) return null;
    if (second !== undefined) {
      refuseAmbiguousChain(
        typeKey,
        [first, second].map((row) => rawIdentifier(row.activation_id, 'activation_id')),
      );
    }
    return toUnitTypeActivation(first);
  }

  findActivationByIdempotencyKey(idempotencyKey: string): Promise<UnitTypeActivation | null> {
    return this.#one(
      `SELECT ${ACTIVATION_PROJECTION} FROM ${ACTIVATION_TABLE} WHERE idempotency_key = $1;`,
      [idempotencyKey],
      toUnitTypeActivation,
    );
  }

  async insertActivation(activation: UnitTypeActivation): Promise<void> {
    try {
      await this.#client.query(
        `INSERT INTO ${ACTIVATION_TABLE} (${ACTIVATION_COLUMNS.join(', ')})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10);`,
        [
          activation.activationId,
          activation.typeKey,
          activation.typeVersionId,
          activation.supersedesVersionId,
          activation.riskPolicyVersionId,
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

  findRetirement(typeKey: string): Promise<UnitTypeRetirement | null> {
    return this.#one(
      `SELECT ${RETIREMENT_PROJECTION} FROM ${RETIREMENT_TABLE} WHERE type_key = $1;`,
      [typeKey],
      toUnitTypeRetirement,
    );
  }

  findRetirementByIdempotencyKey(idempotencyKey: string): Promise<UnitTypeRetirement | null> {
    return this.#one(
      `SELECT ${RETIREMENT_PROJECTION} FROM ${RETIREMENT_TABLE} WHERE idempotency_key = $1;`,
      [idempotencyKey],
      toUnitTypeRetirement,
    );
  }

  async insertRetirement(retirement: UnitTypeRetirement): Promise<void> {
    try {
      await this.#client.query(
        `INSERT INTO ${RETIREMENT_TABLE} (${RETIREMENT_COLUMNS.join(', ')})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8);`,
        [
          retirement.retirementId,
          retirement.typeKey,
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

  /**
   * Every type with a version in force, in one round trip.
   *
   * Resolution walks a chain, and a chain walked one query per level is a query count nobody can
   * bound — this sits on the path of every listing read. Retired types are excluded here rather
   * than filtered afterwards, so a retired ancestor breaks a lineage rather than silently
   * remaining part of one.
   *
   * The three ways this set can be malformed are all refused rather than papered over, because the
   * service turns it into a map keyed by type key (`#inForceIndex`) and every one of them lands as
   * a *plausible* map with the wrong contents:
   *
   *   - **Two terminal activations for one key.** Both would be decoded, both written into the
   *     map, and the second would quietly win — an arbitrary choice of which version described
   *     every listing created since, made per read and reported as the answer.
   *   - **An activation whose version row is absent.** A plain `JOIN` drops that row, so the type
   *     reads as "never registered" and a lineage descending from it reads as `missing-parent`.
   *     A category that exists and cannot be read is not the same fact as one that does not exist,
   *     and the second is the one a caller would act on. So this is a `LEFT JOIN` and the absence
   *     is refused where it can still be seen.
   *   - **An activation and its version disagreeing about the type key.** The join is on the
   *     version id alone, deliberately: adding `AND definition.type_key = current.type_key` would
   *     turn a mismatch back into a dropped row, hiding it in the same way. Unrefused, the map
   *     files the entry under the *version's* key — so one type silently answers with another
   *     type's definition, and its own disappears.
   */
  async listInForce(): Promise<
    readonly { activation: UnitTypeActivation; version: UnitTypeVersion }[]
  > {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${projectionOf(ACTIVATION_COLUMNS, 'current')},
              ${VERSION_COLUMNS.map((column) =>
                (TIMESTAMP_COLUMNS as readonly string[]).includes(column)
                  ? utcText(column, 'definition').replace(` AS ${column}`, ` AS version_${column}`)
                  : `definition.${column} AS version_${column}`,
              ).join(', ')}
         FROM ${ACTIVATION_TABLE} current
         LEFT JOIN ${VERSION_TABLE} definition
           ON definition.type_version_id = current.type_version_id
        WHERE NOT EXISTS (
                SELECT 1 FROM ${ACTIVATION_TABLE} later
                 WHERE later.type_key = current.type_key
                   AND later.supersedes_version_id = current.type_version_id
              )
          AND NOT EXISTS (
                SELECT 1 FROM ${RETIREMENT_TABLE} retired
                 WHERE retired.type_key = current.type_key
              )
        ORDER BY current.type_key, current.activation_id;`,
      [],
    );

    // Ambiguity is a property of the whole result, not of a row, so it is settled before anything
    // is decoded. Otherwise which refusal a caller sees would depend on where in the set the
    // second terminal activation happened to sit.
    //
    // A row whose `type_key` is not text is left out of the grouping rather than counted under a
    // placeholder: two such rows are two separately broken activations, and reporting them as one
    // type with two ends would describe a fault that is not there. The decode below refuses them
    // by name.
    const terminalByKey = new Map<string, string[]>();
    for (const row of result.rows) {
      if (typeof row.type_key !== 'string' || row.type_key === '') continue;
      const found = terminalByKey.get(row.type_key);
      const activationId = rawIdentifier(row.activation_id, 'activation_id');
      if (found === undefined) terminalByKey.set(row.type_key, [activationId]);
      else found.push(activationId);
    }
    for (const [typeKey, activationIds] of terminalByKey) {
      if (activationIds.length > 1) refuseAmbiguousChain(typeKey, activationIds);
    }

    return Object.freeze(
      result.rows.map((row) => {
        const versionRow: Record<string, unknown> = {};
        for (const column of VERSION_COLUMNS) versionRow[column] = row[`version_${column}`];

        const activation = toUnitTypeActivation(row);

        if (versionRow.type_version_id === null || versionRow.type_version_id === undefined) {
          throw new CommerceUnitError(
            'malformed-record',
            `activation ${activation.activationId} puts ${activation.typeKey} in force on version ` +
              `${activation.typeVersionId}, and no such version row exists. A type in force whose ` +
              'definition cannot be read is not a type that was never registered, and reporting it ' +
              'as one would make every listing under it, and every type descending from it, ' +
              'unresolvable for a reason nobody could find',
          );
        }

        const version = toUnitTypeVersion(versionRow);
        if (version.typeKey !== activation.typeKey) {
          throw new CommerceUnitError(
            'malformed-record',
            `activation ${activation.activationId} puts ${activation.typeKey} in force on version ` +
              `${version.typeVersionId}, which is a version of ${version.typeKey}. An activation ` +
              'and the version it activates name one type or the row was not written by this ' +
              'component; taking it would answer for one category with a different category’s ' +
              'definition',
          );
        }

        return { activation, version };
      }),
    );
  }
}
