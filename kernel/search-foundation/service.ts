/**
 * K-15 Search Foundation — the service.
 *
 * Three operations:
 *
 *   `index` — index or re-index a document by `documentId`, with idempotency and deduplication.
 *   `query` — search documents by keyword with filters and pagination, logging the query.
 *   `remove` — remove a document by `documentId`, idempotently.
 *
 * Deterministic by construction: the caller supplies the identifiers and the instants. Nothing here
 * reads a clock or generates randomness.
 *
 * Owned by: K-15 Search Foundation.
 */

import { InvalidInstantError, parseInstant } from '../../platform/time/instant.ts';

import {
  makeSearchIndexedAction,
  makeSearchIndexedEvent,
  makeSearchPerformedAction,
  makeSearchPerformedEvent,
  makeSearchRemovedAction,
  makeSearchRemovedEvent,
} from './outbox.ts';
import { FOREIGN_FIELDS, assertSearchIdentifier } from './registry.ts';
import type {
  SearchFilters,
  SearchOptions,
  SearchRepository,
  SearchTransaction,
} from './repository.ts';
import { sealSearchDocument, sealSearchDocuments, sealSearchQueryLog } from './immutable.ts';
import { validateSearchDocument, validateSearchQueryLog } from './validate.ts';
import {
  SearchError,
  type SearchDocument,
  type SearchErrorCode,
  type SearchQueryLog,
} from './types.ts';

export interface IndexRequest {
  readonly documentId: string;
  readonly ownerType: string;
  readonly ownerId: string;
  readonly scope: string;
  readonly language: string;
  readonly title: string;
  readonly description: string;
  readonly keywords: readonly string[];
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly vectors: Readonly<Record<string, unknown>>;
  readonly ranking: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly idempotencyKey: string;
}

export interface IndexResult {
  readonly document: SearchDocument;
  readonly deduplicated: boolean;
}

export interface QueryRequest {
  readonly queryId: string;
  readonly queryText: string;
  readonly filters?: Readonly<Record<string, unknown>>;
  readonly limit?: number;
  readonly offset?: number;
  readonly executedAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
}

export interface QueryResult {
  readonly queryId: string;
  readonly results: readonly SearchDocument[];
  readonly total: number;
  readonly hasMore: boolean;
}

export interface RemoveRequest {
  readonly documentId: string;
  readonly removedAt: string;
  readonly idempotencyKey: string;
}

export interface RemoveResult {
  readonly removed: boolean;
  readonly deduplicated: boolean;
}

const INDEX_KEYS: readonly string[] = [
  'documentId',
  'ownerType',
  'ownerId',
  'scope',
  'language',
  'title',
  'description',
  'keywords',
  'attributes',
  'vectors',
  'ranking',
  'createdAt',
  'updatedAt',
  'idempotencyKey',
];

const QUERY_KEYS: readonly string[] = [
  'queryId',
  'queryText',
  'filters',
  'limit',
  'offset',
  'executedAt',
  'correlationId',
  'idempotencyKey',
];

const REMOVE_KEYS: readonly string[] = ['documentId', 'removedAt', 'idempotencyKey'];

export class SearchService {
  readonly #repository: SearchRepository;

  constructor(repository: SearchRepository) {
    this.#repository = repository;
  }

  /**
   * Index or re-index a document.
   *
   * Validates, checks idempotency by key, and upserts by `documentId`. Identical content under the
   * same key or the same id returns deduplicated. Different content under the same key is refused.
   * Different content under the same id updates the stored document.
   */
  async index(request: IndexRequest): Promise<IndexResult> {
    assertNoForeignConcerns(request, INDEX_KEYS, 'index');
    const document = sealSearchDocument(
      validateSearchDocument(
        {
          documentId: request.documentId,
          ownerType: request.ownerType,
          ownerId: request.ownerId,
          scope: request.scope,
          language: request.language,
          title: request.title,
          description: request.description,
          keywords: request.keywords,
          attributes: request.attributes,
          vectors: request.vectors,
          ranking: request.ranking,
          createdAt: request.createdAt,
          updatedAt: request.updatedAt,
          idempotencyKey: request.idempotencyKey,
        },
        'request',
      ),
    );

    try {
      return await this.#index(document);
    } catch (error) {
      const conflicted = error instanceof SearchError && error.code === 'idempotency-key-reuse';
      if (!conflicted) throw error;

      const winner = await this.#repository.withTransaction((tx) =>
        tx.findDocumentByIdempotencyKey(document.idempotencyKey),
      );
      if (winner === null || !documentEquals(winner, document)) throw error;
      return { document: sealSearchDocument(winner), deduplicated: true };
    }
  }

  async #index(document: SearchDocument): Promise<IndexResult> {
    return this.#repository.withTransaction(async (tx) => {
      const existingKey = await tx.findDocumentByIdempotencyKey(document.idempotencyKey);
      if (existingKey !== null) {
        if (!documentEquals(existingKey, document)) {
          throw new SearchError(
            'idempotency-key-reuse',
            `idempotency key "${document.idempotencyKey}" has already been used for a different document`,
          );
        }
        return { document: sealSearchDocument(existingKey), deduplicated: true };
      }

      const existingId = await tx.findDocumentById(document.documentId);
      if (existingId !== null) {
        if (documentEquals(existingId, document)) {
          return { document: sealSearchDocument(existingId), deduplicated: true };
        }
        // Update: replace the stored document with the new version.
        await tx.insertDocument(document);
        await this.#emitIndexed(document, tx);
        return { document, deduplicated: false };
      }

      await tx.insertDocument(document);
      await this.#emitIndexed(document, tx);
      return { document, deduplicated: false };
    });
  }

  async #emitIndexed(document: SearchDocument, tx: SearchTransaction): Promise<void> {
    const correlationId = document.documentId;
    const causationId: string | null = null;
    await tx.insertOutbox(makeSearchIndexedEvent(document, correlationId, causationId));
    await tx.insertOutbox(makeSearchIndexedAction(document, correlationId, causationId));
  }

  /**
   * Search documents by keyword, with filters and pagination.
   *
   * Validates, executes the search, logs the query, and emits a K-08 event and a K-09 audit record.
   * A retry with the same idempotency key or query id returns the same search results without
   * writing a second log row or emitting a second event.
   */
  async query(request: QueryRequest): Promise<QueryResult> {
    assertNoForeignConcerns(request, QUERY_KEYS, 'query');
    const options = paginationOf(request.limit, request.offset);
    const filters = parseFilters(request.filters ?? {});

    const pendingLog = sealSearchQueryLog(
      validateSearchQueryLog(
        {
          queryId: request.queryId,
          queryText: request.queryText,
          filters: request.filters ?? {},
          resultCount: 0,
          executedAt: request.executedAt,
          correlationId: request.correlationId,
          idempotencyKey: request.idempotencyKey,
        },
        'request',
      ),
    );

    try {
      return await this.#query(pendingLog, filters, options);
    } catch (error) {
      const conflicted =
        error instanceof SearchError &&
        (error.code === 'idempotency-key-reuse' || error.code === 'duplicate-query-id');
      if (!conflicted) throw error;

      const winner = await this.#findConflictingQueryLog(pendingLog, error.code);
      if (winner === null || !queryLogEquals(winner, pendingLog)) throw error;

      const { documents, total } = await this.#repository.withTransaction((tx) =>
        tx.searchDocuments(pendingLog.queryText, filters, options),
      );
      return {
        queryId: winner.queryId,
        results: sealSearchDocuments(documents),
        total,
        hasMore: total > options.offset + documents.length,
      };
    }
  }

  async #findConflictingQueryLog(
    log: SearchQueryLog,
    code: SearchErrorCode,
  ): Promise<SearchQueryLog | null> {
    if (code === 'idempotency-key-reuse') {
      return this.#repository.withTransaction((tx) =>
        tx.findQueryLogByIdempotencyKey(log.idempotencyKey),
      );
    }
    return this.#repository.withTransaction((tx) => tx.findQueryLogById(log.queryId));
  }

  async #query(
    pendingLog: SearchQueryLog,
    filters: SearchFilters,
    options: SearchOptions,
  ): Promise<QueryResult> {
    return this.#repository.withTransaction(async (tx) => {
      const existingKey = await tx.findQueryLogByIdempotencyKey(pendingLog.idempotencyKey);
      if (existingKey !== null) {
        if (!queryLogEquals(existingKey, pendingLog)) {
          throw new SearchError(
            'idempotency-key-reuse',
            `idempotency key "${pendingLog.idempotencyKey}" has already been used for a different query`,
          );
        }
        throw new SearchError(
          'idempotency-key-reuse',
          `query ${existingKey.queryId} was already logged under idempotency key "${pendingLog.idempotencyKey}"`,
        );
      }

      const existingId = await tx.findQueryLogById(pendingLog.queryId);
      if (existingId !== null) {
        if (queryLogEquals(existingId, pendingLog)) {
          throw new SearchError(
            'duplicate-query-id',
            `query ${pendingLog.queryId} has already been logged with the same content`,
          );
        }
        throw new SearchError(
          'duplicate-query-id',
          `query ${pendingLog.queryId} already exists. A query log is created once and never rewritten`,
        );
      }

      const { documents, total } = await tx.searchDocuments(pendingLog.queryText, filters, options);
      const log = sealSearchQueryLog({ ...pendingLog, resultCount: documents.length });
      await tx.insertQueryLog(log);

      const causationId: string | null = null;
      await tx.insertOutbox(makeSearchPerformedEvent(log, causationId));
      await tx.insertOutbox(makeSearchPerformedAction(log, causationId));

      return {
        queryId: log.queryId,
        results: sealSearchDocuments(documents),
        total,
        hasMore: total > options.offset + documents.length,
      };
    });
  }

  /**
   * Remove a document by `documentId`.
   *
   * Validates, removes the document if it exists, and emits a K-08 event and a K-09 audit record.
   * Removing a document that is already absent is idempotent and returns `deduplicated: true`.
   */
  async remove(request: RemoveRequest): Promise<RemoveResult> {
    assertNoForeignConcerns(request, REMOVE_KEYS, 'remove');
    assertSearchIdentifier(request.documentId, 'documentId');
    const removedAt = parseAndCheckInstant(request.removedAt, 'removedAt');
    const idempotencyKey = assertSearchIdentifier(request.idempotencyKey, 'idempotencyKey');

    return this.#repository.withTransaction(async (tx) => {
      const existing = await tx.findDocumentById(request.documentId);
      if (existing === null) {
        return { removed: false, deduplicated: true };
      }

      await tx.deleteDocument(request.documentId);

      const correlationId = request.documentId;
      const causationId: string | null = null;
      await tx.insertOutbox(
        makeSearchRemovedEvent(
          request.documentId,
          idempotencyKey,
          removedAt,
          correlationId,
          causationId,
        ),
      );
      await tx.insertOutbox(
        makeSearchRemovedAction(
          request.documentId,
          idempotencyKey,
          removedAt,
          correlationId,
          causationId,
        ),
      );

      return { removed: true, deduplicated: false };
    });
  }
}

function paginationOf(limit: number | undefined, offset: number | undefined): SearchOptions {
  const resolvedLimit = clampLimit(limit ?? 20);
  const resolvedOffset = clampOffset(offset ?? 0);
  return { limit: resolvedLimit, offset: resolvedOffset };
}

function clampLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1) return 20;
  if (value > 100) return 100;
  return value;
}

function clampOffset(value: number): number {
  if (!Number.isInteger(value) || value < 0) return 0;
  return value;
}

function parseFilters(raw: Readonly<Record<string, unknown>>): SearchFilters {
  const { ownerType, scope, language, ...attributes } = raw;
  const filters: Record<string, unknown> = {};
  if (ownerType !== undefined) filters.ownerType = assertFilterText(ownerType, 'ownerType');
  if (scope !== undefined) filters.scope = assertFilterText(scope, 'scope');
  if (language !== undefined) filters.language = assertFilterText(language, 'language');
  if (Object.keys(attributes).length > 0) filters.attributes = attributes;
  return filters;
}

function assertFilterText(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new SearchError('malformed-record', `${field} is ${typeof value}; expected text`);
  }
  return value;
}

function assertNoForeignConcerns(
  request: object,
  permitted: readonly string[],
  operation: string,
): void {
  if (request === null || typeof request !== 'object') {
    throw new SearchError(
      'malformed-record',
      `${operation} needs a request object, got ${request === null ? 'null' : typeof request}`,
    );
  }

  for (const key of Object.keys(request)) {
    if (permitted.includes(key)) continue;

    const owner = FOREIGN_FIELDS[key];
    if (owner !== undefined) {
      throw new SearchError(
        'foreign-concern',
        `${operation} carried "${key}", but ${owner}. A search record carries only what K-15 owns`,
      );
    }
    throw new SearchError(
      'foreign-concern',
      `${operation} carried the unrecognised field "${key}". The permitted fields are ` +
        `${permitted.join(', ')}; anything else would be accepted and silently dropped`,
    );
  }
}

function parseAndCheckInstant(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new SearchError(
      'malformed-instant',
      `${field} is ${value === null ? 'null' : typeof value}; expected a UTC instant string`,
    );
  }
  try {
    return parseInstant(value).source;
  } catch (error) {
    if (error instanceof InvalidInstantError) {
      throw new SearchError('malformed-instant', `${field}: ${error.message}`);
    }
    throw error;
  }
}

function documentEquals(a: SearchDocument, b: SearchDocument): boolean {
  return (
    a.documentId === b.documentId &&
    a.ownerType === b.ownerType &&
    a.ownerId === b.ownerId &&
    a.scope === b.scope &&
    a.language === b.language &&
    a.title === b.title &&
    a.description === b.description &&
    arraysEqual(a.keywords, b.keywords) &&
    JSON.stringify(a.attributes) === JSON.stringify(b.attributes) &&
    JSON.stringify(a.vectors) === JSON.stringify(b.vectors) &&
    JSON.stringify(a.ranking) === JSON.stringify(b.ranking) &&
    a.createdAt === b.createdAt &&
    a.updatedAt === b.updatedAt
  );
}

function queryLogEquals(a: SearchQueryLog, b: SearchQueryLog): boolean {
  return (
    a.queryId === b.queryId &&
    a.queryText === b.queryText &&
    JSON.stringify(a.filters) === JSON.stringify(b.filters) &&
    a.executedAt === b.executedAt &&
    a.correlationId === b.correlationId
  );
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
