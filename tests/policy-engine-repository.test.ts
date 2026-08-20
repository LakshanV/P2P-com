/**
 * K-06 Policy Engine — port conformance, adapter queries, the migration and the contract (FND-005b).
 *
 * Three claims here are about layers a service test cannot see.
 *
 * **There is no UPDATE and no DELETE anywhere in this module or its schema.** Four triggers refuse
 * both. v3 §24 requires that changing future policy must not rewrite historical economics, and an
 * `UPDATE` on a rule row breaks that for every transaction ever pinned to it — silently,
 * retroactively, and with no reconciliation that would find it.
 *
 * **A row written around the adapter is refused rather than evaluated.** K-01 needed a correction to
 * reach that shape (§11.22) and K-04 found the same hole in its adapter. Here the consequence is
 * worse than in either: a malformed rule row that decoded cleanly is a commission rate nobody
 * authored, pinned into a financial record as though it had been reviewed.
 *
 * **No column in this schema is a float.** Decimals live in `jsonb` in their exact form, and the
 * migration is scanned for `double precision`, `real` and `float` — because the day one appears is
 * the day rates start being approximately right.
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
  DRAFT_TABLE,
  InMemoryPolicyRepository,
  POLICY_SCHEMA,
  PolicyError,
  PostgresPolicyRepository,
  RETIREMENT_TABLE,
  TIMESTAMP_COLUMNS,
  VERSION_TABLE,
  enlistedClient,
  toPolicyActivation,
  toPolicyDraft,
  toPolicyRetirement,
  toPolicyVersion,
} from '../kernel/policy-engine/index.ts';

import {
  AUTHORITY,
  POLICY,
  activationRow,
  draftRow,
  nextId,
  rate,
  retirementRow,
  versionRow,
} from './helpers/policy-fixtures.ts';
import { RecordingDatabase, sqlstateError } from './helpers/recording-database.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE_DIR = path.join(HERE, '..', 'kernel', 'policy-engine');
const ADAPTER_SOURCE = readFileSync(path.join(MODULE_DIR, 'postgres-repository.ts'), 'utf8');
const PORT_SOURCE = readFileSync(path.join(MODULE_DIR, 'repository.ts'), 'utf8');
const CONTRACT = readFileSync(path.join(MODULE_DIR, 'CONTRACT.md'), 'utf8');
const TYPES_SOURCE = readFileSync(path.join(MODULE_DIR, 'types.ts'), 'utf8');
const MIGRATIONS = path.join(HERE, '..', 'db', 'migrations');
const MIGRATION_UP = readFileSync(
  path.join(MIGRATIONS, '0011_create_kernel_policy_engine_schema.up.sql'),
  'utf8',
);
const MIGRATION_DOWN = readFileSync(
  path.join(MIGRATIONS, '0011_create_kernel_policy_engine_schema.down.sql'),
  'utf8',
);

const codeOf = (error: unknown): string | undefined =>
  error instanceof PolicyError ? error.code : undefined;

const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)\/\/[^\n]*/g, ' ');

// ---------------------------------------------------------------------------
// Append-only, at every layer
// ---------------------------------------------------------------------------

test('neither the port nor the adapter can update or delete a policy', () => {
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
  assert.equal(created.length, 4, 'the schema has four tables');

  for (const table of created) {
    assert.match(
      MIGRATION_UP,
      new RegExp(`BEFORE UPDATE OR DELETE ON ${String(table).replace('.', '\\.')}`),
      `${String(table).split('.').pop()} has no append-only trigger`,
    );
  }
});

test('no column in this schema is a floating-point type', () => {
  // The day one appears is the day rates start being approximately right, and the failure shows up
  // as a penny in a reconciliation report nobody can trace.
  const sql = stripNoise(MIGRATION_UP);
  for (const type of ['double precision', 'real', 'float4', 'float8', 'money']) {
    assert.ok(
      !new RegExp(`\\b${type.replace(' ', '\\s+')}\\b`, 'i').test(sql),
      `the migration declares a ${type} column; policy values are exact decimals in jsonb`,
    );
  }
});

test('a failed transaction writes nothing', async () => {
  const repository = new InMemoryPolicyRepository();
  await assert.rejects(
    repository.withTransaction(async (tx) => {
      await tx.insertRetirement({
        retirementId: nextId('ret'),
        policyKey: POLICY,
        reason: 'about to change my mind',
        retiredAt: '2026-04-01T12:00:00Z',
        retiredBy: { kind: 'system', id: AUTHORITY },
        idempotencyKey: nextId('idem'),
        requestFingerprint: 'a'.repeat(64),
      });
      throw new Error('something went wrong after the insert');
    }),
    /something went wrong/,
  );
  assert.equal(repository.retirements().length, 0);
  assert.equal(repository.transactionsRolledBack, 1);
});

// ---------------------------------------------------------------------------
// Adapter queries
// ---------------------------------------------------------------------------

test('every read projects its timestamps as UTC text, never as a driver Date', async () => {
  const database = new RecordingDatabase({
    selects: [
      { match: /FROM kernel_policy_engine.policy_draft/i, rows: [draftRow()] },
      { match: /FROM kernel_policy_engine.policy_activation/i, rows: [activationRow()] },
      { match: /FROM kernel_policy_engine.policy_retirement/i, rows: [retirementRow()] },
      { match: /FROM kernel_policy_engine.policy_version/i, rows: [versionRow()] },
    ],
  });

  await new PostgresPolicyRepository(database).withTransaction(async (tx) => {
    await tx.findDraftById('draft_01HQZXTESTROW');
    await tx.findVersionById('polver_01HQZXTESTRW');
    await tx.findCurrentActivation(POLICY);
    await tx.findRetirement(POLICY);
  });

  const selects = database.statements().filter((sql) => sql.startsWith('SELECT'));
  assert.ok(selects.length >= 4);
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

test('the version in force is the end of the chain, not the newest row', async () => {
  const database = new RecordingDatabase({
    selects: [{ match: /FROM kernel_policy_engine.policy_activation/i, rows: [] }],
  });
  await new PostgresPolicyRepository(database).withTransaction((tx) =>
    tx.findCurrentActivation(POLICY),
  );

  const sql = database.statements().find((statement) => statement.startsWith('SELECT')) ?? '';
  assert.match(sql, /NOT EXISTS/i, 'the version in force must be found by anti-join');
  assert.match(sql, /supersedes_version_id = current\.policy_version_id/);
  assert.ok(
    !/ORDER BY\s+activated_at/i.test(sql),
    'ordering by the clock would pick arbitrarily between two activations sharing an instant',
  );
});

test('a unique violation becomes the refusal it actually is', async () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['policy_version_number_unique', 'duplicate-policy-version'],
    ['policy_version_idempotency_unique', 'idempotency-key-reuse'],
    ['policy_activation_supersedes_unique', 'stale-activation'],
    ['policy_activation_first_unique', 'stale-activation'],
    ['policy_retirement_policy_unique', 'duplicate-retirement'],
    ['policy_draft_idempotency_unique', 'idempotency-key-reuse'],
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
      new PostgresPolicyRepository(database).withTransaction((tx) =>
        tx.insertRetirement({
          retirementId: 'ret_01HQZXCONFLICT',
          policyKey: POLICY,
          reason: 'probe',
          retiredAt: '2026-04-01T12:00:00Z',
          retiredBy: { kind: 'system', id: AUTHORITY },
          idempotencyKey: 'idem_01HQZXCONFLI',
          requestFingerprint: 'b'.repeat(64),
        }),
      ),
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

  await enlisted.release();
  assert.equal(database.sessionsReleased, 0, 'and it does not close a connection it does not own');
});

test('an enlisted repository shares the caller’s transaction', async () => {
  const database = new RecordingDatabase({
    selects: [{ match: /FROM kernel_policy_engine.policy_version/i, rows: [versionRow()] }],
  });
  const client = await database.connect();
  const repository = PostgresPolicyRepository.enlist(client);

  await repository.withTransaction((tx) => tx.findVersionById('polver_01HQZXTESTRW'));

  const control = database.statements().filter((sql) => /^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sql));
  assert.deepEqual(control, [], 'the enlisted path opened or closed a transaction of its own');
});

// ---------------------------------------------------------------------------
// Fail-closed decoding
// ---------------------------------------------------------------------------

test('well-formed rows decode, sealed', () => {
  const version = toPolicyVersion(versionRow());
  assert.equal(version.policyKey, POLICY);
  assert.equal(version.publishedAt, '2026-04-01T12:00:00.123456Z', 'microseconds survive');
  assert.ok(Object.isFrozen(version));
  assert.ok(Object.isFrozen(version.rules));
  assert.deepEqual(version.rules[0]?.outputs.rate, { kind: 'decimal', value: rate('1000') });

  assert.ok(Object.isFrozen(toPolicyDraft(draftRow())));
  assert.equal(toPolicyActivation(activationRow()).supersedesVersionId, null);
  assert.equal(toPolicyRetirement(retirementRow()).policyKey, POLICY);
});

test('a malformed persisted row is refused rather than evaluated', () => {
  const cases: ReadonlyArray<readonly [string, () => unknown, string]> = [
    [
      'a rate stored as a float',
      () =>
        toPolicyVersion(
          versionRow({
            rules: [
              {
                ruleId: 'rule_01HQZXFLOAT01',
                selector: {},
                condition: null,
                outputs: {
                  rate: { kind: 'decimal', value: 0.1 },
                  holdSeconds: { kind: 'duration-seconds', value: 0 },
                },
              },
            ],
          }),
        ),
      'lossy-numeric-value',
    ],
    [
      'a rate outside the declared range',
      () =>
        toPolicyVersion(
          versionRow({
            rules: [
              {
                ruleId: 'rule_01HQZXRANGE01',
                selector: {},
                condition: null,
                outputs: {
                  rate: { kind: 'decimal', value: rate('99999999') },
                  holdSeconds: { kind: 'duration-seconds', value: 0 },
                },
              },
            ],
          }),
        ),
      'unsupported-output',
    ],
    [
      'a timestamp the driver parsed into a Date',
      () => toPolicyVersion(versionRow({ published_at: new Date('2026-04-01T12:00:00Z') })),
      'malformed-record',
    ],
    [
      'a timestamp in the wrong projected form',
      () => toPolicyVersion(versionRow({ published_at: '2026-04-01 12:00:00+00' })),
      'malformed-record',
    ],
    [
      'jsonb that came back as text',
      () => toPolicyVersion(versionRow({ rules: '[]' })),
      'malformed-record',
    ],
    [
      'a policy key naming another component’s decision',
      () => toPolicyVersion(versionRow({ policy_key: 'staff.permission.elevated' })),
      'malformed-identifier',
    ],
    [
      'an AI author',
      () => toPolicyVersion(versionRow({ published_by_kind: 'ai' })),
      'malformed-record',
    ],
    [
      'a window containing no instant',
      () =>
        toPolicyVersion(
          versionRow({
            effective_from: '2026-05-01T00:00:00.000000Z',
            effective_until: '2026-04-01T00:00:00.000000Z',
          }),
        ),
      'invalid-effective-window',
    ],
    [
      'two rules that can never be told apart',
      () =>
        toPolicyVersion(
          versionRow({
            rules: [
              {
                ruleId: 'rule_01HQZXCLASH11',
                selector: {},
                condition: null,
                outputs: {
                  rate: { kind: 'decimal', value: rate('1000') },
                  holdSeconds: { kind: 'duration-seconds', value: 0 },
                },
              },
              {
                ruleId: 'rule_01HQZXCLASH12',
                selector: {},
                condition: null,
                outputs: {
                  rate: { kind: 'decimal', value: rate('2000') },
                  holdSeconds: { kind: 'duration-seconds', value: 0 },
                },
              },
            ],
          }),
        ),
      'ambiguous-precedence',
    ],
    [
      'an output the schema does not declare',
      () =>
        toPolicyVersion(
          versionRow({
            rules: [
              {
                ruleId: 'rule_01HQZXEXTRA01',
                selector: {},
                condition: null,
                outputs: {
                  rate: { kind: 'decimal', value: rate('1000') },
                  holdSeconds: { kind: 'duration-seconds', value: 0 },
                  secretBonus: { kind: 'boolean', value: true },
                },
              },
            ],
          }),
        ),
      'unsupported-output',
    ],
    [
      'a natural key in an identifier column',
      () => toPolicyVersion(versionRow({ published_by_id: 'alice@example.com' })),
      'natural-identifier',
    ],
    [
      'a fingerprint that is not one',
      () => toPolicyVersion(versionRow({ request_fingerprint: 'not-a-hash' })),
      'malformed-record',
    ],
    [
      'a retirement with no reason',
      () => toPolicyRetirement(retirementRow({ reason: '   ' })),
      'malformed-record',
    ],
    [
      'an activation that supersedes itself',
      () => toPolicyActivation(activationRow({ supersedes_version_id: 'polver_01HQZXTESTRW' })),
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

test('K-06 owns exactly one schema, derived from the manifest', () => {
  const component = KERNEL_COMPONENTS.find((entry) => entry.id === 'K-06');
  assert.ok(component !== undefined, 'the manifest has no K-06');
  assert.equal(POLICY_SCHEMA, `${KERNEL_SCHEMA_PREFIX}${component.dir.replace(/-/g, '_')}`);
  assert.ok(knownSchemas().includes(POLICY_SCHEMA), 'the schema resolves to no owner');

  for (const table of [DRAFT_TABLE, VERSION_TABLE, ACTIVATION_TABLE, RETIREMENT_TABLE]) {
    assert.ok(table.startsWith(`${POLICY_SCHEMA}.`), `${table} is outside K-06's schema`);
  }
});

test('no statement K-06 issues names another unit’s schema, and there is no foreign key', () => {
  const foreign = knownSchemas().filter((schema) => schema !== POLICY_SCHEMA);
  const sql = `${stripComments(ADAPTER_SOURCE)}\n${stripNoise(MIGRATION_UP)}\n${stripNoise(MIGRATION_DOWN)}`;

  for (const schema of foreign) {
    assert.ok(
      !new RegExp(`\\b${schema}\\.`).test(sql),
      `K-06 names ${schema}, which belongs to another unit`,
    );
  }
  assert.ok(
    !/REFERENCES\s+\w/i.test(stripNoise(MIGRATION_UP)),
    'a foreign key out of this schema would make two components one object',
  );
});

test('K-06’s opacity rules are character-for-character every other component’s', () => {
  const bodies = readdirSync(MIGRATIONS)
    .filter((file) => file.endsWith('.up.sql'))
    .map((file) => readFileSync(path.join(MIGRATIONS, file), 'utf8'))
    .map((sql) => /AS \$rules\$([\s\S]*?)\$rules\$/.exec(sql)?.[1])
    .filter((body): body is string => body !== undefined);

  assert.ok(bodies.length >= 6, `expected at least six copies of the rule set, found ${bodies.length}`);
  for (const body of bodies) {
    assert.equal(body, bodies[0], 'one schema’s opacity rule set has drifted from the others');
  }
});

test('the migration enforces the contract in the database, not only in the service', () => {
  const required: ReadonlyArray<readonly [string, RegExp]> = [
    ['no AI author', /published_by_kind IN \('human', 'system'\)/],
    ['one version number per policy', /UNIQUE \(policy_key, version\)/],
    ['one retirement per policy', /CONSTRAINT policy_retirement_policy_unique UNIQUE \(policy_key\)/],
    ['the activation guard', /policy_activation_supersedes_unique/],
    ['the first-activation guard', /policy_activation_first_unique/],
    ['a window that is a window', /effective_until > effective_from/],
    ['at least one rule', /jsonb_array_length\(rules\) >= 1/],
    ['a reason on every retirement', /length\(btrim\(reason\)\) > 0/],
    ['policy keys that name nothing else', /is_policy_key/],
    ['fingerprints', /request_fingerprint ~ '\^\[0-9a-f\]\{64\}\$'/],
    ['positive version numbers', /version >= 1/],
  ];

  for (const [what, pattern] of required) {
    assert.match(MIGRATION_UP, pattern, `the migration does not enforce ${what}`);
  }
});

test('the policy-key rule in the database refuses what the service refuses', () => {
  const rule = /AS \$keys\$([\s\S]*?)\$keys\$/.exec(MIGRATION_UP)?.[1] ?? '';
  for (const fragment of ['permission', 'feature-flag', 'credential']) {
    assert.ok(
      rule.includes(fragment),
      `the database's policy-key rule does not refuse "${fragment}", so a statement written ` +
        'around the service could create one',
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

  assert.match(MIGRATION_DOWN, /DROP SCHEMA IF EXISTS kernel_policy_engine RESTRICT/);
  assert.ok(
    !/CASCADE/i.test(stripNoise(MIGRATION_DOWN)),
    'CASCADE would remove objects no migration described',
  );
});

test('the rollback says plainly that it is data loss rather than a reversal', () => {
  // Unlike every rollback before it, this one leaves historic transactions holding a version id
  // that no longer resolves. An operator should be told that in the file, not discover it.
  assert.match(MIGRATION_DOWN, /data loss/i);
  assert.match(MIGRATION_DOWN, /unexplainable|no longer resolves/i);
});

// ---------------------------------------------------------------------------
// The contract document
// ---------------------------------------------------------------------------

test('CONTRACT.md documents every refusal the union declares', () => {
  const codes = [...TYPES_SOURCE.matchAll(/^\s*\| '([a-z-]+)'$/gm)].map((match) => match[1]);
  assert.ok(codes.length > 15, `expected the error union, found ${codes.length} codes`);
  for (const code of codes) {
    assert.ok(CONTRACT.includes(String(code)), `CONTRACT.md does not document "${String(code)}"`);
  }
});

test('CONTRACT.md records version pinning, the boundaries and the deferred work', () => {
  const required: ReadonlyArray<readonly [string, RegExp]> = [
    ['that every evaluation returns a version id', /every successful evaluation returns/i],
    ['the v3 §35 requirement', /§35/],
    ['the v3 §24 requirement', /§24/],
    ['that AI is never the financial authority', /§38/],
    ['that K-06 does not compute amounts', /K-10/],
    ['the K-05 dependency', /K-05/],
    ['the deferred K-02 integration', /K-02/],
    ['the deferred K-04 integration', /K-04/],
    ['the deferred K-08 events', /K-08/],
    ['the deferred K-09 audit', /K-09/],
    ['the deferred studio', /studio/i],
    ['that no API or UI ships', /No API/i],
    ['that nothing has run against a live server', /live PostgreSQL|live server/i],
    ['no floating point', /floating point|float/i],
    ['ambiguous precedence', /ambiguous/i],
  ];

  for (const [what, pattern] of required) {
    assert.match(CONTRACT, pattern, `CONTRACT.md does not record ${what}`);
  }
});

test('every file CONTRACT.md links to exists, and every suite it names exists', () => {
  for (const match of CONTRACT.matchAll(/`(tests\/[\w./-]+\.ts)`/g)) {
    assert.ok(existsSync(path.join(HERE, '..', String(match[1]))), `${String(match[1])} is missing`);
  }
  for (const match of CONTRACT.matchAll(/`(db\/migrations\/[\w.-]+\.sql)`/g)) {
    assert.ok(existsSync(path.join(HERE, '..', String(match[1]))), `${String(match[1])} is missing`);
  }
});

test('the module has no file the contract does not account for', () => {
  for (const file of readdirSync(MODULE_DIR).filter((entry) => entry.endsWith('.ts'))) {
    assert.ok(
      CONTRACT.includes(file),
      `kernel/policy-engine/${file} is not mentioned in CONTRACT.md, so a reader cannot tell ` +
        'what it is for',
    );
  }
});
