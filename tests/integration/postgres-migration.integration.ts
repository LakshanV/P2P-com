/**
 * Opt-in PostgreSQL integration test (FND-002b).
 *
 * The deterministic tests in migration-runner.test.ts prove the runner's logic against a fake.
 * They cannot prove the SQL is valid PostgreSQL, that transactional DDL behaves as assumed, or
 * that `pg_try_advisory_lock` really excludes a second session. Only a server can.
 *
 * So this test exists and is honest about when it runs. `pg` is a declared dependency now, so
 * the only thing it needs is a server: it **skips with a stated reason** when DATABASE_URL is
 * unset rather than passing silently. A skipped run is not evidence of anything, and the status
 * documents say so.
 *
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
import { DATABASE_URL_ENV, PostgresDatabase } from '../../platform/db/postgres.ts';
import {
  ADVISORY_LOCK_KEY,
  migrateDown,
  migrateUp,
  migrationStatus,
} from '../../platform/db/runner.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const directory = path.join(REPO_ROOT, MIGRATIONS_DIR);

const connectionString = process.env[DATABASE_URL_ENV];

/** The reason this suite is not running, or undefined when it is. */
const skip: string | undefined =
  connectionString === undefined || connectionString.trim() === ''
    ? `${DATABASE_URL_ENV} is not set — no live database to run against`
    : undefined;

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

test(
  'status and a refused rollback create nothing on a completely empty database',
  options,
  async () => {
    const db = new PostgresDatabase(String(connectionString));

    // Reach a genuinely empty state: no platform schema, no ledger, no rows.
    const existing = await migrationStatus(db, { directory });
    for (const row of [...existing.applied].reverse()) {
      await migrateDown(db, { directory, version: row.version });
    }
    const teardown = await db.connect();
    try {
      await teardown.query('DROP SCHEMA IF EXISTS platform CASCADE;');
    } finally {
      await teardown.release();
    }

    const objectsExist = async (): Promise<{ schema: boolean; ledger: boolean }> => {
      const probe = await db.connect();
      try {
        const result = await probe.query<{ schema: boolean; ledger: boolean }>(
          "SELECT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'platform') AS schema, " +
            "to_regclass('platform.schema_migrations') IS NOT NULL AS ledger;",
        );
        return { schema: result.rows[0]?.schema === true, ledger: result.rows[0]?.ledger === true };
      } finally {
        await probe.release();
      }
    };

    const before = await objectsExist();
    assert.deepEqual(before, { schema: false, ledger: false }, 'the database must start empty');

    const status = await migrationStatus(db, { directory });
    assert.deepEqual(status.applied, [], 'an absent ledger means nothing has been applied');
    assert.deepEqual(status.pending, ['0001', '0002']);
    assert.deepEqual(
      await objectsExist(),
      { schema: false, ledger: false },
      'status must not create the schema or the ledger',
    );

    await assert.rejects(
      migrateDown(db, { directory, version: '0001' }),
      /nothing to roll back/,
      'a rollback against an empty database must be refused',
    );
    assert.deepEqual(
      await objectsExist(),
      { schema: false, ledger: false },
      'a refused rollback must not create the schema or the ledger',
    );

    // And the first real run creates them together with the first history row.
    const applied = await migrateUp(db, { directory });
    assert.deepEqual(
      applied.applied.map((row) => row.version),
      ['0001', '0002'],
    );
    assert.deepEqual(await objectsExist(), { schema: true, ledger: true });

    for (const row of [...(await migrationStatus(db, { directory })).applied].reverse()) {
      await migrateDown(db, { directory, version: row.version });
    }
  },
);

test('rolling back 0002 leaves the ledger and the 0001 history row intact', options, async () => {
  const db = new PostgresDatabase(String(connectionString));

  const existing = await migrationStatus(db, { directory });
  for (const row of [...existing.applied].reverse()) {
    await migrateDown(db, { directory, version: row.version });
  }

  try {
    await migrateUp(db, { directory });
    await migrateDown(db, { directory, version: '0002' });

    // The contradiction this replaces: the old 0002 rollback dropped the ledger, so the runner's
    // DELETE ran against a relation that no longer existed and the whole rollback aborted.
    const after = await migrationStatus(db, { directory });
    assert.deepEqual(
      after.applied.map((row) => row.version),
      ['0001'],
      'the ledger must still exist and still record 0001',
    );
    assert.deepEqual(after.pending, ['0002']);

    const reapplied = await migrateUp(db, { directory });
    assert.deepEqual(
      reapplied.applied.map((row) => row.version),
      ['0002'],
      '0002 must be re-appliable after being rolled back',
    );
  } finally {
    for (const row of [...(await migrationStatus(db, { directory })).applied].reverse()) {
      await migrateDown(db, { directory, version: row.version });
    }
  }
});

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
