/**
 * Migration contract tests (FND-002a).
 *
 * The first case asserts the repository's real migrations pass. On its own that proves nothing —
 * a validator that returned no violations for any input would pass it too. So every check the
 * validator declares has a directory under tests/fixtures/migrations/ containing a migration that
 * breaks exactly that rule, and a coverage case fails the build if a check is ever added without
 * one.
 *
 * These fixtures are not broken SQL awaiting repair. They are the evidence that a malformed,
 * unpaired, transactionless, public-schema, cross-owner or destructive migration is actually
 * rejected rather than merely disapproved of in a document.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { BUSINESS_MODULES, KERNEL_COMPONENTS } from '../platform/architecture/manifest.ts';
import {
  MIGRATIONS_DIR,
  MIGRATION_CHECK_IDS,
  stripNoise,
  validateMigrations,
} from '../platform/db/migrations.ts';
import type { MigrationCheckId } from '../platform/db/migrations.ts';
import {
  FORBIDDEN_SCHEMA,
  KERNEL_SCHEMA_PREFIX,
  MODULE_SCHEMA_PREFIX,
  PLATFORM_SCHEMA,
  knownSchemas,
  ownerOfSchema,
  schemaOwners,
} from '../platform/db/schema-namespaces.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REAL_MIGRATIONS = path.join(REPO_ROOT, MIGRATIONS_DIR);
const FIXTURES = path.join(REPO_ROOT, 'tests/fixtures/migrations');

const fixture = (name: string): string => path.join(FIXTURES, name);

// --------------------------------------------------------------- the real migration set

test('the repository migrations satisfy the contract', () => {
  const result = validateMigrations(REAL_MIGRATIONS);
  assert.deepEqual(
    result.violations,
    [],
    `migration violations:\n${result.violations
      .map((v) => `  ${v.severity} [${v.check}] ${v.file}:${v.line} ${v.message}`)
      .join('\n')}`,
  );
  assert.ok(result.filesScanned > 0, 'no migration files found — the set cannot be empty');
});

test('every forward migration has a rollback of the same version and slug', () => {
  const { migrations } = validateMigrations(REAL_MIGRATIONS);
  const ups = migrations.filter((m) => m.direction === 'up');
  const downs = new Set(
    migrations.filter((m) => m.direction === 'down').map((m) => `${m.version}_${m.slug}`),
  );
  assert.ok(ups.length > 0, 'there are no forward migrations');
  for (const up of ups) {
    assert.ok(downs.has(`${up.version}_${up.slug}`), `${up.file} has no rollback`);
  }
});

test('migration versions are unique and densely ordered from 0001', () => {
  const { migrations } = validateMigrations(REAL_MIGRATIONS);
  const versions = migrations
    .filter((m) => m.direction === 'up')
    .map((m) => m.version)
    .sort();
  assert.equal(new Set(versions).size, versions.length, 'duplicate version');
  versions.forEach((version, index) => {
    assert.equal(
      version,
      String(index + 1).padStart(4, '0'),
      'versions must run 0001, 0002, ... with no gaps, so ordering is unambiguous',
    );
  });
});

test('the delivered migrations add no business-module or kernel tables', () => {
  const { migrations } = validateMigrations(REAL_MIGRATIONS);
  for (const migration of migrations) {
    assert.equal(
      migration.owner,
      PLATFORM_SCHEMA,
      `${migration.file} is owned by ${String(migration.owner)} — FND-002a establishes the ` +
        'migration contract only; unit tables arrive with their own modules',
    );
  }
});

// --------------------------------------------------------------- the validator can fail

test('a conforming fixture produces no violations', () => {
  const result = validateMigrations(fixture('valid'));
  assert.deepEqual(
    result.violations.map((v) => `${v.check} ${v.file}`),
    [],
    'the control fixture must pass, or the invalid fixtures prove nothing',
  );
  assert.equal(result.filesScanned, 2);
});

const PLANTED: ReadonlyArray<{ readonly dir: string; readonly check: MigrationCheckId }> =
  MIGRATION_CHECK_IDS.map((check) => ({ dir: `invalid-${check}`, check }));

for (const planted of PLANTED) {
  test(`rejects a migration that violates ${planted.check}`, () => {
    const result = validateMigrations(fixture(planted.dir));
    const found = [...new Set(result.violations.map((v) => v.check))];
    assert.ok(
      found.includes(planted.check),
      `expected a ${planted.check} violation, got ${JSON.stringify(found)}`,
    );
    assert.deepEqual(
      found,
      [planted.check],
      `the fixture must isolate one defect, but also reported ${JSON.stringify(found)}`,
    );
  });
}

test('every declared check has a planted-invalid fixture directory', () => {
  const present = fs
    .readdirSync(FIXTURES, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const missing = MIGRATION_CHECK_IDS.filter((check) => !present.includes(`invalid-${check}`));
  assert.deepEqual(missing, [], `checks with no planted fixture: ${missing.join(', ')}`);
});

test('an empty or absent directory is reported, not silently passed as clean', () => {
  const absent = validateMigrations(fixture('does-not-exist'));
  assert.equal(absent.filesScanned, 0);
  assert.deepEqual(absent.violations, []);
  // Emptiness is not a violation of the contract; it is the caller's job to assert a non-empty
  // set, which the real-migration case above does. This test pins that distinction so a future
  // change cannot quietly make "no files" mean "all good" for the repository set.
});

// --------------------------------------------------------------- parsing

test('SQL inside comments and string literals cannot trigger a check', () => {
  const sql = [
    '-- migration: 0001_x',
    '-- DROP TABLE module_orders.order; TRUNCATE module_orders.order;',
    'BEGIN;',
    "INSERT INTO platform.schema_migrations (version) VALUES ('DROP TABLE evil');",
    '/* TRUNCATE platform.schema_migrations; */',
    'COMMIT;',
  ].join('\n');
  const stripped = stripNoise(sql);
  assert.ok(!/DROP\s+TABLE/i.test(stripped), 'a commented or quoted statement must not count');
  assert.ok(!/TRUNCATE/i.test(stripped), 'a commented or quoted statement must not count');
  assert.equal(
    stripped.split('\n').length,
    sql.split('\n').length,
    'stripping must preserve line structure so reported line numbers stay correct',
  );
});

test('stripNoise preserves the statements that do count', () => {
  const stripped = stripNoise('BEGIN;\nDROP TABLE module_orders.order;\nCOMMIT;');
  assert.match(stripped, /DROP TABLE module_orders\.order;/);
});

// --------------------------------------------------------------- schema-namespace convention

test('the namespace register covers the platform plus every kernel component and module', () => {
  const owners = schemaOwners();
  assert.equal(owners.length, 1 + KERNEL_COMPONENTS.length + BUSINESS_MODULES.length);
  assert.equal(owners.filter((o) => o.kind === 'platform').length, 1);
  assert.equal(owners.filter((o) => o.kind === 'kernel').length, 15);
  assert.equal(owners.filter((o) => o.kind === 'module').length, 47);
});

test('schema names are unique, snake_case, and prefixed by owner kind', () => {
  const owners = schemaOwners();
  const names = owners.map((o) => o.schema);
  assert.equal(new Set(names).size, names.length, 'two units claim one schema');
  for (const owner of owners) {
    assert.match(owner.schema, /^[a-z][a-z0-9_]*$/, `not a legal schema name: ${owner.schema}`);
    assert.ok(!owner.schema.includes('-'), 'kebab-case must be converted to snake_case');
    if (owner.kind === 'kernel') assert.ok(owner.schema.startsWith(KERNEL_SCHEMA_PREFIX));
    if (owner.kind === 'module') assert.ok(owner.schema.startsWith(MODULE_SCHEMA_PREFIX));
    if (owner.kind === 'platform') assert.equal(owner.schema, PLATFORM_SCHEMA);
  }
});

test('the manifest is the source of truth for namespaces, not a second list', () => {
  for (const component of KERNEL_COMPONENTS) {
    const schema = `${KERNEL_SCHEMA_PREFIX}${component.dir.replace(/-/g, '_')}`;
    assert.equal(ownerOfSchema(schema)?.id, component.id, `${schema} must resolve to its owner`);
  }
  for (const mod of BUSINESS_MODULES) {
    const schema = `${MODULE_SCHEMA_PREFIX}${mod.dir.replace(/-/g, '_')}`;
    assert.equal(ownerOfSchema(schema)?.id, mod.id, `${schema} must resolve to its owner`);
  }
});

test('the default schema is owned by nobody, and lookalikes do not resolve', () => {
  assert.equal(ownerOfSchema(FORBIDDEN_SCHEMA), null, '`public` must never resolve to an owner');
  assert.equal(ownerOfSchema('module_reporting'), null);
  assert.equal(ownerOfSchema('kernel_'), null);
  assert.equal(ownerOfSchema('module_orders_archive'), null);
  assert.notEqual(ownerOfSchema('module_orders'), null);
});

test('schema lookup is case-insensitive, as PostgreSQL folds unquoted identifiers', () => {
  assert.equal(ownerOfSchema('MODULE_ORDERS')?.id, ownerOfSchema('module_orders')?.id);
});

test('knownSchemas is sorted and matches the register', () => {
  const names = knownSchemas();
  assert.deepEqual(names, [...names].sort());
  assert.equal(names.length, schemaOwners().length);
});
