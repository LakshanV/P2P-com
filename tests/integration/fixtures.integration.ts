/**
 * Fixtures against a live PostgreSQL server (FND-002d) — opt-in, and honestly skipped otherwise.
 *
 * Everything else about the seed runner is proved against an injected fake, which is right: the
 * failure paths are what matter and a fake makes them deterministic. But two claims cannot be
 * proved that way, because they are claims *about PostgreSQL*:
 *
 *   - that the fixture rows satisfy the real `CHECK` constraints, foreign keys and unique indexes
 *     the migrations declare — a fake accepts any row it is handed;
 *   - that `ON CONFLICT (identity) DO NOTHING` really makes a reload a no-op against the actual
 *     indexes, rather than against a model of them.
 *
 * Everything here runs inside the guarded derived `_test` database created and dropped by the
 * harness. The development database is configuration input only, and is asserted untouched.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { FIXTURES_DIR, validateFixtures } from '../../platform/fixtures/manifest.ts';
import { seed, unseed } from '../../platform/fixtures/runner.ts';
import { migrateUp } from '../../platform/db/runner.ts';
import {
  developmentDatabaseName,
  developmentSnapshot,
  liveTestOptions,
  withTestDatabase,
} from './harness.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MANIFESTS = validateFixtures(path.join(REPO_ROOT, FIXTURES_DIR)).manifests;

async function countRows(
  database: Parameters<typeof migrateUp>[0],
  table: string,
): Promise<number> {
  const client = await database.connect();
  try {
    const result = await client.query<{ count: string }>(`SELECT count(*) AS count FROM ${table};`);
    return Number(result.rows[0]?.count ?? 0);
  } finally {
    await client.release();
  }
}

test(
  'fixtures satisfy the real constraints, and reload idempotently',
  liveTestOptions,
  async () => {
    const before = await developmentSnapshot();

    await withTestDatabase(async ({ database, directory, name }) => {
      assert.notEqual(
        name,
        developmentDatabaseName(),
        'the target is never the development database',
      );

      // The schemas the fixtures write into have to exist first. This is the one place the fixture
      // set depends on the migration set.
      await migrateUp(database, { directory });

      const first = await seed(database, { manifests: MANIFESTS });
      assert.ok(first.rowsInserted > 0, 'the first load inserted rows');
      assert.equal(first.rowsSkipped, 0);

      const versions = await countRows(database, 'kernel_configuration.config_version');
      const events = await countRows(database, 'kernel_event_infrastructure.event');
      const deliveries = await countRows(database, 'kernel_event_infrastructure.event_delivery');
      const receipts = await countRows(database, 'kernel_event_infrastructure.event_receipt');
      assert.equal(versions, 5);
      assert.equal(events, 3);
      assert.equal(deliveries, 4);
      assert.equal(receipts, 1);

      // The claim a fake cannot make: the same rows again, against the real unique indexes.
      const second = await seed(database, { manifests: MANIFESTS });
      assert.equal(second.rowsInserted, 0, 'a reload inserts nothing');
      assert.equal(second.idempotent, true);
      assert.equal(await countRows(database, 'kernel_configuration.config_version'), versions);
      assert.equal(await countRows(database, 'kernel_event_infrastructure.event'), events);

      // And removal, in reverse order, against the real foreign keys.
      const removed = await unseed(database, { manifests: MANIFESTS });
      assert.equal(removed.rowsInserted, first.rowsInserted);
      assert.equal(await countRows(database, 'kernel_event_infrastructure.event'), 0);
      assert.equal(await countRows(database, 'kernel_configuration.config_version'), 0);
    });

    const after = await developmentSnapshot();
    assert.deepEqual(
      after.applied.map((row) => row.version),
      before.applied.map((row) => row.version),
      'the development database was read and never written',
    );
  },
);

test('a failing row rolls the whole load back on a real server', liveTestOptions, async () => {
  await withTestDatabase(async ({ database, directory }) => {
    await migrateUp(database, { directory });

    // A dataset whose second row violates a real CHECK constraint: a draft may not carry a
    // published_at. The first row is valid, so a non-atomic load would leave it behind.
    const invalid = [
      {
        ...MANIFESTS[0],
        dataset: 'live-atomicity-probe',
        dependsOn: [],
        tables: [
          {
            table: 'kernel_configuration.config_version',
            identity: ['version_id'],
            rows: [
              {
                version_id: 'ver-probe-good',
                config_key: 'session.timeout_seconds',
                scope_level: 'global',
                scope_id: '',
                value_kind: 'integer',
                value_text: '60',
                effective_from: '2026-01-01T00:00:00Z',
                status: 'draft',
                created_at: '2026-01-01T00:00:00Z',
                published_at: null,
                superseded_at: null,
                previous_version_id: null,
                idempotency_key: 'probe-good',
                origin: 'system-migration',
              },
              {
                version_id: 'ver-probe-bad',
                config_key: 'session.timeout_seconds',
                scope_level: 'global',
                scope_id: '',
                value_kind: 'integer',
                value_text: '60',
                effective_from: '2026-01-01T00:00:00Z',
                status: 'draft',
                // Refused by config_version_published_when_not_draft.
                published_at: '2026-01-01T00:00:00Z',
                created_at: '2026-01-01T00:00:00Z',
                superseded_at: null,
                previous_version_id: null,
                idempotency_key: 'probe-bad',
                origin: 'system-migration',
              },
            ],
          },
        ],
      },
    ];

    await assert.rejects(seed(database, { manifests: invalid as typeof MANIFESTS }));
    assert.equal(
      await countRows(database, 'kernel_configuration.config_version'),
      0,
      'the valid first row went back with the invalid second one',
    );
  });
});
