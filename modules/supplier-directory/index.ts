/**
 * M-48 Supplier & Merchant Directory — the public surface.
 *
 * Owned by: M-48 Supplier & Merchant Directory.
 */

export {
  DIRECTORY_KINDS,
  DIRECTORY_STATUSES,
  DIRECTORY_TRANSITIONS,
  DirectoryError,
  FACET_KINDS,
  FACET_STATUSES,
} from './types.ts';
export type {
  DirectoryEntry,
  DirectoryErrorCode,
  DirectoryEvent,
  DirectoryKind,
  DirectoryProfile,
  DirectoryQuery,
  DirectoryStatus,
  FacetKind,
  FacetStatus,
  SupplierFacet,
  SupplierLocation,
} from './types.ts';

export {
  FOREIGN_FIELDS,
  IDENTIFIER_REFUSALS,
  MAXIMUM_NAME_LENGTH,
  MINIMUM_REASON_LENGTH,
  assertCapacity,
  assertCode,
  assertDirectoryIdentifier,
  assertDirectoryKind,
  assertDirectoryStatus,
  assertFacetKind,
  assertFacetStatus,
  assertName,
  assertReason,
} from './registry.ts';

export {
  STORED_ROW_NOTE,
  validateDirectoryEvent,
  validateEntry,
  validateFacet,
  validateLocation,
} from './validate.ts';
export type { RecordSource } from './validate.ts';

export {
  sealDirectoryEvent,
  sealDirectoryEvents,
  sealEntries,
  sealEntry,
  sealFacet,
  sealFacets,
  sealLocation,
  sealLocations,
  sealProfile,
  sealProfiles,
} from './immutable.ts';

export { DirectoryService } from './service.ts';
export type {
  AddLocationRequest,
  AvailabilityRequest,
  CloseLocationRequest,
  DeclareFacetRequest,
  EntryResult,
  FacetResult,
  LocationResult,
  RegisterRequest,
  TransitionRequest,
  WithdrawFacetRequest,
} from './service.ts';

export { InMemoryDirectoryRepository } from './repository.ts';
export type { DirectoryRepository, DirectoryTransaction } from './repository.ts';

export {
  SUPPLIER_ACTION,
  SUPPLIER_ACTIVATED_EVENT,
  SUPPLIER_CLOSED_EVENT,
  SUPPLIER_REGISTERED_EVENT,
  SUPPLIER_SUSPENDED_EVENT,
} from './outbox.ts';

export {
  DIRECTORY_SCHEMA,
  ENTRY_TABLE,
  EnlistedDirectoryRepository,
  FACET_TABLE,
  LOCATION_TABLE,
  PostgresDirectoryRepository,
  toDirectoryEvent,
  toEntry,
  toFacet,
  toLocation,
} from './postgres-repository.ts';
