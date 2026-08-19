/**
 * The seed runner (FND-002d).
 *
 * Four guarantees, and each is tested by breaking it rather than by exercising the happy path:
 *
 *   - **Ordering.** Dependencies load first, deterministically, whatever order the manifests arrive
 *     in. A load order that varied would make a failure depend on directory listing order.
 *   - **Atomicity.** A row that fails mid-load rolls back every dataset, not merely its own. A
 *     partial seed looks loaded and surfaces days later as an unrelated test failure.
 *   - **Idempotency.** A second run inserts nothing and says so. This is what makes `db:seed` safe
 *     to run without first wondering whether it has already been run.
 *   - **Target safety.** A remote host or a shared-looking database name is refused, and
 *     destructive replacement is refused anywhere but the guarded derived `_test` database, and
 *     then only on an explicit confirmation.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  FIXTURES_DIR,
  validateFixtures,
  type FixtureManifest,
} from '../platform/fixtures/manifest.ts';
import {
  SeedError,
  assertReplaceable,
  assertSeedableTarget,
  isSeedableTarget,
  seed,
  unseed,
} from '../platform/fixtures/runner.ts';

import { FORBIDDEN_NAME_MARKERS } from '../platform/db/test-database.ts';

import { SeedFakeDatabase } from './helpers/seed-database.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REAL = validateFixtures(path.join(REPO_ROOT, FIXTURES_DIR)).manifests;

const codeOf = (error: unknown): string | undefined =>
  error instanceof SeedError ? error.code : undefined;

const manifest = (overrides: Partial<FixtureManifest> = {}): FixtureManifest => ({
  manifestVersion: 1,
  dataset: 'alpha',
  owner: 'K-05',
  schema: 'kernel_configuration',
  purpose: 'development',
  description: 'x',
  dependsOn: [],
  tables: [
    {
      table: 'kernel_configuration.config_version',
      identity: ['version_id'],
      rows: [{ version_id: 'ver-1', value_text: '900' }],
    },
  ],
  ...overrides,
});

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

test('datasets load in dependency order, whatever order they are given in', async () => {
  const alpha = manifest({ dataset: 'alpha' });
  const beta = manifest({
    dataset: 'beta',
    dependsOn: ['alpha'],
    tables: [
      {
        table: 'kernel_configuration.config_version',
        identity: ['version_id'],
        rows: [{ version_id: 'ver-2' }],
      },
    ],
  });

  for (const order of [
    [alpha, beta],
    [beta, alpha],
  ]) {
    const database = new SeedFakeDatabase();
    const report = await seed(database, { manifests: order });
    assert.deepEqual(
      report.datasets.map((dataset) => dataset.dataset),
      ['alpha', 'beta'],
      'beta depends on alpha and must follow it however the manifests were listed',
    );
    const inserts = database.queries.filter((query) => /^INSERT/i.test(query.sql));
    assert.ok(
      inserts.findIndex((query) => query.params.includes('ver-1')) <
        inserts.findIndex((query) => query.params.includes('ver-2')),
      'the rows themselves were written in that order',
    );
  }
});

test('the real fixture set loads K-05 before K-08, as it declares', async () => {
  const database = new SeedFakeDatabase();
  const report = await seed(database, { manifests: REAL });

  assert.deepEqual(
    report.datasets.map((dataset) => dataset.dataset),
    ['k05-configuration-baseline', 'k08-event-delivery-states'],
  );
  assert.deepEqual(
    report.datasets.map((dataset) => dataset.owner),
    ['K-05', 'K-08'],
  );
});

test('tables within a dataset load in declared order', async () => {
  const database = new SeedFakeDatabase();
  await seed(database, { manifests: REAL });

  const statements = database.statements.filter((sql) => /^INSERT/i.test(sql));
  const first = (table: string): number => statements.findIndex((sql) => sql.includes(table));

  // Events before deliveries before receipts: both later tables carry foreign keys into the event
  // table, so any other order would fail against a real server.
  assert.ok(first('kernel_event_infrastructure.event ') < first('event_delivery'));
  assert.ok(first('event_delivery') < first('event_receipt'));
});

test('a dependency cycle is refused before anything is written', async () => {
  const database = new SeedFakeDatabase();
  await assert.rejects(
    seed(database, {
      manifests: [
        manifest({ dataset: 'alpha', dependsOn: ['beta'] }),
        manifest({ dataset: 'beta', dependsOn: ['alpha'] }),
      ],
    }),
    (error: unknown) => codeOf(error) === 'invalid-fixtures',
  );
  assert.equal(database.sessionsOpened, 0, 'the plan is computed before a connection is opened');
});

// ---------------------------------------------------------------------------
// Atomicity
// ---------------------------------------------------------------------------

test('a row that fails rolls back every dataset, not only its own', async () => {
  // The failing row is in the *second* dataset, so a per-dataset transaction would leave the first
  // one committed — a half-loaded database that looks loaded.
  const database = new SeedFakeDatabase({ failOnValue: 'evt-fixture-0002' });

  await assert.rejects(seed(database, { manifests: REAL }), (error: unknown) => {
    assert.equal(codeOf(error), 'sql-failed');
    assert.match((error as SeedError).message, /rolled back/);
    return true;
  });

  assert.equal(database.rollbacks, 1);
  assert.equal(database.commits, 0);
  assert.equal(database.totalRows, 0, 'including the first dataset, which had already inserted');
  assert.equal(database.sessionsReleased, 1, 'the connection is released on the failure path');
});

test('a failure after a successful earlier load leaves the earlier load intact', async () => {
  const first = new SeedFakeDatabase();
  await seed(first, { manifests: REAL });
  const loaded = first.totalRows;
  assert.ok(loaded > 0);

  // A second run against a database that already holds the rows, where one statement fails.
  const rows = Object.fromEntries(first.tableNames.map((table) => [table, first.rowsOf(table)]));
  const second = new SeedFakeDatabase({ rows, failOn: /INSERT INTO kernel_event_infrastructure/i });
  await assert.rejects(seed(second, { manifests: REAL }));

  assert.equal(second.totalRows, loaded, 'the rollback restored exactly what was there before');
});

test('one transaction spans the whole load', async () => {
  const database = new SeedFakeDatabase();
  await seed(database, { manifests: REAL });

  assert.equal(database.statements.filter((sql) => /^BEGIN/i.test(sql)).length, 1);
  assert.equal(database.commits, 1, 'not one commit per dataset');
  assert.equal(database.sessionsOpened, 1, 'and one connection for all of it');
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

test('a second load inserts nothing and reports that it inserted nothing', async () => {
  const database = new SeedFakeDatabase();
  const first = await seed(database, { manifests: REAL });
  assert.ok(first.rowsInserted > 0);
  assert.equal(first.rowsSkipped, 0);
  assert.equal(first.idempotent, false, 'the first run did work');

  const before = database.totalRows;
  const second = await seed(database, { manifests: REAL });

  assert.equal(second.rowsInserted, 0);
  assert.equal(second.rowsSkipped, first.rowsInserted);
  assert.equal(second.idempotent, true);
  assert.equal(database.totalRows, before, 'the database is unchanged');
});

test('every insert conflicts on the declared identity, not on the whole row', async () => {
  const database = new SeedFakeDatabase();
  await seed(database, { manifests: REAL });

  const inserts = database.statements.filter((sql) => /^INSERT/i.test(sql));
  assert.ok(inserts.length > 0);
  for (const sql of inserts) {
    assert.match(sql, /ON CONFLICT \([^)]+\) DO NOTHING/, `unguarded insert: ${sql}`);
  }

  // The K-08 receipt table's identity is composite; the statement must name both columns or a
  // second subscription's receipt for the same event would be treated as a duplicate.
  const receipt = inserts.find((sql) => sql.includes('event_receipt'));
  assert.match(String(receipt), /ON CONFLICT \(subscription, event_id\)/);
});

test('a fixture never overwrites a row somebody changed by hand', async () => {
  const database = new SeedFakeDatabase({
    rows: {
      'kernel_configuration.config_version': [
        { version_id: 'ver-1', value_text: 'edited-by-hand' },
      ],
    },
  });

  const report = await seed(database, { manifests: [manifest()] });

  assert.equal(report.rowsInserted, 0);
  assert.equal(
    database.rowsOf('kernel_configuration.config_version')[0]?.value_text,
    'edited-by-hand',
    'DO NOTHING rather than DO UPDATE: during a debugging session the database is authoritative',
  );
});

test('unseed removes exactly the declared rows, in reverse order', async () => {
  const database = new SeedFakeDatabase();
  await seed(database, { manifests: REAL });
  const seeded = database.totalRows;

  const removed = await unseed(database, { manifests: REAL });

  assert.equal(removed.rowsInserted, seeded, 'every seeded row was removed');
  assert.equal(database.totalRows, 0);

  const deletes = database.statements.filter((sql) => /^DELETE/i.test(sql));
  const firstDelete = (table: string): number => deletes.findIndex((sql) => sql.includes(table));
  assert.ok(
    firstDelete('event_receipt') < firstDelete('kernel_event_infrastructure.event '),
    'children before parents, or a foreign key would refuse the delete',
  );
  assert.ok(
    firstDelete('kernel_event_infrastructure') < firstDelete('kernel_configuration'),
    'and the dependent dataset before the one it depends on',
  );
});

test('unseed deletes by identity and never truncates', async () => {
  const database = new SeedFakeDatabase();
  await seed(database, { manifests: REAL });
  await unseed(database, { manifests: REAL });

  assert.equal(
    database.statements.filter((sql) => /TRUNCATE/i.test(sql)).length,
    0,
    'a truncate would remove rows this tool never created; the fixture set does not own the tables',
  );
  for (const sql of database.statements.filter((sql) => /^DELETE/i.test(sql))) {
    assert.match(sql, /WHERE .+ = \$1/, `unqualified delete: ${sql}`);
  }
});

// ---------------------------------------------------------------------------
// Target safety
// ---------------------------------------------------------------------------

test('a load refuses any host that is not this machine', () => {
  for (const url of [
    'postgres://jaya:pw@db.example.com:5432/jaya_dev',
    'postgres://jaya:pw@10.0.0.7:5432/jaya_dev',
    'postgres://jaya:pw@jaya-prod.internal:5432/jaya',
  ]) {
    assert.throws(
      () => assertSeedableTarget(url),
      (error: unknown) => {
        assert.equal(codeOf(error), 'unsafe-target');
        return true;
      },
      `${url} is remote and must be refused`,
    );
    assert.equal(isSeedableTarget(url), false);
  }
});

test('a load refuses a database whose name suggests a shared environment', () => {
  // The marker list is the provisioning guard's, imported rather than restated, so the two cannot
  // disagree about what "shared" looks like.
  for (const marker of FORBIDDEN_NAME_MARKERS) {
    assert.throws(
      () => assertSeedableTarget(`postgres://jaya:pw@localhost:5432/jaya_${marker}`),
      (error: unknown) => codeOf(error) === 'unsafe-target',
      `a database named for "${marker}" must be refused even on localhost`,
    );
  }

  for (const name of ['jaya_production', 'jaya_staging', 'jaya_live', 'jaya_prod']) {
    assert.throws(
      () => assertSeedableTarget(`postgres://jaya:pw@localhost:5432/${name}`),
      (error: unknown) => codeOf(error) === 'unsafe-target',
      `${name} must be refused even on localhost`,
    );
  }
});

test('a load accepts the local development and test databases', () => {
  for (const url of [
    'postgres://jaya:pw@localhost:5432/jaya_dev',
    'postgres://jaya:pw@127.0.0.1:5432/jaya_dev_test',
  ]) {
    assertSeedableTarget(url);
    assert.equal(isSeedableTarget(url), true);
  }
});

test('an unparseable connection string is refused rather than assumed safe', () => {
  for (const url of ['', 'not a url', 'jaya_dev']) {
    assert.throws(
      () => assertSeedableTarget(url),
      (error: unknown) => codeOf(error) === 'unsafe-target',
    );
  }
});

test('destructive replacement is refused anywhere but the guarded _test database', () => {
  // The development database is loadable but never replaceable: `reset` deletes rows, and the
  // database a developer has been working in is not the place to discover that.
  assert.throws(
    () => assertReplaceable('postgres://jaya:pw@localhost:5432/jaya_dev', 'jaya_dev'),
    (error: unknown) => error instanceof Error && /not a test database|_test/i.test(error.message),
  );
  assert.throws(
    () =>
      assertReplaceable('postgres://jaya:pw@db.example.com:5432/jaya_dev_test', 'jaya_dev_test'),
    (error: unknown) => error instanceof Error,
  );
});

test('destructive replacement demands an explicit confirmation naming the database', () => {
  const target = 'postgres://jaya:pw@localhost:5432/jaya_dev_test';

  for (const confirmation of [undefined, '', 'yes', 'jaya_dev']) {
    assert.throws(
      () => assertReplaceable(target, confirmation),
      (error: unknown) => {
        assert.equal(codeOf(error), 'confirmation-required');
        assert.match((error as SeedError).message, /--confirm=jaya_dev_test/);
        return true;
      },
      `confirmation ${JSON.stringify(confirmation)} must not be enough`,
    );
  }

  // The right database and the right confirmation together, and only together.
  assertReplaceable(target, 'jaya_dev_test');
});

test('purpose filters which datasets load', async () => {
  const database = new SeedFakeDatabase();
  const report = await seed(database, {
    manifests: [
      manifest({ dataset: 'dev', purpose: 'development' }),
      manifest({ dataset: 'tst', purpose: 'test' }),
    ],
    purpose: 'test',
  });

  assert.deepEqual(
    report.datasets.map((dataset) => dataset.dataset),
    ['tst'],
  );
});
