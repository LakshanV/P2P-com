/**
 * Opt-in PostgreSQL integration test (FND-002b).
 *
 * The deterministic tests in migration-runner.test.ts prove the runner's logic against a fake.
 * They cannot prove the SQL is valid PostgreSQL, that transactional DDL behaves as assumed, or
 * that `pg_try_advisory_lock` really excludes a second session. Only a server can.
 *
 * So this test exists and is honest about when it runs. It requires DATABASE_URL and the `pg`
 * driver, and **skips with a stated reason** when either is missing rather than passing silently.
 * A skipped run is not evidence of anything, and the status documents say so.
 *
 *   npm install --no-save pg
 *   createdb jaya_integration
 *   DATABASE_URL=postgres://localhost:5432/jaya_integration npm run test:integration
 *
 * It applies migrations to whatever database DATABASE_URL names and rolls them back afterwards.
 * Point it at a disposable database, never at one with data you want.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { MIGRATIONS_DIR } from '../../platform/db/migrations.ts';
import { DATABASE_URL_ENV, DRIVER_MODULE, PostgresDatabase } from '../../platform/db/postgres.ts';
import {
  ADVISORY_LOCK_KEY,
  migrateDown,
  migrateUp,
  migrationStatus,
} from '../../platform/db/runner.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const directory = path.join(REPO_ROOT, MIGRATIONS_DIR);

const connectionString = process.env[DATABASE_URL_ENV];

const driverAvailable = await (async (): Promise<boolean> => {
  try {
    const specifier = DRIVER_MODULE;
    await import(specifier);
    return true;
  } catch {
    return false;
  }
})();

/** The reason this suite is not running, or undefined when it is. */
const skip: string | undefined =
  connectionString === undefined || connectionString.trim() === ''
    ? `${DATABASE_URL_ENV} is not set — no live database to run against`
    : driverAvailable
      ? undefined
      : `the ${DRIVER_MODULE} driver is not installed (npm install --no-save pg)`;

const options = skip === undefined ? {} : { skip };

test(
  'a live PostgreSQL applies, reports, rolls back and re-applies the migration set',
  options,
  async () => {
    const db = new PostgresDatabase(String(connectionString));

    // Start from a known state: roll back anything this suite previously applied.
    const before = await migrationStatus(db, { directory });
    for (const row of [...before.applied].reverse()) {
      await migrateDown(db, { directory, version: row.version });
    }

    try {
      const first = await migrateUp(db, { directory });
      assert.deepEqual(
        first.applied.map((applied) => applied.version),
        ['0001', '0002'],
        'a clean database must receive every migration, in order',
      );

      const status = await migrationStatus(db, { directory });
      assert.deepEqual(
        status.applied.map((row) => row.version),
        ['0001', '0002'],
        'the ledger must record what was applied',
      );
      assert.deepEqual(status.pending, [], 'nothing may remain pending');
      for (const row of status.applied) {
        assert.match(row.checksum, /^[0-9a-f]{64}$/, 'a checksum must be persisted per migration');
      }

      const rerun = await migrateUp(db, { directory });
      assert.deepEqual(rerun.applied, [], 'a rerun against a live database must be a no-op');

      const rolledBack = await migrateDown(db, { directory, version: '0002' });
      assert.equal(rolledBack.rolledBack, '0002');

      const afterRollback = await migrationStatus(db, { directory });
      assert.deepEqual(
        afterRollback.applied.map((row) => row.version),
        ['0001'],
        'the rollback must remove exactly one ledger row',
      );
      assert.deepEqual(
        afterRollback.pending,
        ['0002'],
        'the rolled-back migration becomes pending',
      );

      const reapplied = await migrateUp(db, { directory });
      assert.deepEqual(
        reapplied.applied.map((applied) => applied.version),
        ['0002'],
        'a rolled-back migration must be re-appliable',
      );
    } finally {
      // Leave the database as this suite found it, so a rerun starts clean.
      const remaining = await migrationStatus(db, { directory });
      for (const row of [...remaining.applied].reverse()) {
        await migrateDown(db, { directory, version: row.version });
      }
    }
  },
);

test('a second runner is excluded while the first holds the advisory lock', options, async () => {
  const db = new PostgresDatabase(String(connectionString));

  // Two independent sessions: the first takes the lock inside migrateUp, the second must be
  // refused. Serialised here by holding a session open manually, which is what the runner does.
  const holder = await db.connect();
  try {
    const taken = await holder.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS locked;',
      [ADVISORY_LOCK_KEY.toString()],
    );
    assert.equal(taken.rows[0]?.locked, true, 'the test must be holding the lock');

    await assert.rejects(
      migrateUp(db, { directory }),
      /refusing to run concurrently/,
      'a second runner must be refused while the lock is held',
    );
  } finally {
    await holder.query('SELECT pg_advisory_unlock_all();');
    await holder.release();
  }
});
