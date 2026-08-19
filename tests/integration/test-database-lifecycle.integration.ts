/**
 * The test-database lifecycle itself (FND-002c correction).
 *
 * migrations.integration.ts proves migrations behave against a live server. This proves the
 * container they run in: that the derived database is genuinely a different database, that it is
 * created and then removed, that removal happens even when the body fails, and that the configured
 * development database comes back unchanged — measured before and after, not assumed.
 *
 * The development database is opened only for `migrationStatus`, which creates nothing. No
 * migration and no rollback in this repository is ever aimed at it.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { migrateUp } from '../../platform/db/runner.ts';
import {
  UnsafeTestTargetError,
  assertSafeTestTarget,
  deriveTestDatabaseUrl,
} from '../../platform/db/test-database.ts';
import {
  databaseExists,
  developmentDatabaseName,
  developmentSnapshot,
  leftoverMarkerExists,
  liveTestOptions,
  maintenanceDatabase,
  removeTestDatabase,
  seedLeftoverTestDatabase,
  testDatabaseConnection,
  testDatabaseName,
  withTestDatabase,
} from './harness.ts';

test('the derived database is not the development database', liveTestOptions, async () => {
  await withTestDatabase(({ name, url }) => {
    assert.notEqual(
      name,
      developmentDatabaseName(),
      'the test database must not be the development database',
    );
    assert.ok(name.endsWith('_test'), `derived name "${name}" must carry the test suffix`);
    assert.doesNotThrow(() => {
      assertSafeTestTarget(url);
    }, 'the derived target must satisfy the guard');
    return Promise.resolve();
  });
});

test('the test database exists during the run and not after it', liveTestOptions, async () => {
  const maintenance = maintenanceDatabase();
  const name = testDatabaseName();

  await withTestDatabase(async ({ maintenance: inner, name: innerName }) => {
    assert.equal(
      await databaseExists(inner, innerName),
      true,
      'the test database must exist while the body runs',
    );
  });

  assert.equal(
    await databaseExists(maintenance, name),
    false,
    'the test database must not outlive the run',
  );
});

test('the test database is dropped even when the body fails', liveTestOptions, async () => {
  const maintenance = maintenanceDatabase();
  const name = testDatabaseName();
  const planted = new Error('planted failure inside the test database');

  await assert.rejects(
    withTestDatabase(async ({ database, directory }) => {
      await migrateUp(database, { directory });
      throw planted;
    }),
    (error: unknown) => error === planted,
    'the failure must propagate rather than being swallowed by cleanup',
  );

  assert.equal(
    await databaseExists(maintenance, name),
    false,
    'cleanup must run on the failure path too, or one bad run poisons every later one',
  );
});

test('the development database is untouched by a full test run', liveTestOptions, async () => {
  const before = await developmentSnapshot();

  await withTestDatabase(async ({ database, directory }) => {
    await migrateUp(database, { directory });
  });

  const after = await developmentSnapshot();
  assert.deepEqual(
    after.applied.map((row) => row.version),
    before.applied.map((row) => row.version),
    'applying migrations to the test database must not change the development database',
  );
  assert.deepEqual(
    after.pending,
    before.pending,
    'the development database must have the same pending set it started with',
  );
});

test(
  'a leftover database at the guarded name is replaced, not reused',
  liveTestOptions,
  async () => {
    const maintenance = maintenanceDatabase();
    const name = testDatabaseName();

    // What a killed run actually leaves behind: a database occupying the exact name the next run
    // will ask for, carrying objects from the run that died. Not a copy under another name — that
    // would prove nothing, because the next run would create a fresh database either way.
    await seedLeftoverTestDatabase();
    try {
      assert.equal(
        await databaseExists(maintenance, name),
        true,
        'the leftover must exist before the run under test, or this proves nothing',
      );
      assert.equal(
        await leftoverMarkerExists(testDatabaseConnection()),
        true,
        'the marker must be present in the leftover, or its later absence is meaningless',
      );

      await withTestDatabase(async ({ database, name: innerName }) => {
        assert.equal(innerName, name, 'the run must target the same name the leftover occupies');
        assert.equal(
          await leftoverMarkerExists(database),
          false,
          'withTestDatabase reused the leftover database instead of replacing it — a run would ' +
            'inherit whatever state the killed one left, and its results would not be its own',
        );
      });
    } finally {
      // Runs even if an assertion above throws, so a failure here cannot leave a leftover that
      // makes the next run of this very test pass for the wrong reason.
      await removeTestDatabase();
    }

    assert.equal(
      await databaseExists(maintenance, name),
      false,
      'nothing may survive this test, including what it deliberately planted',
    );
  },
);

test('the guard refuses an unsafe derivation even with a server available', liveTestOptions, () => {
  assert.throws(
    () => deriveTestDatabaseUrl('postgres://u:p@db.internal:5432/jaya'),
    UnsafeTestTargetError,
    'a non-loopback host must be refused whether or not a database is reachable',
  );
  assert.throws(
    () => {
      assertSafeTestTarget('postgres://u:p@127.0.0.1:5432/jaya_dev');
    },
    UnsafeTestTargetError,
    'the development database must never satisfy the test-target guard',
  );
});
