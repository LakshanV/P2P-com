/**
 * K-04 Permissions — port conformance, adapter queries, the migration and the contract (FND-004d).
 *
 * The assertion that matters most here has no equivalent in the other components: **there is no
 * UPDATE and no DELETE anywhere in this module or its schema.** Not in the service, not in the
 * port, not in the adapter, and not reachable through the tables — four triggers refuse both. A
 * grant that could be edited answers "who may do this" and destroys "who could have, in March, and
 * who said so", which is the question authority history exists to answer.
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
  DECISION_TABLE,
  GRANT_TABLE,
  InMemoryPermissionRepository,
  PERMISSIONS_SCHEMA,
  POLICY_TABLE,
  PermissionError,
  PostgresPermissionRepository,
  REVOCATION_TABLE,
  TIMESTAMP_COLUMNS,
  enlistedClient,
  toDecision,
  toGrant,
  toPolicyVersion,
  toRevocation,
} from '../kernel/permissions/index.ts';

import { decisionRow, grantRow, policyRow, revocationRow } from './helpers/permission-fixtures.ts';
import { RecordingDatabase, sqlstateError } from './helpers/recording-database.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE_DIR = path.join(HERE, '..', 'kernel', 'permissions');
const ADAPTER_SOURCE = readFileSync(path.join(MODULE_DIR, 'postgres-repository.ts'), 'utf8');
const PORT_SOURCE = readFileSync(path.join(MODULE_DIR, 'repository.ts'), 'utf8');
const CONTRACT = readFileSync(path.join(MODULE_DIR, 'CONTRACT.md'), 'utf8');
const TYPES_SOURCE = readFileSync(path.join(MODULE_DIR, 'types.ts'), 'utf8');
const MIGRATIONS = path.join(HERE, '..', 'db', 'migrations');
const MIGRATION_UP = readFileSync(
  path.join(MIGRATIONS, '0009_create_kernel_permissions_schema.up.sql'),
  'utf8',
);
const MIGRATION_DOWN = readFileSync(
  path.join(MIGRATIONS, '0009_create_kernel_permissions_schema.down.sql'),
  'utf8',
);

const codeOf = (error: unknown): string | undefined =>
  error instanceof PermissionError ? error.code : undefined;

const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)\/\/[^\n]*/g, ' ');

// ---------------------------------------------------------------------------
// Append-only, at every layer
// ---------------------------------------------------------------------------

test('neither the port nor the adapter can update or delete authority', () => {
  for (const [name, source] of [
    ['the port', PORT_SOURCE],
    ['the adapter', ADAPTER_SOURCE],
  ] as const) {
    const code = stripComments(source);
    for (const forbidden of [/\bUPDATE\b/i, /\bDELETE\b/i, /\bTRUNCATE\b/i]) {
      assert.ok(
        !forbidden.test(code),
        `${name} contains ${String(forbidden)} — there must be no statement that could rewrite ` +
          'authority history even if a caller found a way to ask',
      );
    }
  }
  assert.match(stripComments(ADAPTER_SOURCE), /INSERT INTO/, 'the adapter does write');
});

test('the migration refuses UPDATE and DELETE on every table it creates', () => {
  const tables = [
    'permission_policy_version',
    'permission_grant',
    'permission_revocation',
    'permission_decision',
  ];
  for (const table of tables) {
    assert.match(
      MIGRATION_UP,
      new RegExp(`CREATE TRIGGER ${table}_is_append_only\\s+BEFORE UPDATE OR DELETE ON`),
      `${table} has no append-only trigger, so a hand-written UPDATE would succeed`,
    );
  }
  assert.match(MIGRATION_UP, /authority history is append-only/);
});

test('a failed transaction writes nothing', async () => {
  const repository = new InMemoryPermissionRepository();
  await assert.rejects(
    repository.withTransaction(async (tx) => {
      await tx.insertPolicyVersion({
        policyVersionId: 'pol_01HQZXPORT001',
        version: 1,
        roles: [{ role: 'CUSTOMER', capabilities: [{ action: 'read', resourceType: 'order' }] }],
        publishedAt: '2026-04-01T12:00:00Z',
        publishedBy: { kind: 'system', id: 'K-04-permission-service' },
        bootstrap: false,
        idempotencyKey: 'idem_01HQZXPORT001',
        requestFingerprint: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      });
      throw new Error('something went wrong after the insert');
    }),
    /something went wrong/,
  );
  assert.equal(repository.policies().length, 0);
  assert.equal(repository.transactionsRolledBack, 1);
});

// ---------------------------------------------------------------------------
// Adapter queries
// ---------------------------------------------------------------------------

test('every read projects its timestamps as UTC text, never as a driver Date', async () => {
  const database = new RecordingDatabase({
    selects: [
      { match: /permission_policy_version/i, rows: [policyRow()] },
      { match: /permission_grant/i, rows: [grantRow()] },
      { match: /permission_revocation/i, rows: [revocationRow()] },
      { match: /permission_decision/i, rows: [decisionRow()] },
    ],
  });

  await new PostgresPermissionRepository(database).withTransaction(async (tx) => {
    await tx.findActivePolicy();
    await tx.findGrantById('grant_01HQZXTESTROW');
    await tx.findRevocationByGrantId('grant_01HQZXTESTROW');
    await tx.findDecisionById('dec_01HQZXTESTROW');
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

test('the grant query is scoped by subject *and* account', async () => {
  const database = new RecordingDatabase({ selects: [{ match: /permission_grant/i, rows: [] }] });
  await new PostgresPermissionRepository(database).withTransaction((tx) =>
    tx.listGrantsForSubject('sub_01HQZXSCOPE01', 'acct_01HQZXSCOPE01'),
  );

  const select = database.statements().find((sql) => sql.includes('permission_grant'));
  assert.ok(select !== undefined);
  assert.match(
    select,
    /WHERE subject_id = \$1 AND account_id = \$2/,
    'a query by subject alone would read another account’s authority into this decision',
  );
});

test('a unique violation becomes the refusal it actually is', async () => {
  for (const [constraint, expected] of [
    ['permission_policy_version_number_unique', 'duplicate-policy-version'],
    ['permission_grant_pkey', 'duplicate-grant'],
    ['permission_grant_idempotency_unique', 'idempotency-key-reuse'],
    ['permission_revocation_grant_unique', 'stale-revocation'],
    ['permission_decision_idempotency_unique', 'idempotency-key-reuse'],
  ] as const) {
    const database = new RecordingDatabase({
      failures: [
        {
          match: /INSERT INTO/i,
          error: sqlstateError(
            `duplicate key value violates unique constraint "${constraint}"`,
            '23505',
            constraint,
          ),
        },
      ],
    });

    await assert.rejects(
      new PostgresPermissionRepository(database).withTransaction((tx) =>
        tx.insertGrant({
          grantId: 'grant_01HQZXCONFL01',
          subjectId: 'sub_01HQZXCONFL01',
          accountId: 'acct_01HQZXCONFL01',
          role: 'CUSTOMER',
          effect: 'allow',
          action: 'read',
          resourceType: 'order',
          resourceId: null,
          purpose: null,
          condition: null,
          policyVersionId: 'pol_01HQZXCONFL01',
          grantedAt: '2026-04-01T12:00:00Z',
          notBefore: null,
          expiresAt: null,
          grantedBy: { kind: 'human', id: 'ops-alice-console' },
          idempotencyKey: 'idem_01HQZXCONFL01',
          requestFingerprint: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        }),
      ),
      (error: unknown) => codeOf(error) === expected,
      `${constraint} must surface as ${expected}`,
    );
  }
});

test('an enlisted write may not control the transaction', async () => {
  const database = new RecordingDatabase();
  const client = await database.connect();
  const guarded = enlistedClient(client);

  for (const statement of ['BEGIN;', 'COMMIT;', 'ROLLBACK;', 'SAVEPOINT s1;']) {
    await assert.rejects(
      guarded.query(statement),
      (error: unknown) => codeOf(error) === 'nested-transaction',
      `an enlisted permission write may not issue ${statement}`,
    );
  }
  await guarded.query('SELECT 1;');
  assert.ok(database.statements().includes('SELECT 1;'), 'and everything else passes through');
});

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

test('well-formed rows decode, sealed', () => {
  const policy = toPolicyVersion(policyRow());
  const grant = toGrant(grantRow());
  const revocation = toRevocation(revocationRow());
  const decision = toDecision(decisionRow());

  assert.equal(policy.version, 1);
  assert.equal(policy.publishedAt, '2026-04-01T12:00:00Z');
  assert.equal(grant.effect, 'allow');
  assert.equal(revocation.reason, 'access-no-longer-needed');
  assert.equal(decision.reason, 'no-matching-grant');
  for (const record of [policy, grant, revocation, decision]) {
    assert.ok(Object.isFrozen(record));
  }
});

test('a malformed persisted row is refused rather than decided upon', () => {
  const malformed: ReadonlyArray<readonly [string, () => unknown, RegExp]> = [
    [
      'an unknown effect',
      () => toGrant(grantRow({ effect: 'maybe' })),
      /expected one of allow, deny/,
    ],
    ['an unknown role', () => toGrant(grantRow({ role: 'OVERLORD' })), /is not a role/],
    [
      'an unknown action',
      () => toGrant(grantRow({ action: 'obliterate' })),
      /not a registered action/,
    ],
    [
      'a staff role with no purpose',
      () => toGrant(grantRow({ role: 'SUPPORT' })),
      /must declare a purpose/,
    ],
    [
      'an AI grant that is not a tool capability',
      () => toGrant(grantRow({ role: 'AI_AGENT', action: 'read', resource_type: 'conversation' })),
      /only explicitly granted tool capabilities/,
    ],
    [
      'a Date instead of text',
      () => toGrant(grantRow({ granted_at: new Date() })),
      /rather than text/,
    ],
    [
      'a millisecond timestamp',
      () => toGrant(grantRow({ granted_at: '2026-04-01T12:00:00.000Z' })),
      /projected form/,
    ],
    ['an email as a subject id', () => toGrant(grantRow({ subject_id: 'alice@example.com' })), /@/],
    [
      'an unknown decision reason',
      () => toDecision(decisionRow({ reason: 'felt-like-it' })),
      /expected one of/,
    ],
    [
      'an unexplained decision',
      () => toDecision(decisionRow({ explanation: 'no' })),
      /unactionable for the person denied/,
    ],
    ['an empty policy', () => toPolicyVersion(policyRow({ roles: [] })), /at least one role/],
    [
      'an AI origin on a policy',
      () => toPolicyVersion(policyRow({ published_by_kind: 'ai' })),
      /not something AI may author/,
    ],
  ];

  for (const [why, decode, message] of malformed) {
    assert.throws(
      decode,
      (error: unknown) => {
        assert.ok(
          [
            'malformed-record',
            'malformed-instant',
            'unsupported-role',
            'unsupported-action',
            'natural-identifier',
            'missing-purpose',
            'ai-not-permitted',
          ].includes(String(codeOf(error))),
          `${why} got ${String(codeOf(error))}`,
        );
        assert.match((error as PermissionError).message, message, why);
        assert.match(
          (error as PermissionError).message,
          /not written by this component/i,
          `${why}: the refusal must send the reader to the database`,
        );
        return true;
      },
      `${why} must be refused`,
    );
  }
});

// ---------------------------------------------------------------------------
// Ownership
// ---------------------------------------------------------------------------

test('K-04 owns exactly one schema, derived from the manifest', () => {
  const component = KERNEL_COMPONENTS.find((entry) => entry.id === 'K-04');
  assert.ok(component !== undefined);
  assert.equal(PERMISSIONS_SCHEMA, `${KERNEL_SCHEMA_PREFIX}${component.dir.replace(/-/g, '_')}`);
  assert.ok(knownSchemas().includes(PERMISSIONS_SCHEMA), 'the schema resolves to a manifest owner');
  for (const table of [POLICY_TABLE, GRANT_TABLE, REVOCATION_TABLE, DECISION_TABLE]) {
    assert.ok(table.startsWith(`${PERMISSIONS_SCHEMA}.`));
  }
});

test('no statement K-04 issues names another unit’s schema, and there is no foreign key', () => {
  const code = stripComments(ADAPTER_SOURCE);
  for (const schema of knownSchemas()) {
    if (schema === PERMISSIONS_SCHEMA || schema === 'platform') continue;
    assert.ok(!code.includes(schema), `the adapter names ${schema}`);
  }
  const sql = stripNoise(MIGRATION_UP);
  assert.ok(
    !/REFERENCES/i.test(sql),
    'a cross-schema foreign key would make two components one object',
  );
  for (const schema of knownSchemas()) {
    if (schema === PERMISSIONS_SCHEMA) continue;
    assert.ok(!sql.includes(schema), `migration 0009 names ${schema}`);
  }
});

test('K-04’s opacity rules are character-for-character K-01’s, K-02’s and K-03’s', () => {
  const bodyOf = (source: string): string => {
    const match = /AS \$rules\$([\s\S]*?)\$rules\$/.exec(source);
    assert.ok(match !== null, 'the rule function moved');
    return (match[1] as string).trim();
  };

  const permissions = bodyOf(MIGRATION_UP);
  for (const [name, file] of [
    ['K-01', '0006_create_kernel_identity_schema.up.sql'],
    ['K-03', '0007_create_kernel_accounts_schema.up.sql'],
    ['K-02', '0008_create_kernel_authentication_schema.up.sql'],
  ] as const) {
    const other = bodyOf(readFileSync(path.join(MIGRATIONS, file), 'utf8'));
    assert.equal(
      permissions,
      other,
      `K-04's identifier rules have drifted from ${name}'s. The duplication is unavoidable — each ` +
        'schema must be independently creatable — so it is guarded instead',
    );
  }
});

test('the migration enforces the contract in the database, not only in the service', () => {
  for (const [why, pattern] of [
    ['deny/allow is closed', /CHECK \(effect IN \('allow', 'deny'\)\)/],
    ['the role vocabulary is closed', /CHECK \(role IN \('CUSTOMER'/],
    ['staff purpose is required and non-staff purpose refused', /permission_grant_staff_purpose/],
    ['AI holds tool capabilities only', /permission_grant_ai_tool_only/],
    ['an allow names its grant', /permission_decision_allow_is_traceable/],
    ['a decision is explained', /permission_decision_explained/],
    ['one revocation per grant', /permission_revocation_grant_unique UNIQUE \(grant_id\)/],
    [
      'one row per policy version number',
      /permission_policy_version_number_unique UNIQUE \(version\)/,
    ],
    ['AI may not author policy', /permission_policy_version_origin_known/],
  ] as const) {
    assert.match(MIGRATION_UP, pattern, `the schema does not enforce that ${why}`);
  }
});

test('the rollback reverses exactly what the forward migration created', () => {
  for (const object of [
    'permission_decision',
    'permission_revocation',
    'permission_grant',
    'permission_policy_version',
    'refuse_mutation',
    'is_opaque_identifier',
  ]) {
    assert.ok(MIGRATION_DOWN.includes(object), `the rollback does not drop ${object}`);
  }
  assert.ok(
    MIGRATION_DOWN.indexOf('DROP TABLE') <
      MIGRATION_DOWN.indexOf('DROP FUNCTION IF EXISTS kernel_permissions.is_opaque_identifier'),
    'the CHECK constraints reference the rule function, so the tables must go first',
  );
  assert.match(MIGRATION_DOWN, /DROP SCHEMA IF EXISTS kernel_permissions RESTRICT/);
});

// ---------------------------------------------------------------------------
// The contract document
// ---------------------------------------------------------------------------

/** Every member of the `PermissionErrorCode` union, read out of the source that declares it. */
function declaredErrorCodes(): readonly string[] {
  const start = TYPES_SOURCE.indexOf('export type PermissionErrorCode =');
  assert.ok(start !== -1, 'the error-code union moved; this extraction needs updating');
  const block = TYPES_SOURCE.slice(start, TYPES_SOURCE.indexOf(';', start));
  const codes = [...block.matchAll(/\|\s*'([a-z-]+)'/g)].map((match) => match[1] as string);
  assert.ok(codes.length >= 20, `extracted ${codes.length} codes — the extraction is broken`);
  return codes;
}

test('CONTRACT.md documents every refusal the union declares', () => {
  const undocumented = declaredErrorCodes().filter((code) => !CONTRACT.includes(`\`${code}\``));
  assert.deepEqual(
    undocumented,
    [],
    `CONTRACT.md does not document ${undocumented.join(', ')} — a refusal a caller can receive and ` +
      'cannot look up is a refusal it will guess at',
  );
});

test('CONTRACT.md records the trust model and the deferred work', () => {
  const claims: ReadonlyArray<readonly [string, RegExp]> = [
    ['deny by default', /deny by default|denied unless/i],
    ['the caller does not decide', /caller (never|does not) (states|decide)/i],
    ['the subject comes from a validated session', /validated session/i],
    ['the account comes from K-03', /K-03/],
    ['deny precedence', /deny (always )?(wins|outranks)/i],
    ['staff purpose limitation', /purpose/i],
    ['append-only history', /append-only/i],
    ['no super-admin bypass', /SUPER_ADMIN/],
    ['AI holds tool capabilities only', /AI_AGENT/],
    ['no foreign key out of the schema', /no foreign key/i],
    ['no API or UI', /no API/i],
    ['no audit integration', /K-09/],
    ['no events', /K-08/],
    ['no policy studio', /policy studio/i],
    ['no real verifier behind K-02', /no verifier/i],
    [
      'nothing applied to a live server',
      /(never been applied|nothing has run against a live|unproven)/i,
    ],
  ];
  for (const [claim, pattern] of claims) {
    assert.match(CONTRACT, pattern, `CONTRACT.md does not record ${claim}`);
  }

  for (const overclaim of [/\bK-04\b[^.]{0,40}\bis complete\b/i, /\bproduction[- ]ready\b/i]) {
    assert.ok(!overclaim.test(CONTRACT), `CONTRACT.md over-claims via ${String(overclaim)}`);
  }
});

test('every file CONTRACT.md links to exists, and every suite it names exists', () => {
  const targets = [...CONTRACT.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)]
    .map((match) => (match[1] ?? '').split('#')[0] ?? '')
    .filter((target) => target !== '' && !/^[a-z][a-z0-9+.-]*:/i.test(target));
  assert.ok(targets.length > 0, 'expected the contract to link to the schema it declares');
  for (const target of targets) {
    assert.ok(
      existsSync(path.resolve(MODULE_DIR, target)),
      `CONTRACT.md links ${target}, which does not exist`,
    );
  }

  const suites = [...CONTRACT.matchAll(/node --test (tests\/[\w.-]+\.ts)/g)].map(
    (match) => match[1] as string,
  );
  assert.ok(
    suites.length >= 3,
    `expected the verification section to name the suites, found ${suites.length}`,
  );
  for (const suite of suites) {
    assert.ok(
      existsSync(path.join(HERE, '..', suite)),
      `CONTRACT.md names ${suite}, which does not exist`,
    );
  }
});

test('the module has no file the contract does not account for', () => {
  const files = readdirSync(MODULE_DIR).filter((name) => name.endsWith('.ts'));
  assert.ok(files.length >= 8, 'the module should have its full file set');
  for (const file of files) {
    assert.ok(
      readFileSync(path.join(MODULE_DIR, file), 'utf8').includes('Owned by: K-04 Permissions') ||
        file === 'index.ts',
      `${file} does not record its owner`,
    );
  }
});
