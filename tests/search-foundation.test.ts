/**
 * K-15 Search Foundation — contract tests.
 *
 * Proves the public API, every refusal, idempotency, updates, ranking, pagination and the fact that
 * the component carries no business-module fields.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FOREIGN_FIELDS,
  SearchError,
  type SearchService,
  type SearchDocument,
} from '../kernel/search-foundation/index.ts';

import {
  build,
  indexRequest,
  queryRequest,
  removeRequest,
} from './helpers/search-foundation-fixtures.ts';

const codeOf = (error: unknown): string | undefined =>
  error instanceof SearchError ? error.code : undefined;

// ---------------------------------------------------------------------------
// index
// ---------------------------------------------------------------------------

test('index stores a document and returns it', async () => {
  const { service } = build();
  const request = indexRequest();
  const result = await service.index(request);

  assert.equal(result.deduplicated, false);
  assert.equal(result.document.documentId, request.documentId);
  assert.equal(result.document.title, request.title);
  assert.ok(Object.isFrozen(result.document));
  assert.ok(Object.isFrozen(result.document.keywords));
  assert.ok(Object.isFrozen(result.document.attributes));
});

test('index is idempotent for identical requests', async () => {
  const { service } = build();
  const request = indexRequest();
  const first = await service.index(request);
  const second = await service.index(request);

  assert.equal(first.document.documentId, second.document.documentId);
  assert.equal(second.deduplicated, true);
});

test('index returns deduplicated for the same document id and same content', async () => {
  const { service } = build();
  const first = indexRequest();
  await service.index(first);

  const second = indexRequest({
    ...first,
    idempotencyKey: 'idem_doc_different_but_same_content',
  });
  const result = await service.index(second);

  assert.equal(result.deduplicated, true);
  assert.equal(result.document.documentId, first.documentId);
});

test('index updates a document with different content by document id', async () => {
  const { service, repository } = build();
  const first = indexRequest({ title: 'Old title' });
  await service.index(first);

  const second = indexRequest({
    documentId: first.documentId,
    title: 'Updated title',
    idempotencyKey: 'idem_doc_update_0001',
    updatedAt: '2026-04-01T12:00:01Z',
  });
  const result = await service.index(second);

  assert.equal(result.deduplicated, false);
  assert.equal(result.document.title, 'Updated title');

  const stored = await repository.withTransaction((tx) => tx.findDocumentById(first.documentId));
  assert.equal(stored?.title, 'Updated title');
});

test('index refuses a reused idempotency key for different content', async () => {
  const { service } = build();
  const key = 'idem_reused_doc_0001';
  await service.index(indexRequest({ idempotencyKey: key }));

  await assert.rejects(
    service.index(indexRequest({ idempotencyKey: key, title: 'Different title' })),
    (error: unknown) => codeOf(error) === 'idempotency-key-reuse',
  );
});

test('index refuses a foreign field', async () => {
  const { service } = build();
  await assert.rejects(
    service.index({ ...indexRequest(), orderId: 'ord_12345678' } as unknown as ReturnType<
      typeof indexRequest
    >),
    (error: unknown) => codeOf(error) === 'foreign-concern',
  );
});

test('index refuses a malformed identifier', async () => {
  const { service } = build();
  await assert.rejects(
    service.index(indexRequest({ documentId: 'short' })),
    (error: unknown) => codeOf(error) === 'malformed-identifier',
  );
});

test('index refuses a malformed instant', async () => {
  const { service } = build();
  await assert.rejects(
    service.index(indexRequest({ updatedAt: 'tomorrow' })),
    (error: unknown) => codeOf(error) === 'malformed-instant',
  );
});

test('index emits an indexed event and audit action to the outbox', async () => {
  const { service, repository } = build();
  await service.index(indexRequest());

  const entries = repository.outbox().entries();
  assert.equal(entries.length, 2);
  assert.ok(entries.some((entry) => entry.kind === 'event' && entry.outboxId.includes(':indexed')));
  assert.ok(entries.some((entry) => entry.kind === 'audit' && entry.outboxId.includes(':indexed')));
});

test('updating a document emits a second indexed event', async () => {
  const { service, repository } = build();
  const first = indexRequest();
  await service.index(first);

  await service.index({
    ...first,
    title: 'Updated title',
    idempotencyKey: 'idem_doc_update_event_0001',
    updatedAt: '2026-04-01T12:00:01Z',
  });

  const events = repository
    .outbox()
    .entries()
    .filter((entry) => entry.kind === 'event' && entry.outboxId.includes(':indexed'));
  assert.equal(events.length, 2);
});

// ---------------------------------------------------------------------------
// query
// ---------------------------------------------------------------------------

async function seedDocuments(
  service: SearchService,
): Promise<{ chair: SearchDocument; table: SearchDocument }> {
  const chair = await service.index(
    indexRequest({
      documentId: 'doc_chair_01HQZX0001',
      ownerId: 'own_chair_01',
      title: 'Comfortable office chair',
      description: 'Ergonomic chair with lumbar support.',
      keywords: ['chair', 'office', 'furniture'],
      attributes: { category: 'furniture', material: 'mesh' },
      ranking: { score: 5 },
      idempotencyKey: 'idem_doc_chair_0001',
    }),
  );
  const table = await service.index(
    indexRequest({
      documentId: 'doc_table_01HQZX0001',
      ownerId: 'own_table_01',
      title: 'Handmade wooden table',
      description: 'A sturdy dining table made from reclaimed teak.',
      keywords: ['table', 'wood', 'dining'],
      attributes: { category: 'furniture', material: 'wood' },
      ranking: { score: 10 },
      idempotencyKey: 'idem_doc_table_0001',
    }),
  );
  return { chair: chair.document, table: table.document };
}

test('query returns matching documents', async () => {
  const { service } = build();
  await seedDocuments(service);

  const result = await service.query(queryRequest({ queryText: 'table' }));
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0]?.title, 'Handmade wooden table');
  assert.equal(result.total, 1);
  assert.equal(result.hasMore, false);
});

test('query ranks documents by keyword match relevance', async () => {
  const { service } = build();
  await service.index(
    indexRequest({
      documentId: 'doc_ranks_a',
      title: 'wood wood table table dining',
      description: 'irrelevant to the table query',
      keywords: [],
      idempotencyKey: 'idem_ranks_a',
    }),
  );
  await service.index(
    indexRequest({
      documentId: 'doc_ranks_b',
      title: 'table',
      description: 'also irrelevant to tables',
      keywords: [],
      idempotencyKey: 'idem_ranks_b',
    }),
  );

  const result = await service.query(queryRequest({ queryText: 'table' }));
  assert.equal(result.results[0]?.documentId, 'doc_ranks_a');
});

test('query filters by ownerType', async () => {
  const { service } = build();
  await service.index(
    indexRequest({
      documentId: 'doc_product_01',
      ownerType: 'product',
      ownerId: 'own_product_01',
      title: 'Product title',
      idempotencyKey: 'idem_doc_product_01',
    }),
  );
  await service.index(
    indexRequest({
      documentId: 'doc_listing_01',
      ownerType: 'listing',
      ownerId: 'own_listing_01',
      title: 'Listing title',
      idempotencyKey: 'idem_doc_listing_01',
    }),
  );

  const result = await service.query(
    queryRequest({ queryText: 'title', filters: { ownerType: 'product' } }),
  );
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0]?.ownerType, 'product');
});

test('query filters by scope', async () => {
  const { service } = build();
  await service.index(
    indexRequest({
      documentId: 'doc_public_01',
      scope: 'public',
      title: 'Public item',
      idempotencyKey: 'idem_doc_public_01',
    }),
  );
  await service.index(
    indexRequest({
      documentId: 'doc_seller_01',
      scope: 'seller',
      title: 'Seller item',
      idempotencyKey: 'idem_doc_seller_01',
    }),
  );

  const result = await service.query(
    queryRequest({ queryText: 'item', filters: { scope: 'seller' } }),
  );
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0]?.documentId, 'doc_seller_01');
});

test('query filters by language', async () => {
  const { service } = build();
  await service.index(
    indexRequest({
      documentId: 'doc_en_01',
      language: 'en',
      title: 'English item',
      idempotencyKey: 'idem_doc_en_01',
    }),
  );
  await service.index(
    indexRequest({
      documentId: 'doc_si_01',
      language: 'si',
      title: 'Sinhala item',
      idempotencyKey: 'idem_doc_si_01',
    }),
  );

  const result = await service.query(
    queryRequest({ queryText: 'item', filters: { language: 'si' } }),
  );
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0]?.language, 'si');
});

test('query filters by attribute equality', async () => {
  const { service } = build();
  await seedDocuments(service);

  const result = await service.query(
    queryRequest({ queryText: 'table', filters: { material: 'wood' } }),
  );
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0]?.documentId, 'doc_table_01HQZX0001');
});

test('query supports pagination', async () => {
  const { service } = build();
  for (let i = 0; i < 5; i += 1) {
    await service.index(
      indexRequest({
        documentId: `doc_page_${i}`,
        title: `Paginated item ${i}`,
        idempotencyKey: `idem_doc_page_${i}`,
      }),
    );
  }

  const first = await service.query(queryRequest({ queryText: 'item', limit: 2, offset: 0 }));
  assert.equal(first.results.length, 2);
  assert.equal(first.hasMore, true);

  const second = await service.query(queryRequest({ queryText: 'item', limit: 2, offset: 2 }));
  assert.equal(second.results.length, 2);
  assert.equal(second.hasMore, true);

  const third = await service.query(queryRequest({ queryText: 'item', limit: 2, offset: 4 }));
  assert.equal(third.results.length, 1);
  assert.equal(third.hasMore, false);
});

test('query logs the query and emits an event and audit action', async () => {
  const { service, repository } = build();
  await seedDocuments(service);

  await service.query(queryRequest({ queryText: 'table' }));
  assert.equal(repository.queryLogs().length, 1);

  const entries = repository.outbox().entries();
  assert.ok(
    entries.some((entry) => entry.kind === 'event' && entry.outboxId.includes(':performed')),
  );
  assert.ok(
    entries.some((entry) => entry.kind === 'audit' && entry.outboxId.includes(':performed')),
  );
});

test('query is idempotent for the same idempotency key', async () => {
  const { service, repository } = build();
  await seedDocuments(service);

  const request = queryRequest({ queryText: 'chair' });
  const first = await service.query(request);
  const before = repository.queryLogs().length;

  const second = await service.query(request);
  assert.equal(second.results.length, first.results.length);
  assert.equal(repository.queryLogs().length, before, 'a retry must not write another query log');

  const performedEvents = repository
    .outbox()
    .entries()
    .filter((entry) => entry.kind === 'event' && entry.outboxId.includes(':performed'));
  assert.equal(performedEvents.length, 1);
});

test('query is idempotent for the same query id and content', async () => {
  const { service, repository } = build();
  await seedDocuments(service);

  const request = queryRequest({ queryId: 'qry_same_id_01', queryText: 'chair' });
  const first = await service.query(request);
  const before = repository.queryLogs().length;

  const second = await service.query({ ...request, idempotencyKey: 'idem_qry_same_id_02' });
  assert.equal(second.results.length, first.results.length);
  assert.equal(repository.queryLogs().length, before);
});

test('query refuses a reused idempotency key for different content', async () => {
  const { service } = build();
  const key = 'idem_reused_qry_0001';
  await service.query(queryRequest({ queryText: 'chair', idempotencyKey: key }));

  await assert.rejects(
    service.query(queryRequest({ queryText: 'table', idempotencyKey: key })),
    (error: unknown) => codeOf(error) === 'idempotency-key-reuse',
  );
});

test('query refuses a duplicate query id with different content', async () => {
  const { service } = build();
  const queryId = 'qry_duplicate_01';
  await service.query(queryRequest({ queryId, queryText: 'chair' }));

  await assert.rejects(
    service.query(queryRequest({ queryId, queryText: 'table' })),
    (error: unknown) => codeOf(error) === 'duplicate-query-id',
  );
});

test('query refuses a foreign field', async () => {
  const { service } = build();
  await assert.rejects(
    service.query({ ...queryRequest(), orderId: 'ord_12345678' } as unknown as ReturnType<
      typeof queryRequest
    >),
    (error: unknown) => codeOf(error) === 'foreign-concern',
  );
});

test('query refuses a malformed instant', async () => {
  const { service } = build();
  await assert.rejects(
    service.query(queryRequest({ executedAt: 'tomorrow' })),
    (error: unknown) => codeOf(error) === 'malformed-instant',
  );
});

// ---------------------------------------------------------------------------
// remove
// ---------------------------------------------------------------------------

test('remove deletes a document and emits an event and audit action', async () => {
  const { service, repository } = build();
  const request = indexRequest();
  await service.index(request);

  const removed = await service.remove(removeRequest({ documentId: request.documentId }));
  assert.equal(removed.removed, true);
  assert.equal(removed.deduplicated, false);

  const stored = await repository.withTransaction((tx) => tx.findDocumentById(request.documentId));
  assert.equal(stored, null);

  const entries = repository.outbox().entries();
  assert.ok(entries.some((entry) => entry.kind === 'event' && entry.outboxId.includes(':removed')));
  assert.ok(entries.some((entry) => entry.kind === 'audit' && entry.outboxId.includes(':removed')));
});

test('remove is idempotent for an already-removed document', async () => {
  const { service } = build();
  const request = indexRequest();
  await service.index(request);
  await service.remove(removeRequest({ documentId: request.documentId }));

  const second = await service.remove(
    removeRequest({ documentId: request.documentId, idempotencyKey: 'idem_remove_again_0001' }),
  );
  assert.equal(second.removed, false);
  assert.equal(second.deduplicated, true);
});

test('remove refuses a malformed identifier', async () => {
  const { service } = build();
  await assert.rejects(
    service.remove(removeRequest({ documentId: 'short' })),
    (error: unknown) => codeOf(error) === 'malformed-identifier',
  );
});

test('remove refuses a malformed instant', async () => {
  const { service } = build();
  await assert.rejects(
    service.remove(removeRequest({ removedAt: 'tomorrow' })),
    (error: unknown) => codeOf(error) === 'malformed-instant',
  );
});

test('remove refuses a foreign field', async () => {
  const { service } = build();
  await assert.rejects(
    service.remove({ ...removeRequest(), orderId: 'ord_12345678' } as unknown as ReturnType<
      typeof removeRequest
    >),
    (error: unknown) => codeOf(error) === 'foreign-concern',
  );
});

// ---------------------------------------------------------------------------
// Foreign field registry
// ---------------------------------------------------------------------------

test('every FOREIGN_FIELDS entry names an owning component', () => {
  for (const [field, owner] of Object.entries(FOREIGN_FIELDS)) {
    assert.ok(owner.length > 0, `${field} has no owner`);
    assert.match(owner, /owns|belongs? to|is/, `${field} does not name an owner`);
  }
});
