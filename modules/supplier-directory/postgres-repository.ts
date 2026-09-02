/**
 * M-48 — the PostgreSQL adapter.
 *
 * The interesting statement is `findProfiles`, and it is written as **one query**. The obvious
 * implementation — select the entries, then fetch each one's facets — costs a round trip per
 * supplier, and a sourcing rung that costs a round trip per candidate is a rung nobody will run.
 * So the facets are aggregated in the database and the gate is applied there too, which also means
 * a supplier with no matching category never crosses the wire.
 *
 * Every `timestamptz` is projected as UTC text through `to_char`. `daily_capacity` is a `bigint`
 * column and comes back as a digit string, which the validator accepts; it is never read through
 * `Number`.
 *
 * No statement names another unit's schema, and there is no foreign key out of
 * `module_supplier_directory`.
 *
 * Owned by: M-48 Supplier & Merchant Directory.
 */

import { databaseErrorDetail } from '../../platform/db/client.ts';
import type { Database, DatabaseClient } from '../../platform/db/client.ts';
import type { OutboxEntry } from '../../platform/outbox/types.ts';

import {
  sealDirectoryEvent,
  sealEntry,
  sealFacet,
  sealLocation,
  sealProfile,
} from './immutable.ts';
import type { DirectoryRepository, DirectoryTransaction } from './repository.ts';
import {
  DirectoryError,
  type DirectoryEntry,
  type DirectoryErrorCode,
  type DirectoryEvent,
  type DirectoryProfile,
  type DirectoryQuery,
  type SupplierFacet,
  type SupplierLocation,
} from './types.ts';
import {
  validateDirectoryEvent,
  validateEntry,
  validateFacet,
  validateLocation,
} from './validate.ts';

export const DIRECTORY_SCHEMA = 'module_supplier_directory';
export const ENTRY_TABLE = `${DIRECTORY_SCHEMA}.directory_entry`;
export const FACET_TABLE = `${DIRECTORY_SCHEMA}.supplier_facet`;
export const LOCATION_TABLE = `${DIRECTORY_SCHEMA}.supplier_location`;
export const EVENT_TABLE = `${DIRECTORY_SCHEMA}.directory_event`;
export const OUTBOX_TABLE = `${DIRECTORY_SCHEMA}.outbox`;

/** SQLSTATE 23505. The only driver code this adapter interprets. */
const UNIQUE_VIOLATION = '23505';

const CONSTRAINT_MEANINGS: Readonly<
  Record<string, { readonly code: DirectoryErrorCode; readonly explanation: string }>
> = {
  directory_entry_pkey: {
    code: 'duplicate-supplier-id',
    explanation: 'a directory entry with this id already exists',
  },
  directory_entry_account_unique: {
    code: 'already-registered',
    explanation:
      'this account already trades under a directory entry. One account, one entry: two would ' +
      'make "who supplies this" ambiguous for the same business',
  },
  directory_entry_idempotency_unique: {
    code: 'idempotency-key-reuse',
    explanation: 'this idempotency key has already been used for a directory entry',
  },
  supplier_facet_pkey: {
    code: 'duplicate-facet-id',
    explanation: 'a facet with this id already exists',
  },
  supplier_facet_once_per_value: {
    code: 'duplicate-facet-id',
    explanation:
      'this supplier already has a row for that claim. Declaring it again moves that row rather ' +
      'than adding a second, so the history is one row’s story',
  },
  supplier_location_pkey: {
    code: 'duplicate-location-id',
    explanation: 'a location with this id already exists',
  },
  supplier_location_idempotency_unique: {
    code: 'idempotency-key-reuse',
    explanation: 'this idempotency key has already been used for a location',
  },
  supplier_location_one_primary_idx: {
    code: 'primary-location-exists',
    explanation:
      'this supplier already has a primary location. Two would make "show the buyer the main one" ' +
      'a question with no answer',
  },
  directory_event_pkey: {
    code: 'malformed-record',
    explanation: 'a transition with this id has already been recorded',
  },
};

function normalizeDatabaseError(error: unknown): unknown {
  if (error instanceof DirectoryError) return error;

  const detail = databaseErrorDetail(error);
  if (detail.code !== UNIQUE_VIOLATION) return error;

  const message = error instanceof Error ? error.message : String(error);
  const named =
    detail.constraint ??
    Object.keys(CONSTRAINT_MEANINGS).find((constraint) => message.includes(constraint));
  const meaning = named === undefined ? undefined : CONSTRAINT_MEANINGS[named];
  if (meaning === undefined) return error;

  return new DirectoryError(meaning.code, meaning.explanation);
}

function utcText(column: string): string {
  return `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${column}`;
}

const ENTRY_PROJECTION = [
  'supplier_id',
  'account_id',
  'kind',
  'display_name',
  'status',
  'accepts_orders',
  'daily_capacity',
  utcText('registered_at'),
  utcText('updated_at'),
  utcText('closed_at'),
  'closure_reason',
  'correlation_id',
  'idempotency_key',
].join(', ');

/** The same columns, qualified for the join in `findProfiles`. */
const QUALIFIED_ENTRY_PROJECTION = [
  'e.supplier_id',
  'e.account_id',
  'e.kind',
  'e.display_name',
  'e.status',
  'e.accepts_orders',
  'e.daily_capacity',
  `to_char(e.registered_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS registered_at`,
  `to_char(e.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at`,
  `to_char(e.closed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS closed_at`,
  'e.closure_reason',
  'e.correlation_id',
  'e.idempotency_key',
].join(', ');

const FACET_PROJECTION = [
  'facet_id',
  'supplier_id',
  'facet_kind',
  'value',
  'status',
  utcText('declared_at'),
  utcText('withdrawn_at'),
  'correlation_id',
  'idempotency_key',
].join(', ');

const LOCATION_PROJECTION = [
  'location_id',
  'supplier_id',
  'name',
  'district',
  'is_primary',
  'status',
  utcText('opened_at'),
  utcText('closed_at'),
  'correlation_id',
  'idempotency_key',
].join(', ');

const EVENT_PROJECTION = [
  'event_id',
  'supplier_id',
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

function toEntry(row: Record<string, unknown>): DirectoryEntry {
  return sealEntry(
    validateEntry(
      {
        supplierId: row.supplier_id,
        accountId: row.account_id,
        kind: row.kind,
        displayName: row.display_name,
        status: row.status,
        acceptsOrders: row.accepts_orders,
        dailyCapacity: row.daily_capacity ?? null,
        registeredAt: row.registered_at,
        updatedAt: row.updated_at,
        closedAt: row.closed_at ?? null,
        closureReason: row.closure_reason ?? null,
        correlationId: row.correlation_id,
        idempotencyKey: row.idempotency_key,
      },
      'stored row',
    ),
  );
}

function toFacet(row: Record<string, unknown>): SupplierFacet {
  return sealFacet(
    validateFacet(
      {
        facetId: row.facet_id,
        supplierId: row.supplier_id,
        kind: row.facet_kind,
        value: row.value,
        status: row.status,
        declaredAt: row.declared_at,
        withdrawnAt: row.withdrawn_at ?? null,
        correlationId: row.correlation_id,
        idempotencyKey: row.idempotency_key,
      },
      'stored row',
    ),
  );
}

function toLocation(row: Record<string, unknown>): SupplierLocation {
  return sealLocation(
    validateLocation(
      {
        locationId: row.location_id,
        supplierId: row.supplier_id,
        name: row.name,
        district: row.district,
        primary: row.is_primary,
        status: row.status,
        openedAt: row.opened_at,
        closedAt: row.closed_at ?? null,
        correlationId: row.correlation_id,
        idempotencyKey: row.idempotency_key,
      },
      'stored row',
    ),
  );
}

function toDirectoryEvent(row: Record<string, unknown>): DirectoryEvent {
  return sealDirectoryEvent(
    validateDirectoryEvent(
      {
        eventId: row.event_id,
        supplierId: row.supplier_id,
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

/** An aggregated `text[]` column, which the driver returns as an array of strings. */
function codes(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((one): one is string => typeof one === 'string');
}

const TRANSACTION_CONTROL = /^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|START\s+TRANSACTION)\b/i;

export function enlistedClient(client: DatabaseClient): DatabaseClient {
  return {
    query<QueryRow = Record<string, unknown>>(sql: string, params?: readonly unknown[]) {
      if (TRANSACTION_CONTROL.test(sql)) {
        return Promise.reject(
          new DirectoryError(
            'malformed-record',
            `an enlisted directory write may not issue "${sql.trim().split(/\s+/, 2).join(' ')}". ` +
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

class PostgresDirectoryTransaction implements DirectoryTransaction {
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

  async findEntryById(supplierId: string): Promise<DirectoryEntry | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${ENTRY_PROJECTION} FROM ${ENTRY_TABLE} WHERE supplier_id = $1;`,
      [supplierId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toEntry(row);
  }

  async findEntryByAccountId(accountId: string): Promise<DirectoryEntry | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${ENTRY_PROJECTION} FROM ${ENTRY_TABLE} WHERE account_id = $1;`,
      [accountId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toEntry(row);
  }

  async findEntryByIdempotencyKey(idempotencyKey: string): Promise<DirectoryEntry | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${ENTRY_PROJECTION} FROM ${ENTRY_TABLE} WHERE idempotency_key = $1;`,
      [idempotencyKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : toEntry(row);
  }

  async insertEntry(entry: DirectoryEntry): Promise<void> {
    try {
      await this.#client.query(
        `INSERT INTO ${ENTRY_TABLE}
           (supplier_id, account_id, kind, display_name, status, accepts_orders, daily_capacity,
            registered_at, updated_at, closed_at, closure_reason, correlation_id, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13);`,
        [
          entry.supplierId,
          entry.accountId,
          entry.kind,
          entry.displayName,
          entry.status,
          entry.acceptsOrders,
          entry.dailyCapacity === null ? null : entry.dailyCapacity.toString(),
          entry.registeredAt,
          entry.updatedAt,
          entry.closedAt,
          entry.closureReason,
          entry.correlationId,
          entry.idempotencyKey,
        ],
      );
    } catch (error) {
      throw normalizeDatabaseError(error);
    }
  }

  /**
   * Change what can change.
   *
   * `account_id`, `kind` and `registered_at` are not in the SET list: a directory entry belongs to
   * one account for its whole life, and an entry that could change hands would make every past
   * invitation ambiguous about who was actually asked.
   */
  async updateEntry(entry: DirectoryEntry): Promise<void> {
    try {
      const result = await this.#client.query(
        `UPDATE ${ENTRY_TABLE}
            SET display_name = $2,
                status = $3,
                accepts_orders = $4,
                daily_capacity = $5,
                updated_at = $6,
                closed_at = $7,
                closure_reason = $8
          WHERE supplier_id = $1;`,
        [
          entry.supplierId,
          entry.displayName,
          entry.status,
          entry.acceptsOrders,
          entry.dailyCapacity === null ? null : entry.dailyCapacity.toString(),
          entry.updatedAt,
          entry.closedAt,
          entry.closureReason,
        ],
      );
      if (result.rowCount === 0) {
        throw new DirectoryError(
          'supplier-not-found',
          `supplier ${entry.supplierId} does not exist`,
        );
      }
    } catch (error) {
      throw normalizeDatabaseError(error);
    }
  }

  async findFacetById(facetId: string): Promise<SupplierFacet | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${FACET_PROJECTION} FROM ${FACET_TABLE} WHERE facet_id = $1;`,
      [facetId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toFacet(row);
  }

  async findFacet(supplierId: string, kind: string, value: string): Promise<SupplierFacet | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${FACET_PROJECTION} FROM ${FACET_TABLE}
       WHERE supplier_id = $1 AND facet_kind = $2 AND value = $3;`,
      [supplierId, kind, value],
    );
    const row = result.rows[0];
    return row === undefined ? null : toFacet(row);
  }

  async findFacetsBySupplier(supplierId: string): Promise<readonly SupplierFacet[]> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${FACET_PROJECTION} FROM ${FACET_TABLE}
       WHERE supplier_id = $1
       ORDER BY facet_kind, value;`,
      [supplierId],
    );
    return Object.freeze(result.rows.map(toFacet));
  }

  async insertFacet(facet: SupplierFacet): Promise<void> {
    try {
      await this.#client.query(
        `INSERT INTO ${FACET_TABLE}
           (facet_id, supplier_id, facet_kind, value, status, declared_at, withdrawn_at,
            correlation_id, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9);`,
        [
          facet.facetId,
          facet.supplierId,
          facet.kind,
          facet.value,
          facet.status,
          facet.declaredAt,
          facet.withdrawnAt,
          facet.correlationId,
          facet.idempotencyKey,
        ],
      );
    } catch (error) {
      throw normalizeDatabaseError(error);
    }
  }

  async updateFacet(facet: SupplierFacet): Promise<void> {
    try {
      const result = await this.#client.query(
        `UPDATE ${FACET_TABLE}
            SET status = $2, declared_at = $3, withdrawn_at = $4
          WHERE facet_id = $1;`,
        [facet.facetId, facet.status, facet.declaredAt, facet.withdrawnAt],
      );
      if (result.rowCount === 0) {
        throw new DirectoryError('facet-not-found', `facet ${facet.facetId} does not exist`);
      }
    } catch (error) {
      throw normalizeDatabaseError(error);
    }
  }

  async findLocationById(locationId: string): Promise<SupplierLocation | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${LOCATION_PROJECTION} FROM ${LOCATION_TABLE} WHERE location_id = $1;`,
      [locationId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toLocation(row);
  }

  async findLocationsBySupplier(supplierId: string): Promise<readonly SupplierLocation[]> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${LOCATION_PROJECTION} FROM ${LOCATION_TABLE}
       WHERE supplier_id = $1
       ORDER BY is_primary DESC, location_id;`,
      [supplierId],
    );
    return Object.freeze(result.rows.map(toLocation));
  }

  async insertLocation(location: SupplierLocation): Promise<void> {
    try {
      await this.#client.query(
        `INSERT INTO ${LOCATION_TABLE}
           (location_id, supplier_id, name, district, is_primary, status, opened_at, closed_at,
            correlation_id, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10);`,
        [
          location.locationId,
          location.supplierId,
          location.name,
          location.district,
          location.primary,
          location.status,
          location.openedAt,
          location.closedAt,
          location.correlationId,
          location.idempotencyKey,
        ],
      );
    } catch (error) {
      throw normalizeDatabaseError(error);
    }
  }

  async updateLocation(location: SupplierLocation): Promise<void> {
    try {
      const result = await this.#client.query(
        `UPDATE ${LOCATION_TABLE}
            SET name = $2, is_primary = $3, status = $4, closed_at = $5
          WHERE location_id = $1;`,
        [location.locationId, location.name, location.primary, location.status, location.closedAt],
      );
      if (result.rowCount === 0) {
        throw new DirectoryError(
          'location-not-found',
          `location ${location.locationId} does not exist`,
        );
      }
    } catch (error) {
      throw normalizeDatabaseError(error);
    }
  }

  async findEventsBySupplier(supplierId: string): Promise<readonly DirectoryEvent[]> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${EVENT_PROJECTION} FROM ${EVENT_TABLE}
       WHERE supplier_id = $1
       ORDER BY occurred_at, event_id;`,
      [supplierId],
    );
    return Object.freeze(result.rows.map(toDirectoryEvent));
  }

  async insertEvent(event: DirectoryEvent): Promise<void> {
    try {
      await this.#client.query(
        `INSERT INTO ${EVENT_TABLE}
           (event_id, supplier_id, from_status, to_status, reason, occurred_at, correlation_id,
            idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (event_id) DO NOTHING;`,
        [
          event.eventId,
          event.supplierId,
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

  /**
   * The directory query, as one statement.
   *
   * The gate is a `WHERE EXISTS` on an active category facet, so a supplier with nothing in common
   * never crosses the wire. The declared codes are aggregated per kind in the same pass, because a
   * rung scores on them and fetching them per row would cost a round trip per candidate.
   *
   * The district filter is deliberately **permissive**: a supplier who has declared no district has
   * not said where they serve, which is not the same as saying nowhere, so they stay in and the rung
   * scores geography rather than excluding on it.
   */
  async findProfiles(query: DirectoryQuery): Promise<readonly DirectoryProfile[]> {
    const districts = [...(query.districts ?? [])];
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${QUALIFIED_ENTRY_PROJECTION},
              coalesce(f.categories, ARRAY[]::text[])   AS categories,
              coalesce(f.brands, ARRAY[]::text[])       AS brands,
              coalesce(f.capabilities, ARRAY[]::text[]) AS capabilities,
              coalesce(f.districts, ARRAY[]::text[])    AS districts
         FROM ${ENTRY_TABLE} e
         LEFT JOIN (
                SELECT supplier_id,
                       array_agg(value ORDER BY value) FILTER (WHERE facet_kind = 'category')
                         AS categories,
                       array_agg(value ORDER BY value) FILTER (WHERE facet_kind = 'brand')
                         AS brands,
                       array_agg(value ORDER BY value) FILTER (WHERE facet_kind = 'capability')
                         AS capabilities,
                       array_agg(value ORDER BY value) FILTER (WHERE facet_kind = 'district')
                         AS districts
                  FROM ${FACET_TABLE}
                 WHERE status = 'active'
                 GROUP BY supplier_id
              ) f ON f.supplier_id = e.supplier_id
        WHERE e.status = $1
          AND ($2::boolean = false OR e.accepts_orders = true)
          AND ($3::text IS NULL OR e.kind = $3)
          -- The gate. A supplier with no category in common is not a weak match; they are excluded.
          AND EXISTS (
                SELECT 1 FROM ${FACET_TABLE} g
                 WHERE g.supplier_id = e.supplier_id
                   AND g.facet_kind = 'category'
                   AND g.status = 'active'
                   AND g.value = ANY($4::text[]))
          -- Permissive on geography: no declared district means "they have not said".
          AND (
                cardinality($5::text[]) = 0
             OR NOT EXISTS (
                    SELECT 1 FROM ${FACET_TABLE} d
                     WHERE d.supplier_id = e.supplier_id
                       AND d.facet_kind = 'district'
                       AND d.status = 'active')
             OR EXISTS (
                    SELECT 1 FROM ${FACET_TABLE} d
                     WHERE d.supplier_id = e.supplier_id
                       AND d.facet_kind = 'district'
                       AND d.status = 'active'
                       AND d.value = ANY($5::text[])))
        ORDER BY e.supplier_id
        LIMIT $6;`,
      [
        query.status ?? 'active',
        query.openOnly ?? true,
        query.kind ?? null,
        [...query.categories],
        districts,
        query.limit ?? 200,
      ],
    );

    return Object.freeze(
      result.rows.map((row) =>
        sealProfile({
          entry: toEntry(row),
          categories: codes(row.categories),
          brands: codes(row.brands),
          capabilities: codes(row.capabilities),
          districts: codes(row.districts),
        }),
      ),
    );
  }
}

/** M-48 enlisted in a transaction somebody else opened. */
export class EnlistedDirectoryRepository implements DirectoryRepository {
  readonly #client: DatabaseClient;

  constructor(client: DatabaseClient) {
    this.#client = enlistedClient(client);
  }

  withTransaction<T>(body: (tx: DirectoryTransaction) => Promise<T>): Promise<T> {
    return body(new PostgresDirectoryTransaction(this.#client));
  }
}

export class PostgresDirectoryRepository implements DirectoryRepository {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  static enlist(client: DatabaseClient): DirectoryRepository {
    return new EnlistedDirectoryRepository(client);
  }

  async withTransaction<T>(body: (tx: DirectoryTransaction) => Promise<T>): Promise<T> {
    const client = await this.#database.connect();
    try {
      await client.query('BEGIN;');
      try {
        const result = await body(new PostgresDirectoryTransaction(client));
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

export { toDirectoryEvent, toEntry, toFacet, toLocation };
