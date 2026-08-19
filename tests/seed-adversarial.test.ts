/**
 * FND-002d — what a hostile or careless programmatic caller can hand the runner.
 *
 * The previous correction made validation mandatory on every runner path. It did not make that
 * validation *complete* for inputs that never came from a file: `describeShapeProblem` checked the
 * fields a JSON parse would have checked, and trusted the rest because TypeScript said so.
 * TypeScript says nothing at runtime. A caller in JavaScript, a caller that cast an `unknown`, a
 * caller deserialising something over a wire — each can hand over an `identity` containing
 * `"id); DROP TABLE"`, a `dependsOn` holding an object, or a row that is an array.
 *
 * Two consequences, and only one of them is theoretical:
 *
 *   - Column names are interpolated into SQL. `ON CONFLICT (${identity.join(', ')})` and
 *     `WHERE ${column} = $1` cannot be parameterised, so a column name is the one place caller
 *     input reaches a statement as text.
 *   - A non-string dependency silently matches no dataset, so the ordering it was meant to express
 *     disappears and the load runs in an order nobody asked for, reporting nothing.
 *
 * Every case below is cast past the type system on purpose, because that is precisely the caller
 * these checks exist for. Each is asserted to be refused with **no connection opened** — validation
 * that runs after connecting would still refuse, but the invalid set would already have reached the
 * database.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { EVENT_TABLE } from '../kernel/event-infrastructure/index.ts';
import {
  FINGERPRINTED_TABLES,
  FIXTURES_DIR,
  validateFixtures,
  validateManifests,
  type FixtureManifest,
} from '../platform/fixtures/manifest.ts';
import { fingerprintPayload } from '../platform/fixtures/fingerprint.ts';
import { SeedError, replace, seed, unseed } from '../platform/fixtures/runner.ts';

import { SeedFakeDatabase } from './helpers/seed-database.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REAL = validateFixtures(path.join(REPO_ROOT, FIXTURES_DIR)).manifests;

const codeOf = (error: unknown): string | undefined =>
  error instanceof SeedError ? error.code : undefined;

/**
 * A manifest built from an arbitrary object.
 *
 * The cast is the point of the file: it stands in for every runtime path that produces a value
 * TypeScript never saw — JSON off a socket, a JavaScript caller, an `unknown` somebody asserted.
 */
const hostile = (shape: Record<string, unknown>): FixtureManifest =>
  shape as unknown as FixtureManifest;

const base = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  manifestVersion: 1,
  dataset: 'hostile',
  owner: 'K-05',
  schema: 'kernel_configuration',
  purpose: 'development',
  description: 'cast past the type system',
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

/** A dataset with one table, so a case can replace exactly one field of it. */
const withTable = (table: Record<string, unknown>): Record<string, unknown> =>
  base({ tables: [table] });

const CASES: ReadonlyArray<{ readonly why: string; readonly manifest: FixtureManifest }> = [
  // --- dependsOn -----------------------------------------------------------------------------
  {
    why: 'a dependency that is a number',
    manifest: hostile(base({ dependsOn: [1] })),
  },
  {
    why: 'a dependency that is an object',
    manifest: hostile(base({ dependsOn: [{ dataset: 'other' }] })),
  },
  {
    why: 'a dependency that is null',
    manifest: hostile(base({ dependsOn: [null] })),
  },
  {
    why: 'a dependency that is an empty string',
    manifest: hostile(base({ dependsOn: [''] })),
  },
  {
    why: 'a dependsOn that is a string rather than an array',
    manifest: hostile(base({ dependsOn: 'k05-configuration-baseline' })),
  },
  {
    why: 'a dependsOn that is an object',
    manifest: hostile(base({ dependsOn: { first: 'a' } })),
  },

  // --- identity ------------------------------------------------------------------------------
  {
    why: 'an identity column carrying SQL',
    manifest: hostile(
      withTable({
        table: 'kernel_configuration.config_version',
        identity: ['version_id); DROP TABLE kernel_configuration.config_version; --'],
        rows: [{ version_id: 'ver-1' }],
      }),
    ),
  },
  {
    why: 'an identity column closing the conflict clause',
    manifest: hostile(
      withTable({
        table: 'kernel_configuration.config_version',
        identity: ['version_id) DO UPDATE SET value_text = (SELECT 1'],
        rows: [{ version_id: 'ver-1' }],
      }),
    ),
  },
  {
    why: 'an identity column with a quote in it',
    manifest: hostile(
      withTable({
        table: 'kernel_configuration.config_version',
        identity: ['"version_id"'],
        rows: [{ version_id: 'ver-1' }],
      }),
    ),
  },
  {
    why: 'an identity column with a space in it',
    manifest: hostile(
      withTable({
        table: 'kernel_configuration.config_version',
        identity: ['version id'],
        rows: [{ version_id: 'ver-1' }],
      }),
    ),
  },
  {
    why: 'an identity column in upper case',
    manifest: hostile(
      withTable({
        table: 'kernel_configuration.config_version',
        identity: ['VERSION_ID'],
        rows: [{ VERSION_ID: 'ver-1' }],
      }),
    ),
  },
  {
    why: 'an identity column that is a number',
    manifest: hostile(
      withTable({
        table: 'kernel_configuration.config_version',
        identity: [1],
        rows: [{ version_id: 'ver-1' }],
      }),
    ),
  },
  {
    why: 'an identity column that is null',
    manifest: hostile(
      withTable({
        table: 'kernel_configuration.config_version',
        identity: [null],
        rows: [{ version_id: 'ver-1' }],
      }),
    ),
  },
  {
    why: 'the same identity column declared twice',
    manifest: hostile(
      withTable({
        table: 'kernel_configuration.config_version',
        identity: ['version_id', 'version_id'],
        rows: [{ version_id: 'ver-1' }],
      }),
    ),
  },
  {
    why: 'an identity that is a string rather than an array',
    manifest: hostile(
      withTable({
        table: 'kernel_configuration.config_version',
        identity: 'version_id',
        rows: [{ version_id: 'ver-1' }],
      }),
    ),
  },

  // --- jsonColumns ---------------------------------------------------------------------------
  {
    why: 'a jsonColumns that is a string',
    manifest: hostile(
      withTable({
        table: 'kernel_configuration.config_version',
        identity: ['version_id'],
        jsonColumns: 'payload',
        rows: [{ version_id: 'ver-1' }],
      }),
    ),
  },
  {
    why: 'a JSON column that is a number',
    manifest: hostile(
      withTable({
        table: 'kernel_configuration.config_version',
        identity: ['version_id'],
        jsonColumns: [7],
        rows: [{ version_id: 'ver-1' }],
      }),
    ),
  },
  {
    why: 'a JSON column carrying a cast',
    manifest: hostile(
      withTable({
        table: 'kernel_configuration.config_version',
        identity: ['version_id'],
        jsonColumns: ['payload::text, version_id'],
        rows: [{ version_id: 'ver-1' }],
      }),
    ),
  },
  {
    why: 'the same JSON column declared twice',
    manifest: hostile(
      withTable({
        table: 'kernel_configuration.config_version',
        identity: ['version_id'],
        jsonColumns: ['value_text', 'value_text'],
        rows: [{ version_id: 'ver-1' }],
      }),
    ),
  },
  {
    why: 'a column declared as both identity and JSON',
    manifest: hostile(
      withTable({
        table: 'kernel_configuration.config_version',
        identity: ['version_id'],
        jsonColumns: ['version_id'],
        rows: [{ version_id: 'ver-1' }],
      }),
    ),
  },

  // --- rows and tables -----------------------------------------------------------------------
  {
    why: 'a row that is an array',
    manifest: hostile(
      withTable({
        table: 'kernel_configuration.config_version',
        identity: ['version_id'],
        rows: [['ver-1', '900']],
      }),
    ),
  },
  {
    why: 'a row that is a string',
    manifest: hostile(
      withTable({
        table: 'kernel_configuration.config_version',
        identity: ['version_id'],
        rows: ['ver-1'],
      }),
    ),
  },
  {
    why: 'a row that is null',
    manifest: hostile(
      withTable({
        table: 'kernel_configuration.config_version',
        identity: ['version_id'],
        rows: [null],
      }),
    ),
  },
  {
    why: 'a row with no columns at all',
    manifest: hostile(
      withTable({
        table: 'kernel_configuration.config_version',
        identity: ['version_id'],
        rows: [{}],
      }),
    ),
  },
  {
    why: 'rows that are an object rather than an array',
    manifest: hostile(
      withTable({
        table: 'kernel_configuration.config_version',
        identity: ['version_id'],
        rows: { first: { version_id: 'ver-1' } },
      }),
    ),
  },
  {
    why: 'a table that is an array',
    manifest: hostile(base({ tables: [['kernel_configuration.config_version']] })),
  },
  {
    why: 'a table that is null',
    manifest: hostile(base({ tables: [null] })),
  },
  {
    why: 'a table name that is not schema-qualified',
    manifest: hostile(
      withTable({ table: 'config_version', identity: ['version_id'], rows: [{ version_id: 'x' }] }),
    ),
  },
  {
    why: 'a table name carrying a second statement',
    manifest: hostile(
      withTable({
        table: 'kernel_configuration.config_version; DROP SCHEMA kernel_configuration CASCADE',
        identity: ['version_id'],
        rows: [{ version_id: 'ver-1' }],
      }),
    ),
  },
  {
    why: 'a tables value that is an object rather than an array',
    manifest: hostile(base({ tables: { first: {} } })),
  },
];

test('every hostile manifest is refused by seed, before a connection opens', async () => {
  for (const scenario of CASES) {
    const database = new SeedFakeDatabase();

    await assert.rejects(
      seed(database, { manifests: [scenario.manifest] }),
      (error: unknown) => {
        assert.equal(codeOf(error), 'invalid-fixtures', `${scenario.why}: wrong refusal`);
        return true;
      },
      `seed accepted ${scenario.why}`,
    );

    assert.equal(database.sessionsOpened, 0, `${scenario.why}: a connection was opened`);
    assert.equal(database.statements.length, 0, `${scenario.why}: a statement was issued`);
    assert.equal(database.totalRows, 0);
  }
});

test('unseed and replace refuse every hostile manifest too', async () => {
  for (const scenario of CASES) {
    for (const [name, operation] of [
      ['unseed', unseed],
      ['replace', replace],
    ] as const) {
      const database = new SeedFakeDatabase();
      await assert.rejects(
        operation(database, { manifests: [scenario.manifest] }),
        (error: unknown) => codeOf(error) === 'invalid-fixtures',
        `${name} accepted ${scenario.why}`,
      );
      assert.equal(database.sessionsOpened, 0, `${name} opened a connection for ${scenario.why}`);
      assert.equal(database.statements.length, 0, `${name} issued SQL for ${scenario.why}`);
    }
  }
});

test('a hostile manifest alongside valid ones stops the whole load', async () => {
  // Validation is over the set, not per dataset: a caller must not be able to smuggle one bad
  // dataset in behind good ones and have the good ones load anyway.
  const database = new SeedFakeDatabase();

  await assert.rejects(
    seed(database, {
      manifests: [
        ...REAL,
        hostile(
          withTable({
            table: 'kernel_configuration.config_version',
            identity: ['id"; DELETE FROM kernel_configuration.config_version WHERE true; --'],
            rows: [{ version_id: 'ver-1' }],
          }),
        ),
      ],
    }),
    (error: unknown) => codeOf(error) === 'invalid-fixtures',
  );
  assert.equal(database.sessionsOpened, 0);
  assert.equal(database.totalRows, 0, 'the valid datasets did not load either');
});

test('no column name that reaches SQL can contain anything but lower_snake_case', async () => {
  // The property, stated once rather than case by case: whatever a caller supplies, every
  // identifier that ends up interpolated has been through COLUMN_NAME.
  const database = new SeedFakeDatabase();
  await seed(database, { manifests: REAL });

  const interpolated: string[] = [];
  for (const sql of database.statements) {
    const insert = /^INSERT INTO [\w.]+ \(([^)]*)\)[\s\S]*ON CONFLICT \(([^)]*)\)/i.exec(sql);
    if (insert !== null) {
      interpolated.push(...(insert[1] ?? '').split(','), ...(insert[2] ?? '').split(','));
    }
  }

  assert.ok(interpolated.length > 0, 'there were statements to inspect');
  for (const column of interpolated) {
    assert.match(
      column.trim(),
      /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/,
      `an identifier reached SQL that is not a plain column name: ${column}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Event rows must carry their evidence
// ---------------------------------------------------------------------------

const eventTable = (row: Record<string, unknown>): FixtureManifest =>
  hostile({
    manifestVersion: 1,
    dataset: 'hostile-events',
    owner: 'K-08',
    schema: 'kernel_event_infrastructure',
    purpose: 'test',
    description: 'cast past the type system',
    dependsOn: [],
    tables: [
      {
        table: 'kernel_event_infrastructure.event',
        identity: ['event_id'],
        jsonColumns: ['payload'],
        rows: [row],
      },
    ],
  });

const PAYLOAD = { version_id: 'ver-1', config_key: 'session.timeout_seconds' };

test('the fingerprinted-table list still names the table K-08 actually writes', () => {
  // `platform/` cannot import `kernel/` in production code, so the name is duplicated. This is the
  // guard: if K-08 ever renames its table, the constant here stops matching and this fails.
  assert.deepEqual([...FINGERPRINTED_TABLES], [EVENT_TABLE]);
});

test('an event row with no fingerprint is refused, not quietly accepted', async () => {
  // The gap this closes: checking only the fingerprints that are present lets a row opt out by
  // omitting the field — and the row that omits it is exactly the one nobody computed one for.
  const database = new SeedFakeDatabase();

  await assert.rejects(
    seed(database, {
      manifests: [eventTable({ event_id: 'evt-1', payload: PAYLOAD })],
    }),
    (error: unknown) => {
      assert.equal(codeOf(error), 'invalid-fixtures');
      assert.match((error as SeedError).message, /fingerprint-mismatch/);
      assert.match((error as SeedError).message, /no payload_fingerprint/);
      return true;
    },
  );
  assert.equal(database.sessionsOpened, 0);
});

test('an event row with a missing, null or non-object payload is refused', async () => {
  const cases: ReadonlyArray<{ readonly why: string; readonly row: Record<string, unknown> }> = [
    {
      why: 'no payload at all',
      row: { event_id: 'evt-1', payload_fingerprint: fingerprintPayload(PAYLOAD) },
    },
    {
      why: 'a null payload',
      row: {
        event_id: 'evt-1',
        payload: null,
        payload_fingerprint: fingerprintPayload(PAYLOAD),
      },
    },
    {
      why: 'a payload that is an array',
      row: {
        event_id: 'evt-1',
        payload: [1, 2, 3],
        payload_fingerprint: fingerprintPayload(PAYLOAD),
      },
    },
    {
      why: 'a payload that is a string',
      row: {
        event_id: 'evt-1',
        payload: '{"version_id":"ver-1"}',
        payload_fingerprint: fingerprintPayload(PAYLOAD),
      },
    },
    {
      why: 'a payload that is a number',
      row: { event_id: 'evt-1', payload: 42, payload_fingerprint: fingerprintPayload(PAYLOAD) },
    },
  ];

  for (const scenario of cases) {
    const database = new SeedFakeDatabase();
    await assert.rejects(
      seed(database, { manifests: [eventTable(scenario.row)] }),
      (error: unknown) => {
        assert.equal(codeOf(error), 'invalid-fixtures', scenario.why);
        return true;
      },
      `accepted ${scenario.why}`,
    );
    assert.equal(database.sessionsOpened, 0, `${scenario.why}: a connection was opened`);
  }
});

test('an event row with a malformed fingerprint is refused', async () => {
  const malformed = [
    '',
    'not-a-hash',
    'F0DD5A8A762380A14B9E7E6851D193858DA35CA88560B74BD3E9F5A96CC82844', // upper case
    'f0dd5a8a762380a14b9e7e6851d193858da35ca88560b74bd3e9f5a96cc828', // too short
    `${'f'.repeat(64)}0`, // too long
    'zzzz5a8a762380a14b9e7e6851d193858da35ca88560b74bd3e9f5a96cc82844', // not hex
  ];

  for (const fingerprint of malformed) {
    const database = new SeedFakeDatabase();
    await assert.rejects(
      seed(database, {
        manifests: [
          eventTable({ event_id: 'evt-1', payload: PAYLOAD, payload_fingerprint: fingerprint }),
        ],
      }),
      (error: unknown) => codeOf(error) === 'invalid-fixtures',
      `accepted fingerprint ${JSON.stringify(fingerprint)}`,
    );
    assert.equal(database.sessionsOpened, 0);
  }

  // A fingerprint that is not a string at all.
  for (const fingerprint of [null, 42, true, ['f'.repeat(64)]]) {
    const database = new SeedFakeDatabase();
    await assert.rejects(
      seed(database, {
        manifests: [
          eventTable({ event_id: 'evt-1', payload: PAYLOAD, payload_fingerprint: fingerprint }),
        ],
      }),
      (error: unknown) => codeOf(error) === 'invalid-fixtures',
      `accepted fingerprint ${JSON.stringify(fingerprint)}`,
    );
  }
});

test('a correctly fingerprinted event row still loads', async () => {
  // The refusals above must be refusing what they claim to, not refusing event rows in general.
  const database = new SeedFakeDatabase();
  const report = await seed(database, {
    manifests: [
      eventTable({
        event_id: 'evt-1',
        payload: PAYLOAD,
        payload_fingerprint: fingerprintPayload(PAYLOAD),
      }),
    ],
  });

  assert.equal(report.rowsInserted, 1);
  assert.equal(database.totalRows, 1);
});

test('rows in other tables are not required to carry a fingerprint', async () => {
  // The rule is about the event log, not about every table. A configuration row has no payload and
  // must not be asked for evidence of one.
  const database = new SeedFakeDatabase();
  const report = await seed(database, { manifests: [hostile(base())] });

  assert.equal(report.rowsInserted, 1);
});

test('the requirement is enforced through validateManifests as well as through the runner', () => {
  // The runner is one caller of the validator. Anything using the validator directly — the CLI, a
  // future tool — gets the same answer.
  const { violations } = validateManifests([eventTable({ event_id: 'evt-1', payload: PAYLOAD })]);

  assert.ok(
    violations.some((violation) => violation.check === 'fingerprint-mismatch'),
    'validateManifests must refuse an event row with no fingerprint',
  );
});

test('the real event fixtures satisfy the requirement they impose', () => {
  const events = REAL.flatMap((manifest) =>
    manifest.tables
      .filter((table) => FINGERPRINTED_TABLES.includes(table.table))
      .flatMap((table) => table.rows),
  );

  assert.ok(events.length > 0, 'there are event rows to check');
  for (const row of events) {
    assert.ok(row.payload !== undefined, 'every event fixture row carries a payload');
    assert.ok(
      typeof row.payload_fingerprint === 'string',
      'and a fingerprint, which is now required rather than optional',
    );
  }
});
