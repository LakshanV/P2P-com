/**
 * K-07 Feature Flags — port conformance, adapter queries, the migration and the contract (FND-004e).
 *
 * Three claims here are about the layers a service test cannot see.
 *
 * **There is no UPDATE and no DELETE anywhere in this module or its schema.** Not in the service,
 * not in the port, not in the adapter, and not reachable through the tables — three triggers refuse
 * both. A definition that could be edited answers "what is this flag set to" and destroys "what was
 * it doing at 14:05, and who changed it", which is the question a flag's history exists for.
 *
 * **The current version is the end of a chain, not the newest row.** `ORDER BY activated_at DESC`
 * would be wrong: two activations can share an instant and a clock is not a history. The query is
 * asserted to be an anti-join.
 *
 * **A row written around the adapter is refused rather than evaluated.** K-01 needed a correction
 * to reach that shape (§11.22) and K-04 found the same hole in its adapter; the decode cases below
 * are the ones that keep it closed here.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { KERNEL_COMPONENTS } from '../platform/architecture/manifest.ts';
import { stripNoise } from '../platform/db/migrations.ts';
import { KERNEL_SCHEMA_PREFIX, knownSchemas } from '../platform/db/schema-namespaces.ts';
import {
  ACTIVATION_TABLE,
  FEATURE_FLAGS_SCHEMA,
  FeatureFlagError,
  InMemoryFeatureFlagRepository,
  LIFECYCLE_TABLE,
  OUTBOX_TABLE,
  PostgresFeatureFlagRepository,
  TIMESTAMP_COLUMNS,
  VERSION_TABLE,
  enlistedClient,
  toActivation,
  toFlagVersion,
  toLifecycleEvent,
} from '../kernel/feature-flags/index.ts';

import { activationRow, lifecycleRow, versionRow } from './helpers/feature-flag-fixtures.ts';
import { RecordingDatabase, sqlstateError } from './helpers/recording-database.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE_DIR = path.join(HERE, '..', 'kernel', 'feature-flags');
const ADAPTER_SOURCE = readFileSync(path.join(MODULE_DIR, 'postgres-repository.ts'), 'utf8');
const PORT_SOURCE = readFileSync(path.join(MODULE_DIR, 'repository.ts'), 'utf8');
const CONTRACT = readFileSync(path.join(MODULE_DIR, 'CONTRACT.md'), 'utf8');
const TYPES_SOURCE = readFileSync(path.join(MODULE_DIR, 'types.ts'), 'utf8');
const MIGRATIONS = path.join(HERE, '..', 'db', 'migrations');
const MIGRATION_UP = readFileSync(
  path.join(MIGRATIONS, '0010_create_kernel_feature_flags_schema.up.sql'),
  'utf8',
);
const MIGRATION_DOWN = readFileSync(
  path.join(MIGRATIONS, '0010_create_kernel_feature_flags_schema.down.sql'),
  'utf8',
);

const codeOf = (error: unknown): string | undefined =>
  error instanceof FeatureFlagError ? error.code : undefined;

const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)\/\/[^\n]*/g, ' ');

// ---------------------------------------------------------------------------
// Append-only, at every layer
// ---------------------------------------------------------------------------

test('neither the port nor the adapter can update or delete a flag', () => {
  for (const [name, source] of [
    ['the port', PORT_SOURCE],
    ['the adapter', ADAPTER_SOURCE],
  ] as const) {
    const code = stripComments(source);
    assert.ok(!/\bUPDATE\s+\w/i.test(code), `${name} contains an UPDATE statement`);
    assert.ok(!/\bDELETE\s+FROM\b/i.test(code), `${name} contains a DELETE statement`);
  }
});

test('the migration refuses UPDATE and DELETE on every table it creates', () => {
  const created = [...MIGRATION_UP.matchAll(/CREATE TABLE IF NOT EXISTS ([\w.]+)/g)].map(
    (match) => match[1],
  );
  assert.equal(created.length, 3, 'the schema has three tables');

  for (const table of created) {
    const name = String(table).split('.').pop();
    assert.match(
      MIGRATION_UP,
      new RegExp(`BEFORE UPDATE OR DELETE ON ${String(table).replace('.', '\\.')}`),
      `${name} has no append-only trigger`,
    );
  }
});

test('a failed transaction writes nothing', async () => {
  const repository = new InMemoryFeatureFlagRepository();
  await assert.rejects(
    repository.withTransaction(async (tx) => {
      await tx.insertVersion({
        flagVersionId: 'flagver_01HQZXPORT01',
        flagKey: 'commerce.autonomous-purchasing',
        version: 1,
        state: 'on',
        supportedScopes: ['global'],
        rules: [],
        percentage: 0,
        rolloutSalt: 'salt01HQZXPORT01',
        notBefore: null,
        notAfter: null,
        publishedAt: '2026-04-01T12:00:00Z',
        publishedBy: { kind: 'system', id: 'k07-release-console' },
        idempotencyKey: 'idem_01HQZXPORT001',
        requestFingerprint: 'b'.repeat(64),
      });
      throw new Error('something went wrong after the insert');
    }),
    /something went wrong/,
  );
  assert.equal(repository.versions().length, 0);
  assert.equal(repository.transactionsRolledBack, 1);
});

// ---------------------------------------------------------------------------
// Adapter queries
// ---------------------------------------------------------------------------

test('every read projects its timestamps as UTC text, never as a driver Date', async () => {
  const database = new RecordingDatabase({
    selects: [
      { match: /feature_flag_version/i, rows: [versionRow()] },
      { match: /feature_flag_activation/i, rows: [activationRow()] },
      { match: /feature_flag_lifecycle/i, rows: [lifecycleRow()] },
    ],
  });

  await new PostgresFeatureFlagRepository(database).withTransaction(async (tx) => {
    await tx.findVersionById('flagver_01HQZXTESTROW');
    await tx.findCurrentActivation('commerce.autonomous-purchasing');
    await tx.listLifecycleEvents('commerce.autonomous-purchasing');
  });

  const selects = database.statements().filter((sql) => sql.startsWith('SELECT'));
  assert.ok(selects.length >= 3);
  for (const sql of selects) {
    for (const column of TIMESTAMP_COLUMNS) {
      if (!sql.includes(column)) continue;
      assert.match(
        sql,
        new RegExp(`to_char\\(${column} AT TIME ZONE 'UTC'`),
        `${column} is selected raw in: ${sql}`,
      );
    }
  }
});

test('the current activation is the end of the chain, not the newest row', async () => {
  const database = new RecordingDatabase({
    selects: [{ match: /feature_flag_activation/i, rows: [] }],
  });
  await new PostgresFeatureFlagRepository(database).withTransaction((tx) =>
    tx.findCurrentActivation('commerce.autonomous-purchasing'),
  );

  const sql = database.statements().find((statement) => statement.startsWith('SELECT')) ?? '';
  assert.match(sql, /NOT EXISTS/i, 'the current version must be found by anti-join');
  assert.match(sql, /supersedes_version_id = current\.flag_version_id/);
  assert.ok(
    !/ORDER BY\s+activated_at/i.test(sql),
    'ordering by the clock would pick arbitrarily between two activations sharing an instant',
  );
});

test('lifecycle events are read for one flag key, never for all of them', async () => {
  const database = new RecordingDatabase({
    selects: [{ match: /feature_flag_lifecycle/i, rows: [] }],
  });
  await new PostgresFeatureFlagRepository(database).withTransaction((tx) =>
    tx.listLifecycleEvents('commerce.autonomous-purchasing'),
  );

  const sql = database.statements().find((statement) => statement.startsWith('SELECT')) ?? '';
  assert.match(sql, /WHERE flag_key = \$1/);
});

test('a unique violation becomes the refusal it actually is', async () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['feature_flag_version_number_unique', 'duplicate-flag-version'],
    ['feature_flag_version_idempotency_unique', 'idempotency-key-reuse'],
    ['feature_flag_activation_supersedes_unique', 'stale-activation'],
    ['feature_flag_activation_first_unique', 'stale-activation'],
    ['feature_flag_lifecycle_flag_unique', 'duplicate-lifecycle-event'],
  ];

  for (const [constraint, expected] of cases) {
    const database = new RecordingDatabase({
      failures: [
        {
          match: /INSERT INTO/i,
          error: sqlstateError(`duplicate key value violates ${constraint}`, '23505', constraint),
        },
      ],
    });
    await assert.rejects(
      new PostgresFeatureFlagRepository(database).withTransaction(async (tx) => {
        await tx.insertVersion({
          flagVersionId: 'flagver_01HQZXCONF01',
          flagKey: 'commerce.autonomous-purchasing',
          version: 1,
          state: 'on',
          supportedScopes: ['global'],
          rules: [],
          percentage: 0,
          rolloutSalt: 'salt01HQZXCONF01',
          notBefore: null,
          notAfter: null,
          publishedAt: '2026-04-01T12:00:00Z',
          publishedBy: { kind: 'system', id: 'k07-release-console' },
          idempotencyKey: 'idem_01HQZXCONF001',
          requestFingerprint: 'c'.repeat(64),
        });
      }),
      (error: unknown) => {
        assert.equal(codeOf(error), expected, constraint);
        return true;
      },
      `${constraint} must be reported as ${expected}, not as a raw driver error`,
    );
  }
});

test('an enlisted write may not control the transaction', async () => {
  const database = new RecordingDatabase({});
  const client = await database.connect();
  const enlisted = enlistedClient(client);

  for (const statement of ['BEGIN;', 'COMMIT;', 'ROLLBACK;', '  begin ', 'SAVEPOINT s1;']) {
    await assert.rejects(
      enlisted.query(statement),
      (error: unknown) => {
        assert.equal(codeOf(error), 'nested-transaction', statement);
        return true;
      },
      `an enlisted write issuing "${statement}" would commit its caller's half-written work`,
    );
  }

  // And it does not close a connection it does not own.
  await enlisted.release();
  assert.equal(database.sessionsReleased, 0);
});

test('an enlisted repository shares the caller’s transaction', async () => {
  const database = new RecordingDatabase({
    selects: [{ match: /feature_flag_version/i, rows: [versionRow()] }],
  });
  const client = await database.connect();
  const repository = PostgresFeatureFlagRepository.enlist(client);

  await repository.withTransaction((tx) => tx.findVersionById('flagver_01HQZXTESTROW'));

  const control = database.statements().filter((sql) => /^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sql));
  assert.deepEqual(control, [], 'the enlisted path opened or closed a transaction of its own');
});

test('the adapter parameterises every value it writes', () => {
  // Scan the SQL the adapter actually sends, not the whole file: an error message may legitimately
  // interpolate a variable, a query may not. Anything but the fixed table and column lists would
  // mean caller data reaching SQL as text.
  const statements = [
    ...ADAPTER_SOURCE.matchAll(/client\.query(?:<[^>]*>)?\(\s*`([\s\S]*?)`/g),
  ].map((match) => String(match[1]));

  const permitted = new Set([
    'FEATURE_FLAGS_SCHEMA',
    'VERSION_TABLE',
    'ACTIVATION_TABLE',
    'LIFECYCLE_TABLE',
    'OUTBOX_TABLE',
    'VERSION_COLUMNS',
    'ACTIVATION_COLUMNS',
    'LIFECYCLE_COLUMNS',
    'OUTBOX_COLUMNS',
    'VERSION_PROJECTION',
    'ACTIVATION_PROJECTION',
    'LIFECYCLE_PROJECTION',
    'TIMESTAMP_COLUMNS',
    'utcText',
  ]);
  for (const sql of statements) {
    for (const match of sql.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
      const name = String(match[1]);
      assert.ok(permitted.has(name), `SQL interpolates ${name}, which is not a fixed constant`);
    }
  }
  assert.ok(
    statements.some((sql) => sql.includes('$1')),
    'the adapter must bind parameters rather than interpolate values',
  );
});

// ---------------------------------------------------------------------------
// Fail-closed decoding
// ---------------------------------------------------------------------------

test('well-formed rows decode, sealed', () => {
  const version = toFlagVersion(versionRow());
  assert.equal(version.flagKey, 'commerce.autonomous-purchasing');
  assert.ok(Object.isFrozen(version));
  assert.ok(Object.isFrozen(version.supportedScopes));

  const activation = toActivation(activationRow());
  assert.equal(activation.supersedesVersionId, null);
  assert.ok(Object.isFrozen(activation));

  const event = toLifecycleEvent(lifecycleRow());
  assert.equal(event.kind, 'kill');
  assert.ok(Object.isFrozen(event));
});

test('a malformed persisted row is refused rather than evaluated', () => {
  const cases: ReadonlyArray<readonly [string, () => unknown, string]> = [
    [
      'a state nothing here writes',
      () => toFlagVersion(versionRow({ state: 'maybe' })),
      'malformed-record',
    ],
    [
      'a timestamp the driver parsed into a Date',
      () => toFlagVersion(versionRow({ published_at: new Date('2026-04-01T12:00:00Z') })),
      'malformed-record',
    ],
    [
      'a timestamp in the wrong projected form',
      () => toFlagVersion(versionRow({ published_at: '2026-04-01 12:00:00+00' })),
      'malformed-record',
    ],
    [
      'jsonb that came back as text',
      () => toFlagVersion(versionRow({ supported_scopes: '["global"]' })),
      'malformed-record',
    ],
    [
      'a percentage on a flag that is not rolling out',
      () => toFlagVersion(versionRow({ percentage: 30 })),
      'malformed-record',
    ],
    [
      'a window that contains no instant',
      () =>
        toFlagVersion(
          versionRow({
            not_before: '2026-05-01T00:00:00.000000Z',
            not_after: '2026-04-01T00:00:00.000000Z',
          }),
        ),
      'invalid-activation-window',
    ],
    [
      'a flag key naming another component’s decision',
      () => toFlagVersion(versionRow({ flag_key: 'admin.permissions.enabled' })),
      'not-a-feature-flag',
    ],
    [
      'an AI author',
      () => toFlagVersion(versionRow({ published_by_kind: 'ai' })),
      'not-a-feature-flag',
    ],
    [
      'a natural key in an identifier column',
      () => toFlagVersion(versionRow({ rollout_salt: 'alice@example.com' })),
      'natural-identifier',
    ],
    [
      'a fingerprint that is not one',
      () => toFlagVersion(versionRow({ request_fingerprint: 'not-a-hash' })),
      'malformed-record',
    ],
    [
      'a lifecycle kind nothing here writes',
      () => toLifecycleEvent(lifecycleRow({ kind: 'pause' })),
      'malformed-record',
    ],
    [
      'a kill with no reason',
      () => toLifecycleEvent(lifecycleRow({ reason: '   ' })),
      'malformed-record',
    ],
    [
      'an activation that supersedes itself',
      () => toActivation(activationRow({ supersedes_version_id: 'flagver_01HQZXTESTROW' })),
      'malformed-record',
    ],
  ];

  for (const [why, decode, expected] of cases) {
    assert.throws(
      decode,
      (error: unknown) => {
        assert.equal(codeOf(error), expected, why);
        assert.match(
          (error as Error).message,
          /not written by this component/,
          `${why}: the refusal must say the row came from the database`,
        );
        return true;
      },
      `${why} must be refused`,
    );
  }
});

// ---------------------------------------------------------------------------
// Schema ownership
// ---------------------------------------------------------------------------

test('K-07 owns exactly one schema, derived from the manifest', () => {
  const component = KERNEL_COMPONENTS.find((entry) => entry.id === 'K-07');
  assert.ok(component !== undefined, 'the manifest has no K-07');
  assert.equal(FEATURE_FLAGS_SCHEMA, `${KERNEL_SCHEMA_PREFIX}${component.dir.replace(/-/g, '_')}`);
  assert.ok(knownSchemas().includes(FEATURE_FLAGS_SCHEMA), 'the schema resolves to no owner');

  for (const table of [VERSION_TABLE, ACTIVATION_TABLE, LIFECYCLE_TABLE, OUTBOX_TABLE]) {
    assert.ok(table.startsWith(`${FEATURE_FLAGS_SCHEMA}.`), `${table} is outside K-07's schema`);
  }
});

test('no statement K-07 issues names another unit’s schema, and there is no foreign key', () => {
  const foreign = knownSchemas().filter((schema) => schema !== FEATURE_FLAGS_SCHEMA);
  const sql = `${stripComments(ADAPTER_SOURCE)}\n${stripNoise(MIGRATION_UP)}\n${stripNoise(MIGRATION_DOWN)}`;

  for (const schema of foreign) {
    assert.ok(
      !new RegExp(`\\b${schema}\\.`).test(sql),
      `K-07 names ${schema}, which belongs to another unit`,
    );
  }
  assert.ok(
    !/REFERENCES\s+\w/i.test(stripNoise(MIGRATION_UP)),
    'a foreign key out of this schema would make two components one object',
  );
});

test('K-07’s opacity rules are character-for-character K-01’s, K-02’s, K-03’s and K-04’s', () => {
  // Five copies exist because each schema must be independently creatable. That is only safe while
  // they are identical, so the identity is a test rather than a convention.
  const bodies = readdirSync(MIGRATIONS)
    .filter((file) => file.endsWith('.up.sql'))
    .map((file) => readFileSync(path.join(MIGRATIONS, file), 'utf8'))
    .map((sql) => /AS \$rules\$([\s\S]*?)\$rules\$/.exec(sql)?.[1])
    .filter((body): body is string => body !== undefined);

  assert.ok(
    bodies.length >= 5,
    `expected at least five copies of the rule set, found ${bodies.length}`,
  );
  for (const body of bodies) {
    assert.equal(body, bodies[0], 'one schema’s opacity rule set has drifted from the others');
  }
});

test('the migration enforces the contract in the database, not only in the service', () => {
  const required: ReadonlyArray<readonly [string, RegExp]> = [
    ['the state vocabulary', /state IN \('off', 'internal-only', 'targeted', 'percentage', 'on'\)/],
    ['no AI author', /published_by_kind IN \('human', 'system'\)/],
    ['the percentage range', /percentage >= 0 AND percentage <= 100/],
    ['a percentage only on a rolling flag', /state = 'percentage' OR percentage = 0/],
    ['rules only on a targeted flag', /feature_flag_version_rules_only_when_targeted/],
    ['a window that is a window', /not_after > not_before/],
    ['one version number per flag', /UNIQUE \(flag_key, version\)/],
    ['one terminal event per flag', /feature_flag_lifecycle_flag_unique UNIQUE .flag_key./],
    ['the activation guard', /feature_flag_activation_supersedes_unique/],
    ['the first-activation guard', /feature_flag_activation_first_unique/],
    ['a reason on every lifecycle event', /length\(btrim\(reason\)\) > 0/],
    ['flag keys that name nothing else', /is_flag_key/],
    ['fingerprints', /request_fingerprint ~ '\^\[0-9a-f\]\{64\}\$'/],
  ];

  for (const [what, pattern] of required) {
    assert.match(MIGRATION_UP, pattern, `the migration does not enforce ${what}`);
  }
});

test('the flag-key rule in the database refuses what the service refuses', () => {
  const rule = /AS \$keys\$([\s\S]*?)\$keys\$/.exec(MIGRATION_UP)?.[1] ?? '';
  for (const fragment of ['permission', 'entitlement', 'price', 'experiment', 'ai-authority']) {
    assert.ok(
      rule.includes(fragment),
      `the database's flag-key rule does not refuse "${fragment}", so a statement written around ` +
        'the service could create one',
    );
  }
});

test('the rollback reverses exactly what the forward migration created', () => {
  const created = {
    schemas: [...MIGRATION_UP.matchAll(/CREATE SCHEMA IF NOT EXISTS ([\w.]+)/g)],
    tables: [...MIGRATION_UP.matchAll(/CREATE TABLE IF NOT EXISTS ([\w.]+)/g)],
    functions: [...MIGRATION_UP.matchAll(/CREATE OR REPLACE FUNCTION ([\w.]+)\(/g)],
    triggers: [...MIGRATION_UP.matchAll(/CREATE TRIGGER (\w+)/g)],
    indexes: [...MIGRATION_UP.matchAll(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS (\w+)/g)],
  };

  for (const [kind, matches] of Object.entries(created)) {
    assert.ok(matches.length > 0, `the forward migration creates no ${kind}`);
    for (const match of matches) {
      const name = String(match[1]).split('.').pop();
      assert.ok(
        MIGRATION_DOWN.includes(String(name)),
        `the rollback does not drop the ${kind.slice(0, -1)} ${String(name)}`,
      );
    }
  }

  assert.match(MIGRATION_DOWN, /DROP SCHEMA IF EXISTS kernel_feature_flags RESTRICT/);
  assert.ok(
    !/CASCADE/i.test(stripNoise(MIGRATION_DOWN)),
    'CASCADE would remove objects no migration described',
  );
});

// ---------------------------------------------------------------------------
// The contract document
// ---------------------------------------------------------------------------

test('CONTRACT.md documents every refusal the union declares', () => {
  const codes = [...TYPES_SOURCE.matchAll(/^\s*\| '([a-z-]+)'$/gm)].map((match) => match[1]);
  assert.ok(codes.length > 10, `expected the error union, found ${codes.length} codes`);
  for (const code of codes) {
    assert.ok(CONTRACT.includes(String(code)), `CONTRACT.md does not document "${String(code)}"`);
  }
});

test('CONTRACT.md records the five things a flag is not, and the deferred work', () => {
  const required: ReadonlyArray<readonly [string, RegExp]> = [
    ['that a flag is not a permission', /not a permission|K-04/],
    ['that a flag is not an entitlement', /entitlement/i],
    ['that a flag is not an experiment', /experiment/i],
    ['that a flag is not financial policy', /financial|K-10/],
    ['that a flag is not AI authority', /AI/],
    ['the K-05 dependency', /K-05/],
    ['the deferred K-02 integration', /K-02/],
    ['the deferred K-08 events', /K-08/],
    ['the deferred K-09 audit', /K-09/],
    ['that no API or UI ships', /No API/i],
    ['that nothing has run against a live server', /live PostgreSQL|live server/i],
    ['the kill switch precedence', /kill/i],
  ];

  for (const [what, pattern] of required) {
    assert.match(CONTRACT, pattern, `CONTRACT.md does not record ${what}`);
  }
});

test('every file CONTRACT.md links to exists, and every suite it names exists', () => {
  for (const match of CONTRACT.matchAll(/`(tests\/[\w./-]+\.ts)`/g)) {
    assert.ok(
      existsSync(path.join(HERE, '..', String(match[1]))),
      `${String(match[1])} is missing`,
    );
  }
  for (const match of CONTRACT.matchAll(/`(db\/migrations\/[\w.-]+\.sql)`/g)) {
    assert.ok(
      existsSync(path.join(HERE, '..', String(match[1]))),
      `${String(match[1])} is missing`,
    );
  }
});

test('the module has no file the contract does not account for', () => {
  const files = readdirSync(MODULE_DIR).filter((file) => file.endsWith('.ts'));
  for (const file of files) {
    assert.ok(
      CONTRACT.includes(file),
      `kernel/feature-flags/${file} is not mentioned in CONTRACT.md, so a reader cannot tell ` +
        'what it is for',
    );
  }
});
