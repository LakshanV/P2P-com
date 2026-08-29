/**
 * K-10 Ledger Foundation — persistence and contract tests.
 *
 * The port contract is exercised in tests/ledger-foundation.test.ts; this file asserts the
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
  ACCOUNT_TABLE,
  ASSET_TYPE_TABLE,
  ENTRY_TABLE,
  LEDGER_SCHEMA,
  OUTBOX_TABLE,
  TRANSACTION_TABLE,
} from '../kernel/ledger-foundation/index.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = path.join(REPO_ROOT, 'db', 'migrations');
const MODULE_DIR = path.join(REPO_ROOT, 'kernel', 'ledger-foundation');
const ADAPTER_SOURCE = fs.readFileSync(path.join(MODULE_DIR, 'postgres-repository.ts'), 'utf8');
const PORT_SOURCE = fs.readFileSync(path.join(MODULE_DIR, 'repository.ts'), 'utf8');
const SERVICE_SOURCE = fs.readFileSync(path.join(MODULE_DIR, 'service.ts'), 'utf8');
const MIGRATION_SQL = fs.readFileSync(
  path.join(MIGRATIONS, '0017_create_kernel_ledger_schema.up.sql'),
  'utf8',
);
const MIGRATION_DOWN_SQL = fs.readFileSync(
  path.join(MIGRATIONS, '0017_create_kernel_ledger_schema.down.sql'),
  'utf8',
);

const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)\/\/[^\n]*/g, ' ');

// ---------------------------------------------------------------------------
// Port conformance
// ---------------------------------------------------------------------------

test('the port exposes no way to change, remove, void or rewrite ledger history', () => {
  const operations = new Set<string>();
  for (const source of [PORT_SOURCE, SERVICE_SOURCE]) {
    const code = stripComments(source);
    for (const match of code.matchAll(/\b(async\s+)?(\w+)\s*\(/g)) {
      operations.add(String(match[2]));
    }
  }

  const mutators = [...operations].filter((operation) =>
    /^(update|delete|remove|amend|void|reverse|rewrite|close|suspend|purge|truncate|set[A-Z])/i.test(
      operation,
    ),
  );
  assert.deepEqual(
    mutators,
    [],
    'the ledger is append-only; the port must not expose a way to mutate history',
  );
});

// ---------------------------------------------------------------------------
// PostgreSQL adapter structure
// ---------------------------------------------------------------------------

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
    statements.length >= 4,
    `expected the adapter to issue queries, found ${statements.length}`,
  );

  const permitted = new Set([
    'ASSET_TYPE_TABLE',
    'ACCOUNT_TABLE',
    'TRANSACTION_TABLE',
    'ENTRY_TABLE',
    'OUTBOX_TABLE',
    'LEDGER_SCHEMA',
    'ASSET_TYPE_COLUMNS',
    'ACCOUNT_COLUMNS',
    'TRANSACTION_COLUMNS',
    'ENTRY_COLUMNS',
    'OUTBOX_COLUMNS',
    'ASSET_TYPE_PROJECTION',
    'ACCOUNT_PROJECTION',
    'TRANSACTION_PROJECTION',
    'ENTRY_PROJECTION',
  ]);
  for (const sql of statements) {
    for (const match of sql.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
      const name = String(match[1]);
      assert.ok(permitted.has(name), `SQL interpolates ${name}, which is not a fixed constant`);
    }
  }
  assert.ok(
    statements.some((sql) => sql.includes('$1')),
    'the adapter must bind parameters',
  );
});

test('the adapter only ever names its own schema', () => {
  assert.equal(LEDGER_SCHEMA, `${KERNEL_SCHEMA_PREFIX}ledger_foundation`);
  assert.equal(ASSET_TYPE_TABLE, `${LEDGER_SCHEMA}.asset_type`);
  assert.equal(ACCOUNT_TABLE, `${LEDGER_SCHEMA}.ledger_account`);
  assert.equal(TRANSACTION_TABLE, `${LEDGER_SCHEMA}.ledger_transaction`);
  assert.equal(ENTRY_TABLE, `${LEDGER_SCHEMA}.ledger_entry`);
  assert.equal(OUTBOX_TABLE, `${LEDGER_SCHEMA}.outbox`);

  const schemas = [...ADAPTER_SOURCE.matchAll(/\b(kernel_[a-z_]+|module_[a-z_]+|platform)\./g)].map(
    (match) => match[1],
  );
  for (const schema of schemas) {
    assert.equal(schema, LEDGER_SCHEMA, `the adapter reaches into ${String(schema)}`);
  }
});

test('the adapter projects timestamps as UTC text and amounts as strings', () => {
  assert.match(
    ADAPTER_SOURCE,
    /to_char\(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS\.US"Z"'\) AS created_at/,
  );
  assert.match(
    ADAPTER_SOURCE,
    /to_char\(posted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS\.US"Z"'\) AS posted_at/,
  );
  assert.match(ADAPTER_SOURCE, /amount::text AS amount/);
});

// ---------------------------------------------------------------------------
// Migration ownership and shape
// ---------------------------------------------------------------------------

test('the K-10 schema is the one the architecture manifest derives', () => {
  const component = KERNEL_COMPONENTS.find((candidate) => candidate.id === 'K-10');
  assert.ok(component, 'K-10 must be registered in the manifest');
  assert.equal(component.dir, 'ledger-foundation');
  assert.equal(LEDGER_SCHEMA, `${KERNEL_SCHEMA_PREFIX}ledger_foundation`);
  assert.equal(ownerOfSchema(LEDGER_SCHEMA)?.id, 'K-10', 'the schema must resolve back to K-10');
});

test('the K-10 migration is owned by K-10 and touches no other schema', () => {
  const { violations } = validateMigrations(MIGRATIONS);
  assert.deepEqual(violations, [], 'the migration set must satisfy the FND-002a contract');

  for (const sql of [MIGRATION_SQL, MIGRATION_DOWN_SQL]) {
    const schemas = [
      ...stripNoise(sql).matchAll(/\b(kernel_[a-z_]+|module_[a-z_]+|platform)\b/g),
    ].map((m) => m[1]);
    for (const schema of schemas) {
      assert.equal(schema, LEDGER_SCHEMA, `the migration names ${String(schema)}`);
    }
  }
});

test('the migration creates the four business tables, the outbox table, and an unprocessed index', () => {
  assert.match(MIGRATION_SQL, /CREATE TABLE IF NOT EXISTS kernel_ledger_foundation\.asset_type/);
  assert.match(
    MIGRATION_SQL,
    /CREATE TABLE IF NOT EXISTS kernel_ledger_foundation\.ledger_account/,
  );
  assert.match(
    MIGRATION_SQL,
    /CREATE TABLE IF NOT EXISTS kernel_ledger_foundation\.ledger_transaction/,
  );
  assert.match(MIGRATION_SQL, /CREATE TABLE IF NOT EXISTS kernel_ledger_foundation\.ledger_entry/);
  assert.match(MIGRATION_SQL, /CREATE TABLE IF NOT EXISTS kernel_ledger_foundation\.outbox/);
  assert.match(
    MIGRATION_SQL,
    /CREATE INDEX IF NOT EXISTS outbox_unprocessed_idx[\s\S]*?WHERE processed_at IS NULL/,
  );
});

test('the migration enforces append-only history and a balanced journal', () => {
  assert.match(
    MIGRATION_SQL,
    /CREATE OR REPLACE FUNCTION kernel_ledger_foundation\.refuse_mutation/,
  );
  assert.match(MIGRATION_SQL, /CREATE TRIGGER ledger_entry_is_append_only/);
  assert.match(
    MIGRATION_SQL,
    /CREATE CONSTRAINT TRIGGER ledger_entry_balanced[\s\S]*?DEFERRABLE INITIALLY DEFERRED/,
  );
  assert.match(MIGRATION_SQL, /v_debits <> v_credits/);
});

test('the rollback reverses exactly what the forward migration created', () => {
  const created = [...MIGRATION_SQL.matchAll(/CREATE TABLE IF NOT EXISTS ([\w.]+)/g)].map((match) =>
    String(match[1]),
  );
  const dropped = [...MIGRATION_DOWN_SQL.matchAll(/DROP TABLE IF EXISTS ([\w.]+)/g)].map((match) =>
    String(match[1]),
  );
  assert.deepEqual([...created].sort(), [...dropped].sort());

  for (const match of MIGRATION_SQL.matchAll(/CREATE INDEX IF NOT EXISTS (\w+)/g)) {
    assert.ok(
      MIGRATION_DOWN_SQL.includes(String(match[1])),
      `${String(match[1])} is created but never dropped`,
    );
  }

  assert.ok(
    MIGRATION_DOWN_SQL.indexOf('DROP TRIGGER') < MIGRATION_DOWN_SQL.indexOf('DROP FUNCTION'),
    'a function cannot be dropped while a trigger still references it',
  );
  assert.ok(
    MIGRATION_DOWN_SQL.indexOf('DROP TABLE') <
      MIGRATION_DOWN_SQL.indexOf(
        'DROP FUNCTION IF EXISTS kernel_ledger_foundation.is_opaque_identifier',
      ),
    'the CHECK constraints reference the rule function, so the table must go first',
  );
  assert.match(MIGRATION_DOWN_SQL, /DROP SCHEMA IF EXISTS kernel_ledger_foundation RESTRICT/);
});
