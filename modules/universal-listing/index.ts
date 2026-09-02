/**
 * M-04 Universal Listing — slice A public surface.
 *
 * Everything another unit may depend on is re-exported here. Anything not listed is internal and may
 * change without notice.
 *
 * M-04 owns the listing lifecycle, its immutable versions, and the media and declarations pinned to
 * each version. It depends on the platform substrate and K-03 Accounts (for identifier rules and the
 * account reference). It does not import any other business module.
 *
 * Owned by: M-04 Universal Listing.
 */

export {
  DECLARATION_KINDS,
  INVENTORY_MODES,
  LISTING_STATUSES,
  requiresReservation,
  MEDIA_KINDS,
  MOVEMENT_KINDS,
  UniversalListingError,
} from './types.ts';
export type {
  DeclarationKind,
  InventoryAvailability,
  InventoryMovement,
  InventorySnapshot,
  Listing,
  ListingDeclaration,
  ListingMedia,
  InventoryMode,
  ListingStatus,
  ListingVersion,
  MediaKind,
  MovementKind,
  UniversalListingErrorCode,
} from './types.ts';

export {
  FOREIGN_FIELDS,
  IDENTIFIER_REFUSALS,
  assertDeclarationKind,
  assertInventoryMode,
  assertListingStatus,
  assertMediaKind,
  assertMovementKind,
  assertUniversalListingIdentifier,
} from './registry.ts';

export {
  isInventoryMovementSealed,
  isInventorySnapshotSealed,
  isListingDeclarationSealed,
  isListingMediaSealed,
  isListingSealed,
  isListingVersionSealed,
  sealInventoryMovement,
  sealInventoryMovements,
  sealInventorySnapshot,
  sealListing,
  sealListingDeclaration,
  sealListingDeclarations,
  sealListingMedia,
  sealListingMedias,
  sealListings,
  sealListingVersion,
  sealListingVersions,
} from './immutable.ts';

export {
  validateInventoryMovement,
  validateInventorySnapshot,
  validateListing,
  validateListingDeclaration,
  validateListingMedia,
  validateListingVersion,
} from './validate.ts';
export type { RecordSource } from './validate.ts';

export { DEFAULT_RECALL_LIMIT, MAXIMUM_RECALL_LIMIT, UniversalListingService } from './service.ts';
export type {
  AddDeclarationRequest,
  AddDeclarationResult,
  AddMediaRequest,
  AddMediaResult,
  AdjustInventoryRequest,
  AdjustInventoryResult,
  CommitInventoryRequest,
  CommitInventoryResult,
  CreateListingRequest,
  CreateListingResult,
  PublishListingRequest,
  PublishListingResult,
  ReceiveInventoryRequest,
  ReceiveInventoryResult,
  ReleaseInventoryRequest,
  ReleaseInventoryResult,
  ReserveInventoryRequest,
  ReserveInventoryResult,
  SuspendListingRequest,
  SuspendListingResult,
  WithdrawListingRequest,
  WithdrawListingResult,
} from './service.ts';

export { InMemoryUniversalListingRepository } from './repository.ts';
export type {
  PublishedVersion,
  UniversalListingRepository,
  UniversalListingTransaction,
} from './repository.ts';

export {
  EnlistedUniversalListingRepository,
  INVENTORY_MOVEMENT_TABLE,
  INVENTORY_SNAPSHOT_TABLE,
  LISTING_DECLARATION_TABLE,
  LISTING_MEDIA_TABLE,
  LISTING_TABLE,
  LISTING_VERSION_TABLE,
  OUTBOX_TABLE,
  PostgresUniversalListingRepository,
  TIMESTAMP_COLUMNS,
  UNIVERSAL_LISTING_SCHEMA,
  enlistedClient,
  toInventoryMovement,
  toInventorySnapshot,
  toListing,
  toListingDeclaration,
  toListingMedia,
  toListingVersion,
} from './postgres-repository.ts';

export {
  INVENTORY_ADJUSTED_ACTION,
  INVENTORY_ADJUSTED_EVENT,
  INVENTORY_COMMITTED_ACTION,
  INVENTORY_COMMITTED_EVENT,
  INVENTORY_RECEIVED_ACTION,
  INVENTORY_RECEIVED_EVENT,
  INVENTORY_RELEASED_ACTION,
  INVENTORY_RELEASED_EVENT,
  INVENTORY_RESERVED_ACTION,
  INVENTORY_RESERVED_EVENT,
  LISTING_CREATED_ACTION,
  LISTING_CREATED_EVENT,
  LISTING_PUBLISHED_ACTION,
  LISTING_PUBLISHED_EVENT,
  LISTING_SUSPENDED_ACTION,
  LISTING_SUSPENDED_EVENT,
  LISTING_WITHDRAWN_ACTION,
  LISTING_WITHDRAWN_EVENT,
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
