/**
 * K-11 Commerce Unit Registry — persistence and contract tests (FND-005c).
 *
 * The port contract is exercised in tests/commerce-unit-registry.test.ts; this file asserts the
 * structural guarantees of the PostgreSQL adapter and the module's migration ownership so the two
 * implementations cannot drift apart silently.
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
  ACTIVATION_TABLE,
  COMMERCE_UNIT_SCHEMA,
  OUTBOX_TABLE,
  RETIREMENT_TABLE,
  VERSION_TABLE,
} from '../kernel/commerce-unit-registry/index.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = path.join(REPO_ROOT, 'db/migrations');
const ADAPTER_SOURCE = fs.readFileSync(
  path.join(REPO_ROOT, 'kernel/commerce-unit-registry/postgres-repository.ts'),
  'utf8',
);
const MIGRATION_SQL = fs.readFileSync(
  path.join(MIGRATIONS, '0012_create_kernel_commerce_unit_registry_schema.up.sql'),
  'utf8',
);
const OUTBOX_MIGRATION_SQL = fs.readFileSync(
  path.join(MIGRATIONS, '0016_create_kernel_commerce_unit_registry_outbox.up.sql'),
  'utf8',
);
const OUTBOX_ROLLBACK_SQL = fs.readFileSync(
  path.join(MIGRATIONS, '0016_create_kernel_commerce_unit_registry_outbox.down.sql'),
  'utf8',
);

// --------------------------------------------------------------- the PostgreSQL adapter

test('the adapter wraps every unit of work in a transaction that rolls back on failure', () => {
  assert.match(ADAPTER_SOURCE, /await client\.query\('BEGIN;'\)/);
  assert.match(ADAPTER_SOURCE, /await client\.query\('COMMIT;'\)/);
  assert.match(ADAPTER_SOURCE, /catch \(error\) \{\s*await client\.query\('ROLLBACK;'\)/);
  assert.match(ADAPTER_SOURCE, /finally \{\s*await client\.release\(\)/);
});

test('the adapter parameterises every value it writes', () => {
  const statements = [
    ...ADAPTER_SOURCE.matchAll(/client\.query(?:<[^>]*>)?\(\s*`([\s\S]*?)`/g),
  ].map((match) => match[1] ?? '');
  assert.ok(
    statements.length >= 5,
    `expected the adapter to issue queries, found ${statements.length}`,
  );

  const permitted = new Set([
    'VERSION_TABLE',
    'ACTIVATION_TABLE',
    'RETIREMENT_TABLE',
    'OUTBOX_TABLE',
    'COMMERCE_UNIT_SCHEMA',
    'VERSION_COLUMNS',
    'ACTIVATION_COLUMNS',
    'RETIREMENT_COLUMNS',
    'OUTBOX_COLUMNS',
    'VERSION_PROJECTION',
    'ACTIVATION_PROJECTION',
    'RETIREMENT_PROJECTION',
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

test('the adapter only ever names its own schema', () => {
  assert.equal(COMMERCE_UNIT_SCHEMA, `${KERNEL_SCHEMA_PREFIX}commerce_unit_registry`);
  assert.equal(VERSION_TABLE, `${COMMERCE_UNIT_SCHEMA}.commerce_unit_type_version`);
  assert.equal(ACTIVATION_TABLE, `${COMMERCE_UNIT_SCHEMA}.commerce_unit_type_activation`);
  assert.equal(RETIREMENT_TABLE, `${COMMERCE_UNIT_SCHEMA}.commerce_unit_type_retirement`);
  assert.equal(OUTBOX_TABLE, `${COMMERCE_UNIT_SCHEMA}.outbox`);
  const schemas = [...ADAPTER_SOURCE.matchAll(/\b(kernel_[a-z_]+|module_[a-z_]+|platform)\./g)].map(
    (match) => match[1],
  );
  for (const schema of schemas) {
    assert.equal(schema, COMMERCE_UNIT_SCHEMA, `the adapter reaches into ${String(schema)}`);
  }
});

// --------------------------------------------------------------- the module contract

test('the K-11 schema is the one the architecture manifest derives', () => {
  const component = KERNEL_COMPONENTS.find((candidate) => candidate.id === 'K-11');
  assert.ok(component, 'K-11 must be registered in the manifest');
  assert.equal(component.dir, 'commerce-unit-registry');
  assert.equal(COMMERCE_UNIT_SCHEMA, `${KERNEL_SCHEMA_PREFIX}commerce_unit_registry`);
  assert.equal(
    ownerOfSchema(COMMERCE_UNIT_SCHEMA)?.id,
    'K-11',
    'the schema must resolve back to K-11',
  );
});

test('the K-11 migration is owned by K-11 and touches no other schema', () => {
  const { violations } = validateMigrations(MIGRATIONS);
  assert.deepEqual(violations, [], 'the migration set must satisfy the FND-002a contract');

  for (const sql of [MIGRATION_SQL, OUTBOX_MIGRATION_SQL, OUTBOX_ROLLBACK_SQL]) {
    const schemas = [
      ...stripNoise(sql).matchAll(/\b(kernel_[a-z_]+|module_[a-z_]+|platform)\b/g),
    ].map((m) => m[1]);
    for (const schema of schemas) {
      assert.equal(schema, COMMERCE_UNIT_SCHEMA, `the migration names ${String(schema)}`);
    }
  }
});

test('the outbox migration creates an unprocessed index and a rollback reverses it', () => {
  assert.match(
    OUTBOX_MIGRATION_SQL,
    /CREATE INDEX[\s\S]*?outbox_unprocessed_idx[\s\S]*?WHERE processed_at IS NULL/,
  );
  assert.ok(OUTBOX_ROLLBACK_SQL.includes('outbox'), 'the rollback must drop the outbox table');
});
