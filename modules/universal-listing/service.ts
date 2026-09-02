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
  makeInventoryAdjustedAction,
  makeInventoryAdjustedEvent,
  makeInventoryCommittedAction,
  makeInventoryCommittedEvent,
  makeInventoryReceivedAction,
  makeInventoryReceivedEvent,
  makeInventoryReleasedAction,
  makeInventoryReleasedEvent,
  makeInventoryReservedAction,
  makeInventoryReservedEvent,
  makeListingCreatedAction,
  makeListingCreatedEvent,
  makeListingPublishedAction,
  makeListingPublishedEvent,
  makeListingSuspendedAction,
  makeListingSuspendedEvent,
  makeListingWithdrawnAction,
  makeListingWithdrawnEvent,
} from './outbox.ts';
import {
  FOREIGN_FIELDS,
  assertInventoryMode,
  assertUniversalListingIdentifier,
} from './registry.ts';
import type {
  PublishedVersion,
  UniversalListingRepository,
  UniversalListingTransaction,
} from './repository.ts';
import {
  sealInventoryMovement,
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
  validateInventoryMovement,
  validateListing,
  validateListingDeclaration,
  validateListingMedia,
  validateListingVersion,
} from './validate.ts';
import {
  UniversalListingError,
  type InventoryAvailability,
  type InventoryMode,
  type InventoryMovement,
  type InventorySnapshot,
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
  /**
   * How fulfilment of this version relates to stock.
   *
   * Required, with no default. A default of `tracked` would make the most restrictive behaviour the
   * one nobody chose, and would quietly demand a stock reservation for a service.
   */
  readonly inventoryMode: string;
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

export interface ReceiveInventoryRequest {
  readonly movementId: string;
  readonly listingId: string;
  readonly versionId: string;
  readonly quantity: bigint;
  readonly reason: string;
  readonly occurredAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
}

export interface ReceiveInventoryResult {
  readonly movement: InventoryMovement;
  readonly availability: InventoryAvailability;
  readonly replayed: boolean;
}

export interface AdjustInventoryRequest {
  readonly movementId: string;
  readonly listingId: string;
  readonly versionId: string;
  readonly kind: 'adjust-up' | 'adjust-down';
  readonly quantity: bigint;
  readonly reason: string;
  readonly occurredAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
}

export interface AdjustInventoryResult {
  readonly movement: InventoryMovement;
  readonly availability: InventoryAvailability;
  readonly replayed: boolean;
}

export interface ReserveInventoryRequest {
  readonly movementId: string;
  readonly listingId: string;
  readonly versionId: string;
  readonly reservationId: string;
  readonly quantity: bigint;
  readonly reason: string;
  readonly occurredAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
}

export interface ReserveInventoryResult {
  readonly movement: InventoryMovement;
  readonly availability: InventoryAvailability;
  readonly replayed: boolean;
}

export interface ReleaseInventoryRequest {
  readonly movementId: string;
  readonly listingId: string;
  readonly versionId: string;
  readonly reservationId: string;
  readonly quantity: bigint;
  readonly reason: string;
  readonly occurredAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
}

export interface ReleaseInventoryResult {
  readonly movement: InventoryMovement;
  readonly availability: InventoryAvailability;
  readonly replayed: boolean;
}

export interface CommitInventoryRequest {
  readonly movementId: string;
  readonly listingId: string;
  readonly versionId: string;
  readonly reservationId: string;
  readonly quantity: bigint;
  readonly reason: string;
  readonly occurredAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
}

export interface CommitInventoryResult {
  readonly movement: InventoryMovement;
  readonly availability: InventoryAvailability;
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
  'inventoryMode',
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

const RECEIVE_INVENTORY_KEYS: readonly string[] = [
  'movementId',
  'listingId',
  'versionId',
  'quantity',
  'reason',
  'occurredAt',
  'correlationId',
  'idempotencyKey',
];

const ADJUST_INVENTORY_KEYS: readonly string[] = [
  'movementId',
  'listingId',
  'versionId',
  'kind',
  'quantity',
  'reason',
  'occurredAt',
  'correlationId',
  'idempotencyKey',
];

const RESERVE_INVENTORY_KEYS: readonly string[] = [
  'movementId',
  'listingId',
  'versionId',
  'reservationId',
  'quantity',
  'reason',
  'occurredAt',
  'correlationId',
  'idempotencyKey',
];

const RELEASE_INVENTORY_KEYS: readonly string[] = [
  'movementId',
  'listingId',
  'versionId',
  'reservationId',
  'quantity',
  'reason',
  'occurredAt',
  'correlationId',
  'idempotencyKey',
];

const COMMIT_INVENTORY_KEYS: readonly string[] = [
  'movementId',
  'listingId',
  'versionId',
  'reservationId',
  'quantity',
  'reason',
  'occurredAt',
  'correlationId',
  'idempotencyKey',
];

/**
 * How many published versions a recall step reads when the caller does not say.
 *
 * Small enough that reading them all is cheap, large enough that a young marketplace's whole
 * catalogue fits. Neither number is a search strategy, which is the point of saying so here.
 */
export const DEFAULT_RECALL_LIMIT = 200;
export const MAXIMUM_RECALL_LIMIT = 1000;

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

      const expected = buildVersion({
        versionId: winner.versionId,
        listingId: winner.listingId,
        versionNumber: winner.versionNumber,
        title: request.title,
        description: request.description,
        unitPriceMinor: request.unitPriceMinor,
        currency: request.currency,
        quantityAvailable: request.quantityAvailable,
        inventoryMode: assertInventoryMode(request.inventoryMode, 'inventoryMode'),
        attributes: request.attributes,
        publishedAt,
        correlationId: request.correlationId,
        idempotencyKey: request.idempotencyKey,
      });
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
            inventoryMode: request.inventoryMode,
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

  /**
   * Every published listing's current version, newest first, bounded.
   *
   * The **recall** step of a search, for a caller that has to look across supply rather than at one
   * listing: a sourcing rung scores what it is given, and a source that pre-filtered aggressively
   * would hide the near misses a customer most wants to see when nothing matched exactly.
   *
   * **This is recall by enumeration and it belongs to M-06 Search & Discovery** the moment supply
   * outgrows a page. It is here because M-04 owns supply and a bounded query over its own published
   * versions is its own operation — but a module that answers "what is for sale, roughly?" by
   * reading everything is not a search engine, and should not be mistaken for one.
   */
  async listPublishedVersions(limit = DEFAULT_RECALL_LIMIT): Promise<readonly PublishedVersion[]> {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAXIMUM_RECALL_LIMIT) {
      throw new UniversalListingError(
        'malformed-record',
        `limit is ${String(limit)}; expected a whole number between 1 and ` +
          `${String(MAXIMUM_RECALL_LIMIT)}. An unbounded read of every version is how a recall ` +
          'step becomes an outage',
      );
    }
    return this.#repository.withTransaction((tx) => tx.findPublishedVersions(limit));
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

  /**
   * Add stock to a listing version.
   *
   * Appends a `receive` movement and updates the snapshot. Refuses `listing-not-found`,
   * `version-not-found`, `version-not-current` and `listing-withdrawn`.
   */
  async receiveInventory(request: ReceiveInventoryRequest): Promise<ReceiveInventoryResult> {
    assertNoForeignConcerns(request, RECEIVE_INVENTORY_KEYS, 'receiveInventory');
    assertUniversalListingIdentifier(request.movementId, 'movementId');
    assertUniversalListingIdentifier(request.listingId, 'listingId');
    assertUniversalListingIdentifier(request.versionId, 'versionId');
    const occurredAt = parseAndCheckInstant(request.occurredAt, 'occurredAt');

    const movement = sealInventoryMovement(
      validateInventoryMovement(
        {
          movementId: request.movementId,
          listingId: request.listingId,
          versionId: request.versionId,
          kind: 'receive',
          quantity: request.quantity,
          reservationId: null,
          reason: request.reason,
          occurredAt,
          correlationId: request.correlationId,
          idempotencyKey: request.idempotencyKey,
        },
        'request',
      ),
    );

    return this.#applyInventoryMovement(movement, (tx) => this.#emitReceived(movement, tx));
  }

  /**
   * Correct inventory up or down.
   *
   * Refuses `insufficient-stock` when an `adjust-down` would take `onHand` below
   * `reserved + committed`.
   */
  async adjustInventory(request: AdjustInventoryRequest): Promise<AdjustInventoryResult> {
    assertNoForeignConcerns(request, ADJUST_INVENTORY_KEYS, 'adjustInventory');
    assertUniversalListingIdentifier(request.movementId, 'movementId');
    assertUniversalListingIdentifier(request.listingId, 'listingId');
    assertUniversalListingIdentifier(request.versionId, 'versionId');
    const occurredAt = parseAndCheckInstant(request.occurredAt, 'occurredAt');

    const movement = sealInventoryMovement(
      validateInventoryMovement(
        {
          movementId: request.movementId,
          listingId: request.listingId,
          versionId: request.versionId,
          kind: request.kind,
          quantity: request.quantity,
          reservationId: null,
          reason: request.reason,
          occurredAt,
          correlationId: request.correlationId,
          idempotencyKey: request.idempotencyKey,
        },
        'request',
      ),
    );

    return this.#applyInventoryMovement(movement, (tx) => this.#emitAdjusted(movement, tx));
  }

  /**
   * Hold stock for a caller.
   *
   * Refuses `insufficient-stock` when the requested quantity exceeds availability.
   * Idempotent by `reservationId`: reserving twice with the same id and quantity is one reservation.
   */
  async reserveInventory(request: ReserveInventoryRequest): Promise<ReserveInventoryResult> {
    assertNoForeignConcerns(request, RESERVE_INVENTORY_KEYS, 'reserveInventory');
    assertUniversalListingIdentifier(request.movementId, 'movementId');
    assertUniversalListingIdentifier(request.listingId, 'listingId');
    assertUniversalListingIdentifier(request.versionId, 'versionId');
    assertUniversalListingIdentifier(request.reservationId, 'reservationId');
    const occurredAt = parseAndCheckInstant(request.occurredAt, 'occurredAt');

    const movement = sealInventoryMovement(
      validateInventoryMovement(
        {
          movementId: request.movementId,
          listingId: request.listingId,
          versionId: request.versionId,
          kind: 'reserve',
          quantity: request.quantity,
          reservationId: request.reservationId,
          reason: request.reason,
          occurredAt,
          correlationId: request.correlationId,
          idempotencyKey: request.idempotencyKey,
        },
        'request',
      ),
    );

    return this.#applyInventoryMovement(movement, (tx) => this.#emitReserved(movement, tx));
  }

  /**
   * Give held stock back.
   *
   * Refuses `reservation-not-found` and `reservation-not-open`.
   */
  async releaseInventory(request: ReleaseInventoryRequest): Promise<ReleaseInventoryResult> {
    assertNoForeignConcerns(request, RELEASE_INVENTORY_KEYS, 'releaseInventory');
    assertUniversalListingIdentifier(request.movementId, 'movementId');
    assertUniversalListingIdentifier(request.listingId, 'listingId');
    assertUniversalListingIdentifier(request.versionId, 'versionId');
    assertUniversalListingIdentifier(request.reservationId, 'reservationId');
    const occurredAt = parseAndCheckInstant(request.occurredAt, 'occurredAt');

    const movement = sealInventoryMovement(
      validateInventoryMovement(
        {
          movementId: request.movementId,
          listingId: request.listingId,
          versionId: request.versionId,
          kind: 'release',
          quantity: request.quantity,
          reservationId: request.reservationId,
          reason: request.reason,
          occurredAt,
          correlationId: request.correlationId,
          idempotencyKey: request.idempotencyKey,
        },
        'request',
      ),
    );

    return this.#applyInventoryMovement(movement, (tx) => this.#emitReleased(movement, tx));
  }

  /**
   * Turn a reservation into a sale.
   *
   * Moves stock from `reserved` to `committed` and lowers `onHand`. Refuses
   * `reservation-not-found` and `reservation-not-open`.
   */
  async commitInventory(request: CommitInventoryRequest): Promise<CommitInventoryResult> {
    assertNoForeignConcerns(request, COMMIT_INVENTORY_KEYS, 'commitInventory');
    assertUniversalListingIdentifier(request.movementId, 'movementId');
    assertUniversalListingIdentifier(request.listingId, 'listingId');
    assertUniversalListingIdentifier(request.versionId, 'versionId');
    assertUniversalListingIdentifier(request.reservationId, 'reservationId');
    const occurredAt = parseAndCheckInstant(request.occurredAt, 'occurredAt');

    const movement = sealInventoryMovement(
      validateInventoryMovement(
        {
          movementId: request.movementId,
          listingId: request.listingId,
          versionId: request.versionId,
          kind: 'commit',
          quantity: request.quantity,
          reservationId: request.reservationId,
          reason: request.reason,
          occurredAt,
          correlationId: request.correlationId,
          idempotencyKey: request.idempotencyKey,
        },
        'request',
      ),
    );

    return this.#applyInventoryMovement(movement, (tx) => this.#emitCommitted(movement, tx));
  }

  /**
   * Return the derived availability for one listing version.
   *
   * A listing that has never received stock returns all zeroes.
   */
  async getAvailability(listingId: string, versionId: string): Promise<InventoryAvailability> {
    assertUniversalListingIdentifier(listingId, 'listingId');
    assertUniversalListingIdentifier(versionId, 'versionId');
    return this.#repository.withTransaction(async (tx) => {
      const snapshot = await tx.findInventorySnapshot(listingId, versionId);
      return availabilityFromSnapshot(snapshot);
    });
  }

  async #applyInventoryMovement(
    movement: InventoryMovement,
    emit: (tx: UniversalListingTransaction) => Promise<void>,
  ): Promise<{
    readonly movement: InventoryMovement;
    readonly availability: InventoryAvailability;
    readonly replayed: boolean;
  }> {
    try {
      return await this.#repository.withTransaction(async (tx) => {
        const existingKey = await tx.findInventoryMovementByIdempotencyKey(movement.idempotencyKey);
        if (existingKey !== null) {
          if (!inventoryMovementEquals(existingKey, movement)) {
            throw new UniversalListingError(
              'idempotency-key-reuse',
              `idempotency key "${movement.idempotencyKey}" has already been used for a different movement`,
            );
          }
          return {
            movement: sealInventoryMovement(existingKey),
            availability: await this.#availabilityInTx(tx, movement.listingId, movement.versionId),
            replayed: true,
          };
        }

        const existingId = await tx.findInventoryMovementById(movement.movementId);
        if (existingId !== null) {
          if (!inventoryMovementEquals(existingId, movement)) {
            throw new UniversalListingError(
              'duplicate-movement-id',
              `movement ${movement.movementId} already exists with different content`,
            );
          }
          return {
            movement: sealInventoryMovement(existingId),
            availability: await this.#availabilityInTx(tx, movement.listingId, movement.versionId),
            replayed: true,
          };
        }

        await this.#requireInventoryContext(tx, movement.listingId, movement.versionId);
        await this.#enforceInventoryRules(tx, movement);

        await tx.insertInventoryMovement(movement);
        await emit(tx);
        return {
          movement,
          availability: await this.#availabilityInTx(tx, movement.listingId, movement.versionId),
          replayed: false,
        };
      });
    } catch (error) {
      const conflicted =
        error instanceof UniversalListingError &&
        (error.code === 'duplicate-movement-id' || error.code === 'idempotency-key-reuse');
      if (!conflicted) throw error;

      const winner = await this.#findInventoryMovement(
        movement.movementId,
        movement.idempotencyKey,
      );
      if (winner === null || !inventoryMovementEquals(winner, movement)) throw error;
      return {
        movement: sealInventoryMovement(winner),
        availability: await this.#repository.withTransaction((tx) =>
          this.#availabilityInTx(tx, movement.listingId, movement.versionId),
        ),
        replayed: true,
      };
    }
  }

  async #findInventoryMovement(
    movementId: string,
    idempotencyKey: string,
  ): Promise<InventoryMovement | null> {
    const byId = await this.#repository.withTransaction((tx) =>
      tx.findInventoryMovementById(movementId),
    );
    if (byId !== null) return byId;
    return this.#repository.withTransaction((tx) =>
      tx.findInventoryMovementByIdempotencyKey(idempotencyKey),
    );
  }

  async #requireInventoryContext(
    tx: UniversalListingTransaction,
    listingId: string,
    versionId: string,
  ): Promise<{ readonly listing: Listing; readonly version: ListingVersion }> {
    const listing = await requireListing(tx, listingId);
    requireNotWithdrawn(listing);
    const version = await requireVersion(tx, versionId);
    if (
      version.versionNumber !== listing.currentVersion ||
      version.listingId !== listing.listingId
    ) {
      throw new UniversalListingError(
        'version-not-current',
        `version ${versionId} is not the current version of listing ${listingId}`,
      );
    }
    return { listing, version };
  }

  async #enforceInventoryRules(
    tx: UniversalListingTransaction,
    movement: InventoryMovement,
  ): Promise<void> {
    const snapshot = await tx.findInventorySnapshot(movement.listingId, movement.versionId);
    const current = availabilityFromSnapshot(snapshot);

    switch (movement.kind) {
      case 'receive':
      case 'adjust-up':
        return;
      case 'adjust-down': {
        const newOnHand = current.onHand - movement.quantity;
        const minimum = current.reserved + current.committed;
        if (newOnHand < minimum) {
          throw new UniversalListingError(
            'insufficient-stock',
            `adjust-down would take onHand to ${String(newOnHand)}, below reserved + committed ` +
              `(${String(minimum)})`,
          );
        }
        return;
      }
      case 'reserve': {
        if (movement.quantity > current.available) {
          throw new UniversalListingError(
            'insufficient-stock',
            `cannot reserve ${String(movement.quantity)} when only ${String(current.available)} ` +
              'is available',
          );
        }
        return;
      }
      case 'release':
      case 'commit': {
        const reservation = await this.#reservationState(
          tx,
          movement.listingId,
          movement.versionId,
          movement.reservationId as string,
        );
        if (reservation === null) {
          throw new UniversalListingError(
            'reservation-not-found',
            `reservation ${movement.reservationId} does not exist`,
          );
        }
        if (!reservation.isOpen) {
          throw new UniversalListingError(
            'reservation-not-open',
            `reservation ${movement.reservationId} is not open`,
          );
        }
        if (movement.kind === 'commit') {
          if (movement.quantity > reservation.reservedQuantity) {
            throw new UniversalListingError(
              'insufficient-stock',
              `cannot commit ${String(movement.quantity)} from reservation ${movement.reservationId} ` +
                `when only ${String(reservation.reservedQuantity)} is reserved`,
            );
          }
        }
        return;
      }
    }
  }

  async #reservationState(
    tx: UniversalListingTransaction,
    listingId: string,
    versionId: string,
    reservationId: string,
  ): Promise<{ readonly isOpen: boolean; readonly reservedQuantity: bigint } | null> {
    const movements = (await tx.findInventoryMovements(listingId, versionId)).filter(
      (m) => m.reservationId === reservationId,
    );
    if (movements.length === 0) return null;

    let reserved = 0n;
    for (const movement of movements) {
      switch (movement.kind) {
        case 'reserve':
          reserved += movement.quantity;
          break;
        case 'release':
          reserved -= movement.quantity;
          break;
        case 'commit':
          reserved -= movement.quantity;
          break;
      }
    }
    return { isOpen: reserved > 0n, reservedQuantity: reserved };
  }

  async #availabilityInTx(
    tx: UniversalListingTransaction,
    listingId: string,
    versionId: string,
  ): Promise<InventoryAvailability> {
    const snapshot = await tx.findInventorySnapshot(listingId, versionId);
    return availabilityFromSnapshot(snapshot);
  }

  async #emitReceived(movement: InventoryMovement, tx: UniversalListingTransaction): Promise<void> {
    const correlationId = movement.correlationId;
    const causationId: string | null = null;
    await tx.insertOutbox(makeInventoryReceivedEvent(movement, correlationId, causationId));
    await tx.insertOutbox(makeInventoryReceivedAction(movement, correlationId, causationId));
  }

  async #emitAdjusted(movement: InventoryMovement, tx: UniversalListingTransaction): Promise<void> {
    const correlationId = movement.correlationId;
    const causationId: string | null = null;
    await tx.insertOutbox(makeInventoryAdjustedEvent(movement, correlationId, causationId));
    await tx.insertOutbox(makeInventoryAdjustedAction(movement, correlationId, causationId));
  }

  async #emitReserved(movement: InventoryMovement, tx: UniversalListingTransaction): Promise<void> {
    const correlationId = movement.correlationId;
    const causationId: string | null = null;
    await tx.insertOutbox(makeInventoryReservedEvent(movement, correlationId, causationId));
    await tx.insertOutbox(makeInventoryReservedAction(movement, correlationId, causationId));
  }

  async #emitReleased(movement: InventoryMovement, tx: UniversalListingTransaction): Promise<void> {
    const correlationId = movement.correlationId;
    const causationId: string | null = null;
    await tx.insertOutbox(makeInventoryReleasedEvent(movement, correlationId, causationId));
    await tx.insertOutbox(makeInventoryReleasedAction(movement, correlationId, causationId));
  }

  async #emitCommitted(
    movement: InventoryMovement,
    tx: UniversalListingTransaction,
  ): Promise<void> {
    const correlationId = movement.correlationId;
    const causationId: string | null = null;
    await tx.insertOutbox(makeInventoryCommittedEvent(movement, correlationId, causationId));
    await tx.insertOutbox(makeInventoryCommittedAction(movement, correlationId, causationId));
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
    a.inventoryMode === b.inventoryMode &&
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

/**
 * Assemble a version record.
 *
 * Takes an object rather than a positional list. It used to take twelve positional arguments, which
 * is precisely the shape where adding a thirteenth lands it in the wrong slot and the compiler is
 * happy because `bigint` and `bigint` look alike — the mode was added here, and this is what that
 * near-miss cost.
 */
function buildVersion(fields: {
  readonly versionId: string;
  readonly listingId: string;
  readonly versionNumber: number;
  readonly title: string;
  readonly description: string;
  readonly unitPriceMinor: bigint;
  readonly currency: string;
  readonly quantityAvailable: bigint;
  readonly inventoryMode: InventoryMode;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly publishedAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
}): ListingVersion {
  return { ...fields };
}

function buildVersionFromStored(
  stored: ListingVersion,
  request: PublishListingRequest,
): ListingVersion {
  return buildVersion({
    versionId: stored.versionId,
    listingId: stored.listingId,
    versionNumber: stored.versionNumber,
    title: request.title,
    description: request.description,
    unitPriceMinor: request.unitPriceMinor,
    currency: request.currency,
    quantityAvailable: request.quantityAvailable,
    inventoryMode: assertInventoryMode(request.inventoryMode, 'inventoryMode'),
    attributes: request.attributes,
    publishedAt: request.publishedAt,
    correlationId: request.correlationId,
    idempotencyKey: request.idempotencyKey,
  });
}

function availabilityFromSnapshot(snapshot: InventorySnapshot | null): InventoryAvailability {
  if (snapshot === null) {
    return { onHand: 0n, reserved: 0n, committed: 0n, available: 0n };
  }
  return {
    onHand: snapshot.onHand,
    reserved: snapshot.reserved,
    committed: snapshot.committed,
    available: snapshot.onHand - snapshot.reserved,
  };
}

/**
 * Whether two movements are the same request, for idempotency.
 *
 * **Neither `correlationId` nor `occurredAt` is compared, and that is the whole point of this
 * comment.** A retry is a different request that means the same thing: it arrives later, so its
 * instant differs, and it carries a fresh correlation id by definition. Comparing either made the
 * second attempt at an identical reservation fail as `idempotency-key-reuse` — so a client that
 * retried a timed-out "add this line to my order" was told it had reused its key, and the honest
 * fix from the client's side would have been to send a *new* key, which would have reserved the
 * stock twice.
 *
 * M-11, M-12 and M-13 each shipped exactly this defect and each had it corrected; M-04 kept it
 * until the reservation flow started retrying through the API. An idempotency check compares what
 * the caller **meant**, never the trace it happened to arrive under.
 */
function inventoryMovementEquals(a: InventoryMovement, b: InventoryMovement): boolean {
  return (
    a.movementId === b.movementId &&
    a.listingId === b.listingId &&
    a.versionId === b.versionId &&
    a.kind === b.kind &&
    a.quantity === b.quantity &&
    a.reservationId === b.reservationId &&
    a.reason === b.reason &&
    a.idempotencyKey === b.idempotencyKey
  );
}
