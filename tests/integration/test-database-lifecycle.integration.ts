/**
 * Isolated integration-test database lifecycle (FND-002c).
 *
 * The other live suite applies migrations to whatever DATABASE_URL names, which means running it
 * costs you your development data. This one derives a separate database from that same
 * configuration, creates it, runs the migration suite against it, and drops it — so a test run
 * leaves the development database untouched.
 *
 *   npm run db:up && npm run db:ready
 *   npm run test:integration
 *
 * Skips with a stated reason when DATABASE_URL is unset. A skipped run is not evidence.
 *
 * Every target passes through assertSafeTestTarget before anything is created or dropped, so this
 * suite cannot act on a non-loopback host or on a database that is not named as a test database,
 * whatever DATABASE_URL happens to say.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { MIGRATIONS_DIR } from '../../platform/db/migrations.ts';
import { DATABASE_URL_ENV, PostgresDatabase } from '../../platform/db/postgres.ts';
import { migrateDown, migrateUp, migrationStatus } from '../../platform/db/runner.ts';
import {
  createTestDatabase,
  databaseNameOf,
  deriveTestDatabaseUrl,
  dropTestDatabase,
  maintenanceUrl,
} from '../../platform/db/test-database.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const directory = path.join(REPO_ROOT, MIGRATIONS_DIR);

const developmentUrl = process.env[DATABASE_URL_ENV];

const skip: string | undefined =
  developmentUrl === undefined || developmentUrl.trim() === ''
    ? `${DATABASE_URL_ENV} is not set — no local PostgreSQL to derive a test database from`
    : undefined;

const options = skip === undefined ? {} : { skip };

test('the migration suite runs against a derived, isolated test database', options, async () => {
  const testUrl = deriveTestDatabaseUrl(String(developmentUrl));
  const maintenance = new PostgresDatabase(maintenanceUrl(testUrl));
  const testDatabase = new PostgresDatabase(testUrl);

  assert.notEqual(
    databaseNameOf(testUrl),
    databaseNameOf(String(developmentUrl)),
    'the test database must not be the development database',
  );

  await createTestDatabase(maintenance, testUrl);
  try {
    // Freshly created: no schema, no ledger, nothing applied.
    const initial = await migrationStatus(testDatabase, { directory });
    assert.deepEqual(initial.applied, [], 'a newly created database has no history');
    assert.deepEqual(initial.pending, ['0001', '0002']);

    const applied = await migrateUp(testDatabase, { directory });
    assert.deepEqual(
      applied.applied.map((row) => row.version),
      ['0001', '0002'],
      'every migration must apply to the isolated database',
    );

    const after = await migrationStatus(testDatabase, { directory });
    assert.deepEqual(after.pending, [], 'nothing may remain pending');
    for (const row of after.applied) {
      assert.match(row.checksum, /^[0-9a-f]{64}$/);
    }

    const rerun = await migrateUp(testDatabase, { directory });
    assert.deepEqual(rerun.applied, [], 'a rerun must be a no-op');

    await migrateDown(testDatabase, { directory, version: '0002' });
    const rolledBack = await migrationStatus(testDatabase, { directory });
    assert.deepEqual(
      rolledBack.applied.map((row) => row.version),
      ['0001'],
      'the ledger survives its own migration being reversed',
    );
  } finally {
    await dropTestDatabase(maintenance, testUrl);
  }
});

test('the development database is untouched by a test run', options, async () => {
  const testUrl = deriveTestDatabaseUrl(String(developmentUrl));
  const maintenance = new PostgresDatabase(maintenanceUrl(testUrl));
  const development = new PostgresDatabase(String(developmentUrl));
  const testDatabase = new PostgresDatabase(testUrl);

  const before = await migrationStatus(development, { directory });

  await createTestDatabase(maintenance, testUrl);
  try {
    await migrateUp(testDatabase, { directory });
  } finally {
    await dropTestDatabase(maintenance, testUrl);
  }

  const after = await migrationStatus(development, { directory });
  assert.deepEqual(
    after.applied.map((row) => row.version),
    before.applied.map((row) => row.version),
    'applying migrations to the test database must not change the development database',
  );
});

test('the test database is removed after the run', options, async () => {
  const testUrl = deriveTestDatabaseUrl(String(developmentUrl));
  const maintenance = new PostgresDatabase(maintenanceUrl(testUrl));
  const name = databaseNameOf(testUrl);

  await createTestDatabase(maintenance, testUrl);
  await dropTestDatabase(maintenance, testUrl);

  const client = await maintenance.connect();
  try {
    const result = await client.query<{ present: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS present;',
      [name],
    );
    assert.equal(result.rows[0]?.present, false, 'the test database must not outlive the run');
  } finally {
    await client.release();
  }
});
