/**
 * K-15 Search Foundation — domain types.
 *
 * Index abstraction, query primitives and ranking hooks for keyword, semantic, structured and
 * visual search aggregation. This component owns the search document and the query log; it does not
 * own the entities the documents describe, nor the AI providers that may produce embeddings.
 *
 * Deterministic by construction: the caller supplies every identifier and every instant. Nothing
 * here reads a clock or generates randomness.
 *
 * Owned by: K-15 Search Foundation.
 */

/** A document owner type is a vocabulary word, not a foreign key into another component. */
export const OWNER_TYPES = ['listing', 'product', 'supplier', 'need'] as const;
export type OwnerType = (typeof OWNER_TYPES)[number];

/** Search scope vocabulary. */
export const SCOPES = ['public', 'buyer', 'seller'] as const;
export type Scope = (typeof SCOPES)[number];

/** Supported content languages for the first slice. */
export const LANGUAGES = ['en', 'si', 'ta'] as const;
export type Language = (typeof LANGUAGES)[number];

/**
 * A searchable document.
 *
 * The document is an index abstraction: it carries enough text, structured facets and optional
 * embedding buckets for a consumer to search it, but it does not carry the full state of the thing
 * it describes. A document may be updated by `documentId`; earlier versions remain in storage but are
 * not returned by queries.
 */
export interface SearchDocument {
  /** Caller-supplied, opaque and stable. */
  readonly documentId: string;
  /** Who owns the document in search vocabulary (e.g. `listing`, `product`). Not a foreign key. */
  readonly ownerType: string;
  /** The opaque identifier of the owning entity in its own component. */
  readonly ownerId: string;
  /** Search scope. */
  readonly scope: string;
  /** Content language. */
  readonly language: string;
  /** Searchable title. */
  readonly title: string;
  /** Searchable description. */
  readonly description: string;
  /** Searchable keyword list. */
  readonly keywords: readonly string[];
  /** Structured facets (e.g. category, price range). */
  readonly attributes: Readonly<Record<string, unknown>>;
  /** Optional embedding buckets for semantic or visual search. */
  readonly vectors: Readonly<Record<string, unknown>>;
  /** Static ranking signals supplied by the caller. */
  readonly ranking: Readonly<Record<string, unknown>>;
  /** When the document was first indexed, as a canonical UTC instant. */
  readonly createdAt: string;
  /** When this version of the document was written, as a canonical UTC instant. */
  readonly updatedAt: string;
  /** Stable across retries of one logical index request. */
  readonly idempotencyKey: string;
}

/**
 * A recorded query.
 *
 * Query logs are append-only. The result count is the number of results returned for this query,
 * not a rolled-up statistic.
 */
export interface SearchQueryLog {
  /** Caller-supplied, opaque and stable. */
  readonly queryId: string;
  /** The text the caller searched for. */
  readonly queryText: string;
  /** The structured filters supplied with the query. */
  readonly filters: Readonly<Record<string, unknown>>;
  /** The number of results returned. */
  readonly resultCount: number;
  /** When the query was executed, as a canonical UTC instant. */
  readonly executedAt: string;
  /** Correlates the query with the caller's request trace. */
  readonly correlationId: string;
  /** Stable across retries of one logical query. */
  readonly idempotencyKey: string;
}

export type SearchErrorCode =
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
  /** A query id already exists with different content. */
  | 'duplicate-query-id'
  /** An enlisted write tried to issue transaction control. */
  | 'nested-transaction';

/** A refusal the caller must act on. */
export class SearchError extends Error {
  readonly code: SearchErrorCode;

  constructor(code: SearchErrorCode, message: string) {
    super(message);
    this.name = 'SearchError';
    this.code = code;
  }
}
