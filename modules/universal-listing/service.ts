/**
 * M-04 Universal Listing — slice A service.
 *
 * A listing is a stable identity that offers one `CommerceUnit` type. What it offers changes by
 * version, never by edit. This service owns the listing lifecycle, the append-only version history,
 * and the media and declarations pinned to each version.
 *
 * Deterministic by construction: the caller supplies every identifier and every instant. Nothing
 * here reads a clock or generates randomness.
 *
 * Owned by: M-04 Universal Listing.
 */

import { InvalidInstantError, parseInstant } from '../../platform/time/instant.ts';

import {
  makeListingCreatedAction,
  makeListingCreatedEvent,
  makeListingPublishedAction,
  makeListingPublishedEvent,
  makeListingSuspendedAction,
  makeListingSuspendedEvent,
  makeListingWithdrawnAction,
  makeListingWithdrawnEvent,
} from './outbox.ts';
import { FOREIGN_FIELDS, assertUniversalListingIdentifier } from './registry.ts';
import type { UniversalListingRepository, UniversalListingTransaction } from './repository.ts';
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
  validateListing,
  validateListingDeclaration,
  validateListingMedia,
  validateListingVersion,
} from './validate.ts';
import {
  UniversalListingError,
  type Listing,
  type ListingDeclaration,
  type ListingMedia,
  type ListingVersion,
} from './types.ts';

export interface CreateListingRequest {
  readonly listingId: string;
  readonly accountId: string;
  readonly commerceUnitTypeId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  /** Opaque id for the creation fact; the outbox entries are derived from it. */
  readonly recordId: string;
}

export interface CreateListingResult {
  readonly listing: Listing;
  readonly replayed: boolean;
}

export interface PublishListingRequest {
  readonly versionId: string;
  readonly listingId: string;
  readonly title: string;
  readonly description: string;
  readonly unitPriceMinor: bigint;
  readonly currency: string;
  readonly quantityAvailable: bigint;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly publishedAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
}

export interface PublishListingResult {
  readonly listing: Listing;
  readonly version: ListingVersion;
  readonly replayed: boolean;
}

export interface AddMediaRequest {
  readonly mediaId: string;
  readonly listingId: string;
  readonly versionId: string;
  readonly kind: string;
  readonly reference: string;
  readonly position: number;
  readonly caption: string;
  readonly addedAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
}

export interface AddMediaResult {
  readonly media: ListingMedia;
  readonly replayed: boolean;
}

export interface AddDeclarationRequest {
  readonly declarationId: string;
  readonly listingId: string;
  readonly versionId: string;
  readonly kind: string;
  readonly statement: string;
  readonly declaredAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
}

export interface AddDeclarationResult {
  readonly declaration: ListingDeclaration;
  readonly replayed: boolean;
}

export interface SuspendListingRequest {
  readonly listingId: string;
  readonly reason: string;
  readonly occurredAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  /** Opaque id for the suspension fact; the outbox entries are derived from it. */
  readonly recordId: string;
}

export interface SuspendListingResult {
  readonly listing: Listing;
  readonly replayed: boolean;
}

export interface WithdrawListingRequest {
  readonly listingId: string;
  readonly reason: string;
  readonly occurredAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  /** Opaque id for the withdrawal fact; the outbox entries are derived from it. */
  readonly recordId: string;
}

export interface WithdrawListingResult {
  readonly listing: Listing;
  readonly replayed: boolean;
}

const CREATE_LISTING_KEYS: readonly string[] = [
  'listingId',
  'accountId',
  'commerceUnitTypeId',
  'createdAt',
  'updatedAt',
  'correlationId',
  'idempotencyKey',
  'recordId',
];

const PUBLISH_LISTING_KEYS: readonly string[] = [
  'versionId',
  'listingId',
  'title',
  'description',
  'unitPriceMinor',
  'currency',
  'quantityAvailable',
  'attributes',
  'publishedAt',
  'correlationId',
  'idempotencyKey',
];

const ADD_MEDIA_KEYS: readonly string[] = [
  'mediaId',
  'listingId',
  'versionId',
  'kind',
  'reference',
  'position',
  'caption',
  'addedAt',
  'correlationId',
  'idempotencyKey',
];

const ADD_DECLARATION_KEYS: readonly string[] = [
  'declarationId',
  'listingId',
  'versionId',
  'kind',
  'statement',
  'declaredAt',
  'correlationId',
  'idempotencyKey',
];

const SUSPEND_LISTING_KEYS: readonly string[] = [
  'listingId',
  'reason',
  'occurredAt',
  'correlationId',
  'idempotencyKey',
  'recordId',
];

const WITHDRAW_LISTING_KEYS: readonly string[] = [
  'listingId',
  'reason',
  'occurredAt',
  'correlationId',
  'idempotencyKey',
  'recordId',
];

export class UniversalListingService {
  readonly #repository: UniversalListingRepository;

  constructor(repository: UniversalListingRepository) {
    this.#repository = repository;
  }

  /**
   * Create a listing as a draft.
   *
   * The listing starts at `status: 'draft'` and `currentVersion: 0`. Idempotent by key. Refuses
   * `listing-already-exists` when the listing id already exists with different content.
   */
  async createListing(request: CreateListingRequest): Promise<CreateListingResult> {
    assertNoForeignConcerns(request, CREATE_LISTING_KEYS, 'createListing');
    assertUniversalListingIdentifier(request.recordId, 'recordId');
    const createdAt = parseAndCheckInstant(request.createdAt, 'createdAt');
    const updatedAt = parseAndCheckInstant(request.updatedAt, 'updatedAt');

    const listing = sealListing(
      validateListing(
        {
          listingId: request.listingId,
          accountId: request.accountId,
          commerceUnitTypeId: request.commerceUnitTypeId,
          status: 'draft',
          currentVersion: 0,
          createdAt,
          updatedAt,
          publishedAt: null,
          withdrawnAt: null,
          correlationId: request.correlationId,
          idempotencyKey: request.idempotencyKey,
        },
        'request',
      ),
    );

    try {
      return await this.#create(listing, request.recordId);
    } catch (error) {
      const conflicted =
        error instanceof UniversalListingError &&
        (error.code === 'duplicate-listing-id' || error.code === 'idempotency-key-reuse');
      if (!conflicted) throw error;

      const winner = await this.#repository.withTransaction((tx) =>
        tx.findListingByIdempotencyKey(listing.idempotencyKey),
      );
      if (winner === null || !listingEquals(winner, listing)) throw error;
      return { listing: sealListing(winner), replayed: true };
    }
  }

  async #create(listing: Listing, recordId: string): Promise<CreateListingResult> {
    return this.#repository.withTransaction(async (tx) => {
      const existingKey = await tx.findListingByIdempotencyKey(listing.idempotencyKey);
      if (existingKey !== null) {
        if (!listingEquals(existingKey, listing)) {
          throw new UniversalListingError(
            'idempotency-key-reuse',
            `idempotency key "${listing.idempotencyKey}" has already been used for a different listing`,
          );
        }
        return { listing: sealListing(existingKey), replayed: true };
      }

      const existingId = await tx.findListingById(listing.listingId);
      if (existingId !== null) {
        if (!listingEquals(existingId, listing)) {
          throw new UniversalListingError(
            'listing-already-exists',
            `listing ${listing.listingId} already exists. A listing is created once and ` +
              'its lifecycle is updated through the service',
          );
        }
        return { listing: sealListing(existingId), replayed: true };
      }

      await tx.insertListing(listing);
      await this.#emitCreated(listing, recordId, tx);
      return { listing, replayed: false };
    });
  }

  /**
   * Publish a new version of a listing.
   *
   * Appends a `ListingVersion` at `versionNumber = currentVersion + 1`, moves the listing to
   * `published`, sets `publishedAt` on first publish, updates `currentVersion`, and emits. Refuses
   * `listing-not-found` and `listing-withdrawn`. Republishing an already-published listing appends a
   * new version; it never edits the old one.
   */
  async publishListing(request: PublishListingRequest): Promise<PublishListingResult> {
    assertNoForeignConcerns(request, PUBLISH_LISTING_KEYS, 'publishListing');
    assertUniversalListingIdentifier(request.versionId, 'versionId');
    assertUniversalListingIdentifier(request.listingId, 'listingId');
    const publishedAt = parseAndCheckInstant(request.publishedAt, 'publishedAt');

    try {
      return await this.#publish({ ...request, publishedAt });
    } catch (error) {
      const conflicted =
        error instanceof UniversalListingError &&
        (error.code === 'duplicate-version-id' || error.code === 'idempotency-key-reuse');
      if (!conflicted) throw error;

      const winner = await this.#findVersion(request.versionId, request.idempotencyKey);
      if (winner === null) throw error;

      const listing = await this.#repository.withTransaction((tx) =>
        tx.findListingById(winner.listingId),
      );
      if (listing === null) throw error;

      const expected = buildVersion(
        winner.versionId,
        winner.listingId,
        winner.versionNumber,
        request.title,
        request.description,
        request.unitPriceMinor,
        request.currency,
        request.quantityAvailable,
        request.attributes,
        publishedAt,
        request.correlationId,
        request.idempotencyKey,
      );
      if (!versionEquals(winner, expected)) throw error;
      return { listing: sealListing(listing), version: sealListingVersion(winner), replayed: true };
    }
  }

  async #publish(
    request: PublishListingRequest & { readonly publishedAt: string },
  ): Promise<PublishListingResult> {
    return this.#repository.withTransaction(async (tx) => {
      const existingKey = await tx.findVersionByIdempotencyKey(request.idempotencyKey);
      if (existingKey !== null) {
        const listing = await requireListing(tx, existingKey.listingId);
        const expected = buildVersionFromStored(existingKey, request);
        if (!versionEquals(existingKey, expected)) {
          throw new UniversalListingError(
            'idempotency-key-reuse',
            `idempotency key "${request.idempotencyKey}" has already been used for a different version`,
          );
        }
        return {
          listing: sealListing(listing),
          version: sealListingVersion(existingKey),
          replayed: true,
        };
      }

      const existingId = await tx.findVersionById(request.versionId);
      if (existingId !== null) {
        const listing = await requireListing(tx, existingId.listingId);
        const expected = buildVersionFromStored(existingId, request);
        if (!versionEquals(existingId, expected)) {
          throw new UniversalListingError(
            'duplicate-version-id',
            `version ${request.versionId} already exists with different content`,
          );
        }
        return {
          listing: sealListing(listing),
          version: sealListingVersion(existingId),
          replayed: true,
        };
      }

      const listing = await requireListing(tx, request.listingId);
      if (listing.status === 'withdrawn') {
        throw new UniversalListingError(
          'listing-withdrawn',
          `listing ${request.listingId} has been withdrawn and refuses further operation`,
        );
      }

      const versionNumber = listing.currentVersion + 1;
      const version = sealListingVersion(
        validateListingVersion(
          {
            versionId: request.versionId,
            listingId: request.listingId,
            versionNumber,
            title: request.title,
            description: request.description,
            unitPriceMinor: request.unitPriceMinor,
            currency: request.currency,
            quantityAvailable: request.quantityAvailable,
            attributes: request.attributes,
            publishedAt: request.publishedAt,
            correlationId: request.correlationId,
            idempotencyKey: request.idempotencyKey,
          },
          'request',
        ),
      );

      const updated = sealListing({
        ...listing,
        status: 'published',
        currentVersion: versionNumber,
        publishedAt: listing.publishedAt ?? request.publishedAt,
        updatedAt: request.publishedAt,
      });

      await tx.insertVersion(version);
      await tx.updateListing(updated);
      await this.#emitPublished(updated, version, tx);
      return { listing: updated, version, replayed: false };
    });
  }

  async #findVersion(versionId: string, idempotencyKey: string): Promise<ListingVersion | null> {
    const byId = await this.#repository.withTransaction((tx) => tx.findVersionById(versionId));
    if (byId !== null) return byId;
    return this.#repository.withTransaction((tx) => tx.findVersionByIdempotencyKey(idempotencyKey));
  }

  /**
   * Add a media reference to the current version of a listing.
   *
   * Refuses `listing-withdrawn` for a withdrawn listing, `version-not-found` when the version id
   * is unknown, and `version-not-current` when the
   * version is not the listing's current one.
   */
  async addMedia(request: AddMediaRequest): Promise<AddMediaResult> {
    assertNoForeignConcerns(request, ADD_MEDIA_KEYS, 'addMedia');
    assertUniversalListingIdentifier(request.mediaId, 'mediaId');
    assertUniversalListingIdentifier(request.listingId, 'listingId');
    assertUniversalListingIdentifier(request.versionId, 'versionId');
    const addedAt = parseAndCheckInstant(request.addedAt, 'addedAt');

    const media = sealListingMedia(
      validateListingMedia(
        {
          mediaId: request.mediaId,
          listingId: request.listingId,
          versionId: request.versionId,
          kind: request.kind,
          reference: request.reference,
          position: request.position,
          caption: request.caption,
          addedAt,
          correlationId: request.correlationId,
          idempotencyKey: request.idempotencyKey,
        },
        'request',
      ),
    );

    try {
      return await this.#addMedia(media);
    } catch (error) {
      const conflicted =
        error instanceof UniversalListingError &&
        (error.code === 'duplicate-media-id' || error.code === 'idempotency-key-reuse');
      if (!conflicted) throw error;

      const winner = await this.#findMedia(request.mediaId, request.idempotencyKey);
      if (winner === null) throw error;

      if (!mediaEquals(winner, media)) throw error;
      return { media: sealListingMedia(winner), replayed: true };
    }
  }

  async #addMedia(media: ListingMedia): Promise<AddMediaResult> {
    return this.#repository.withTransaction(async (tx) => {
      const existingKey = await tx.findMediaByIdempotencyKey(media.idempotencyKey);
      if (existingKey !== null) {
        if (!mediaEquals(existingKey, media)) {
          throw new UniversalListingError(
            'idempotency-key-reuse',
            `idempotency key "${media.idempotencyKey}" has already been used for a different media row`,
          );
        }
        return { media: sealListingMedia(existingKey), replayed: true };
      }

      const existingId = await tx.findMediaById(media.mediaId);
      if (existingId !== null) {
        if (!mediaEquals(existingId, media)) {
          throw new UniversalListingError(
            'duplicate-media-id',
            `media ${media.mediaId} already exists with different content`,
          );
        }
        return { media: sealListingMedia(existingId), replayed: true };
      }

      const version = await requireVersion(tx, media.versionId);
      const listing = await requireListing(tx, media.listingId);
      requireNotWithdrawn(listing);
      if (
        version.versionNumber !== listing.currentVersion ||
        version.listingId !== listing.listingId
      ) {
        throw new UniversalListingError(
          'version-not-current',
          `version ${media.versionId} is not the current version of listing ${media.listingId}`,
        );
      }

      await tx.insertMedia(media);
      return { media, replayed: false };
    });
  }

  async #findMedia(mediaId: string, idempotencyKey: string): Promise<ListingMedia | null> {
    const byId = await this.#repository.withTransaction((tx) => tx.findMediaById(mediaId));
    if (byId !== null) return byId;
    return this.#repository.withTransaction((tx) => tx.findMediaByIdempotencyKey(idempotencyKey));
  }

  /**
   * Add a declaration to the current version of a listing.
   *
   * Refuses `listing-withdrawn` for a withdrawn listing, `version-not-found` when the version id
   * is unknown, and `version-not-current` when the
   * version is not the listing's current one.
   */
  async addDeclaration(request: AddDeclarationRequest): Promise<AddDeclarationResult> {
    assertNoForeignConcerns(request, ADD_DECLARATION_KEYS, 'addDeclaration');
    assertUniversalListingIdentifier(request.declarationId, 'declarationId');
    assertUniversalListingIdentifier(request.listingId, 'listingId');
    assertUniversalListingIdentifier(request.versionId, 'versionId');
    const declaredAt = parseAndCheckInstant(request.declaredAt, 'declaredAt');

    const declaration = sealListingDeclaration(
      validateListingDeclaration(
        {
          declarationId: request.declarationId,
          listingId: request.listingId,
          versionId: request.versionId,
          kind: request.kind,
          statement: request.statement,
          declaredAt,
          correlationId: request.correlationId,
          idempotencyKey: request.idempotencyKey,
        },
        'request',
      ),
    );

    try {
      return await this.#addDeclaration(declaration);
    } catch (error) {
      const conflicted =
        error instanceof UniversalListingError &&
        (error.code === 'duplicate-declaration-id' || error.code === 'idempotency-key-reuse');
      if (!conflicted) throw error;

      const winner = await this.#findDeclaration(request.declarationId, request.idempotencyKey);
      if (winner === null) throw error;

      if (!declarationEquals(winner, declaration)) throw error;
      return { declaration: sealListingDeclaration(winner), replayed: true };
    }
  }

  async #addDeclaration(declaration: ListingDeclaration): Promise<AddDeclarationResult> {
    return this.#repository.withTransaction(async (tx) => {
      const existingKey = await tx.findDeclarationByIdempotencyKey(declaration.idempotencyKey);
      if (existingKey !== null) {
        if (!declarationEquals(existingKey, declaration)) {
          throw new UniversalListingError(
            'idempotency-key-reuse',
            `idempotency key "${declaration.idempotencyKey}" has already been used for a different declaration`,
          );
        }
        return { declaration: sealListingDeclaration(existingKey), replayed: true };
      }

      const existingId = await tx.findDeclarationById(declaration.declarationId);
      if (existingId !== null) {
        if (!declarationEquals(existingId, declaration)) {
          throw new UniversalListingError(
            'duplicate-declaration-id',
            `declaration ${declaration.declarationId} already exists with different content`,
          );
        }
        return { declaration: sealListingDeclaration(existingId), replayed: true };
      }

      const version = await requireVersion(tx, declaration.versionId);
      const listing = await requireListing(tx, declaration.listingId);
      requireNotWithdrawn(listing);
      if (
        version.versionNumber !== listing.currentVersion ||
        version.listingId !== listing.listingId
      ) {
        throw new UniversalListingError(
          'version-not-current',
          `version ${declaration.versionId} is not the current version of listing ${declaration.listingId}`,
        );
      }

      await tx.insertDeclaration(declaration);
      return { declaration, replayed: false };
    });
  }

  async #findDeclaration(
    declarationId: string,
    idempotencyKey: string,
  ): Promise<ListingDeclaration | null> {
    const byId = await this.#repository.withTransaction((tx) =>
      tx.findDeclarationById(declarationId),
    );
    if (byId !== null) return byId;
    return this.#repository.withTransaction((tx) =>
      tx.findDeclarationByIdempotencyKey(idempotencyKey),
    );
  }

  /**
   * Suspend a listing.
   *
   * Moves the listing to `suspended`. Refuses `listing-not-found` and `listing-withdrawn`. A retry
   * with the same `occurredAt` is idempotent by content.
   */
  async suspendListing(request: SuspendListingRequest): Promise<SuspendListingResult> {
    assertNoForeignConcerns(request, SUSPEND_LISTING_KEYS, 'suspendListing');
    assertUniversalListingIdentifier(request.listingId, 'listingId');
    assertUniversalListingIdentifier(request.recordId, 'recordId');
    const occurredAt = parseAndCheckInstant(request.occurredAt, 'occurredAt');

    return this.#repository.withTransaction(async (tx) => {
      const listing = await requireListing(tx, request.listingId);
      if (listing.status === 'withdrawn') {
        throw new UniversalListingError(
          'listing-withdrawn',
          `listing ${request.listingId} has been withdrawn and refuses further operation`,
        );
      }
      if (listing.status === 'suspended' && listing.updatedAt === occurredAt) {
        return { listing: sealListing(listing), replayed: true };
      }

      const updated = sealListing({
        ...listing,
        status: 'suspended',
        updatedAt: occurredAt,
      });

      await tx.updateListing(updated);
      await this.#emitSuspended(
        updated,
        request.recordId,
        request.reason,
        occurredAt,
        request.correlationId,
        request.idempotencyKey,
        tx,
      );
      return { listing: updated, replayed: false };
    });
  }

  /**
   * Withdraw a listing.
   *
   * Withdrawal is terminal: a withdrawn listing refuses every further operation. Refuses
   * `listing-not-found`. A retry with the same `occurredAt` is idempotent by content; a withdrawal
   * with a different `occurredAt` is refused as `listing-withdrawn`.
   */
  async withdrawListing(request: WithdrawListingRequest): Promise<WithdrawListingResult> {
    assertNoForeignConcerns(request, WITHDRAW_LISTING_KEYS, 'withdrawListing');
    assertUniversalListingIdentifier(request.listingId, 'listingId');
    assertUniversalListingIdentifier(request.recordId, 'recordId');
    const occurredAt = parseAndCheckInstant(request.occurredAt, 'occurredAt');

    return this.#repository.withTransaction(async (tx) => {
      const listing = await requireListing(tx, request.listingId);
      if (listing.status === 'withdrawn') {
        if (listing.withdrawnAt === occurredAt) {
          return { listing: sealListing(listing), replayed: true };
        }
        throw new UniversalListingError(
          'listing-withdrawn',
          `listing ${request.listingId} has already been withdrawn`,
        );
      }

      const updated = sealListing({
        ...listing,
        status: 'withdrawn',
        withdrawnAt: occurredAt,
        updatedAt: occurredAt,
      });

      await tx.updateListing(updated);
      await this.#emitWithdrawn(
        updated,
        request.recordId,
        request.reason,
        occurredAt,
        request.correlationId,
        request.idempotencyKey,
        tx,
      );
      return { listing: updated, replayed: false };
    });
  }

  /** Return one listing by id, sealed. */
  async getListing(listingId: string): Promise<Listing | null> {
    assertUniversalListingIdentifier(listingId, 'listingId');
    const listing = await this.#repository.withTransaction((tx) => tx.findListingById(listingId));
    return listing === null ? null : sealListing(listing);
  }

  /** Return one version by id, sealed. */
  async getVersion(versionId: string): Promise<ListingVersion | null> {
    assertUniversalListingIdentifier(versionId, 'versionId');
    const version = await this.#repository.withTransaction((tx) => tx.findVersionById(versionId));
    return version === null ? null : sealListingVersion(version);
  }

  /** Every published version for the listing, oldest first. */
  async listVersions(listingId: string): Promise<readonly ListingVersion[]> {
    assertUniversalListingIdentifier(listingId, 'listingId');
    const versions = await this.#repository.withTransaction((tx) =>
      tx.findVersionsByListingId(listingId),
    );
    return sealListingVersions(versions);
  }

  /** Every media reference for the version, in display order. */
  async listMedia(versionId: string): Promise<readonly ListingMedia[]> {
    assertUniversalListingIdentifier(versionId, 'versionId');
    const medias = await this.#repository.withTransaction((tx) =>
      tx.findMediaByVersionId(versionId),
    );
    return sealListingMedias(medias);
  }

  /** Every declaration for the version, oldest first. */
  async listDeclarations(versionId: string): Promise<readonly ListingDeclaration[]> {
    assertUniversalListingIdentifier(versionId, 'versionId');
    const declarations = await this.#repository.withTransaction((tx) =>
      tx.findDeclarationsByVersionId(versionId),
    );
    return sealListingDeclarations(declarations);
  }

  /** Every listing for the account, oldest first. */
  async listListingsByAccount(accountId: string): Promise<readonly Listing[]> {
    assertUniversalListingIdentifier(accountId, 'accountId');
    const listings = await this.#repository.withTransaction((tx) =>
      tx.findListingsByAccountId(accountId),
    );
    return sealListings(listings);
  }

  async #emitCreated(
    listing: Listing,
    recordId: string,
    tx: UniversalListingTransaction,
  ): Promise<void> {
    const correlationId = listing.correlationId;
    const causationId: string | null = null;
    await tx.insertOutbox(makeListingCreatedEvent(listing, recordId, correlationId, causationId));
    await tx.insertOutbox(makeListingCreatedAction(listing, recordId, correlationId, causationId));
  }

  async #emitPublished(
    listing: Listing,
    version: ListingVersion,
    tx: UniversalListingTransaction,
  ): Promise<void> {
    const correlationId = version.correlationId;
    const causationId: string | null = null;
    await tx.insertOutbox(makeListingPublishedEvent(listing, version, correlationId, causationId));
    await tx.insertOutbox(makeListingPublishedAction(listing, version, correlationId, causationId));
  }

  async #emitSuspended(
    listing: Listing,
    recordId: string,
    reason: string,
    occurredAt: string,
    correlationId: string,
    idempotencyKey: string,
    tx: UniversalListingTransaction,
  ): Promise<void> {
    const causationId: string | null = null;
    await tx.insertOutbox(
      makeListingSuspendedEvent(
        listing,
        recordId,
        reason,
        occurredAt,
        correlationId,
        causationId,
        idempotencyKey,
      ),
    );
    await tx.insertOutbox(
      makeListingSuspendedAction(
        listing,
        recordId,
        reason,
        occurredAt,
        correlationId,
        causationId,
        idempotencyKey,
      ),
    );
  }

  async #emitWithdrawn(
    listing: Listing,
    recordId: string,
    reason: string,
    occurredAt: string,
    correlationId: string,
    idempotencyKey: string,
    tx: UniversalListingTransaction,
  ): Promise<void> {
    const causationId: string | null = null;
    await tx.insertOutbox(
      makeListingWithdrawnEvent(
        listing,
        recordId,
        reason,
        occurredAt,
        correlationId,
        causationId,
        idempotencyKey,
      ),
    );
    await tx.insertOutbox(
      makeListingWithdrawnAction(
        listing,
        recordId,
        reason,
        occurredAt,
        correlationId,
        causationId,
        idempotencyKey,
      ),
    );
  }
}

function assertNoForeignConcerns(
  request: object,
  permitted: readonly string[],
  operation: string,
): void {
  if (request === null || typeof request !== 'object') {
    throw new UniversalListingError(
      'malformed-record',
      `${operation} needs a request object, got ${request === null ? 'null' : typeof request}`,
    );
  }

  for (const key of Object.keys(request)) {
    if (permitted.includes(key)) continue;

    const owner = FOREIGN_FIELDS[key];
    if (owner !== undefined) {
      throw new UniversalListingError(
        'foreign-concern',
        `${operation} carried "${key}", but ${owner}. A listing record carries only what M-04 owns`,
      );
    }
    throw new UniversalListingError(
      'foreign-concern',
      `${operation} carried the unrecognised field "${key}". The permitted fields are ` +
        `${permitted.join(', ')}; anything else would be accepted and silently dropped`,
    );
  }
}

function parseAndCheckInstant(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new UniversalListingError(
      'malformed-instant',
      `${field} is ${value === null ? 'null' : typeof value}; expected a UTC instant string`,
    );
  }
  try {
    return parseInstant(value).source;
  } catch (error) {
    if (error instanceof InvalidInstantError) {
      throw new UniversalListingError('malformed-instant', `${field}: ${error.message}`);
    }
    throw error;
  }
}

async function requireListing(
  tx: UniversalListingTransaction,
  listingId: string,
): Promise<Listing> {
  const listing = await tx.findListingById(listingId);
  if (listing === null) {
    throw new UniversalListingError('listing-not-found', `listing ${listingId} does not exist`);
  }
  return listing;
}

/**
 * Withdrawal is terminal, and that has to mean every operation, not just the ones that change
 * status.
 *
 * The first draft of this module guarded `publishListing`, `suspendListing` and `withdrawListing`
 * and left `addMedia` and `addDeclaration` open, because neither changes the listing's state. But a
 * declaration is what the supplier asserted about what they were offering, and it is the thing a
 * dispute is judged against — so being able to append one to a withdrawn offer is exactly the hole
 * somebody would use. A photograph added to an offer nobody can accept is merely pointless; a claim
 * added to one is not.
 */
function requireNotWithdrawn(listing: Listing): void {
  if (listing.status === 'withdrawn') {
    throw new UniversalListingError(
      'listing-withdrawn',
      `listing ${listing.listingId} was withdrawn, and withdrawal is terminal`,
    );
  }
}

async function requireVersion(
  tx: UniversalListingTransaction,
  versionId: string,
): Promise<ListingVersion> {
  const version = await tx.findVersionById(versionId);
  if (version === null) {
    throw new UniversalListingError('version-not-found', `version ${versionId} does not exist`);
  }
  return version;
}

function listingEquals(a: Listing, b: Listing): boolean {
  return (
    a.listingId === b.listingId &&
    a.accountId === b.accountId &&
    a.commerceUnitTypeId === b.commerceUnitTypeId &&
    a.createdAt === b.createdAt
  );
}

function versionEquals(a: ListingVersion, b: ListingVersion): boolean {
  return (
    a.versionId === b.versionId &&
    a.listingId === b.listingId &&
    a.versionNumber === b.versionNumber &&
    a.title === b.title &&
    a.description === b.description &&
    a.unitPriceMinor === b.unitPriceMinor &&
    a.currency === b.currency &&
    a.quantityAvailable === b.quantityAvailable &&
    JSON.stringify(a.attributes) === JSON.stringify(b.attributes) &&
    a.publishedAt === b.publishedAt
  );
}

function mediaEquals(a: ListingMedia, b: ListingMedia): boolean {
  return (
    a.mediaId === b.mediaId &&
    a.listingId === b.listingId &&
    a.versionId === b.versionId &&
    a.kind === b.kind &&
    a.reference === b.reference &&
    a.position === b.position &&
    a.caption === b.caption &&
    a.addedAt === b.addedAt
  );
}

function declarationEquals(a: ListingDeclaration, b: ListingDeclaration): boolean {
  return (
    a.declarationId === b.declarationId &&
    a.listingId === b.listingId &&
    a.versionId === b.versionId &&
    a.kind === b.kind &&
    a.statement === b.statement &&
    a.declaredAt === b.declaredAt
  );
}

function buildVersion(
  versionId: string,
  listingId: string,
  versionNumber: number,
  title: string,
  description: string,
  unitPriceMinor: bigint,
  currency: string,
  quantityAvailable: bigint,
  attributes: Readonly<Record<string, unknown>>,
  publishedAt: string,
  correlationId: string,
  idempotencyKey: string,
): ListingVersion {
  return {
    versionId,
    listingId,
    versionNumber,
    title,
    description,
    unitPriceMinor,
    currency,
    quantityAvailable,
    attributes,
    publishedAt,
    correlationId,
    idempotencyKey,
  };
}

function buildVersionFromStored(
  stored: ListingVersion,
  request: PublishListingRequest,
): ListingVersion {
  return buildVersion(
    stored.versionId,
    stored.listingId,
    stored.versionNumber,
    request.title,
    request.description,
    request.unitPriceMinor,
    request.currency,
    request.quantityAvailable,
    request.attributes,
    request.publishedAt,
    request.correlationId,
    request.idempotencyKey,
  );
}
