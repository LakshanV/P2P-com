/**
 * K-15 Search Foundation — the immutability boundary.
 *
 * Every record that crosses a service or repository boundary is deep-frozen and cloned, so a caller
 * cannot edit what was stored. Query logs are append-only, and documents are replaced whole by
 * `documentId`; the only defence against silent mutation at the boundary is to make mutation throw.
 *
 * Owned by: K-15 Search Foundation.
 */

import type { SearchDocument, SearchQueryLog } from './types.ts';

function sealRecord(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return Object.freeze(value.map(sealRecord));
  }
  const copy: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    copy[key] = sealRecord(entry);
  }
  return Object.freeze(copy);
}

/** A deep, frozen copy of a search document. */
export function sealSearchDocument(document: SearchDocument): SearchDocument {
  return Object.freeze({
    documentId: document.documentId,
    ownerType: document.ownerType,
    ownerId: document.ownerId,
    scope: document.scope,
    language: document.language,
    title: document.title,
    description: document.description,
    keywords: sealRecord(document.keywords) as readonly string[],
    attributes: sealRecord(document.attributes) as Readonly<Record<string, unknown>>,
    vectors: sealRecord(document.vectors) as Readonly<Record<string, unknown>>,
    ranking: sealRecord(document.ranking) as Readonly<Record<string, unknown>>,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
    idempotencyKey: document.idempotencyKey,
  });
}

/** A deep, frozen copy of a query log record. */
export function sealSearchQueryLog(log: SearchQueryLog): SearchQueryLog {
  return Object.freeze({
    queryId: log.queryId,
    queryText: log.queryText,
    filters: sealRecord(log.filters) as Readonly<Record<string, unknown>>,
    resultCount: log.resultCount,
    executedAt: log.executedAt,
    correlationId: log.correlationId,
    idempotencyKey: log.idempotencyKey,
  });
}

/** Frozen copies of a list of documents. */
export function sealSearchDocuments(
  documents: readonly SearchDocument[],
): readonly SearchDocument[] {
  return Object.freeze(documents.map(sealSearchDocument));
}

/** Frozen copies of a list of query logs. */
export function sealSearchQueryLogs(logs: readonly SearchQueryLog[]): readonly SearchQueryLog[] {
  return Object.freeze(logs.map(sealSearchQueryLog));
}

/** Is this document sealed all the way down? */
export function isSearchDocumentSealed(document: SearchDocument): boolean {
  return (
    Object.isFrozen(document) &&
    Object.isFrozen(document.keywords) &&
    Object.isFrozen(document.attributes) &&
    Object.isFrozen(document.vectors) &&
    Object.isFrozen(document.ranking)
  );
}

/** Is this query log sealed all the way down? */
export function isSearchQueryLogSealed(log: SearchQueryLog): boolean {
  return Object.isFrozen(log) && Object.isFrozen(log.filters);
}
