/**
 * M-04 Universal Listing — slice A persistence port.
 *
 * The service is written against this interface. The port exposes listing lookup, creation and
 * lifecycle updates, append-only version storage, append-only media storage, append-only declaration
 * storage, and the outbox insert every producing module must support.
 *
 * Owned by: M-04 Universal Listing.
 */

import { InMemoryOutboxStore } from '../../platform/outbox/repository.ts';
import type { OutboxEntry, OutboxTransaction } from '../../platform/outbox/types.ts';

import {
  sealInventoryMovement,
  sealInventoryMovements,
  sealInventorySnapshot,
  sealListing,
  sealListingDeclaration,
  sealListingDeclarations,
  sealListingMedia,
  sealListingMedias,
  sealListingVersion,
  sealListingVersions,
  sealListings,
} from './immutable.ts';
import {
  UniversalListingError,
  type InventoryMovement,
  type InventorySnapshot,
  type Listing,
  type ListingDeclaration,
  type ListingMedia,
  type ListingVersion,
} from './types.ts';

export interface UniversalListingTransaction extends OutboxTransaction {
  /** Listing lookup and creation. */
  findListingById(listingId: string): Promise<Listing | null>;
  findListingByIdempotencyKey(idempotencyKey: string): Promise<Listing | null>;
  findListingsByAccountId(accountId: string): Promise<readonly Listing[]>;
  insertListing(listing: Listing): Promise<void>;
  updateListing(listing: Listing): Promise<void>;

  /** Version lookup and creation. */
  findVersionById(versionId: string): Promise<ListingVersion | null>;
  findVersionByIdempotencyKey(idempotencyKey: string): Promise<ListingVersion | null>;
  findVersionsByListingId(listingId: string): Promise<readonly ListingVersion[]>;
  findVersionByListingAndNumber(
    listingId: string,
    versionNumber: number,
  ): Promise<ListingVersion | null>;
  insertVersion(version: ListingVersion): Promise<void>;

  /** Media lookup and creation. */
  findMediaById(mediaId: string): Promise<ListingMedia | null>;
  findMediaByIdempotencyKey(idempotencyKey: string): Promise<ListingMedia | null>;
  findMediaByVersionId(versionId: string): Promise<readonly ListingMedia[]>;
  insertMedia(media: ListingMedia): Promise<void>;

  /** Declaration lookup and creation. */
  findDeclarationById(declarationId: string): Promise<ListingDeclaration | null>;
  findDeclarationByIdempotencyKey(idempotencyKey: string): Promise<ListingDeclaration | null>;
  findDeclarationsByVersionId(versionId: string): Promise<readonly ListingDeclaration[]>;
  findDeclarationsByListingId(listingId: string): Promise<readonly ListingDeclaration[]>;
  insertDeclaration(declaration: ListingDeclaration): Promise<void>;

  /** Inventory movement lookup and creation. */
  findInventoryMovementById(movementId: string): Promise<InventoryMovement | null>;
  findInventoryMovementByIdempotencyKey(idempotencyKey: string): Promise<InventoryMovement | null>;
  findInventoryMovements(
    listingId: string,
    versionId: string,
  ): Promise<readonly InventoryMovement[]>;
  insertInventoryMovement(movement: InventoryMovement): Promise<void>;

  /** Inventory snapshot lookup and creation. */
  findInventorySnapshot(listingId: string, versionId: string): Promise<InventorySnapshot | null>;
  upsertInventorySnapshot(snapshot: InventorySnapshot): Promise<void>;
}

export interface UniversalListingRepository {
  /**
   * Run `body` in one transaction. An exception must roll everything back — a caller that sees a
   * failure must be able to assume nothing was written, including a half-written listing, version,
   * media or declaration.
   */
  withTransaction<T>(body: (tx: UniversalListingTransaction) => Promise<T>): Promise<T>;
}

/**
 * An in-memory repository.
 *
 * The reference implementation of the port's contract. It enforces the same uniqueness rules the
 * database does, and checks them **at commit against the store as it stands** rather than against
 * the snapshot the transaction read.
 */
export class InMemoryUniversalListingRepository implements UniversalListingRepository {
  #listings: Listing[] = [];
  #versions: ListingVersion[] = [];
  #medias: ListingMedia[] = [];
  #declarations: ListingDeclaration[] = [];
  #movements: InventoryMovement[] = [];
  #snapshots: InventorySnapshot[] = [];
  readonly #outbox = new InMemoryOutboxStore('M-04', 'module_universal_listing');
  transactionsCommitted = 0;
  transactionsRolledBack = 0;

  listings(): readonly Listing[] {
    return sealListings(this.#listings);
  }

  versions(): readonly ListingVersion[] {
    return sealListingVersions(this.#versions);
  }

  medias(): readonly ListingMedia[] {
    return sealListingMedias(this.#medias);
  }

  declarations(): readonly ListingDeclaration[] {
    return sealListingDeclarations(this.#declarations);
  }

  movements(): readonly InventoryMovement[] {
    return sealInventoryMovements(this.#movements);
  }

  snapshots(): readonly InventorySnapshot[] {
    return Object.freeze(this.#snapshots.map(sealInventorySnapshot));
  }

  outbox(): InMemoryOutboxStore {
    return this.#outbox;
  }

  /** Seed state directly, for tests that need a starting point without going through the service. */
  seed(state: {
    readonly listings?: readonly Listing[];
    readonly versions?: readonly ListingVersion[];
    readonly medias?: readonly ListingMedia[];
    readonly declarations?: readonly ListingDeclaration[];
    readonly movements?: readonly InventoryMovement[];
    readonly snapshots?: readonly InventorySnapshot[];
    readonly outbox?: readonly OutboxEntry[];
  }): void {
    this.#listings = (state.listings ?? []).map(sealListing);
    this.#versions = (state.versions ?? []).map(sealListingVersion);
    this.#medias = (state.medias ?? []).map(sealListingMedia);
    this.#declarations = (state.declarations ?? []).map(sealListingDeclaration);
    this.#movements = (state.movements ?? []).map(sealInventoryMovement);
    this.#snapshots = (state.snapshots ?? []).map(sealInventorySnapshot);
    this.#outbox.seed(state.outbox ?? []);
  }

  async withTransaction<T>(body: (tx: UniversalListingTransaction) => Promise<T>): Promise<T> {
    const working = new WorkingSet({
      listings: this.#listings.map(sealListing),
      versions: this.#versions.map(sealListingVersion),
      medias: this.#medias.map(sealListingMedia),
      declarations: this.#declarations.map(sealListingDeclaration),
      movements: this.#movements.map(sealInventoryMovement),
      snapshots: this.#snapshots.map(sealInventorySnapshot),
    });
    const outboxWorking = new InMemoryOutboxStore(this.#outbox.name, this.#outbox.schema);
    outboxWorking.seed(this.#outbox.entries());

    const touched = new Touched();
    const tx = new InMemoryUniversalListingTransaction(working, outboxWorking, touched);

    try {
      const result = await body(tx);
      this.#commit(working, touched);
      this.#outbox.seed(outboxWorking.entries());
      this.transactionsCommitted += 1;
      return result;
    } catch (error) {
      this.transactionsRolledBack += 1;
      throw error;
    }
  }

  #commit(working: WorkingSet, touched: Touched): void {
    // Listings: idempotency-key conflicts come first, then listing-id conflicts.
    for (const listing of working.listings) {
      if (touched.listingKeys.has(listing.idempotencyKey)) {
        const holder = this.#listings.find(
          (held) => held.idempotencyKey === listing.idempotencyKey,
        );
        if (holder !== undefined && holder.listingId !== listing.listingId) {
          throw new UniversalListingError(
            'idempotency-key-reuse',
            `idempotency key "${listing.idempotencyKey}" was used by listing ` +
              `${holder.listingId}, created by another transaction while this one was open`,
          );
        }
      }
      if (touched.listings.has(listing.listingId)) {
        if (this.#listings.some((held) => held.listingId === listing.listingId)) {
          throw new UniversalListingError(
            'duplicate-listing-id',
            `listing ${listing.listingId} was created by another transaction while ` +
              'this one was open',
          );
        }
      }
    }

    // Listing updates: a touched listing id may already exist in the store.
    for (const listing of working.listings) {
      if (touched.listingUpdates.has(listing.listingId)) {
        this.#listings = this.#listings.map((held) =>
          held.listingId === listing.listingId ? sealListing(listing) : held,
        );
      }
    }

    this.#listings = [
      ...this.#listings,
      ...working.listings.filter((l) => touched.listings.has(l.listingId)).map(sealListing),
    ];

    // Versions are append-only and version numbers are unique per listing.
    for (const version of working.versions) {
      if (touched.versions.has(version.versionId)) {
        if (this.#versions.some((held) => held.versionId === version.versionId)) {
          throw new UniversalListingError(
            'duplicate-version-id',
            `version ${version.versionId} was created by another transaction while ` +
              'this one was open',
          );
        }
      }
      if (touched.versionKeys.has(version.idempotencyKey)) {
        const holder = this.#versions.find(
          (held) => held.idempotencyKey === version.idempotencyKey,
        );
        if (holder !== undefined) {
          throw new UniversalListingError(
            'idempotency-key-reuse',
            `idempotency key "${version.idempotencyKey}" was used by version ${holder.versionId}, ` +
              'created by another transaction while this one was open',
          );
        }
      }
      const versionKey = `${version.listingId}:${version.versionNumber}`;
      if (touched.versionNumbers.has(versionKey)) {
        const holder = this.#versions.find(
          (held) =>
            held.listingId === version.listingId && held.versionNumber === version.versionNumber,
        );
        if (holder !== undefined && holder.versionId !== version.versionId) {
          throw new UniversalListingError(
            'version-number-conflict',
            `listing ${version.listingId} already has version ${version.versionNumber}: ` +
              holder.versionId,
          );
        }
      }
    }

    this.#versions = [
      ...this.#versions,
      ...working.versions.filter((v) => touched.versions.has(v.versionId)).map(sealListingVersion),
    ];

    // Media is append-only and positions are unique per version.
    for (const media of working.medias) {
      if (touched.medias.has(media.mediaId)) {
        if (this.#medias.some((held) => held.mediaId === media.mediaId)) {
          throw new UniversalListingError(
            'duplicate-media-id',
            `media ${media.mediaId} was created by another transaction while ` +
              'this one was open',
          );
        }
      }
      if (touched.mediaKeys.has(media.idempotencyKey)) {
        const holder = this.#medias.find((held) => held.idempotencyKey === media.idempotencyKey);
        if (holder !== undefined) {
          throw new UniversalListingError(
            'idempotency-key-reuse',
            `idempotency key "${media.idempotencyKey}" was used by media ${holder.mediaId}, ` +
              'created by another transaction while this one was open',
          );
        }
      }
      const positionKey = `${media.versionId}:${media.position}`;
      if (touched.mediaPositions.has(positionKey)) {
        const holder = this.#medias.find(
          (held) => held.versionId === media.versionId && held.position === media.position,
        );
        if (holder !== undefined && holder.mediaId !== media.mediaId) {
          throw new UniversalListingError(
            'duplicate-media-id',
            `version ${media.versionId} already has media at position ${media.position}: ` +
              holder.mediaId,
          );
        }
      }
    }

    this.#medias = [
      ...this.#medias,
      ...working.medias.filter((m) => touched.medias.has(m.mediaId)).map(sealListingMedia),
    ];

    // Declarations are append-only.
    for (const declaration of working.declarations) {
      if (touched.declarations.has(declaration.declarationId)) {
        if (this.#declarations.some((held) => held.declarationId === declaration.declarationId)) {
          throw new UniversalListingError(
            'duplicate-declaration-id',
            `declaration ${declaration.declarationId} was created by another transaction while ` +
              'this one was open',
          );
        }
      }
      if (touched.declarationKeys.has(declaration.idempotencyKey)) {
        const holder = this.#declarations.find(
          (held) => held.idempotencyKey === declaration.idempotencyKey,
        );
        if (holder !== undefined) {
          throw new UniversalListingError(
            'idempotency-key-reuse',
            `idempotency key "${declaration.idempotencyKey}" was used by declaration ` +
              `${holder.declarationId}, created by another transaction while this one was open`,
          );
        }
      }
    }

    this.#declarations = [
      ...this.#declarations,
      ...working.declarations
        .filter((d) => touched.declarations.has(d.declarationId))
        .map(sealListingDeclaration),
    ];

    // Inventory movements are append-only. Recompute every touched snapshot from the store plus the
    // working set so a race cannot violate the invariant.
    for (const movement of working.movements) {
      if (touched.movements.has(movement.movementId)) {
        if (this.#movements.some((held) => held.movementId === movement.movementId)) {
          throw new UniversalListingError(
            'duplicate-movement-id',
            `movement ${movement.movementId} was created by another transaction while ` +
              'this one was open',
          );
        }
      }
      if (touched.movementKeys.has(movement.idempotencyKey)) {
        const holder = this.#movements.find(
          (held) => held.idempotencyKey === movement.idempotencyKey,
        );
        if (holder !== undefined) {
          throw new UniversalListingError(
            'idempotency-key-reuse',
            `idempotency key "${movement.idempotencyKey}" was used by movement ${holder.movementId}, ` +
              'created by another transaction while this one was open',
          );
        }
      }
    }

    const recomputedSnapshots = new Map<string, InventorySnapshot>();
    for (const key of touched.snapshotKeys) {
      const [listingId, versionId] = key.split(':') as [string, string];
      const allMovements = [
        ...this.#movements.filter((m) => m.listingId === listingId && m.versionId === versionId),
        ...working.movements.filter(
          (m) =>
            touched.movements.has(m.movementId) &&
            m.listingId === listingId &&
            m.versionId === versionId,
        ),
      ].sort(compareMovementOrder);
      const snapshot = computeInventorySnapshot(listingId, versionId, allMovements);
      if (snapshot.onHand < 0n || snapshot.reserved < 0n || snapshot.committed < 0n) {
        throw new UniversalListingError(
          'insufficient-stock',
          `movement would take listing ${listingId} version ${versionId} negative`,
        );
      }
      if (snapshot.reserved > snapshot.onHand) {
        throw new UniversalListingError(
          'insufficient-stock',
          `movement would reserve more than is available for listing ${listingId} version ${versionId}`,
        );
      }
      recomputedSnapshots.set(key, snapshot);
    }

    this.#movements = [
      ...this.#movements,
      ...working.movements
        .filter((m) => touched.movements.has(m.movementId))
        .map(sealInventoryMovement),
    ];

    for (const [key, snapshot] of recomputedSnapshots) {
      const [listingId, versionId] = key.split(':') as [string, string];
      const existingIndex = this.#snapshots.findIndex(
        (s) => s.listingId === listingId && s.versionId === versionId,
      );
      if (existingIndex === -1) {
        this.#snapshots.push(sealInventorySnapshot(snapshot));
      } else {
        this.#snapshots[existingIndex] = sealInventorySnapshot(snapshot);
      }
    }
  }
}

function compareMovementOrder(a: InventoryMovement, b: InventoryMovement): number {
  return a.occurredAt.localeCompare(b.occurredAt) || a.movementId.localeCompare(b.movementId);
}

function computeInventorySnapshot(
  listingId: string,
  versionId: string,
  movements: readonly InventoryMovement[],
): InventorySnapshot {
  let onHand = 0n;
  let reserved = 0n;
  let committed = 0n;
  let updatedAt = '';
  let correlationId = '';

  for (const movement of movements) {
    switch (movement.kind) {
      case 'receive':
        onHand += movement.quantity;
        break;
      case 'adjust-up':
        onHand += movement.quantity;
        break;
      case 'adjust-down':
        onHand -= movement.quantity;
        break;
      case 'reserve':
        reserved += movement.quantity;
        break;
      case 'release':
        reserved -= movement.quantity;
        break;
      case 'commit':
        onHand -= movement.quantity;
        reserved -= movement.quantity;
        committed += movement.quantity;
        break;
    }
    updatedAt = movement.occurredAt;
    correlationId = movement.correlationId;
  }

  return {
    listingId,
    versionId,
    onHand,
    reserved,
    committed,
    updatedAt,
    correlationId,
  };
}

class WorkingSet {
  listings: Listing[];
  versions: ListingVersion[];
  medias: ListingMedia[];
  declarations: ListingDeclaration[];
  movements: InventoryMovement[];
  snapshots: InventorySnapshot[];

  constructor(snapshot: {
    listings: Listing[];
    versions: ListingVersion[];
    medias: ListingMedia[];
    declarations: ListingDeclaration[];
    movements: InventoryMovement[];
    snapshots: InventorySnapshot[];
  }) {
    this.listings = snapshot.listings;
    this.versions = snapshot.versions;
    this.medias = snapshot.medias;
    this.declarations = snapshot.declarations;
    this.movements = snapshot.movements;
    this.snapshots = snapshot.snapshots;
  }
}

class Touched {
  readonly listings = new Set<string>();
  readonly listingKeys = new Set<string>();
  readonly listingUpdates = new Set<string>();
  readonly versions = new Set<string>();
  readonly versionKeys = new Set<string>();
  readonly versionNumbers = new Set<string>();
  readonly medias = new Set<string>();
  readonly mediaKeys = new Set<string>();
  readonly mediaPositions = new Set<string>();
  readonly declarations = new Set<string>();
  readonly declarationKeys = new Set<string>();
  readonly movements = new Set<string>();
  readonly movementKeys = new Set<string>();
  readonly snapshotKeys = new Set<string>();
}

class InMemoryUniversalListingTransaction implements UniversalListingTransaction {
  readonly #state: WorkingSet;
  readonly #outbox: InMemoryOutboxStore;
  readonly #touched: Touched;

  constructor(state: WorkingSet, outbox: InMemoryOutboxStore, touched: Touched) {
    this.#state = state;
    this.#outbox = outbox;
    this.#touched = touched;
  }

  insertOutbox(entry: OutboxEntry): Promise<void> {
    this.#outbox.insert(entry);
    return Promise.resolve();
  }

  findListingById(listingId: string): Promise<Listing | null> {
    const found = this.#state.listings.find((l) => l.listingId === listingId);
    return Promise.resolve(found === undefined ? null : sealListing(found));
  }

  findListingByIdempotencyKey(idempotencyKey: string): Promise<Listing | null> {
    const found = this.#state.listings.find((l) => l.idempotencyKey === idempotencyKey);
    return Promise.resolve(found === undefined ? null : sealListing(found));
  }

  findListingsByAccountId(accountId: string): Promise<readonly Listing[]> {
    const found = this.#state.listings
      .filter((l) => l.accountId === accountId)
      .sort(
        (a, b) => a.createdAt.localeCompare(b.createdAt) || a.listingId.localeCompare(b.listingId),
      );
    return Promise.resolve(sealListings(found));
  }

  insertListing(listing: Listing): Promise<void> {
    if (this.#state.listings.some((held) => held.listingId === listing.listingId)) {
      return Promise.reject(
        new UniversalListingError(
          'duplicate-listing-id',
          `listing ${listing.listingId} already exists. A listing is created once and ` +
            'its lifecycle is updated through the service',
        ),
      );
    }
    if (this.#state.listings.some((held) => held.idempotencyKey === listing.idempotencyKey)) {
      return Promise.reject(
        new UniversalListingError(
          'idempotency-key-reuse',
          `idempotency key "${listing.idempotencyKey}" has already been used`,
        ),
      );
    }
    this.#state.listings.push(sealListing(listing));
    this.#touched.listings.add(listing.listingId);
    this.#touched.listingKeys.add(listing.idempotencyKey);
    return Promise.resolve();
  }

  updateListing(listing: Listing): Promise<void> {
    const index = this.#state.listings.findIndex((held) => held.listingId === listing.listingId);
    if (index === -1) {
      return Promise.reject(
        new UniversalListingError(
          'listing-not-found',
          `listing ${listing.listingId} does not exist`,
        ),
      );
    }
    this.#state.listings[index] = sealListing(listing);
    this.#touched.listingUpdates.add(listing.listingId);
    return Promise.resolve();
  }

  findVersionById(versionId: string): Promise<ListingVersion | null> {
    const found = this.#state.versions.find((v) => v.versionId === versionId);
    return Promise.resolve(found === undefined ? null : sealListingVersion(found));
  }

  findVersionByIdempotencyKey(idempotencyKey: string): Promise<ListingVersion | null> {
    const found = this.#state.versions.find((v) => v.idempotencyKey === idempotencyKey);
    return Promise.resolve(found === undefined ? null : sealListingVersion(found));
  }

  findVersionsByListingId(listingId: string): Promise<readonly ListingVersion[]> {
    const found = this.#state.versions
      .filter((v) => v.listingId === listingId)
      .sort((a, b) => a.versionNumber - b.versionNumber || a.versionId.localeCompare(b.versionId));
    return Promise.resolve(sealListingVersions(found));
  }

  findVersionByListingAndNumber(
    listingId: string,
    versionNumber: number,
  ): Promise<ListingVersion | null> {
    const found = this.#state.versions.find(
      (v) => v.listingId === listingId && v.versionNumber === versionNumber,
    );
    return Promise.resolve(found === undefined ? null : sealListingVersion(found));
  }

  insertVersion(version: ListingVersion): Promise<void> {
    if (this.#state.versions.some((held) => held.versionId === version.versionId)) {
      return Promise.reject(
        new UniversalListingError(
          'duplicate-version-id',
          `version ${version.versionId} already exists. A version is created once and ` +
            'never rewritten',
        ),
      );
    }
    if (this.#state.versions.some((held) => held.idempotencyKey === version.idempotencyKey)) {
      return Promise.reject(
        new UniversalListingError(
          'idempotency-key-reuse',
          `idempotency key "${version.idempotencyKey}" has already been used`,
        ),
      );
    }
    if (
      this.#state.versions.some(
        (held) =>
          held.listingId === version.listingId && held.versionNumber === version.versionNumber,
      )
    ) {
      return Promise.reject(
        new UniversalListingError(
          'version-number-conflict',
          `listing ${version.listingId} already has version ${version.versionNumber}`,
        ),
      );
    }
    this.#state.versions.push(sealListingVersion(version));
    this.#touched.versions.add(version.versionId);
    this.#touched.versionKeys.add(version.idempotencyKey);
    this.#touched.versionNumbers.add(`${version.listingId}:${version.versionNumber}`);
    return Promise.resolve();
  }

  findMediaById(mediaId: string): Promise<ListingMedia | null> {
    const found = this.#state.medias.find((m) => m.mediaId === mediaId);
    return Promise.resolve(found === undefined ? null : sealListingMedia(found));
  }

  findMediaByIdempotencyKey(idempotencyKey: string): Promise<ListingMedia | null> {
    const found = this.#state.medias.find((m) => m.idempotencyKey === idempotencyKey);
    return Promise.resolve(found === undefined ? null : sealListingMedia(found));
  }

  findMediaByVersionId(versionId: string): Promise<readonly ListingMedia[]> {
    const found = this.#state.medias
      .filter((m) => m.versionId === versionId)
      .sort((a, b) => a.position - b.position || a.mediaId.localeCompare(b.mediaId));
    return Promise.resolve(sealListingMedias(found));
  }

  insertMedia(media: ListingMedia): Promise<void> {
    if (this.#state.medias.some((held) => held.mediaId === media.mediaId)) {
      return Promise.reject(
        new UniversalListingError(
          'duplicate-media-id',
          `media ${media.mediaId} already exists. A media row is created once and ` +
            'never rewritten',
        ),
      );
    }
    if (this.#state.medias.some((held) => held.idempotencyKey === media.idempotencyKey)) {
      return Promise.reject(
        new UniversalListingError(
          'idempotency-key-reuse',
          `idempotency key "${media.idempotencyKey}" has already been used`,
        ),
      );
    }
    if (
      this.#state.medias.some(
        (held) => held.versionId === media.versionId && held.position === media.position,
      )
    ) {
      return Promise.reject(
        new UniversalListingError(
          'duplicate-media-id',
          `version ${media.versionId} already has media at position ${media.position}`,
        ),
      );
    }
    this.#state.medias.push(sealListingMedia(media));
    this.#touched.medias.add(media.mediaId);
    this.#touched.mediaKeys.add(media.idempotencyKey);
    this.#touched.mediaPositions.add(`${media.versionId}:${media.position}`);
    return Promise.resolve();
  }

  findDeclarationById(declarationId: string): Promise<ListingDeclaration | null> {
    const found = this.#state.declarations.find((d) => d.declarationId === declarationId);
    return Promise.resolve(found === undefined ? null : sealListingDeclaration(found));
  }

  findDeclarationByIdempotencyKey(idempotencyKey: string): Promise<ListingDeclaration | null> {
    const found = this.#state.declarations.find((d) => d.idempotencyKey === idempotencyKey);
    return Promise.resolve(found === undefined ? null : sealListingDeclaration(found));
  }

  findDeclarationsByVersionId(versionId: string): Promise<readonly ListingDeclaration[]> {
    const found = this.#state.declarations
      .filter((d) => d.versionId === versionId)
      .sort(
        (a, b) =>
          a.declaredAt.localeCompare(b.declaredAt) ||
          a.declarationId.localeCompare(b.declarationId),
      );
    return Promise.resolve(sealListingDeclarations(found));
  }

  findDeclarationsByListingId(listingId: string): Promise<readonly ListingDeclaration[]> {
    const found = this.#state.declarations
      .filter((d) => d.listingId === listingId)
      .sort(
        (a, b) =>
          a.declaredAt.localeCompare(b.declaredAt) ||
          a.declarationId.localeCompare(b.declarationId),
      );
    return Promise.resolve(sealListingDeclarations(found));
  }

  insertDeclaration(declaration: ListingDeclaration): Promise<void> {
    if (this.#state.declarations.some((held) => held.declarationId === declaration.declarationId)) {
      return Promise.reject(
        new UniversalListingError(
          'duplicate-declaration-id',
          `declaration ${declaration.declarationId} already exists. A declaration is created once ` +
            'and never rewritten',
        ),
      );
    }
    if (
      this.#state.declarations.some((held) => held.idempotencyKey === declaration.idempotencyKey)
    ) {
      return Promise.reject(
        new UniversalListingError(
          'idempotency-key-reuse',
          `idempotency key "${declaration.idempotencyKey}" has already been used`,
        ),
      );
    }
    this.#state.declarations.push(sealListingDeclaration(declaration));
    this.#touched.declarations.add(declaration.declarationId);
    this.#touched.declarationKeys.add(declaration.idempotencyKey);
    return Promise.resolve();
  }

  findInventoryMovementById(movementId: string): Promise<InventoryMovement | null> {
    const found = this.#state.movements.find((m) => m.movementId === movementId);
    return Promise.resolve(found === undefined ? null : sealInventoryMovement(found));
  }

  findInventoryMovementByIdempotencyKey(idempotencyKey: string): Promise<InventoryMovement | null> {
    const found = this.#state.movements.find((m) => m.idempotencyKey === idempotencyKey);
    return Promise.resolve(found === undefined ? null : sealInventoryMovement(found));
  }

  findInventoryMovements(
    listingId: string,
    versionId: string,
  ): Promise<readonly InventoryMovement[]> {
    const found = this.#state.movements
      .filter((m) => m.listingId === listingId && m.versionId === versionId)
      .sort(compareMovementOrder);
    return Promise.resolve(sealInventoryMovements(found));
  }

  insertInventoryMovement(movement: InventoryMovement): Promise<void> {
    if (this.#state.movements.some((held) => held.movementId === movement.movementId)) {
      return Promise.reject(
        new UniversalListingError(
          'duplicate-movement-id',
          `movement ${movement.movementId} already exists. A movement is created once and ` +
            'never rewritten',
        ),
      );
    }
    if (this.#state.movements.some((held) => held.idempotencyKey === movement.idempotencyKey)) {
      return Promise.reject(
        new UniversalListingError(
          'idempotency-key-reuse',
          `idempotency key "${movement.idempotencyKey}" has already been used`,
        ),
      );
    }
    this.#state.movements.push(sealInventoryMovement(movement));
    this.#touched.movements.add(movement.movementId);
    this.#touched.movementKeys.add(movement.idempotencyKey);
    this.#touched.snapshotKeys.add(`${movement.listingId}:${movement.versionId}`);
    return Promise.resolve();
  }

  findInventorySnapshot(listingId: string, versionId: string): Promise<InventorySnapshot | null> {
    const movements = this.#state.movements
      .filter((m) => m.listingId === listingId && m.versionId === versionId)
      .sort(compareMovementOrder);
    if (movements.length === 0) {
      return Promise.resolve(null);
    }
    return Promise.resolve(
      sealInventorySnapshot(computeInventorySnapshot(listingId, versionId, movements)),
    );
  }

  upsertInventorySnapshot(snapshot: InventorySnapshot): Promise<void> {
    const index = this.#state.snapshots.findIndex(
      (s) => s.listingId === snapshot.listingId && s.versionId === snapshot.versionId,
    );
    if (index === -1) {
      this.#state.snapshots.push(sealInventorySnapshot(snapshot));
    } else {
      this.#state.snapshots[index] = sealInventorySnapshot(snapshot);
    }
    this.#touched.snapshotKeys.add(`${snapshot.listingId}:${snapshot.versionId}`);
    return Promise.resolve();
  }
}
