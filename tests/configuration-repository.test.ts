/**
 * K-05 Configuration — persistence and contract tests (FND-003a).
 *
 * Two things are proved here.
 *
 * First, the **port contract**: one conformance suite runs against the in-memory repository, and
 * the same expectations are asserted structurally against the PostgreSQL adapter's SQL. Two
 * implementations of one interface drift apart silently otherwise, and the drift is only noticed
 * when the one nobody tests is the one in production.
 *
 * Second, the **module contract**: the migration, the schema name and the documented guarantees
 * are checked against the manifest and against planted weakenings, so K-05's ownership claims
 * cannot quietly stop being true.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { KERNEL_COMPONENTS } from '../platform/architecture/manifest.ts';
import { stripNoise, validateMigrations } from '../platform/db/migrations.ts';
import { KERNEL_SCHEMA_PREFIX, ownerOfSchema } from '../platform/db/schema-namespaces.ts';
import {
  CONFIG_SCHEMA,
  CONFIG_TABLE,
  ConfigurationError,
  ConfigurationRegistry,
  ConfigurationService,
  GLOBAL_SCOPE,
  InMemoryConfigurationRepository,
  decodeValue,
  encodeValue,
} from '../kernel/configuration/index.ts';
import type {
  ConfigurationKey,
  ConfigurationRepository,
  ConfigurationVersion,
} from '../kernel/configuration/index.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = path.join(REPO_ROOT, 'db/migrations');
const ADAPTER_SOURCE = fs.readFileSync(
  path.join(REPO_ROOT, 'kernel/configuration/postgres-repository.ts'),
  'utf8',
);
const MIGRATION_SQL = fs.readFileSync(
  path.join(MIGRATIONS, '0003_create_kernel_configuration_schema.up.sql'),
  'utf8',
);
const ROLLBACK_SQL = fs.readFileSync(
  path.join(MIGRATIONS, '0003_create_kernel_configuration_schema.down.sql'),
  'utf8',
);

const KEY: ConfigurationKey = {
  id: 'session.timeout_seconds',
  description: 'How long an idle session survives.',
  schema: { kind: 'duration-seconds', minimum: 60, maximum: 86_400 },
  scopes: ['global'],
};

/** A draft, because that is the only thing the port accepts as an insert. */
const version = (overrides: Partial<ConfigurationVersion> = {}): ConfigurationVersion => ({
  versionId: 'ver-1',
  key: KEY.id,
  scope: GLOBAL_SCOPE,
  value: 900,
  effectiveFrom: '2026-01-01T00:00:00Z',
  status: 'draft',
  createdAt: '2026-01-01T00:00:00Z',
  publishedAt: null,
  supersededAt: null,
  previousVersionId: null,
  idempotencyKey: 'idem-1',
  origin: 'human',
  ...overrides,
});

const codeOf = (error: unknown): string =>
  error instanceof ConfigurationError ? error.code : `not-a-configuration-error:${String(error)}`;

// --------------------------------------------------------------- port conformance

/**
 * The behaviours every adapter must have. Run against the in-memory implementation here; the
 * PostgreSQL adapter's equivalent guarantees are asserted structurally below, because running it
 * needs a server.
 */
function conformanceSuite(name: string, make: () => ConfigurationRepository): void {
  test(`${name}: a version round-trips unchanged`, async () => {
    const repository = make();
    await repository.withTransaction((tx) => tx.insertDraft(version()));
    const found = await repository.withTransaction((tx) => tx.findVersionById('ver-1'));
    assert.deepEqual(found, version());
  });

  test(`${name}: an unknown id and an unknown idempotency key both return null`, async () => {
    const repository = make();
    assert.equal(await repository.withTransaction((tx) => tx.findVersionById('missing')), null);
    assert.equal(
      await repository.withTransaction((tx) => tx.findByIdempotencyKey('missing')),
      null,
    );
  });

  test(`${name}: a duplicate version id is refused, not overwritten`, async () => {
    const repository = make();
    await repository.withTransaction((tx) => tx.insertDraft(version()));
    await assert.rejects(
      repository.withTransaction((tx) => tx.insertDraft(version({ value: 1800 }))),
      (error: unknown) =>
        codeOf(error) === 'immutable-version' || codeOf(error) === 'idempotency-key-reuse',
    );
    const found = await repository.withTransaction((tx) => tx.findVersionById('ver-1'));
    assert.equal(found?.value, 900, 'the original must survive');
  });

  test(`${name}: a duplicate idempotency key is refused`, async () => {
    const repository = make();
    await repository.withTransaction((tx) => tx.insertDraft(version()));
    await assert.rejects(
      repository.withTransaction((tx) =>
        tx.insertDraft(version({ versionId: 'ver-2', idempotencyKey: 'idem-1' })),
      ),
      (error: unknown) => codeOf(error) === 'idempotency-key-reuse',
    );
  });

  test(`${name}: superseding a version that is not active is refused`, async () => {
    const repository = make();
    await repository.withTransaction((tx) => tx.insertDraft(version()));
    await assert.rejects(
      repository.withTransaction((tx) =>
        tx.supersedeActiveVersion('ver-1', '2026-01-03T00:00:00Z'),
      ),
      (error: unknown) => codeOf(error) === 'concurrent-modification',
      'a draft is not an incumbent, and a lost update must be refused rather than applied twice',
    );
  });

  test(`${name}: inserting an already-active version is refused`, async () => {
    const repository = make();
    await assert.rejects(
      repository.withTransaction((tx) =>
        tx.insertDraft(version({ status: 'active', publishedAt: '2026-01-01T00:00:00Z' })),
      ),
      (error: unknown) => codeOf(error) === 'immutable-version',
      'a version is created as a draft and activated separately, never inserted active',
    );
  });

  test(`${name}: a draft activates once, and only from draft`, async () => {
    const repository = make();
    await repository.withTransaction((tx) => tx.insertDraft(version()));
    await repository.withTransaction((tx) =>
      tx.activateDraft('ver-1', '2026-01-02T00:00:00Z', null),
    );

    const activated = await repository.withTransaction((tx) => tx.findVersionById('ver-1'));
    assert.equal(activated?.status, 'active');
    assert.equal(activated?.publishedAt, '2026-01-02T00:00:00Z');
    assert.equal(activated?.value, 900, 'activation must not touch content');

    await assert.rejects(
      repository.withTransaction((tx) => tx.activateDraft('ver-1', '2026-01-03T00:00:00Z', null)),
      (error: unknown) => codeOf(error) === 'concurrent-modification',
      'a second activation must be refused, not applied',
    );
  });

  test(`${name}: superseding then activating keeps at most one active version`, async () => {
    const repository = make();
    await repository.withTransaction(async (tx) => {
      await tx.insertDraft(version());
      await tx.activateDraft('ver-1', '2026-01-01T00:00:00Z', null);
    });
    await repository.withTransaction(async (tx) => {
      await tx.insertDraft(
        version({
          versionId: 'ver-2',
          idempotencyKey: 'idem-2',
          effectiveFrom: '2026-02-01T00:00:00Z',
        }),
      );
      // The order the partial unique index requires.
      await tx.supersedeActiveVersion('ver-1', '2026-01-15T00:00:00Z');
      await tx.activateDraft('ver-2', '2026-01-15T00:00:00Z', 'ver-1');
    });

    const all = await repository.withTransaction((tx) => tx.findVersions(KEY.id, [GLOBAL_SCOPE]));
    assert.deepEqual(
      all.map((v) => [v.versionId, v.status].join(':')),
      ['ver-1:superseded', 'ver-2:active'],
    );
  });

  test(`${name}: activating before superseding is refused by the unique-index invariant`, async () => {
    const repository = make();
    await repository.withTransaction(async (tx) => {
      await tx.insertDraft(version());
      await tx.activateDraft('ver-1', '2026-01-01T00:00:00Z', null);
    });

    await assert.rejects(
      repository.withTransaction(async (tx) => {
        await tx.insertDraft(
          version({
            versionId: 'ver-2',
            idempotencyKey: 'idem-2',
            effectiveFrom: '2026-02-01T00:00:00Z',
          }),
        );
        // Deliberately the wrong order: two rows would be active at once.
        await tx.activateDraft('ver-2', '2026-01-15T00:00:00Z', 'ver-1');
        await tx.supersedeActiveVersion('ver-1', '2026-01-15T00:00:00Z');
      }),
      (error: unknown) => codeOf(error) === 'ambiguous-active-version',
      'the reference implementation enforces the same index the migration declares',
    );

    const all = await repository.withTransaction((tx) => tx.findVersions(KEY.id, [GLOBAL_SCOPE]));
    assert.deepEqual(
      all.map((v) => v.versionId),
      ['ver-1'],
      'the refused transaction wrote nothing',
    );
  });

  test(`${name}: a rejected transaction writes nothing`, async () => {
    const repository = make();
    await assert.rejects(
      repository.withTransaction(async (tx) => {
        await tx.insertDraft(version());
        throw new Error('planted failure after the insert');
      }),
      /planted failure/,
    );
    assert.equal(
      await repository.withTransaction((tx) => tx.findVersionById('ver-1')),
      null,
      'the insert must have rolled back with the transaction',
    );
  });

  test(`${name}: findVersions filters by key and scope together`, async () => {
    const repository = make();
    await repository.withTransaction(async (tx) => {
      await tx.insertDraft(version());
      await tx.insertDraft(
        version({
          versionId: 'ver-2',
          idempotencyKey: 'idem-2',
          scope: { level: 'tenant', id: 'a' },
        }),
      );
    });
    const global = await repository.withTransaction((tx) =>
      tx.findVersions(KEY.id, [GLOBAL_SCOPE]),
    );
    assert.deepEqual(
      global.map((v) => v.versionId),
      ['ver-1'],
      'a tenant version must not be returned for a global query',
    );
  });
}

conformanceSuite('in-memory', () => new InMemoryConfigurationRepository());

// --------------------------------------------------------------- value round trip

test('every permitted value kind survives encoding and decoding', () => {
  const cases: ReadonlyArray<[string, boolean | number | string]> = [
    ['boolean', true],
    ['boolean', false],
    ['integer', 900],
    ['integer', 0],
    ['string', 'https://help.example.com'],
    ['string', ''],
  ];
  for (const [, value] of cases) {
    const encoded = encodeValue(value);
    assert.equal(
      decodeValue(encoded.kind, encoded.text),
      value,
      `round trip failed for ${String(value)}`,
    );
  }
  assert.equal(decodeValue('enum', 'sampled'), 'sampled');
  assert.equal(decodeValue('duration-seconds', '900'), 900);
  assert.throws(() => decodeValue('object', '{}'), ConfigurationError);
});

// --------------------------------------------------------------- the PostgreSQL adapter

test('the adapter wraps every unit of work in a transaction that rolls back on failure', () => {
  assert.match(ADAPTER_SOURCE, /await client\.query\('BEGIN;'\)/);
  assert.match(ADAPTER_SOURCE, /await client\.query\('COMMIT;'\)/);
  assert.match(ADAPTER_SOURCE, /catch \(error\) \{\s*await client\.query\('ROLLBACK;'\)/);
  assert.match(ADAPTER_SOURCE, /finally \{\s*await client\.release\(\)/);
});

test('the adapter supersedes conditionally, so a lost update is detected', () => {
  assert.match(
    ADAPTER_SOURCE,
    /UPDATE \$\{CONFIG_TABLE\}[\s\S]*?WHERE version_id = \$1 AND status = 'active';/,
    'an unconditional UPDATE would silently overwrite a concurrent supersession',
  );
  assert.match(ADAPTER_SOURCE, /rowCount === 0/, 'the adapter must notice when nothing changed');
});

test('the adapter parameterises every value it writes', () => {
  // Scan the SQL the adapter actually sends, not the whole file: an error message may legitimately
  // interpolate a variable, a query may not. Anything but the fixed table and column lists would
  // mean caller data reaching SQL as text.
  const statements = [
    ...ADAPTER_SOURCE.matchAll(/client\.query(?:<[^>]*>)?\(\s*`([\s\S]*?)`/g),
  ].map((match) => match[1] ?? '');
  assert.ok(
    statements.length >= 5,
    `expected the adapter to issue queries, found ${statements.length}`,
  );

  // PROJECTION is the SELECT list. Like COLUMNS it is built from literal column names — see
  // tests/configuration-timestamp-projection.test.ts, which proves it carries no caller data.
  const permitted = new Set(['CONFIG_TABLE', 'CONFIG_SCHEMA', 'COLUMNS', 'PROJECTION']);
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

test('the adapter only ever names its own schema', () => {
  assert.equal(CONFIG_SCHEMA, `${KERNEL_SCHEMA_PREFIX}configuration`);
  assert.equal(CONFIG_TABLE, `${CONFIG_SCHEMA}.config_version`);
  const schemas = [...ADAPTER_SOURCE.matchAll(/\b(kernel_[a-z_]+|module_[a-z_]+|platform)\./g)].map(
    (match) => match[1],
  );
  for (const schema of schemas) {
    assert.equal(schema, CONFIG_SCHEMA, `the adapter reaches into ${String(schema)}`);
  }
});

// --------------------------------------------------------------- the module contract

test('the K-05 schema is the one the architecture manifest derives', () => {
  const component = KERNEL_COMPONENTS.find((candidate) => candidate.id === 'K-05');
  assert.ok(component, 'K-05 must be registered in the manifest');
  assert.equal(component.dir, 'configuration');
  assert.equal(CONFIG_SCHEMA, `${KERNEL_SCHEMA_PREFIX}${component.dir}`);
  assert.equal(ownerOfSchema(CONFIG_SCHEMA)?.id, 'K-05', 'the schema must resolve back to K-05');
});

test('the K-05 migration is owned by K-05 and touches no other schema', () => {
  const { migrations, violations } = validateMigrations(MIGRATIONS);
  assert.deepEqual(violations, [], 'the migration set must satisfy the FND-002a contract');

  const owned = migrations.filter(
    (migration) => migration.slug === 'create_kernel_configuration_schema',
  );
  assert.equal(owned.length, 2, 'the forward migration and its rollback must both exist');
  for (const migration of owned) {
    assert.equal(migration.owner, CONFIG_SCHEMA);
  }

  // Comment-stripped, so prose that mentions another schema is not mistaken for SQL that touches
  // one. stripNoise preserves length, so this is the same text the migration validator sees.
  for (const sql of [MIGRATION_SQL, ROLLBACK_SQL]) {
    const schemas = [
      ...stripNoise(sql).matchAll(/\b(kernel_[a-z_]+|module_[a-z_]+|platform)\b/g),
    ].map((m) => m[1]);
    for (const schema of schemas) {
      assert.equal(schema, CONFIG_SCHEMA, `the migration names ${String(schema)}`);
    }
  }
});

test('the migration enforces one active version per key and scope in the database itself', () => {
  assert.match(
    MIGRATION_SQL,
    /CREATE UNIQUE INDEX[\s\S]*?config_key, scope_level, scope_id\)\s*WHERE status = 'active'/,
    'the invariant must hold even if something writes around the service',
  );
});

test('the migration refuses an AI origin at the database level', () => {
  assert.match(MIGRATION_SQL, /origin IN \('human', 'system-migration'\)/);
  assert.equal(
    /ai[-_]suggested/i.test(MIGRATION_SQL),
    false,
    'the schema must not permit an AI-authored version at all',
  );
});

test('the rollback reverses exactly what the forward migration created', () => {
  for (const object of [
    'config_version_resolution_idx',
    'config_version_one_active_per_scope',
    'config_version',
    'kernel_configuration',
  ]) {
    assert.ok(ROLLBACK_SQL.includes(object), `${object} is created but never dropped`);
  }
  assert.match(ROLLBACK_SQL, /DROP SCHEMA IF EXISTS kernel_configuration RESTRICT/);
});

test('the module contract document records the deferred integrations', () => {
  const contract = fs.readFileSync(
    path.join(REPO_ROOT, 'kernel/configuration/CONTRACT.md'),
    'utf8',
  );
  for (const required of ['K-02', 'K-04', 'K-08', 'K-09', 'K-06', 'npm run verify']) {
    assert.ok(contract.includes(required), `CONTRACT.md does not mention ${required}`);
  }
  assert.match(
    contract,
    /Deliberately deferred/,
    'the contract must record what it has deliberately not built',
  );
  assert.match(
    contract,
    /Administrative API/,
    'the contract must say the administrative API is deferred, and on what',
  );
});

// --------------------------------------------------------------- planted contract weakenings

test('the service still refuses what the contract says it refuses', async () => {
  // A compact re-assertion of the contract's headline refusals, so a weakening in the service
  // fails here as well as in configuration.test.ts. Two independent statements of one rule are
  // cheap; a rule stated only once is a rule one careless edit removes.
  const repository = new InMemoryConfigurationRepository();
  const service = new ConfigurationService(new ConfigurationRegistry([KEY]), repository);
  const base = {
    key: KEY.id,
    scope: GLOBAL_SCOPE,
    value: 900,
    effectiveFrom: '2026-01-01T00:00:00Z',
    expectedActiveVersionId: null,
    idempotencyKey: 'idem-x',
    versionId: 'ver-x',
    origin: 'human' as const,
    authorityLevel: 'global' as const,
    now: '2026-01-01T00:00:00Z',
  };

  const refusals: ReadonlyArray<[string, Record<string, unknown>]> = [
    ['unknown-key', { key: 'nope.missing' }],
    ['invalid-value', { value: 1 }],
    ['retroactive-change', { effectiveFrom: '2025-01-01T00:00:00Z' }],
    ['origin-not-permitted', { origin: 'ai-suggested' }],
  ];
  for (const [expected, overrides] of refusals) {
    await assert.rejects(
      service.publish({ ...base, ...overrides }),
      (error: unknown) => codeOf(error) === expected,
      `expected ${expected} for ${JSON.stringify(overrides)}`,
    );
  }
  assert.deepEqual(repository.snapshot(), [], 'no refusal may write');
});
