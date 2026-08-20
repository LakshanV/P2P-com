/**
 * Migration runner tests (FND-002b).
 *
 * Every case runs against an injected fake database, which is the whole reason the runner takes a
 * `Database` rather than importing a driver: the behaviours worth asserting are the failure paths
 * — a migration whose SQL throws, a checksum that drifted, a second runner arriving mid-deploy —
 * and those are exactly the paths a live database makes slow and unreliable to provoke on demand.
 *
 * The live-database counterpart is tests/integration/postgres-migration.integration.ts, run by
 * `npm run test:integration`, which skips itself with a stated reason when there is no server to
 * talk to.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { passwordOf, redactConnectionString, redactText } from '../platform/db/client.ts';
import { MIGRATIONS_DIR } from '../platform/db/migrations.ts';
import {
  DATABASE_URL_ENV,
  MissingConnectionError,
  PostgresDatabase,
  connectionStringFromEnv,
} from '../platform/db/postgres.ts';
import {
  ADVISORY_LOCK_KEY,
  MigrationError,
  advisoryLockKey,
  checksumOf,
  discover,
  migrateDown,
  migrateUp,
  migrationStatus,
  unwrapTransaction,
} from '../platform/db/runner.ts';
import { FakeDatabase } from './helpers/fake-database.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(REPO_ROOT, MIGRATIONS_DIR);

const realChecksum = (file: string): string =>
  checksumOf(fs.readFileSync(path.join(directory, file), 'utf8'));

const LEDGER_0001 = {
  version: '0001',
  slug: 'create_platform_schema',
  checksum: realChecksum('0001_create_platform_schema.up.sql'),
};
const LEDGER_0002 = {
  version: '0002',
  slug: 'create_migration_ledger',
  checksum: realChecksum('0002_create_migration_ledger.up.sql'),
};

/** Versions of the real forward migrations, so a new migration cannot make these stale. */
const ALL_VERSIONS: readonly string[] = discover(directory).map((migration) => migration.version);

/**
 * A ledger in which every real forward migration is applied, derived rather than listed.
 *
 * Listing the rows by hand made these tests stale the moment a migration was added: the fixture
 * said three were applied while ALL_VERSIONS said four, and the mismatch surfaced as a failure in
 * a test about something else entirely.
 */
const FULL_LEDGER = discover(directory).map((migration) => ({
  version: migration.version,
  slug: migration.slug,
  checksum: realChecksum(`${migration.version}_${migration.slug}.up.sql`),
}));

/** The ledger as it would stand with everything up to and including `version` applied. */
const ledgerThrough = (version: string): typeof FULL_LEDGER =>
  FULL_LEDGER.filter((row) => row.version <= version);

/** Versions strictly after `version` — what would still be pending. */
const versionsAfter = (version: string): string[] =>
  ALL_VERSIONS.filter((candidate) => candidate > version);

/** Index of the first statement matching a pattern, for asserting ordering. */
const indexOf = (statements: readonly string[], pattern: RegExp): number =>
  statements.findIndex((statement) => pattern.test(statement));

// --------------------------------------------------------------- clean bootstrap

test('bootstraps a fresh database, then applies every migration in version order', async () => {
  const db = new FakeDatabase();
  const report = await migrateUp(db, { directory });

  assert.deepEqual(
    report.applied.map((a) => a.version),
    ALL_VERSIONS,
    'migrations must apply in ascending version order',
  );
  assert.deepEqual(report.alreadyApplied, []);
  assert.equal(db.bootstrapped, true, 'the ledger must exist after the run');
  assert.deepEqual(db.appliedVersions(), [...ALL_VERSIONS]);
});

test('on a fresh database the bootstrap shares the first migration transaction', async () => {
  const db = new FakeDatabase();
  await migrateUp(db, { directory });

  const firstBegin = indexOf(db.statements, /^BEGIN;$/i);
  const bootstrapAt = indexOf(
    db.statements,
    /CREATE TABLE IF NOT EXISTS platform\.schema_migrations/i,
  );
  const firstInsert = indexOf(db.statements, /^INSERT INTO platform\.schema_migrations/i);
  const firstCommit = indexOf(db.statements, /^COMMIT;$/i);

  assert.ok(
    firstBegin !== -1 && bootstrapAt > firstBegin,
    'the bootstrap must be inside a transaction',
  );
  assert.ok(firstInsert > bootstrapAt, 'the first history row is written after the bootstrap');
  assert.ok(firstCommit > firstInsert, 'schema, ledger and first history row must commit together');
  assert.equal(
    db.statements.slice(firstBegin + 1, firstInsert).some((s) => /^COMMIT;$/i.test(s)),
    false,
    'nothing may commit between creating the ledger and recording the first migration',
  );
});

test('a run that applies nothing creates neither schema nor ledger', async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'jaya-empty-'));
  try {
    const db = new FakeDatabase();
    const report = await migrateUp(db, { directory: empty });
    assert.deepEqual(report.applied, []);
    assert.equal(db.bootstrapped, false, 'no work means no ledger');
    assert.equal(db.schemaCreated, false, 'no work means no schema');
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test('status on an empty database creates nothing', async () => {
  const db = new FakeDatabase();
  const report = await migrationStatus(db, { directory });

  assert.deepEqual(report.applied, [], 'an absent ledger means nothing has been applied');
  assert.deepEqual(report.pending, [...ALL_VERSIONS]);
  assert.equal(db.bootstrapped, false, 'status must not create the ledger');
  assert.equal(db.schemaCreated, false, 'status must not create the schema');
  assert.equal(
    db.statements.some((s) => /^(CREATE|INSERT|DELETE|ALTER|DROP)/i.test(s)),
    false,
    `status issued a mutating statement: ${db.statements.join(' | ')}`,
  );
  assert.equal(db.lockHeld, false, 'the lock is still released');
});

test('a refused rollback on an empty database creates nothing', async () => {
  const db = new FakeDatabase();

  await assert.rejects(
    migrateDown(db, { directory, version: '0001' }),
    (error: unknown) => error instanceof MigrationError && error.code === 'rollback-unapplied',
  );

  assert.equal(db.bootstrapped, false, 'a refusal must not create the ledger');
  assert.equal(db.schemaCreated, false, 'a refusal must not create the schema');
  assert.equal(
    db.statements.some((s) => /^(CREATE|INSERT|DELETE|ALTER|DROP)/i.test(s)),
    false,
    `a refused rollback issued a mutating statement: ${db.statements.join(' | ')}`,
  );
});

test('a first-migration failure leaves neither schema, ledger nor history row', async () => {
  const db = new FakeDatabase({ failOn: /COMMENT ON SCHEMA platform/i });

  await assert.rejects(
    migrateUp(db, { directory }),
    (error: unknown) => error instanceof MigrationError && error.code === 'sql-failed',
  );

  assert.equal(db.bootstrapped, false, 'the bootstrap must roll back with the migration');
  assert.equal(db.schemaCreated, false, 'the schema must roll back with the migration');
  assert.deepEqual(db.ledger, [], 'no history row may survive');
});

test('a failed bootstrap rolls back, leaving neither schema nor ledger, and releases the lock', async () => {
  const db = new FakeDatabase({
    failOn: /CREATE TABLE IF NOT EXISTS platform\.schema_migrations/i,
  });

  await assert.rejects(migrateUp(db, { directory }), /simulated SQL failure/);

  assert.equal(db.bootstrapped, false, 'a failed bootstrap must leave no ledger behind');
  assert.deepEqual(db.ledger, [], 'a failed bootstrap must leave no rows behind');
  assert.ok(
    db.statements.some((s) => /^ROLLBACK;$/i.test(s)),
    'the bootstrap transaction must be rolled back',
  );
  assert.equal(db.lockHeld, false, 'the advisory lock must be released');
  assert.equal(db.sessionsReleased, 1, 'the session must be closed');
});

// --------------------------------------------------------------- incremental and idempotent

test('applies only what is pending, leaving applied migrations alone', async () => {
  const db = new FakeDatabase({ ledger: ledgerThrough('0002') });
  const report = await migrateUp(db, { directory });

  assert.deepEqual(
    report.applied.map((a) => a.version),
    versionsAfter('0002'),
    'only the unapplied migrations may run',
  );
  assert.deepEqual(report.alreadyApplied, ['0001', '0002']);
  assert.deepEqual(db.appliedVersions(), [...ALL_VERSIONS]);
});

test('a rerun on an up-to-date database applies nothing and writes nothing', async () => {
  const db = new FakeDatabase({ ledger: FULL_LEDGER });
  const report = await migrateUp(db, { directory });

  assert.deepEqual(report.applied, [], 'a rerun must be a no-op');
  assert.equal(
    db.statements.some((s) => /^INSERT INTO platform\.schema_migrations/i.test(s)),
    false,
    'no ledger row may be written when nothing is applied',
  );
  assert.deepEqual(db.appliedVersions(), [...ALL_VERSIONS]);
});

// --------------------------------------------------------------- atomicity with the ledger

test('each migration commits together with its ledger row, never before it', async () => {
  const db = new FakeDatabase({ ledger: [LEDGER_0001] });
  await migrateUp(db, { directory });

  // Statement window for the single pending migration: BEGIN, body, INSERT, COMMIT.
  const insertAt = indexOf(db.statements, /^INSERT INTO platform\.schema_migrations/i);
  assert.notEqual(insertAt, -1, 'a ledger row must be written');

  const beginBefore = db.statements
    .slice(0, insertAt)
    .reduce((last, s, i) => (/^BEGIN;$/i.test(s) ? i : last), -1);
  const commitAfter = db.statements.findIndex((s, i) => i > insertAt && /^COMMIT;$/i.test(s));

  assert.ok(
    beginBefore !== -1 && beginBefore < insertAt,
    'the ledger row must be inside a transaction',
  );
  assert.ok(commitAfter > insertAt, 'the transaction must commit after the ledger row, not before');
  assert.equal(
    db.statements.slice(beginBefore + 1, insertAt).some((s) => /^COMMIT;$/i.test(s)),
    false,
    'nothing may commit between the migration body and its ledger row',
  );
});

test('the migration body is executed unwrapped, so the file cannot self-commit', async () => {
  const db = new FakeDatabase({ ledger: [LEDGER_0001, LEDGER_0002] });
  await migrationStatus(db, { directory });
  // Status applies nothing; the assertion that matters is on unwrapTransaction directly.
  const body = unwrapTransaction(
    fs.readFileSync(path.join(directory, '0002_create_migration_ledger.up.sql'), 'utf8'),
    '0002',
  );
  assert.equal(/\bBEGIN\s*;/i.test(body), false, 'the outer BEGIN must be stripped');
  assert.equal(/\bCOMMIT\s*;/i.test(body), false, 'the outer COMMIT must be stripped');
  assert.match(body, /CREATE TABLE IF NOT EXISTS platform\.schema_migrations/i);
});

// --------------------------------------------------------------- SQL failure

test('a failing migration rolls back and records no ledger row', async () => {
  const db = new FakeDatabase({ failOn: /COMMENT ON SCHEMA platform/i });

  await assert.rejects(
    migrateUp(db, { directory }),
    (error: unknown) =>
      error instanceof MigrationError &&
      error.code === 'sql-failed' &&
      /0001_create_platform_schema\.up\.sql failed and was rolled back/.test(error.message),
  );

  assert.deepEqual(db.ledger, [], 'a failed migration must leave no ledger row');
  assert.ok(db.statements.some((s) => /^ROLLBACK;$/i.test(s)));
  assert.equal(db.lockHeld, false, 'the lock must be released after a failure');
  assert.equal(db.sessionsReleased, 1);
});

test('a failure stops the run, so later migrations are not attempted', async () => {
  const db = new FakeDatabase({ failOn: /COMMENT ON SCHEMA platform/i });
  await assert.rejects(migrateUp(db, { directory }));
  assert.equal(
    db.statements.some((s) => /schema_migrations_applied_at_idx/i.test(s)),
    false,
    'migration 0002 must not run after 0001 failed',
  );
});

// --------------------------------------------------------------- fail-closed reconciliation

test('rejects a migration whose checksum has drifted since it was applied', async () => {
  const db = new FakeDatabase({
    ledger: [{ ...LEDGER_0001, checksum: 'f'.repeat(64) }],
  });

  await assert.rejects(
    migrateUp(db, { directory }),
    (error: unknown) =>
      error instanceof MigrationError &&
      error.code === 'checksum-drift' &&
      /an applied migration is immutable/.test(error.message),
  );
  assert.equal(
    db.statements.some((s) => /^INSERT INTO platform\.schema_migrations/i.test(s)),
    false,
    'nothing may be applied once drift is detected',
  );
  assert.equal(db.lockHeld, false);
});

test('rejects a ledger version that has no migration on disk', async () => {
  const db = new FakeDatabase({
    ledger: [
      LEDGER_0001,
      LEDGER_0002,
      // Far above every migration this revision has, so it stays "from the future" as the real
      // set grows. It was 0009 until FND-004d added a migration with that number, at which point
      // this stopped testing an absent version and started testing checksum drift.
      { version: '0099', slug: 'from_the_future', checksum: 'a'.repeat(64) },
    ],
  });

  await assert.rejects(
    migrateUp(db, { directory }),
    (error: unknown) =>
      error instanceof MigrationError &&
      error.code === 'unknown-applied-version' &&
      /migrated by a different revision/.test(error.message),
  );
  assert.equal(db.lockHeld, false);
});

test('rejects a pending migration that sorts before an applied one', async () => {
  const db = new FakeDatabase({ ledger: [LEDGER_0002] });

  await assert.rejects(
    migrateUp(db, { directory }),
    (error: unknown) => error instanceof MigrationError && error.code === 'out-of-order-version',
  );
  assert.equal(db.lockHeld, false);
});

test('refuses to run at all when the migration set fails the FND-002a contract', () => {
  const invalid = path.join(REPO_ROOT, 'tests/fixtures/migrations/invalid-missing-rollback');
  assert.throws(
    () => discover(invalid),
    (error: unknown) =>
      error instanceof MigrationError &&
      error.code === 'invalid-migration-set' &&
      /nothing was applied/.test(error.message),
  );
});

// --------------------------------------------------------------- concurrency

test('refuses to run while another runner holds the advisory lock', async () => {
  const db = new FakeDatabase({ lockHeldByAnother: true });

  await assert.rejects(
    migrateUp(db, { directory }),
    (error: unknown) =>
      error instanceof MigrationError &&
      error.code === 'concurrent-run' &&
      /refusing to run concurrently/.test(error.message),
  );

  assert.equal(db.bootstrapped, false, 'a blocked runner must not touch the database');
  assert.equal(db.lockReleases, 0, 'a runner must not release a lock it did not take');
  assert.equal(db.sessionsReleased, 1, 'the session must still be closed');
});

test('the advisory lock is taken once and released once on a successful run', async () => {
  const db = new FakeDatabase();
  await migrateUp(db, { directory });
  assert.equal(db.lockAcquisitions, 1);
  assert.equal(db.lockReleases, 1);
  assert.equal(db.lockHeld, false);
  assert.equal(db.sessionsOpened, 1);
  assert.equal(db.sessionsReleased, 1);
});

test('the advisory lock key is stable, not incidentally derived', () => {
  assert.equal(
    advisoryLockKey(),
    ADVISORY_LOCK_KEY,
    'the published constant must equal its derivation, or older runners stop being excluded',
  );
  assert.ok(ADVISORY_LOCK_KEY > 0n && ADVISORY_LOCK_KEY < 2n ** 63n);
});

// --------------------------------------------------------------- status

test('status reports applied and pending without changing anything', async () => {
  const db = new FakeDatabase({ ledger: ledgerThrough('0001') });
  const report = await migrationStatus(db, { directory });

  assert.deepEqual(
    report.applied.map((row) => row.version),
    ['0001'],
  );
  assert.deepEqual(report.pending, versionsAfter('0001'));
  assert.equal(
    db.statements.some((s) => /^INSERT INTO platform\.schema_migrations/i.test(s)),
    false,
    'status must not apply anything',
  );
  assert.equal(db.lockHeld, false);
});

// --------------------------------------------------------------- rollback

test('rolls back the most recently applied migration and removes its ledger row', async () => {
  const db = new FakeDatabase({ ledger: [LEDGER_0001, LEDGER_0002] });
  const report = await migrateDown(db, { directory, version: '0002' });

  assert.equal(report.rolledBack, '0002');
  assert.deepEqual(db.appliedVersions(), ['0001'], 'only the rolled-back row is removed');
  assert.ok(
    db.statements.some((s) =>
      /DROP INDEX IF EXISTS platform\.schema_migrations_applied_at_idx/i.test(s),
    ),
    'the rollback body must actually run',
  );
});

test('rolling back 0002 leaves the ledger intact, and the earlier history with it', async () => {
  const db = new FakeDatabase({ ledger: ledgerThrough('0002') });
  await migrateDown(db, { directory, version: '0002' });

  assert.equal(
    db.statements.some((s) => /DROP TABLE[\s\S]*schema_migrations/i.test(s)),
    false,
    'the ledger table is bootstrap-owned; no rollback may drop it',
  );
  assert.equal(db.bootstrapped, true, 'the ledger must survive its own migration being reversed');
  assert.deepEqual(
    db.appliedVersions(),
    ['0001'],
    'reversing one migration must not erase the history of the others',
  );

  const after = await migrationStatus(db, { directory });
  assert.deepEqual(
    after.applied.map((row) => row.version),
    ['0001'],
    'the database is still readable and its history still coherent',
  );
  assert.deepEqual(after.pending, versionsAfter('0001'), '0002 becomes pending again, not lost');
});

test('the ledger row is deleted before the rollback body runs', async () => {
  const db = new FakeDatabase({ ledger: [LEDGER_0001, LEDGER_0002] });
  await migrateDown(db, { directory, version: '0002' });

  const deleteAt = indexOf(db.statements, /^DELETE FROM platform\.schema_migrations/i);
  const bodyAt = indexOf(
    db.statements,
    /DROP INDEX IF EXISTS platform\.schema_migrations_applied_at_idx/i,
  );

  assert.ok(deleteAt !== -1 && bodyAt !== -1);
  assert.ok(
    deleteAt < bodyAt,
    'history first: a body that removes what the DELETE depends on would otherwise fail against ' +
      'a relation it had just dropped — which is how the original 0002 rollback became ' +
      'unexecutable',
  );
});

test('refuses to roll back anything other than the latest applied migration', async () => {
  const db = new FakeDatabase({ ledger: FULL_LEDGER });

  await assert.rejects(
    migrateDown(db, { directory, version: '0001' }),
    (error: unknown) =>
      error instanceof MigrationError &&
      error.code === 'rollback-not-latest' &&
      /one version at a time/.test(error.message),
  );
  assert.deepEqual(db.appliedVersions(), ALL_VERSIONS, 'nothing may change on refusal');
});

test('refuses to roll back when nothing has been applied', async () => {
  const db = new FakeDatabase({ ledger: [] });
  await assert.rejects(
    migrateDown(db, { directory, version: '0001' }),
    (error: unknown) => error instanceof MigrationError && error.code === 'rollback-unapplied',
  );
});

test('refuses to roll back on inconsistent checksum evidence', async () => {
  const db = new FakeDatabase({
    // Every migration applied, but 0002's recorded checksum does not match its file.
    ledger: FULL_LEDGER.map((row) =>
      row.version === '0002' ? { ...row, checksum: 'b'.repeat(64) } : row,
    ),
  });

  await assert.rejects(
    migrateDown(db, { directory, version: '0002' }),
    (error: unknown) => error instanceof MigrationError && error.code === 'checksum-drift',
  );
  assert.deepEqual(db.appliedVersions(), ALL_VERSIONS, 'a refused rollback changes nothing');
});

test('a failing rollback leaves the ledger row in place', async () => {
  const db = new FakeDatabase({
    // 0003 is the latest applied here, because a rollback reverses the most recent migration.
    ledger: ledgerThrough('0003'),
    failOn: /DROP INDEX IF EXISTS kernel_configuration\.config_version_resolution_idx/i,
  });

  await assert.rejects(
    migrateDown(db, { directory, version: '0003' }),
    (error: unknown) =>
      error instanceof MigrationError &&
      error.code === 'sql-failed' &&
      /the ledger row for 0003 is untouched/.test(error.message),
  );
  assert.deepEqual(
    db.appliedVersions(),
    ledgerThrough('0003').map((row) => row.version),
  );
  assert.equal(db.lockHeld, false);
});

// --------------------------------------------------------------- transaction unwrapping

test('unwrapTransaction refuses a body it cannot delimit', () => {
  const cases: ReadonlyArray<{ sql: string; why: RegExp }> = [
    { sql: 'CREATE SCHEMA x;\nCOMMIT;', why: /has no BEGIN/ },
    { sql: 'BEGIN;\nCREATE SCHEMA x;', why: /has no COMMIT/ },
    { sql: 'BEGIN;\nCREATE SCHEMA x;\nCOMMIT;\nDROP SCHEMA x;', why: /after its final COMMIT/ },
    {
      sql: 'BEGIN;\nCREATE SCHEMA a;\nCOMMIT;\nBEGIN;\nCREATE SCHEMA b;\nCOMMIT;',
      why: /nested transaction/,
    },
  ];
  for (const { sql, why } of cases) {
    assert.throws(
      () => unwrapTransaction(sql, 'fixture.sql'),
      (error: unknown) =>
        error instanceof MigrationError &&
        error.code === 'malformed-transaction' &&
        why.test(error.message),
      `expected ${why} for: ${sql.replace(/\n/g, ' ')}`,
    );
  }
});

test('unwrapTransaction ignores BEGIN and COMMIT quoted in comments', () => {
  const sql = ['-- BEGIN; this is prose', 'BEGIN;', "SELECT 'COMMIT;';", 'COMMIT;'].join('\n');
  const body = unwrapTransaction(sql, 'fixture.sql');
  assert.match(body, /SELECT 'COMMIT;';/);
  assert.equal(body.includes('this is prose'), false, 'the comment before BEGIN is not body');
});

// --------------------------------------------------------------- checksums

test('checksums are SHA-256 of the file, and change when the file changes', () => {
  const sql = 'BEGIN;\nCREATE SCHEMA platform;\nCOMMIT;\n';
  assert.match(checksumOf(sql), /^[0-9a-f]{64}$/);
  assert.equal(checksumOf(sql), checksumOf(sql), 'checksums must be deterministic');
  assert.notEqual(checksumOf(sql), checksumOf(`${sql}-- trailing edit\n`));
});

test('discovered checksums match the files on disk', () => {
  const discovered = discover(directory);
  assert.equal(discovered.length, ALL_VERSIONS.length);
  for (const migration of discovered) {
    assert.equal(migration.checksum, realChecksum(migration.upFile));
  }
});

// --------------------------------------------------------------- credential handling

test('a connection string is reduced to a description that cannot leak the password', () => {
  const url = 'postgres://jaya_app:sup3r-s3cret@db.internal:5432/jaya?sslmode=require';
  const description = redactConnectionString(url);

  assert.equal(description.includes('sup3r-s3cret'), false, 'the password must never appear');
  assert.match(description, /^postgres:\/\/jaya_app:\*\*\*@db\.internal:5432\/jaya/);
});

test('an unparseable connection string is not echoed back', () => {
  assert.equal(redactConnectionString('not a url at all'), '<unparseable connection string>');
});

test('a connection string with no password is rendered without inventing one', () => {
  assert.equal(
    redactConnectionString('postgres://db.internal:5432/jaya'),
    'postgres://db.internal:5432/jaya',
  );
});

test('redactText removes the password from arbitrary driver output', () => {
  const password = 'sup3r-s3cret';
  const message = `connection to server at "db.internal" failed: password "${password}" rejected`;
  const redacted = redactText(message, [password]);
  assert.equal(redacted.includes(password), false);
  assert.match(redacted, /password "\*\*\*" rejected/);
});

test('redactText masks userinfo even when the password was not supplied separately', () => {
  const redacted = redactText('failed for postgres://jaya:hunter2@db.internal/jaya', []);
  assert.equal(redacted.includes('hunter2'), false);
});

test('the adapter description never carries the password', () => {
  const db = new PostgresDatabase('postgres://jaya:hunter2@db.internal:5432/jaya');
  assert.equal(db.description.includes('hunter2'), false);
  assert.equal(db.redact('error near hunter2 while connecting').includes('hunter2'), false);
  assert.equal(passwordOf('postgres://jaya:hunter2@db.internal/jaya'), 'hunter2');
});

test('a missing DATABASE_URL is an explicit refusal, not a default', () => {
  assert.throws(() => connectionStringFromEnv({}), MissingConnectionError);
  assert.throws(
    () => connectionStringFromEnv({ [DATABASE_URL_ENV]: '   ' }),
    MissingConnectionError,
  );
  assert.equal(
    connectionStringFromEnv({ [DATABASE_URL_ENV]: ' postgres://x/y ' }),
    'postgres://x/y',
  );
});

test('the runner never puts the connection string in a log line', async () => {
  const secret = 'postgres://jaya:hunter2@db.internal:5432/jaya';
  const db = new FakeDatabase({ description: redactConnectionString(secret) });
  const lines: string[] = [];
  await migrateUp(db, { directory, log: (message) => lines.push(message) });

  assert.ok(lines.length > 0, 'the runner must report progress');
  for (const line of lines) {
    assert.equal(line.includes('hunter2'), false, `credential leaked into a log line: ${line}`);
  }
});

// --------------------------------------------------------------- missing rollback file

test('refuses to roll back a migration whose rollback file has been removed', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'jaya-migrations-'));
  try {
    for (const file of fs.readdirSync(directory)) {
      fs.copyFileSync(path.join(directory, file), path.join(temporary, file));
    }
    const db = new FakeDatabase({ ledger: FULL_LEDGER });
    // Discovery happens against the complete copy; the file disappears before the rollback reads
    // it, which is the race this branch exists to catch.
    fs.rmSync(path.join(temporary, '0002_create_migration_ledger.down.sql'));

    await assert.rejects(
      migrateDown(db, { directory: temporary, version: '0002' }),
      (error: unknown) =>
        error instanceof MigrationError &&
        (error.code === 'missing-rollback-file' || error.code === 'invalid-migration-set'),
      'a rollback with no rollback file must fail closed',
    );
    assert.deepEqual(db.appliedVersions(), ALL_VERSIONS, 'nothing may change on refusal');
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
