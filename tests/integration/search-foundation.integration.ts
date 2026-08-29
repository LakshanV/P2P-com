/**
 * K-15 Search Foundation against a live PostgreSQL server — opt-in, and honestly skipped otherwise.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { PostgresSearchRepository, SearchService } from '../../kernel/search-foundation/index.ts';
import { migrateDown, migrateUp } from '../../platform/db/runner.ts';
import type { Database } from '../../platform/db/client.ts';

import { indexRequest, queryRequest } from '../helpers/search-foundation-fixtures.ts';
import {
  developmentDatabaseName,
  developmentSnapshot,
  liveTestOptions,
  withTestDatabase,
} from './harness.ts';

async function count(database: Database, table: string): Promise<number> {
  const client = await database.connect();
  try {
    const result = await client.query<{ count: string }>(`SELECT count(*) AS count FROM ${table};`);
    return Number(result.rows[0]?.count ?? 0);
  } finally {
    await client.release();
  }
}

async function refuses(database: Database, sql: string): Promise<string | null> {
  const client = await database.connect();
  try {
    await client.query(sql);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  } finally {
    await client.release();
  }
}

test(
  'indexes a document, queries it, and records the query log end-to-end',
  liveTestOptions,
  async () => {
    const before = await developmentSnapshot();

    await withTestDatabase(async ({ database, directory, name }) => {
      assert.notEqual(
        name,
        developmentDatabaseName(),
        'the target is never the development database',
      );
      await migrateUp(database, { directory });

      const service = new SearchService(new PostgresSearchRepository(database));

      const indexed = await service.index(
        indexRequest({ documentId: 'doc_live_01', ownerId: 'own_live_01' }),
      );
      assert.equal(indexed.deduplicated, false);

      const result = await service.query(
        queryRequest({ queryId: 'qry_live_01', queryText: 'wooden table' }),
      );
      assert.equal(result.results.length, 1);
      assert.equal(result.results[0]?.documentId, 'doc_live_01');
      assert.equal(result.total, 1);
      assert.equal(result.hasMore, false);

      assert.equal(await count(database, 'kernel_search_foundation.document'), 1);
      assert.equal(await count(database, 'kernel_search_foundation.query_log'), 1);
      assert.equal(await count(database, 'kernel_search_foundation.outbox'), 4);
    });

    const after = await developmentSnapshot();
    assert.deepEqual(
      after.applied.map((entry) => entry.version),
      before.applied.map((entry) => entry.version),
      'the development database was read and never written',
    );
  },
);

test('the database refuses a duplicate document id', liveTestOptions, async () => {
  await withTestDatabase(async ({ database, directory }) => {
    await migrateUp(database, { directory });
    const service = new SearchService(new PostgresSearchRepository(database));

    const request = indexRequest({ documentId: 'doc_dup_01', ownerId: 'own_dup_01' });
    await service.index(request);

    const result = await refuses(
      database,
      `INSERT INTO kernel_search_foundation.document
         (document_id, owner_type, owner_id, scope, language, title, description, keywords, attributes, vectors, ranking, created_at, updated_at, idempotency_key)
       VALUES ('doc_dup_01', 'listing', 'own_dup_02', 'public', 'en', 'Other', 'Other desc', '{}', '{}', '{}', '{}', '2026-04-01T12:00:00Z', '2026-04-01T12:00:00Z', 'idem_doc_dup_02');`,
    );
    assert.ok(result !== null, 'a duplicate document id must be refused');
    assert.match(result, /unique constraint/i);
  });
});

test('the database refuses a duplicate idempotency key', liveTestOptions, async () => {
  await withTestDatabase(async ({ database, directory }) => {
    await migrateUp(database, { directory });
    const service = new SearchService(new PostgresSearchRepository(database));

    const request = indexRequest({ documentId: 'doc_idem_01', ownerId: 'own_idem_01' });
    await service.index(request);

    const result = await refuses(
      database,
      `INSERT INTO kernel_search_foundation.document
         (document_id, owner_type, owner_id, scope, language, title, description, keywords, attributes, vectors, ranking, created_at, updated_at, idempotency_key)
       VALUES ('doc_idem_02', 'listing', 'own_idem_02', 'public', 'en', 'Other', 'Other desc', '{}', '{}', '{}', '{}', '2026-04-01T12:00:00Z', '2026-04-01T12:00:00Z', '${request.idempotencyKey}');`,
    );
    assert.ok(result !== null, 'a duplicate idempotency key must be refused');
    assert.match(result, /unique constraint/i);
  });
});

test('the database refuses to mutate the query log', liveTestOptions, async () => {
  await withTestDatabase(async ({ database, directory }) => {
    await migrateUp(database, { directory });
    const service = new SearchService(new PostgresSearchRepository(database));

    await service.index(indexRequest({ documentId: 'doc_mutate_01', ownerId: 'own_mutate_01' }));
    await service.query(queryRequest({ queryId: 'qry_mutate_01', queryText: 'table' }));

    const update = await refuses(
      database,
      `UPDATE kernel_search_foundation.query_log SET result_count = 99 WHERE query_id = 'qry_mutate_01';`,
    );
    assert.ok(update !== null, 'updating a query log must be refused');
    assert.match(update, /append-only/i);

    const deleteQueryLog = await refuses(
      database,
      `DELETE FROM kernel_search_foundation.query_log WHERE query_id = 'qry_mutate_01';`,
    );
    assert.ok(deleteQueryLog !== null, 'deleting a query log must be refused');
    assert.match(deleteQueryLog, /append-only/i);
  });
});

test(
  'kernel_search_foundation rolls back independently of other schemas',
  liveTestOptions,
  async () => {
    await withTestDatabase(async ({ database, directory }) => {
      await migrateUp(database, { directory, target: '0021' });
      const service = new SearchService(new PostgresSearchRepository(database));

      await service.index(
        indexRequest({ documentId: 'doc_rollback_01', ownerId: 'own_rollback_01' }),
      );

      await migrateDown(database, { directory, version: '0021' });

      const client = await database.connect();
      try {
        await assert.rejects(
          client.query('SELECT 1 FROM kernel_search_foundation.document LIMIT 1;'),
        );
      } finally {
        await client.release();
      }
    });
  },
);
