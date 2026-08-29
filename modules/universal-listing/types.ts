/**
 * M-04 Universal Listing — slices A and B domain types.
 *
 * A listing is a stable identity that offers one `CommerceUnit` type. What it offers changes by
 * version, never by edit. Slice A owns the listing lifecycle, the append-only version history, and
 * the media and declarations pinned to each version. Slice B owns the inventory interface: an
 * append-only movement log and a derived snapshot that makes the current position cheap to read.
 *
 * Deterministic by construction: the caller supplies every identifier and every instant. Nothing
 * here reads a clock or generates randomness.
 *
 * Owned by: M-04 Universal Listing.
 */

/** Lifecycle of a listing. */
export const LISTING_STATUSES = ['draft', 'published', 'suspended', 'withdrawn'] as const;
export type ListingStatus = (typeof LISTING_STATUSES)[number];

/** Kinds of media a listing may attach to a version. */
export const MEDIA_KINDS = ['image', 'video', 'document'] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

/** Kinds of declaration a supplier may make about a version. */
export const DECLARATION_KINDS = [
  'condition',
  'origin',
  'compliance',
  'warranty',
  'restriction',
] as const;
export type DeclarationKind = (typeof DECLARATION_KINDS)[number];

/**
 * The stable identity and current state of one listing.
 *
 * A listing is created as a draft, published one or more times, and may be suspended or withdrawn.
 * Withdrawal is terminal.
 */
export interface Listing {
  /** Caller-supplied opaque and stable identifier. */
  readonly listingId: string;
  /** The K-03 account that supplies this listing. Not a foreign key. */
  readonly accountId: string;
  /** The K-11 commerce unit type this listing offers. Not a foreign key. */
  readonly commerceUnitTypeId: string;
  /** Current lifecycle status. */
  readonly status: ListingStatus;
  /** The version currently on offer; 0 while the listing is still a draft. */
  readonly currentVersion: number;
  /** When the listing was created, as a canonical UTC instant. */
  readonly createdAt: string;
  /** When the listing was last changed, as a canonical UTC instant. */
  readonly updatedAt: string;
  /** Set when the listing is first published; null until then. */
  readonly publishedAt: string | null;
  /** Set when the listing is withdrawn; null until then. */
  readonly withdrawnAt: string | null;
  /** Correlates with the caller request trace. */
  readonly correlationId: string;
  /** Stable across retries of one logical request. */
  readonly idempotencyKey: string;
}

/**
 * One published version of a listing.
 *
 * Append-only. A version is what an order is placed against, so later versions do not rewrite it.
 */
export interface ListingVersion {
  /** Caller-supplied opaque and stable identifier. */
  readonly versionId: string;
  /** The listing this version belongs to. */
  readonly listingId: string;
  /** The version number within the listing, starting at 1. */
  readonly versionNumber: number;
  /** Short display name, 1-200 characters. */
  readonly title: string;
  /** Long description, 1-5000 characters. */
  readonly description: string;
  /** Price in integer minor units. */
  readonly unitPriceMinor: bigint;
  /** ISO-4217 currency code, exactly three uppercase letters. */
  readonly currency: string;
  /** How many units this version offers. */
  readonly quantityAvailable: bigint;
  /** Unit-type-specific facts supplied by the caller. */
  readonly attributes: Readonly<Record<string, unknown>>;
  /** When the version was published, as a canonical UTC instant. */
  readonly publishedAt: string;
  /** Correlates with the caller request trace. */
  readonly correlationId: string;
  /** Stable across retries of one logical request. */
  readonly idempotencyKey: string;
}

/**
 * One media reference attached to a listing version.
 *
 * Append-only. M-04 stores only an opaque reference to the artefact; it never stores the artefact
 * itself, a URL or a natural key.
 */
export interface ListingMedia {
  /** Caller-supplied opaque and stable identifier. */
  readonly mediaId: string;
  /** The listing this media belongs to. */
  readonly listingId: string;
  /** The version this media belongs to. */
  readonly versionId: string;
  /** What kind of media this is. */
  readonly kind: MediaKind;
  /** Opaque handle to the artefact held by another system. */
  readonly reference: string;
  /** Display order among media for the same version. */
  readonly position: number;
  /** Short caption, 1-500 characters. */
  readonly caption: string;
  /** When the media was added, as a canonical UTC instant. */
  readonly addedAt: string;
  /** Correlates with the caller request trace. */
  readonly correlationId: string;
  /** Stable across retries of one logical request. */
  readonly idempotencyKey: string;
}

/**
 * One declaration attached to a listing version.
 *
 * Append-only. These are the claims a dispute is later judged against, so they are immutable and
 * pinned to the version they were made against.
 */
export interface ListingDeclaration {
  /** Caller-supplied opaque and stable identifier. */
  readonly declarationId: string;
  /** The listing this declaration belongs to. */
  readonly listingId: string;
  /** The version this declaration belongs to. */
  readonly versionId: string;
  /** What kind of declaration this is. */
  readonly kind: DeclarationKind;
  /** What the supplier asserts, 1-2000 characters. */
  readonly statement: string;
  /** When the declaration was made, as a canonical UTC instant. */
  readonly declaredAt: string;
  /** Correlates with the caller request trace. */
  readonly correlationId: string;
  /** Stable across retries of one logical request. */
  readonly idempotencyKey: string;
}

/**
 * Kinds of inventory movement. The kind carries the direction; the quantity is always a positive
 * bigint.
 */
export const MOVEMENT_KINDS = [
  'receive',
  'adjust-up',
  'adjust-down',
  'reserve',
  'release',
  'commit',
] as const;
export type MovementKind = (typeof MOVEMENT_KINDS)[number];

/**
 * One append-only inventory movement. A movement is a fact; the current availability is derived from
 * the sum of every movement for a `(listingId, versionId)` pair.
 */
export interface InventoryMovement {
  /** Caller-supplied opaque identifier for the movement fact. */
  readonly movementId: string;
  /** The listing whose stock moved. */
  readonly listingId: string;
  /** The version the movement applies to. */
  readonly versionId: string;
  /** What kind of movement this is. */
  readonly kind: MovementKind;
  /** Always positive; the kind says which way the stock moves. */
  readonly quantity: bigint;
  /** Set for reserve, release and commit; null for receive and adjust. */
  readonly reservationId: string | null;
  /** Why the movement happened, 1-500 characters with at least one non-whitespace character. */
  readonly reason: string;
  /** When the movement happened, as a canonical UTC instant. */
  readonly occurredAt: string;
  /** Correlates with the caller request trace. */
  readonly correlationId: string;
  /** Stable across retries of one logical request. */
  readonly idempotencyKey: string;
}

/**
 * A derived cache of the movement sum for one `(listingId, versionId)` pair.
 *
 * The snapshot is written in the same transaction as the movement that changes it. `available` is
 * not stored; it is computed on read as `onHand - reserved`.
 */
export interface InventorySnapshot {
  readonly listingId: string;
  readonly versionId: string;
  readonly onHand: bigint;
  readonly reserved: bigint;
  readonly committed: bigint;
  readonly updatedAt: string;
  readonly correlationId: string;
}

/**
 * The availability derived from a snapshot. A listing that has never received stock reports all
 * zeroes.
 */
export interface InventoryAvailability {
  readonly onHand: bigint;
  readonly reserved: bigint;
  readonly committed: bigint;
  readonly available: bigint;
}

export type UniversalListingErrorCode =
  /** An identifier is not well formed. */
  | 'malformed-identifier'
  /** An identifier looks like a natural key. */
  | 'natural-identifier'
  /** An identifier names or looks like a credential. */
  | 'secret-bearing-input'
  /** The instant is not a real UTC instant. */
  | 'malformed-instant'
  /** A request carried a field belonging to another component. */
  | 'foreign-concern'
  /** A stored row, or a candidate record, is not what this component writes. */
  | 'malformed-record'
  /** The idempotency key was already used for a different record. */
  | 'idempotency-key-reuse'
  /** An enlisted write tried to issue transaction control. */
  | 'nested-transaction'
  /** A listing id already exists with different content. */
  | 'duplicate-listing-id'
  /** A version id already exists with different content. */
  | 'duplicate-version-id'
  /** A media id already exists with different content. */
  | 'duplicate-media-id'
  /** A declaration id already exists with different content. */
  | 'duplicate-declaration-id'
  /** The status is not one M-04 recognises. */
  | 'unknown-status'
  /** The media kind is not one M-04 recognises. */
  | 'unknown-media-kind'
  /** The declaration kind is not one M-04 recognises. */
  | 'unknown-declaration-kind'
  /** The inventory movement kind is not one M-04 recognises. */
  | 'unknown-movement-kind'
  /** The title is malformed. */
  | 'malformed-title'
  /** The description is malformed. */
  | 'malformed-description'
  /** The statement is malformed. */
  | 'malformed-statement'
  /** The caption is malformed. */
  | 'malformed-caption'
  /** The reference is not a valid opaque handle. */
  | 'malformed-reference'
  /** The currency is not a valid ISO-4217 code. */
  | 'malformed-currency'
  /** An amount is negative. */
  | 'negative-amount'
  /** A quantity is negative. */
  | 'negative-quantity'
  /** An inventory movement quantity is not a positive integer. */
  | 'negative-movement'
  /** A listing id already exists with different content on create. */
  | 'listing-already-exists'
  /** The listing id is unknown. */
  | 'listing-not-found'
  /** The listing has been withdrawn and refuses further operation. */
  | 'listing-withdrawn'
  /** The version id is unknown. */
  | 'version-not-found'
  /** The version is not the listing's current one. */
  | 'version-not-current'
  /** The version number conflicts with an existing version. */
  | 'version-number-conflict'
  /** The requested stock is not available. */
  | 'insufficient-stock'
  /** A movement id already exists with different content. */
  | 'duplicate-movement-id'
  /** A reservation id is unknown. */
  | 'reservation-not-found'
  /** A reservation has already been released or committed. */
  | 'reservation-not-open';

/** A refusal the caller must act on. */
export class UniversalListingError extends Error {
  readonly code: UniversalListingErrorCode;

  constructor(code: UniversalListingErrorCode, message: string) {
    super(message);
    this.name = 'UniversalListingError';
    this.code = code;
  }
}
