/**
 * Shared fixtures for the K-15 Search Foundation suites.
 */

import {
  InMemorySearchRepository,
  SearchService,
  type IndexRequest,
  type QueryRequest,
  type RemoveRequest,
  type SearchDocument,
  type SearchQueryLog,
} from '../../kernel/search-foundation/index.ts';

export interface Harness {
  readonly service: SearchService;
  readonly repository: InMemorySearchRepository;
}

export function build(): Harness {
  const repository = new InMemorySearchRepository();
  return { service: new SearchService(repository), repository };
}

let sequence = 0;

function seq(): string {
  sequence += 1;
  return String(sequence).padStart(4, '0');
}

export function indexRequest(overrides: Partial<IndexRequest> = {}): IndexRequest {
  const n = seq();
  return {
    documentId: `doc_01HQZX${n}`,
    ownerType: 'listing',
    ownerId: `own_01HQZX${n}`,
    scope: 'public',
    language: 'en',
    title: 'Handmade wooden table',
    description: 'A sturdy dining table made from reclaimed teak.',
    keywords: ['table', 'wood', 'furniture'],
    attributes: { category: 'furniture', condition: 'new' },
    vectors: {},
    ranking: { popularity: 10 },
    createdAt: '2026-04-01T12:00:00Z',
    updatedAt: '2026-04-01T12:00:00Z',
    idempotencyKey: `idem_doc_${n}`,
    ...overrides,
  };
}

export function documentRecord(overrides: Partial<SearchDocument> = {}): SearchDocument {
  const n = seq();
  return {
    documentId: `doc_01HQZY${n}`,
    ownerType: 'listing',
    ownerId: `own_01HQZY${n}`,
    scope: 'public',
    language: 'en',
    title: 'Handmade wooden table',
    description: 'A sturdy dining table made from reclaimed teak.',
    keywords: ['table', 'wood', 'furniture'],
    attributes: { category: 'furniture' },
    vectors: {},
    ranking: { popularity: 10 },
    createdAt: '2026-04-01T12:00:00Z',
    updatedAt: '2026-04-01T12:00:00Z',
    idempotencyKey: `idem_doc_${n}`,
    ...overrides,
  };
}

export function queryRequest(overrides: Partial<QueryRequest> = {}): QueryRequest {
  const n = seq();
  return {
    queryId: `qry_01HQZX${n}`,
    queryText: 'wooden table',
    filters: {},
    limit: 20,
    offset: 0,
    executedAt: '2026-04-01T12:00:10Z',
    correlationId: `corr_01HQZX${n}`,
    idempotencyKey: `idem_qry_${n}`,
    ...overrides,
  };
}

export function queryLogRecord(overrides: Partial<SearchQueryLog> = {}): SearchQueryLog {
  const n = seq();
  return {
    queryId: `qry_01HQZY${n}`,
    queryText: 'wooden table',
    filters: {},
    resultCount: 1,
    executedAt: '2026-04-01T12:00:10Z',
    correlationId: `corr_01HQZY${n}`,
    idempotencyKey: `idem_qry_${n}`,
    ...overrides,
  };
}

export function removeRequest(overrides: Partial<RemoveRequest> = {}): RemoveRequest {
  const n = seq();
  return {
    documentId: `doc_01HQZX${n}`,
    removedAt: '2026-04-01T12:00:20Z',
    idempotencyKey: `idem_remove_${n}`,
    ...overrides,
  };
}

export function documentRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    document_id: 'doc_01HQZXTESTROW',
    owner_type: 'listing',
    owner_id: 'own_01HQZXTESTROW',
    scope: 'public',
    language: 'en',
    title: 'Handmade wooden table',
    description: 'A sturdy dining table made from reclaimed teak.',
    keywords: ['table', 'wood', 'furniture'],
    attributes: { category: 'furniture' },
    vectors: {},
    ranking: { popularity: 10 },
    created_at: '2026-04-01T12:00:00.000000Z',
    updated_at: '2026-04-01T12:00:00.000000Z',
    idempotency_key: 'idem_doc_01HQZXTESTROW',
    ...overrides,
  };
}

export function queryLogRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    query_id: 'qry_01HQZXTESTROW',
    query_text: 'wooden table',
    filters: {},
    result_count: 1,
    executed_at: '2026-04-01T12:00:10.000000Z',
    correlation_id: 'corr_01HQZXTESTROW',
    idempotency_key: 'idem_qry_01HQZXTESTROW',
    ...overrides,
  };
}
