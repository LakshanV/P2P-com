/**
 * Live PostgreSQL migration coverage (FND-002c correction).
 *
 * Everything here runs inside a derived `_test` database created by the harness and dropped
 * afterwards. Nothing in this file constructs a migration runner against DATABASE_URL: the
 * configured development database is connection input, not a target, and
 * `tests/integration-safety.test.ts` fails the build if that ever stops being true.
 *
 *   cp .env.example .env
 *   npm run db:up && npm run db:ready
 *   npm run test:integration
 *
 * Skips with a stated reason when nothing is configured. A skipped run is not evidence.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ADVISORY_LOCK_KEY,
  migrateDown,
  migrateUp,
  migrationStatus,
} from '../../platform/db/runner.ts';
import { liveTestOptions, withTestDatabase } from './harness.ts';

test(
  'a clean database receives every migration, in order, and records them',
  liveTestOptions,
  async () => {
    await withTestDatabase(async ({ database, directory }) => {
      const initial = await migrationStatus(database, { directory });
      assert.deepEqual(initial.applied, [], 'a newly created database has no history');
      assert.deepEqual(initial.pending, ['0001', '0002']);

      const applied = await migrateUp(database, { directory });
      assert.deepEqual(
        applied.applied.map((row) => row.version),
        ['0001', '0002'],
        'migrations must apply in ascending version order',
      );

      const after = await migrationStatus(database, { directory });
      assert.deepEqual(
        after.applied.map((row) => row.version),
        ['0001', '0002'],
        'the ledger must record what was applied',
      );
      assert.deepEqual(after.pending, [], 'nothing may remain pending');
      for (const row of after.applied) {
        assert.match(row.checksum, /^[0-9a-f]{64}$/, 'a checksum must be persisted per migration');
      }
    });
  },
);

test('a rerun against a live database applies nothing', liveTestOptions, async () => {
  await withTestDatabase(async ({ database, directory }) => {
    await migrateUp(database, { directory });
    const rerun = await migrateUp(database, { directory });
    assert.deepEqual(rerun.applied, [], 'a rerun must be a no-op');
  });
});

test('a rolled-back migration becomes pending and can be re-applied', liveTestOptions, async () => {
  await withTestDatabase(async ({ database, directory }) => {
    await migrateUp(database, { directory });

    const rolledBack = await migrateDown(database, { directory, version: '0002' });
    assert.equal(rolledBack.rolledBack, '0002');

    const after = await migrationStatus(database, { directory });
    assert.deepEqual(
      after.applied.map((row) => row.version),
      ['0001'],
      'the rollback must remove exactly one ledger row',
    );
    assert.deepEqual(after.pending, ['0002'], 'the rolled-back migration becomes pending');

    const reapplied = await migrateUp(database, { directory });
    assert.deepEqual(
      reapplied.applied.map((row) => row.version),
      ['0002'],
      'a rolled-back migration must be re-appliable',
    );
  });
});

test(
  'rolling back 0002 leaves the ledger and the 0001 history row intact',
  liveTestOptions,
  async () => {
    await withTestDatabase(async ({ database, directory }) => {
      await migrateUp(database, { directory });
      await migrateDown(database, { directory, version: '0002' });

      // The contradiction this replaces: the original 0002 rollback dropped the ledger, so the
      // runner's DELETE ran against a relation that no longer existed and the rollback aborted.
      const after = await migrationStatus(database, { directory });
      assert.deepEqual(
        after.applied.map((row) => row.version),
        ['0001'],
        'the ledger must still exist and still record 0001',
      );
    });
  },
);

test(
  'status and a refused rollback create nothing on a freshly created database',
  liveTestOptions,
  async () => {
    await withTestDatabase(async ({ database, maintenance, directory }) => {
      const objectsExist = async (): Promise<{ schema: boolean; ledger: boolean }> => {
        const probe = await maintenance.connect();
        try {
          // Asked on the test database's own connection, since to_regclass is per-database.
          const client = await database.connect();
          try {
            const result = await client.query<{ schema: boolean; ledger: boolean }>(
              "SELECT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'platform') AS schema, " +
                "to_regclass('platform.schema_migrations') IS NOT NULL AS ledger;",
            );
            return {
              schema: result.rows[0]?.schema === true,
              ledger: result.rows[0]?.ledger === true,
            };
          } finally {
            await client.release();
          }
        } finally {
          await probe.release();
        }
      };

      assert.deepEqual(
        await objectsExist(),
        { schema: false, ledger: false },
        'a freshly created database starts with neither schema nor ledger',
      );

      const status = await migrationStatus(database, { directory });
      assert.deepEqual(status.applied, [], 'an absent ledger means nothing has been applied');
      assert.deepEqual(
        await objectsExist(),
        { schema: false, ledger: false },
        'status must not create the schema or the ledger',
      );

      await assert.rejects(
        migrateDown(database, { directory, version: '0001' }),
        /nothing to roll back/,
        'a rollback against an empty database must be refused',
      );
      assert.deepEqual(
        await objectsExist(),
        { schema: false, ledger: false },
        'a refused rollback must not create the schema or the ledger',
      );

      // And the first real run creates them together with the first history row.
      await migrateUp(database, { directory });
      assert.deepEqual(await objectsExist(), { schema: true, ledger: true });
    });
  },
);

test(
  'a second runner is excluded while the first holds the advisory lock',
  liveTestOptions,
  async () => {
    await withTestDatabase(async ({ database, directory }) => {
      // Two sessions against the test database. The first holds the lock the runner needs.
      const holder = await database.connect();
      try {
        const taken = await holder.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_lock($1) AS locked;',
          [ADVISORY_LOCK_KEY.toString()],
        );
        assert.equal(taken.rows[0]?.locked, true, 'the test must be holding the lock');

        await assert.rejects(
          migrateUp(database, { directory }),
          /refusing to run concurrently/,
          'a second runner must be refused while the lock is held',
        );
      } finally {
        await holder.query('SELECT pg_advisory_unlock_all();');
        await holder.release();
      }
    });
  },
);
