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

  outbox(): InMemoryOutboxStore {
    return this.#outbox;
  }

  /** Seed state directly, for tests that need a starting point without going through the service. */
  seed(state: {
    readonly listings?: readonly Listing[];
    readonly versions?: readonly ListingVersion[];
    readonly medias?: readonly ListingMedia[];
    readonly declarations?: readonly ListingDeclaration[];
    readonly outbox?: readonly OutboxEntry[];
  }): void {
    this.#listings = (state.listings ?? []).map(sealListing);
    this.#versions = (state.versions ?? []).map(sealListingVersion);
    this.#medias = (state.medias ?? []).map(sealListingMedia);
    this.#declarations = (state.declarations ?? []).map(sealListingDeclaration);
    this.#outbox.seed(state.outbox ?? []);
  }

  async withTransaction<T>(body: (tx: UniversalListingTransaction) => Promise<T>): Promise<T> {
    const working = new WorkingSet({
      listings: this.#listings.map(sealListing),
      versions: this.#versions.map(sealListingVersion),
      medias: this.#medias.map(sealListingMedia),
      declarations: this.#declarations.map(sealListingDeclaration),
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
  }
}

class WorkingSet {
  listings: Listing[];
  versions: ListingVersion[];
  medias: ListingMedia[];
  declarations: ListingDeclaration[];

  constructor(snapshot: {
    listings: Listing[];
    versions: ListingVersion[];
    medias: ListingMedia[];
    declarations: ListingDeclaration[];
  }) {
    this.listings = snapshot.listings;
    this.versions = snapshot.versions;
    this.medias = snapshot.medias;
    this.declarations = snapshot.declarations;
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
}
