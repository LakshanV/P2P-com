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
  LISTING_STATUSES,
  MEDIA_KINDS,
  UniversalListingError,
} from './types.ts';
export type {
  DeclarationKind,
  Listing,
  ListingDeclaration,
  ListingMedia,
  ListingStatus,
  ListingVersion,
  MediaKind,
  UniversalListingErrorCode,
} from './types.ts';

export {
  FOREIGN_FIELDS,
  IDENTIFIER_REFUSALS,
  assertDeclarationKind,
  assertListingStatus,
  assertMediaKind,
  assertUniversalListingIdentifier,
} from './registry.ts';

export {
  isListingDeclarationSealed,
  isListingMediaSealed,
  isListingSealed,
  isListingVersionSealed,
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
  validateListing,
  validateListingDeclaration,
  validateListingMedia,
  validateListingVersion,
} from './validate.ts';
export type { RecordSource } from './validate.ts';

export { UniversalListingService } from './service.ts';
export type {
  AddDeclarationRequest,
  AddDeclarationResult,
  AddMediaRequest,
  AddMediaResult,
  CreateListingRequest,
  CreateListingResult,
  PublishListingRequest,
  PublishListingResult,
  SuspendListingRequest,
  SuspendListingResult,
  WithdrawListingRequest,
  WithdrawListingResult,
} from './service.ts';

export { InMemoryUniversalListingRepository } from './repository.ts';
export type { UniversalListingRepository, UniversalListingTransaction } from './repository.ts';

export {
  EnlistedUniversalListingRepository,
  LISTING_DECLARATION_TABLE,
  LISTING_MEDIA_TABLE,
  LISTING_TABLE,
  LISTING_VERSION_TABLE,
  OUTBOX_TABLE,
  PostgresUniversalListingRepository,
  TIMESTAMP_COLUMNS,
  UNIVERSAL_LISTING_SCHEMA,
  enlistedClient,
  toListing,
  toListingDeclaration,
  toListingMedia,
  toListingVersion,
} from './postgres-repository.ts';

export {
  LISTING_CREATED_ACTION,
  LISTING_CREATED_EVENT,
  LISTING_PUBLISHED_ACTION,
  LISTING_PUBLISHED_EVENT,
  LISTING_SUSPENDED_ACTION,
  LISTING_SUSPENDED_EVENT,
  LISTING_WITHDRAWN_ACTION,
  LISTING_WITHDRAWN_EVENT,
  makeListingCreatedAction,
  makeListingCreatedEvent,
  makeListingPublishedAction,
  makeListingPublishedEvent,
  makeListingSuspendedAction,
  makeListingSuspendedEvent,
  makeListingWithdrawnAction,
  makeListingWithdrawnEvent,
} from './outbox.ts';
