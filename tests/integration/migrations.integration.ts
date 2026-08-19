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
  discover,
  migrateDown,
  migrateUp,
  migrationStatus,
} from '../../platform/db/runner.ts';
import { MIGRATIONS_PATH, liveTestOptions, withTestDatabase } from './harness.ts';

/**
 * The versions actually on disk. Derived rather than written out, so adding a migration does not
 * silently make this suite assert a stale set — which it would do only on a machine that has a
 * database, and therefore only where it would be noticed last.
 */
const ALL_VERSIONS: readonly string[] = discover(MIGRATIONS_PATH).map(
  (migration) => migration.version,
);
const LAST_VERSION = ALL_VERSIONS[ALL_VERSIONS.length - 1] ?? '';

test(
  'a clean database receives every migration, in order, and records them',
  liveTestOptions,
  async () => {
    await withTestDatabase(async ({ database, directory }) => {
      const initial = await migrationStatus(database, { directory });
      assert.deepEqual(initial.applied, [], 'a newly created database has no history');
      assert.deepEqual(initial.pending, [...ALL_VERSIONS]);

      const applied = await migrateUp(database, { directory });
      assert.deepEqual(
        applied.applied.map((row) => row.version),
        [...ALL_VERSIONS],
        'migrations must apply in ascending version order',
      );

      const after = await migrationStatus(database, { directory });
      assert.deepEqual(
        after.applied.map((row) => row.version),
        [...ALL_VERSIONS],
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

    const rolledBack = await migrateDown(database, { directory, version: LAST_VERSION });
    assert.equal(rolledBack.rolledBack, LAST_VERSION);

    const after = await migrationStatus(database, { directory });
    assert.deepEqual(
      after.applied.map((row) => row.version),
      ALL_VERSIONS.slice(0, -1),
      'the rollback must remove exactly one ledger row',
    );
    assert.deepEqual(after.pending, [LAST_VERSION], 'the rolled-back migration becomes pending');

    const reapplied = await migrateUp(database, { directory });
    assert.deepEqual(
      reapplied.applied.map((row) => row.version),
      [LAST_VERSION],
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

      // Roll back to 0002 inclusive, in reverse order — the runner refuses anything but the
      // latest, which is itself the behaviour under test everywhere else. 0002 is the interesting
      // one: the original version of its rollback dropped the ledger, so the runner's DELETE ran
      // against a relation that no longer existed and the whole rollback aborted.
      for (const version of [...ALL_VERSIONS].reverse()) {
        if (version < '0002') break;
        await migrateDown(database, { directory, version });
      }

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
