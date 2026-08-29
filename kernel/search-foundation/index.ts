/**
 * K-15 Search Foundation — public surface.
 *
 * Everything another unit may depend on is re-exported here. Anything not listed is internal and may
 * change without notice; see kernel/search-foundation/CONTRACT.md for the contract this fixes.
 *
 * K-15 owns the search document and query-log primitives. It depends only on the platform substrate,
 * K-08 Event Infrastructure and K-09 Audit Foundation. It does not import any business module,
 * financial module, AI gateway or notification module.
 *
 * Owned by: K-15 Search Foundation.
 */

export {
  LANGUAGES,
  OWNER_TYPES,
  SCOPES,
  SearchError,
  type Language,
  type OwnerType,
  type Scope,
  type SearchDocument,
  type SearchErrorCode,
  type SearchQueryLog,
} from './types.ts';

export { FOREIGN_FIELDS, assertSearchIdentifier } from './registry.ts';

export {
  isSearchDocumentSealed,
  isSearchQueryLogSealed,
  sealSearchDocument,
  sealSearchDocuments,
  sealSearchQueryLog,
  sealSearchQueryLogs,
} from './immutable.ts';

export { validateSearchDocument, validateSearchQueryLog } from './validate.ts';
export type { RecordSource } from './validate.ts';

export { SearchService } from './service.ts';
export type {
  IndexRequest,
  IndexResult,
  QueryRequest,
  QueryResult,
  RemoveRequest,
  RemoveResult,
} from './service.ts';

export { InMemorySearchRepository } from './repository.ts';
export type {
  SearchFilters,
  SearchOptions,
  SearchRepository,
  SearchResult,
  SearchTransaction,
} from './repository.ts';

export {
  DOCUMENT_TABLE,
  EnlistedSearchRepository,
  OUTBOX_TABLE,
  QUERY_LOG_TABLE,
  SEARCH_SCHEMA,
  PostgresSearchRepository,
  TIMESTAMP_COLUMNS,
  enlistedClient,
  toDocument,
  toQueryLog,
} from './postgres-repository.ts';

export {
  SEARCH_INDEXED_ACTION,
  SEARCH_INDEXED_EVENT,
  SEARCH_PERFORMED_ACTION,
  SEARCH_PERFORMED_EVENT,
  SEARCH_REMOVED_ACTION,
  SEARCH_REMOVED_EVENT,
  makeSearchIndexedAction,
  makeSearchIndexedEvent,
  makeSearchPerformedAction,
  makeSearchPerformedEvent,
  makeSearchRemovedAction,
  makeSearchRemovedEvent,
} from './outbox.ts';
