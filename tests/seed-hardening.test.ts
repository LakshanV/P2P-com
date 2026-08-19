/**
 * FND-002d correction — validation that cannot be walked around, and a replacement that cannot
 * leave nothing behind.
 *
 * Three gaps, none of them visible from the tests that shipped with the slice:
 *
 *   - **The contract was enforced by the route, not by the runner.** The CLI validated and then
 *     called `seed`. A programmatic caller passing hand-built manifests skipped ownership,
 *     identity, determinism, credential, personal-data and dependency checks entirely. A guarantee
 *     that holds only for callers who came the polite way is not a guarantee, and `seed` is an
 *     exported function.
 *   - **Replacement could leave the database empty.** `reset` ran `unseed` then `seed`, each
 *     atomic on its own. Between the two commits there was no fixture data at all, and a reload
 *     that failed there left the operator with an empty database and an error message.
 *   - **Fingerprints were trusted.** K-08 treats a payload fingerprint as the evidence that the
 *     payload was never edited. A fixture writing the two inconsistently seeds a row whose own
 *     evidence contradicts it, and nothing notices until a consumer compares them.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { fingerprintPayload as kernelFingerprint } from '../kernel/event-infrastructure/index.ts';
import { fingerprintPayload as platformFingerprint } from '../platform/fixtures/fingerprint.ts';
import {
  FIXTURES_DIR,
  validateFixtures,
  validateManifests,
  type FixtureManifest,
} from '../platform/fixtures/manifest.ts';
import { SeedError, replace, seed, unseed } from '../platform/fixtures/runner.ts';

import { SeedFakeDatabase } from './helpers/seed-database.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REAL = validateFixtures(path.join(REPO_ROOT, FIXTURES_DIR)).manifests;

const codeOf = (error: unknown): string | undefined =>
  error instanceof SeedError ? error.code : undefined;

/** A JSON object, or null. Fixture values are `FixtureJson`; fingerprinting wants a record. */
const asRecord = (value: unknown): Readonly<Record<string, unknown>> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;

/** A structurally valid manifest, so each case below breaks exactly one thing. */
const manifest = (overrides: Partial<FixtureManifest> = {}): FixtureManifest => ({
  manifestVersion: 1,
  dataset: 'direct-caller',
  owner: 'K-05',
  schema: 'kernel_configuration',
  purpose: 'development',
  description: 'built in code, never validated by the CLI',
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

const table = (rows: ReadonlyArray<Record<string, unknown>>): FixtureManifest['tables'] => [
  {
    table: 'kernel_configuration.config_version',
    identity: ['version_id'],
    rows: rows as FixtureManifest['tables'][number]['rows'],
  },
];

// ---------------------------------------------------------------------------
// 1. Direct runner calls are validated
// ---------------------------------------------------------------------------

const INVALID: ReadonlyArray<{ readonly why: string; readonly manifests: FixtureManifest[] }> = [
  {
    why: 'a schema no unit owns',
    manifests: [
      manifest({
        schema: 'kernel_nonexistent',
        tables: [{ table: 'kernel_nonexistent.thing', identity: ['id'], rows: [{ id: 'row-1' }] }],
      }),
    ],
  },
  {
    why: "a write into another unit's schema",
    manifests: [
      manifest({
        tables: [
          {
            table: 'kernel_event_infrastructure.event',
            identity: ['event_id'],
            rows: [{ event_id: 'evt-1' }],
          },
        ],
      }),
    ],
  },
  {
    why: 'an owner that does not own the schema it names',
    manifests: [manifest({ owner: 'K-08' })],
  },
  {
    why: 'two rows with one identity',
    manifests: [manifest({ tables: table([{ version_id: 'ver-1' }, { version_id: 'ver-1' }]) })],
  },
  {
    why: 'a row missing its identity column',
    manifests: [manifest({ tables: table([{ value_text: '900' }]) })],
  },
  {
    why: 'a nondeterministic value',
    manifests: [manifest({ tables: table([{ version_id: 'ver-1', created_at: 'now()' }]) })],
  },
  {
    why: 'a seeded credential',
    manifests: [
      manifest({
        tables: table([{ version_id: 'ver-1', value_text: 'sk-abcdefghijklmnopqrstuv' }]),
      }),
    ],
  },
  {
    why: 'a deliverable email address',
    manifests: [
      manifest({ tables: table([{ version_id: 'ver-1', value_text: 'someone@gmail.com' }]) }),
    ],
  },
  {
    why: 'a nested value in a column not declared as JSON',
    manifests: [
      manifest({ tables: table([{ version_id: 'ver-1', value_text: { nested: true } }]) }),
    ],
  },
  {
    why: 'a manifest version this code does not read',
    manifests: [manifest({ manifestVersion: 99 })],
  },
  {
    why: 'a dataset name that is not kebab-case',
    manifests: [manifest({ dataset: 'Direct_Caller' })],
  },
  {
    why: 'a purpose outside the permitted set',
    manifests: [manifest({ purpose: 'production' as FixtureManifest['purpose'] })],
  },
  {
    why: 'two datasets claiming one name',
    manifests: [manifest(), manifest({ tables: table([{ version_id: 'ver-2' }]) })],
  },
  {
    why: 'a dependency on a dataset that does not exist',
    manifests: [manifest({ dependsOn: ['nowhere'] })],
  },
];

test('seed refuses every invalid manifest a direct caller can hand it', async () => {
  for (const scenario of INVALID) {
    const database = new SeedFakeDatabase();

    await assert.rejects(
      seed(database, { manifests: scenario.manifests }),
      (error: unknown) => {
        assert.equal(codeOf(error), 'invalid-fixtures', `${scenario.why} must be refused`);
        return true;
      },
      `seed accepted ${scenario.why}`,
    );

    // Refused *before* a connection is opened. Validating after connecting would still refuse, but
    // it would also mean an invalid fixture set had already reached the database.
    assert.equal(database.sessionsOpened, 0, `${scenario.why}: a connection was opened anyway`);
    assert.equal(database.totalRows, 0);
  }
});

test('unseed and replace refuse the same manifests seed does', async () => {
  for (const scenario of INVALID) {
    for (const [name, operation] of [
      ['unseed', unseed],
      ['replace', replace],
    ] as const) {
      const database = new SeedFakeDatabase();
      await assert.rejects(
        operation(database, { manifests: scenario.manifests }),
        (error: unknown) => codeOf(error) === 'invalid-fixtures',
        `${name} accepted ${scenario.why}`,
      );
      assert.equal(database.sessionsOpened, 0, `${name} opened a connection for ${scenario.why}`);
    }
  }
});

test('the refusal names every violation, not merely the first', async () => {
  const database = new SeedFakeDatabase();

  await assert.rejects(
    seed(database, {
      manifests: [
        manifest({
          tables: table([
            { version_id: 'ver-1', created_at: 'now()' },
            { version_id: 'ver-1', value_text: 'someone@gmail.com' },
          ]),
        }),
      ],
    }),
    (error: unknown) => {
      const message = (error as SeedError).message;
      assert.match(message, /nondeterministic-value/);
      assert.match(message, /personal-data/);
      assert.match(message, /duplicate-identity/);
      // Fixing one at a time, guessing each round, is how a validator that stops at the first
      // problem gets worked around instead of used.
      return true;
    },
  );
});

test('a valid manifest built in code still loads', async () => {
  const database = new SeedFakeDatabase();
  const report = await seed(database, { manifests: [manifest()] });

  assert.equal(report.rowsInserted, 1, 'validation refuses the invalid, not the unfamiliar');
  assert.equal(database.totalRows, 1);
});

test('validateManifests reports what validateFixtures reports, for the same data', () => {
  // The two entry points must not disagree: one reads files and the other does not, and that is
  // the only difference there should be.
  const fromFiles = validateFixtures(path.join(REPO_ROOT, FIXTURES_DIR));
  const fromMemory = validateManifests(fromFiles.manifests);

  assert.deepEqual(fromMemory.violations, []);
  assert.deepEqual(
    fromMemory.manifests.map((entry) => entry.dataset),
    fromFiles.manifests.map((entry) => entry.dataset),
  );
});

// ---------------------------------------------------------------------------
// 2. Replacement is one transaction
// ---------------------------------------------------------------------------

test('a successful replacement commits once, having deleted and reloaded', async () => {
  const database = new SeedFakeDatabase();
  const loaded = await seed(database, { manifests: REAL });
  const commitsAfterLoad = database.commits;
  const rowsAfterLoad = database.totalRows;

  const report = await replace(database, { manifests: REAL });

  assert.equal(report.rowsRemoved, loaded.rowsInserted, 'every seeded row was removed');
  assert.equal(report.rowsInserted, loaded.rowsInserted, 'and every one was put back');
  assert.equal(database.totalRows, rowsAfterLoad, 'the database holds what it held before');

  assert.equal(database.commits - commitsAfterLoad, 1, 'one commit, not one per phase');
  assert.equal(database.rollbacks, 0);
  assert.equal(database.sessionsOpened, 2, 'one connection for the load, one for the replacement');
});

test('the delete and the reload share a transaction, deletes first', async () => {
  const database = new SeedFakeDatabase();
  await seed(database, { manifests: REAL });
  const start = database.statements.length;

  await replace(database, { manifests: REAL });
  const statements = database.statements.slice(start);

  const begins = statements.filter((sql) => /^BEGIN/i.test(sql)).length;
  const commits = statements.filter((sql) => /^COMMIT/i.test(sql)).length;
  assert.equal(begins, 1);
  assert.equal(commits, 1);

  const lastDelete = statements.map((sql) => /^DELETE/i.test(sql)).lastIndexOf(true);
  const firstInsert = statements.findIndex((sql) => /^INSERT/i.test(sql));
  assert.ok(lastDelete >= 0 && firstInsert > lastDelete, 'every delete precedes every insert');

  // No commit between them: that gap is exactly where the database would hold nothing.
  const between = statements.slice(lastDelete, firstInsert);
  assert.equal(
    between.filter((sql) => /^COMMIT/i.test(sql)).length,
    0,
    'a commit here would leave the database empty if the reload then failed',
  );
});

test('a replacement that fails while reloading preserves every original row', async () => {
  const first = new SeedFakeDatabase();
  await seed(first, { manifests: REAL });
  const original = Object.fromEntries(first.tableNames.map((name) => [name, first.rowsOf(name)]));
  const originalCount = first.totalRows;
  assert.ok(originalCount > 0);

  // The deletes all succeed; the reload fails partway through the second dataset. Matching on the
  // INSERT rather than on a row value matters: a value-based failure would also fire on the DELETE
  // of the same row, and the test would then be proving something about the delete phase instead.
  const database = new SeedFakeDatabase({
    rows: original,
    failOn: /^INSERT INTO kernel_event_infrastructure/i,
  });

  await assert.rejects(replace(database, { manifests: REAL }), (error: unknown) => {
    assert.equal(codeOf(error), 'sql-failed');
    assert.match((error as SeedError).message, /rolled back; the original rows are unchanged/);
    return true;
  });

  assert.ok(
    database.statements.filter((sql) => /^DELETE/i.test(sql)).length > 0,
    'the delete phase ran, so this is a failure *after* the rows had been removed in-transaction',
  );
  assert.ok(
    database.statements.some((sql) => /^INSERT INTO kernel_configuration/i.test(sql)),
    'and the reload had started before it failed',
  );
  assert.equal(database.totalRows, originalCount, 'nothing was lost');
  for (const name of first.tableNames) {
    assert.deepEqual(
      database.rowsOf(name),
      first.rowsOf(name),
      `${name} is exactly as it was before the replacement`,
    );
  }
  assert.equal(database.rollbacks, 1);
  assert.equal(database.commits, 0);
  assert.equal(database.sessionsReleased, 1, 'the connection is released on the failure path');
});

test('a replacement that fails while deleting preserves every original row', async () => {
  const first = new SeedFakeDatabase();
  await seed(first, { manifests: REAL });
  const original = Object.fromEntries(first.tableNames.map((name) => [name, first.rowsOf(name)]));

  const database = new SeedFakeDatabase({ rows: original, failOn: /^DELETE FROM/i });

  await assert.rejects(replace(database, { manifests: REAL }));
  assert.equal(database.totalRows, first.totalRows);
  assert.equal(database.rollbacks, 1);
  assert.equal(database.commits, 0);
});

test('replacement reloads rows an operator had deleted by hand', async () => {
  // The point of `reset` rather than a second `load`: a load is idempotent and would leave a
  // hand-modified row alone, whereas a replacement restores the declared state.
  const database = new SeedFakeDatabase();
  await seed(database, { manifests: REAL });

  const edited = Object.fromEntries(
    database.tableNames.map((name) => [
      name,
      name.endsWith('config_version') ? database.rowsOf(name).slice(1) : database.rowsOf(name),
    ]),
  );
  const trimmed = new SeedFakeDatabase({ rows: edited });
  const before = trimmed.totalRows;

  const report = await replace(trimmed, { manifests: REAL });

  assert.equal(report.rowsRemoved, before, 'only the rows that were there could be removed');
  assert.ok(report.rowsInserted > report.rowsRemoved, 'and the missing one came back');
  assert.equal(trimmed.totalRows, database.totalRows, 'the declared state is restored');
});

// ---------------------------------------------------------------------------
// 3. Fingerprints are recomputed, not trusted
// ---------------------------------------------------------------------------

test('the fixture fingerprint algorithm matches the one EventService uses', () => {
  // The two implementations are separate because `platform/` may not import `kernel/` — an upward
  // import is exactly what the layer-direction rule forbids. This is the guard on that duplication.
  const corpus: ReadonlyArray<Readonly<Record<string, unknown>>> = [
    {},
    { a: 1 },
    { a: 'x', b: 2, c: true },
    { c: true, b: 2, a: 'x' },
    { nullish: null },
    { 'key with spaces': 'value', ünïcode: 'ü' },
    { nested_looking: '{"a":1}' },
    { quote: 'he said "hi"', backslash: 'a\\b' },
    { big: Number.MAX_SAFE_INTEGER, negative: -1, zero: 0 },
    // Every payload in the real fixtures, so the corpus is not merely invented examples.
    ...REAL.flatMap((entry) =>
      entry.tables.flatMap((tableEntry) =>
        tableEntry.rows.flatMap((row) => {
          const payload = asRecord(row.payload);
          return payload === null ? [] : [payload];
        }),
      ),
    ),
  ];

  for (const payload of corpus) {
    assert.equal(
      platformFingerprint(payload),
      kernelFingerprint(payload as Parameters<typeof kernelFingerprint>[0]),
      `the two implementations disagree on ${JSON.stringify(payload)}`,
    );
  }

  // And key order does not matter, which is the property that makes it a fingerprint of content.
  assert.equal(platformFingerprint({ a: 1, b: 2 }), platformFingerprint({ b: 2, a: 1 }));
});

test('every fingerprint in the real fixtures is the fingerprint of its own payload', () => {
  let checked = 0;

  for (const entry of REAL) {
    for (const tableEntry of entry.tables) {
      for (const row of tableEntry.rows) {
        const declared = row.payload_fingerprint;
        if (declared === undefined) continue;
        checked += 1;
        assert.equal(
          declared,
          platformFingerprint(asRecord(row.payload) ?? {}),
          `${entry.dataset} ${tableEntry.table} declares a fingerprint of something else`,
        );
      }
    }
  }

  assert.ok(checked >= 3, `expected the K-08 event rows to be checked, checked ${checked}`);
});

test('an altered payload and an altered fingerprint are both refused before any database access', async () => {
  const eventManifest = (payload: unknown, fingerprint: string): FixtureManifest =>
    ({
      manifestVersion: 1,
      dataset: 'fingerprint-probe',
      owner: 'K-08',
      schema: 'kernel_event_infrastructure',
      purpose: 'test',
      description: 'probe',
      dependsOn: [],
      tables: [
        {
          table: 'kernel_event_infrastructure.event',
          identity: ['event_id'],
          jsonColumns: ['payload'],
          rows: [
            {
              event_id: 'evt-probe-1',
              payload,
              payload_fingerprint: fingerprint,
            },
          ],
        },
      ],
    }) as FixtureManifest;

  const payload = { version_id: 'ver-1', config_key: 'session.timeout_seconds' };
  const correct = platformFingerprint(payload);

  // A consistent pair is accepted, so the cases below fail for the reason claimed.
  await seed(new SeedFakeDatabase(), { manifests: [eventManifest(payload, correct)] });

  const cases: ReadonlyArray<{ readonly why: string; readonly manifest: FixtureManifest }> = [
    {
      why: 'the payload was edited without recomputing',
      manifest: eventManifest({ ...payload, config_key: 'search.results_per_page' }, correct),
    },
    {
      why: 'the fingerprint was edited without recomputing',
      manifest: eventManifest(payload, 'f'.repeat(64)),
    },
    {
      why: 'the fingerprint was copied from another row',
      manifest: eventManifest(payload, platformFingerprint({ other: 'payload' })),
    },
    {
      why: 'the fingerprint is not a SHA-256 at all',
      manifest: eventManifest(payload, 'not-a-hash'),
    },
    {
      why: 'a fingerprint with no payload to confirm it',
      manifest: eventManifest(undefined, correct),
    },
  ];

  for (const scenario of cases) {
    const database = new SeedFakeDatabase();
    await assert.rejects(
      seed(database, { manifests: [scenario.manifest] }),
      (error: unknown) => {
        assert.equal(codeOf(error), 'invalid-fixtures');
        assert.match((error as SeedError).message, /fingerprint-mismatch/);
        return true;
      },
      `accepted: ${scenario.why}`,
    );
    assert.equal(database.sessionsOpened, 0, `${scenario.why}: a connection was opened`);
  }
});

test('a payload edited in the real fixture set would be caught', () => {
  // The regression this exists for: somebody changes a fixture payload, the fingerprint beside it
  // no longer describes it, and the row is seeded with evidence that contradicts it.
  const events = REAL.find((entry) => entry.owner === 'K-08');
  assert.ok(events !== undefined);

  const tampered: FixtureManifest = {
    ...events,
    tables: events.tables.map((tableEntry) =>
      tableEntry.table.endsWith('.event')
        ? {
            ...tableEntry,
            rows: tableEntry.rows.map((row, index) =>
              index === 0 ? { ...row, payload: { version_id: 'tampered' } } : row,
            ),
          }
        : tableEntry,
    ),
  };

  const { violations } = validateManifests([tampered]);
  assert.ok(
    violations.some((violation) => violation.check === 'fingerprint-mismatch'),
    'editing a payload without recomputing its fingerprint must be refused',
  );
});
