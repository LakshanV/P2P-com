/**
 * M-04 Universal Listing — slice A PostgreSQL adapter.
 *
 * Implements the persistence port against `module_universal_listing`. It knows SQL and nothing else:
 * no validation, no lifecycle, no referential check. Those live in the service, where they can be
 * tested without a server.
 *
 * Every `timestamptz` is projected as UTC text. JSON objects are stored as `jsonb` and read as
 * objects. Money is `bigint` minor units.
 *
 * No statement names another unit's schema, and there is no foreign key out of
 * `module_universal_listing`. The module's outbox table lives in the same schema.
 *
 * Owned by: M-04 Universal Listing.
 */

import { databaseErrorDetail } from '../../platform/db/client.ts';
import type { Database, DatabaseClient } from '../../platform/db/client.ts';
import type { OutboxEntry } from '../../platform/outbox/types.ts';

import {
  sealInventoryMovement,
  sealInventorySnapshot,
  sealListing,
  sealListingDeclaration,
  sealListingMedia,
  sealListingVersion,
} from './immutable.ts';
import type { UniversalListingRepository, UniversalListingTransaction } from './repository.ts';
import {
  UniversalListingError,
  type UniversalListingErrorCode,
  type InventoryMovement,
  type InventorySnapshot,
  type Listing,
  type ListingDeclaration,
  type ListingMedia,
  type ListingVersion,
} from './types.ts';
import {
  validateInventoryMovement,
  validateInventorySnapshot,
  validateListing,
  validateListingDeclaration,
  validateListingMedia,
  validateListingVersion,
} from './validate.ts';

export const UNIVERSAL_LISTING_SCHEMA = 'module_universal_listing';
export const LISTING_TABLE = `${UNIVERSAL_LISTING_SCHEMA}.listing`;
export const LISTING_VERSION_TABLE = `${UNIVERSAL_LISTING_SCHEMA}.listing_version`;
export const LISTING_MEDIA_TABLE = `${UNIVERSAL_LISTING_SCHEMA}.listing_media`;
export const LISTING_DECLARATION_TABLE = `${UNIVERSAL_LISTING_SCHEMA}.listing_declaration`;
export const INVENTORY_MOVEMENT_TABLE = `${UNIVERSAL_LISTING_SCHEMA}.inventory_movement`;
export const INVENTORY_SNAPSHOT_TABLE = `${UNIVERSAL_LISTING_SCHEMA}.inventory_snapshot`;
export const OUTBOX_TABLE = `${UNIVERSAL_LISTING_SCHEMA}.outbox`;

/** SQLSTATE 23505. The only driver code this adapter interprets. */
const UNIQUE_VIOLATION = '23505';

const CONSTRAINT_MEANINGS: Readonly<
  Record<string, { readonly code: UniversalListingErrorCode; readonly explanation: string }>
> = {
  listing_pkey: {
    code: 'duplicate-listing-id',
    explanation: 'a listing with this id already exists, and a listing is never overwritten',
  },
  listing_idempotency_unique: {
    code: 'idempotency-key-reuse',
    explanation: 'this idempotency key has already been used for a listing',
  },
  listing_version_pkey: {
    code: 'duplicate-version-id',
    explanation: 'a version with this id already exists, and a version is never rewritten',
  },
  listing_version_idempotency_unique: {
    code: 'idempotency-key-reuse',
    explanation: 'this idempotency key has already been used for a version',
  },
  listing_version_number_unique: {
    code: 'version-number-conflict',
    explanation: 'this listing already has a version with this number',
  },
  listing_media_pkey: {
    code: 'duplicate-media-id',
    explanation: 'a media row with this id already exists, and a media row is never rewritten',
  },
  listing_media_idempotency_unique: {
    code: 'idempotency-key-reuse',
    explanation: 'this idempotency key has already been used for a media row',
  },
  listing_media_position_unique: {
    code: 'duplicate-media-id',
    explanation: 'this version already has media at this position',
  },
  listing_declaration_pkey: {
    code: 'duplicate-declaration-id',
    explanation: 'a declaration with this id already exists, and a declaration is never rewritten',
  },
  listing_declaration_idempotency_unique: {
    code: 'idempotency-key-reuse',
    explanation: 'this idempotency key has already been used for a declaration',
  },
  inventory_movement_pkey: {
    code: 'duplicate-movement-id',
    explanation: 'a movement with this id already exists, and a movement is never rewritten',
  },
  inventory_movement_idempotency_unique: {
    code: 'idempotency-key-reuse',
    explanation: 'this idempotency key has already been used for a movement',
  },
  inventory_snapshot_pkey: {
    code: 'idempotency-key-reuse',
    explanation: 'this snapshot id already exists',
  },
  inventory_snapshot_on_hand_non_negative: {
    code: 'insufficient-stock',
    explanation: 'the movement would take onHand negative',
  },
  inventory_snapshot_reserved_non_negative: {
    code: 'insufficient-stock',
    explanation: 'the movement would take reserved negative',
  },
  inventory_snapshot_committed_non_negative: {
    code: 'insufficient-stock',
    explanation: 'the movement would take committed negative',
  },
  inventory_snapshot_reserved_lte_on_hand: {
    code: 'insufficient-stock',
    explanation: 'the movement would reserve more than is on hand',
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
  if (error instanceof UniversalListingError) return error;

  const detail = databaseErrorDetail(error);
  if (detail.code !== UNIQUE_VIOLATION) return error;

  const message = error instanceof Error ? error.message : String(error);
  const named =
    detail.constraint ??
    Object.keys(CONSTRAINT_MEANINGS).find((constraint) => message.includes(constraint));
  const meaning = named === undefined ? undefined : CONSTRAINT_MEANINGS[named];
  if (meaning === undefined) return error;

  return new UniversalListingError(
    meaning.code,
    `${operation} was refused: ${meaning.explanation}`,
  );
}

const LISTING_COLUMNS = [
  'listing_id',
  'account_id',
  'commerce_unit_type_id',
  'status',
  'current_version',
  'created_at',
  'updated_at',
  'published_at',
  'withdrawn_at',
  'correlation_id',
  'idempotency_key',
] as const;

const LISTING_VERSION_COLUMNS = [
  'version_id',
  'listing_id',
  'version_number',
  'title',
  'description',
  'unit_price_minor',
  'currency',
  'quantity_available',
  'inventory_mode',
  'attributes',
  'published_at',
  'correlation_id',
  'idempotency_key',
] as const;

const LISTING_MEDIA_COLUMNS = [
  'media_id',
  'listing_id',
  'version_id',
  'kind',
  'reference',
  'position',
  'caption',
  'added_at',
  'correlation_id',
  'idempotency_key',
] as const;

const LISTING_DECLARATION_COLUMNS = [
  'declaration_id',
  'listing_id',
  'version_id',
  'kind',
  'statement',
  'declared_at',
  'correlation_id',
  'idempotency_key',
] as const;

const INVENTORY_MOVEMENT_COLUMNS = [
  'movement_id',
  'listing_id',
  'version_id',
  'kind',
  'quantity',
  'reservation_id',
  'reason',
  'occurred_at',
  'correlation_id',
  'idempotency_key',
] as const;

const INVENTORY_SNAPSHOT_COLUMNS = [
  'listing_id',
  'version_id',
  'on_hand',
  'reserved',
  'committed',
  'updated_at',
  'correlation_id',
] as const;

function utcText(column: string): string {
  return `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${column}`;
}

const LISTING_PROJECTION = [
  'listing_id',
  'account_id',
  'commerce_unit_type_id',
  'status',
  'current_version',
  utcText('created_at'),
  utcText('updated_at'),
  utcText('published_at'),
  utcText('withdrawn_at'),
  'correlation_id',
  'idempotency_key',
].join(', ');

const LISTING_VERSION_PROJECTION = [
  'version_id',
  'listing_id',
  'version_number',
  'title',
  'description',
  'unit_price_minor',
  'currency',
  'quantity_available',
  'inventory_mode',
  'attributes',
  utcText('published_at'),
  'correlation_id',
  'idempotency_key',
].join(', ');

const LISTING_MEDIA_PROJECTION = [
  'media_id',
  'listing_id',
  'version_id',
  'kind',
  'reference',
  'position',
  'caption',
  utcText('added_at'),
  'correlation_id',
  'idempotency_key',
].join(', ');

const LISTING_DECLARATION_PROJECTION = [
  'declaration_id',
  'listing_id',
  'version_id',
  'kind',
  'statement',
  utcText('declared_at'),
  'correlation_id',
  'idempotency_key',
].join(', ');

const INVENTORY_MOVEMENT_PROJECTION = [
  'movement_id',
  'listing_id',
  'version_id',
  'kind',
  'quantity',
  'reservation_id',
  'reason',
  utcText('occurred_at'),
  'correlation_id',
  'idempotency_key',
].join(', ');

const INVENTORY_SNAPSHOT_PROJECTION = [
  'listing_id',
  'version_id',
  'on_hand',
  'reserved',
  'committed',
  utcText('updated_at'),
  'correlation_id',
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
    throw new UniversalListingError(
      'malformed-record',
      `${column} is ${value === null ? 'null' : typeof value}; expected non-empty text`,
    );
  }
  return value;
}

function optionalText(value: unknown, column: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new UniversalListingError(
      'malformed-record',
      `${column} is ${typeof value}; expected text or null`,
    );
  }
  return value === '' ? null : value;
}

function jsonObject(value: unknown, column: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new UniversalListingError(
      'malformed-record',
      `${column} is ${value === null ? 'null' : typeof value}; expected a JSON object`,
    );
  }
  return value as Record<string, unknown>;
}

export function toListing(row: Record<string, unknown>): Listing {
  return sealListing(
    validateListing(
      {
        listingId: text(row.listing_id, 'listing_id'),
        accountId: text(row.account_id, 'account_id'),
        commerceUnitTypeId: text(row.commerce_unit_type_id, 'commerce_unit_type_id'),
        status: text(row.status, 'status'),
        currentVersion: row.current_version,
        createdAt: text(row.created_at, 'created_at'),
        updatedAt: text(row.updated_at, 'updated_at'),
        publishedAt: optionalText(row.published_at, 'published_at'),
        withdrawnAt: optionalText(row.withdrawn_at, 'withdrawn_at'),
        correlationId: text(row.correlation_id, 'correlation_id'),
        idempotencyKey: text(row.idempotency_key, 'idempotency_key'),
      },
      'stored row',
    ),
  );
}

export function toListingVersion(row: Record<string, unknown>): ListingVersion {
  return sealListingVersion(
    validateListingVersion(
      {
        versionId: text(row.version_id, 'version_id'),
        listingId: text(row.listing_id, 'listing_id'),
        versionNumber: row.version_number,
        title: text(row.title, 'title'),
        description: text(row.description, 'description'),
        unitPriceMinor: row.unit_price_minor,
        currency: text(row.currency, 'currency'),
        quantityAvailable: row.quantity_available,
        inventoryMode: row.inventory_mode,
        attributes: jsonObject(row.attributes, 'attributes'),
        publishedAt: text(row.published_at, 'published_at'),
        correlationId: text(row.correlation_id, 'correlation_id'),
        idempotencyKey: text(row.idempotency_key, 'idempotency_key'),
      },
      'stored row',
    ),
  );
}

export function toListingMedia(row: Record<string, unknown>): ListingMedia {
  return sealListingMedia(
    validateListingMedia(
      {
        mediaId: text(row.media_id, 'media_id'),
        listingId: text(row.listing_id, 'listing_id'),
        versionId: text(row.version_id, 'version_id'),
        kind: text(row.kind, 'kind'),
        reference: text(row.reference, 'reference'),
        position: row.position,
        caption: text(row.caption, 'caption'),
        addedAt: text(row.added_at, 'added_at'),
        correlationId: text(row.correlation_id, 'correlation_id'),
        idempotencyKey: text(row.idempotency_key, 'idempotency_key'),
      },
      'stored row',
    ),
  );
}

export function toListingDeclaration(row: Record<string, unknown>): ListingDeclaration {
  return sealListingDeclaration(
    validateListingDeclaration(
      {
        declarationId: text(row.declaration_id, 'declaration_id'),
        listingId: text(row.listing_id, 'listing_id'),
        versionId: text(row.version_id, 'version_id'),
        kind: text(row.kind, 'kind'),
        statement: text(row.statement, 'statement'),
        declaredAt: text(row.declared_at, 'declared_at'),
        correlationId: text(row.correlation_id, 'correlation_id'),
        idempotencyKey: text(row.idempotency_key, 'idempotency_key'),
      },
      'stored row',
    ),
  );
}

function bigintValue(value: unknown, column: string): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'string') {
    if (!/^-?\d+$/.test(value)) {
      throw new UniversalListingError(
        'malformed-record',
        `${column} "${value}" is not an integer string`,
      );
    }
    return BigInt(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new UniversalListingError(
        'malformed-record',
        `${column} is ${value}; expected a safe integer`,
      );
    }
    return BigInt(value);
  }
  throw new UniversalListingError(
    'malformed-record',
    `${column} is ${value === null ? 'null' : typeof value}; expected an integer`,
  );
}

export function toInventoryMovement(row: Record<string, unknown>): InventoryMovement {
  return sealInventoryMovement(
    validateInventoryMovement(
      {
        movementId: text(row.movement_id, 'movement_id'),
        listingId: text(row.listing_id, 'listing_id'),
        versionId: text(row.version_id, 'version_id'),
        kind: text(row.kind, 'kind'),
        quantity: bigintValue(row.quantity, 'quantity'),
        reservationId: optionalText(row.reservation_id, 'reservation_id'),
        reason: text(row.reason, 'reason'),
        occurredAt: text(row.occurred_at, 'occurred_at'),
        correlationId: text(row.correlation_id, 'correlation_id'),
        idempotencyKey: text(row.idempotency_key, 'idempotency_key'),
      },
      'stored row',
    ),
  );
}

export function toInventorySnapshot(row: Record<string, unknown>): InventorySnapshot {
  return sealInventorySnapshot(
    validateInventorySnapshot(
      {
        listingId: text(row.listing_id, 'listing_id'),
        versionId: text(row.version_id, 'version_id'),
        onHand: bigintValue(row.on_hand, 'on_hand'),
        reserved: bigintValue(row.reserved, 'reserved'),
        committed: bigintValue(row.committed, 'committed'),
        updatedAt: text(row.updated_at, 'updated_at'),
        correlationId: text(row.correlation_id, 'correlation_id'),
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
          new UniversalListingError(
            'nested-transaction',
            `an enlisted universal-listing write may not issue "${sql.trim().split(/\s+/, 2).join(' ')}". ` +
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

export class EnlistedUniversalListingRepository implements UniversalListingRepository {
  readonly #client: DatabaseClient;

  constructor(client: DatabaseClient) {
    this.#client = enlistedClient(client);
  }

  withTransaction<T>(body: (tx: UniversalListingTransaction) => Promise<T>): Promise<T> {
    return body(new PostgresUniversalListingTransaction(this.#client));
  }
}

export class PostgresUniversalListingRepository implements UniversalListingRepository {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  static enlist(client: DatabaseClient): UniversalListingRepository {
    return new EnlistedUniversalListingRepository(client);
  }

  async withTransaction<T>(body: (tx: UniversalListingTransaction) => Promise<T>): Promise<T> {
    const client = await this.#database.connect();
    try {
      await client.query('BEGIN;');
      try {
        const result = await body(new PostgresUniversalListingTransaction(client));
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
  'created_at',
  'updated_at',
  'published_at',
  'withdrawn_at',
  'added_at',
  'declared_at',
  'occurred_at',
] as const;

class PostgresUniversalListingTransaction implements UniversalListingTransaction {
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

  async findListingById(listingId: string): Promise<Listing | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${LISTING_PROJECTION} FROM ${LISTING_TABLE} WHERE listing_id = $1;`,
      [listingId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toListing(row);
  }

  async findListingByIdempotencyKey(idempotencyKey: string): Promise<Listing | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${LISTING_PROJECTION} FROM ${LISTING_TABLE} WHERE idempotency_key = $1;`,
      [idempotencyKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : toListing(row);
  }

  async findListingsByAccountId(accountId: string): Promise<readonly Listing[]> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${LISTING_PROJECTION} FROM ${LISTING_TABLE}
       WHERE account_id = $1 ORDER BY created_at ASC, listing_id ASC;`,
      [accountId],
    );
    return Object.freeze(result.rows.map(toListing));
  }

  async insertListing(listing: Listing): Promise<void> {
    try {
      await this.#client.query(
        `INSERT INTO ${LISTING_TABLE} (${LISTING_COLUMNS.join(', ')})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11);`,
        [
          listing.listingId,
          listing.accountId,
          listing.commerceUnitTypeId,
          listing.status,
          listing.currentVersion,
          listing.createdAt,
          listing.updatedAt,
          listing.publishedAt,
          listing.withdrawnAt,
          listing.correlationId,
          listing.idempotencyKey,
        ],
      );
    } catch (error) {
      throw normalizeDatabaseError(error, 'insertListing');
    }
  }

  async updateListing(listing: Listing): Promise<void> {
    await this.#client.query(
      `UPDATE ${LISTING_TABLE}
       SET account_id = $1, commerce_unit_type_id = $2, status = $3, current_version = $4,
           created_at = $5, updated_at = $6, published_at = $7, withdrawn_at = $8,
           correlation_id = $9, idempotency_key = $10
       WHERE listing_id = $11;`,
      [
        listing.accountId,
        listing.commerceUnitTypeId,
        listing.status,
        listing.currentVersion,
        listing.createdAt,
        listing.updatedAt,
        listing.publishedAt,
        listing.withdrawnAt,
        listing.correlationId,
        listing.idempotencyKey,
        listing.listingId,
      ],
    );
  }

  async findVersionById(versionId: string): Promise<ListingVersion | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${LISTING_VERSION_PROJECTION} FROM ${LISTING_VERSION_TABLE} WHERE version_id = $1;`,
      [versionId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toListingVersion(row);
  }

  async findVersionByIdempotencyKey(idempotencyKey: string): Promise<ListingVersion | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${LISTING_VERSION_PROJECTION} FROM ${LISTING_VERSION_TABLE} WHERE idempotency_key = $1;`,
      [idempotencyKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : toListingVersion(row);
  }

  async findVersionsByListingId(listingId: string): Promise<readonly ListingVersion[]> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${LISTING_VERSION_PROJECTION} FROM ${LISTING_VERSION_TABLE}
       WHERE listing_id = $1 ORDER BY version_number ASC, version_id ASC;`,
      [listingId],
    );
    return Object.freeze(result.rows.map(toListingVersion));
  }

  async findVersionByListingAndNumber(
    listingId: string,
    versionNumber: number,
  ): Promise<ListingVersion | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${LISTING_VERSION_PROJECTION} FROM ${LISTING_VERSION_TABLE}
       WHERE listing_id = $1 AND version_number = $2;`,
      [listingId, versionNumber],
    );
    const row = result.rows[0];
    return row === undefined ? null : toListingVersion(row);
  }

  async insertVersion(version: ListingVersion): Promise<void> {
    try {
      await this.#client.query(
        `INSERT INTO ${LISTING_VERSION_TABLE} (${LISTING_VERSION_COLUMNS.join(', ')})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13);`,
        [
          version.versionId,
          version.listingId,
          version.versionNumber,
          version.title,
          version.description,
          version.unitPriceMinor,
          version.currency,
          version.quantityAvailable,
          version.inventoryMode,
          JSON.stringify(version.attributes),
          version.publishedAt,
          version.correlationId,
          version.idempotencyKey,
        ],
      );
    } catch (error) {
      throw normalizeDatabaseError(error, 'insertVersion');
    }
  }

  async findMediaById(mediaId: string): Promise<ListingMedia | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${LISTING_MEDIA_PROJECTION} FROM ${LISTING_MEDIA_TABLE} WHERE media_id = $1;`,
      [mediaId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toListingMedia(row);
  }

  async findMediaByIdempotencyKey(idempotencyKey: string): Promise<ListingMedia | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${LISTING_MEDIA_PROJECTION} FROM ${LISTING_MEDIA_TABLE} WHERE idempotency_key = $1;`,
      [idempotencyKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : toListingMedia(row);
  }

  async findMediaByVersionId(versionId: string): Promise<readonly ListingMedia[]> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${LISTING_MEDIA_PROJECTION} FROM ${LISTING_MEDIA_TABLE}
       WHERE version_id = $1 ORDER BY position ASC, media_id ASC;`,
      [versionId],
    );
    return Object.freeze(result.rows.map(toListingMedia));
  }

  async insertMedia(media: ListingMedia): Promise<void> {
    try {
      await this.#client.query(
        `INSERT INTO ${LISTING_MEDIA_TABLE} (${LISTING_MEDIA_COLUMNS.join(', ')})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10);`,
        [
          media.mediaId,
          media.listingId,
          media.versionId,
          media.kind,
          media.reference,
          media.position,
          media.caption,
          media.addedAt,
          media.correlationId,
          media.idempotencyKey,
        ],
      );
    } catch (error) {
      throw normalizeDatabaseError(error, 'insertMedia');
    }
  }

  async findDeclarationById(declarationId: string): Promise<ListingDeclaration | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${LISTING_DECLARATION_PROJECTION} FROM ${LISTING_DECLARATION_TABLE} WHERE declaration_id = $1;`,
      [declarationId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toListingDeclaration(row);
  }

  async findDeclarationByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<ListingDeclaration | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${LISTING_DECLARATION_PROJECTION} FROM ${LISTING_DECLARATION_TABLE} WHERE idempotency_key = $1;`,
      [idempotencyKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : toListingDeclaration(row);
  }

  async findDeclarationsByVersionId(versionId: string): Promise<readonly ListingDeclaration[]> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${LISTING_DECLARATION_PROJECTION} FROM ${LISTING_DECLARATION_TABLE}
       WHERE version_id = $1 ORDER BY declared_at ASC, declaration_id ASC;`,
      [versionId],
    );
    return Object.freeze(result.rows.map(toListingDeclaration));
  }

  async findDeclarationsByListingId(listingId: string): Promise<readonly ListingDeclaration[]> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${LISTING_DECLARATION_PROJECTION} FROM ${LISTING_DECLARATION_TABLE}
       WHERE listing_id = $1 ORDER BY declared_at ASC, declaration_id ASC;`,
      [listingId],
    );
    return Object.freeze(result.rows.map(toListingDeclaration));
  }

  async insertDeclaration(declaration: ListingDeclaration): Promise<void> {
    try {
      await this.#client.query(
        `INSERT INTO ${LISTING_DECLARATION_TABLE} (${LISTING_DECLARATION_COLUMNS.join(', ')})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8);`,
        [
          declaration.declarationId,
          declaration.listingId,
          declaration.versionId,
          declaration.kind,
          declaration.statement,
          declaration.declaredAt,
          declaration.correlationId,
          declaration.idempotencyKey,
        ],
      );
    } catch (error) {
      throw normalizeDatabaseError(error, 'insertDeclaration');
    }
  }

  async findInventoryMovementById(movementId: string): Promise<InventoryMovement | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${INVENTORY_MOVEMENT_PROJECTION} FROM ${INVENTORY_MOVEMENT_TABLE} WHERE movement_id = $1;`,
      [movementId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toInventoryMovement(row);
  }

  async findInventoryMovementByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<InventoryMovement | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${INVENTORY_MOVEMENT_PROJECTION} FROM ${INVENTORY_MOVEMENT_TABLE} WHERE idempotency_key = $1;`,
      [idempotencyKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : toInventoryMovement(row);
  }

  async findInventoryMovements(
    listingId: string,
    versionId: string,
  ): Promise<readonly InventoryMovement[]> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${INVENTORY_MOVEMENT_PROJECTION} FROM ${INVENTORY_MOVEMENT_TABLE}
       WHERE listing_id = $1 AND version_id = $2
       ORDER BY occurred_at ASC, movement_id ASC;`,
      [listingId, versionId],
    );
    return Object.freeze(result.rows.map(toInventoryMovement));
  }

  async insertInventoryMovement(movement: InventoryMovement): Promise<void> {
    try {
      await this.#client.query(
        `INSERT INTO ${INVENTORY_MOVEMENT_TABLE} (${INVENTORY_MOVEMENT_COLUMNS.join(', ')})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10);`,
        [
          movement.movementId,
          movement.listingId,
          movement.versionId,
          movement.kind,
          movement.quantity,
          movement.reservationId,
          movement.reason,
          movement.occurredAt,
          movement.correlationId,
          movement.idempotencyKey,
        ],
      );

      const deltaOnHand =
        movement.kind === 'receive' || movement.kind === 'adjust-up'
          ? movement.quantity
          : movement.kind === 'adjust-down' || movement.kind === 'commit'
            ? -movement.quantity
            : 0n;
      const deltaReserved =
        movement.kind === 'reserve'
          ? movement.quantity
          : movement.kind === 'release' || movement.kind === 'commit'
            ? -movement.quantity
            : 0n;
      const deltaCommitted = movement.kind === 'commit' ? movement.quantity : 0n;

      // The proposed row must itself satisfy the table's CHECK constraints, because PostgreSQL
      // evaluates them on the tuple built from VALUES *before* it resolves the conflict and reaches
      // DO UPDATE. So a delta-based upsert — `VALUES (0, 30, 0) ON CONFLICT DO UPDATE SET reserved
      // = reserved + 30` — cannot work here: the proposed row claims 30 reserved against 0 on hand,
      // and `reserved <= on_hand` refuses it before the update branch is ever considered. The whole
      // point of that constraint is that it refuses exactly this shape, so the statement is what has
      // to change.
      //
      // The deltas are therefore resolved to an **absolute** position in the SELECT, against the row
      // already there, and DO UPDATE simply takes it. One statement, one snapshot read, and a
      // proposed row that is valid whether it is inserted or merged.
      await this.#client.query(
        `INSERT INTO ${INVENTORY_SNAPSHOT_TABLE} (${INVENTORY_SNAPSHOT_COLUMNS.join(', ')})
         SELECT $1, $2,
                COALESCE(existing.on_hand, 0) + $3,
                COALESCE(existing.reserved, 0) + $4,
                COALESCE(existing.committed, 0) + $5,
                $6, $7
           FROM (SELECT 1) AS anchor
           LEFT JOIN ${INVENTORY_SNAPSHOT_TABLE} AS existing
             ON existing.listing_id = $1 AND existing.version_id = $2
         ON CONFLICT (listing_id, version_id) DO UPDATE SET
           on_hand = EXCLUDED.on_hand,
           reserved = EXCLUDED.reserved,
           committed = EXCLUDED.committed,
           updated_at = EXCLUDED.updated_at,
           correlation_id = EXCLUDED.correlation_id;`,
        [
          movement.listingId,
          movement.versionId,
          deltaOnHand,
          deltaReserved,
          deltaCommitted,
          movement.occurredAt,
          movement.correlationId,
        ],
      );
    } catch (error) {
      throw normalizeDatabaseError(error, 'insertInventoryMovement');
    }
  }

  async findInventorySnapshot(
    listingId: string,
    versionId: string,
  ): Promise<InventorySnapshot | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${INVENTORY_SNAPSHOT_PROJECTION} FROM ${INVENTORY_SNAPSHOT_TABLE}
       WHERE listing_id = $1 AND version_id = $2;`,
      [listingId, versionId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toInventorySnapshot(row);
  }

  async upsertInventorySnapshot(snapshot: InventorySnapshot): Promise<void> {
    await this.#client.query(
      `INSERT INTO ${INVENTORY_SNAPSHOT_TABLE} (${INVENTORY_SNAPSHOT_COLUMNS.join(', ')})
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (listing_id, version_id) DO UPDATE SET
         on_hand = $3,
         reserved = $4,
         committed = $5,
         updated_at = $6,
         correlation_id = $7;`,
      [
        snapshot.listingId,
        snapshot.versionId,
        snapshot.onHand,
        snapshot.reserved,
        snapshot.committed,
        snapshot.updatedAt,
        snapshot.correlationId,
      ],
    );
  }
}
