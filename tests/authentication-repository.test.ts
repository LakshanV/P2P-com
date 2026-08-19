/**
 * K-02 Authentication — port conformance, adapter queries and the module contract (FND-004c).
 *
 * The assertion that matters most here is one no other component has needed: **no secret is ever a
 * SQL parameter.** Every statement the adapter issues is inspected, parameter by parameter, and any
 * value that looks like a session secret rather than a hash fails the suite. It is the kind of
 * mistake that is invisible in review — a variable renamed, a hash computed one line too late — and
 * catastrophic in effect, because the store would then hold live sessions in plaintext.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { KERNEL_COMPONENTS } from '../platform/architecture/manifest.ts';
import { stripNoise } from '../platform/db/migrations.ts';
import { KERNEL_SCHEMA_PREFIX, knownSchemas } from '../platform/db/schema-namespaces.ts';
import {
  AUTH_SCHEMA,
  AuthenticationError,
  BINDING_TABLE,
  EVIDENCE_TABLE,
  InMemoryAuthenticationRepository,
  PostgresAuthenticationRepository,
  SESSION_TABLE,
  TIMESTAMP_COLUMNS,
  hashToken,
  toBinding,
  toEvidence,
  toSession,
} from '../kernel/authentication/index.ts';

import {
  bindingRow,
  evidenceRow,
  sessionRow,
} from './helpers/authentication-fixtures.ts';
import { RecordingDatabase, sqlstateError } from './helpers/recording-database.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE_DIR = path.join(HERE, '..', 'kernel', 'authentication');
const ADAPTER_SOURCE = readFileSync(path.join(MODULE_DIR, 'postgres-repository.ts'), 'utf8');
const PORT_SOURCE = readFileSync(path.join(MODULE_DIR, 'repository.ts'), 'utf8');
const SERVICE_SOURCE = readFileSync(path.join(MODULE_DIR, 'service.ts'), 'utf8');
const CONTRACT = readFileSync(path.join(MODULE_DIR, 'CONTRACT.md'), 'utf8');
const MIGRATIONS = path.join(HERE, '..', 'db', 'migrations');
const MIGRATION_UP = readFileSync(
  path.join(MIGRATIONS, '0008_create_kernel_authentication_schema.up.sql'),
  'utf8',
);
const MIGRATION_DOWN = readFileSync(
  path.join(MIGRATIONS, '0008_create_kernel_authentication_schema.down.sql'),
  'utf8',
);

const codeOf = (error: unknown): string | undefined =>
  error instanceof AuthenticationError ? error.code : undefined;

const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)\/\/[^\n]*/g, ' ');

// ---------------------------------------------------------------------------
// No secret reaches SQL
// ---------------------------------------------------------------------------

test('no session secret is ever a SQL parameter', async () => {
  // Every parameter of every statement, checked against the shape of a secret. A hash is 64 hex
  // characters; a secret is 43+ base64url. Nothing the adapter sends may look like the latter.
  const secret = 'S3cr3t-looking-value-that-is-forty-three-ch';
  const hash = hashToken(secret);
  const database = new RecordingDatabase({ selects: [{ match: /SELECT/i, rows: [sessionRow()] }] });

  await new PostgresAuthenticationRepository(database).withTransaction(async (tx) => {
    await tx.findSessionByTokenHash(hash);
    await tx.insertSession({
      sessionId: 'sess_01HQZXPARAMS1',
      bindingId: 'bind_01HQZXPARAMS1',
      subjectId: 'sub_01HQZXPARAMS1',
      evidenceId: 'evid_01HQZXPARAMS1',
      assurance: 'single-factor',
      factors: ['possession'],
      tokenHash: hash,
      issuedAt: '2026-04-01T12:00:00Z',
      absoluteExpiresAt: '2026-04-02T00:00:00Z',
      idleExpiresAt: '2026-04-01T12:30:00Z',
      rotationCount: 0,
      revokedAt: null,
      revocationReason: null,
      idempotencyKey: 'idem_01HQZXPARAMS1',
    });
    await tx.rotateSession({
      sessionId: 'sess_01HQZXPARAMS1',
      expectedTokenHash: hash,
      nextTokenHash: hashToken('another-secret-that-is-forty-three-chars-ok'),
      nextIdleExpiresAt: '2026-04-01T13:00:00Z',
      nextRotationCount: 1,
    });
  });

  assert.ok(database.queries.length > 0, 'statements were actually issued');
  for (const query of database.queries) {
    for (const parameter of query.params) {
      if (typeof parameter !== 'string') continue;
      assert.ok(
        !/^[A-Za-z0-9_-]{43,}$/.test(parameter) || /^[0-9a-f]{64}$/.test(parameter),
        `a parameter looks like a session secret rather than a hash: ${query.sql}`,
      );
      assert.notEqual(parameter, secret, 'the raw secret reached SQL');
    }
  }
});

test('the adapter never selects or inserts a column that could hold a secret', () => {
  const code = stripComments(ADAPTER_SOURCE);
  for (const forbidden of [/token_secret/i, /session_secret/i, /\bplaintext\b/i, /raw_token/i]) {
    assert.ok(!forbidden.test(code), `the adapter names ${String(forbidden)}`);
  }
  // The only session material in SQL is the hash.
  assert.match(code, /token_hash/);
});

test('the migration declares no column that could hold a credential', () => {
  const code = stripNoise(MIGRATION_UP);
  for (const forbidden of [
    'password',
    'password_hash',
    'secret',
    'private_key',
    'recovery_code',
    'token_secret',
    'otp',
  ]) {
    assert.ok(
      !new RegExp(`^\\s+${forbidden}\\s`, 'm').test(code),
      `the schema declares a "${forbidden}" column — K-02 exists so that nothing holds one`,
    );
  }
  assert.match(MIGRATION_UP, /CHECK \(token_hash ~ '\^\[0-9a-f\]\{64\}\$'\)/);
});

// ---------------------------------------------------------------------------
// Port conformance
// ---------------------------------------------------------------------------

test('bindings, evidence and sessions are each written once', async () => {
  const repository = new InMemoryAuthenticationRepository();
  const binding = {
    bindingId: 'bind_01HQZXPORT001',
    subjectId: 'sub_01HQZXPORT001',
    provider: 'passkey',
    providerReference: 'ref_01HQZXPORT001',
    createdAt: '2026-04-01T12:00:00Z',
    idempotencyKey: 'idem_01HQZXPORT001',
  };

  await repository.withTransaction((tx) => tx.insertBinding(binding));
  await assert.rejects(
    repository.withTransaction((tx) =>
      tx.insertBinding({ ...binding, idempotencyKey: 'idem_01HQZXPORT002' }),
    ),
    (error: unknown) => codeOf(error) === 'duplicate-binding',
  );
  await assert.rejects(
    repository.withTransaction((tx) =>
      tx.insertBinding({
        ...binding,
        bindingId: 'bind_01HQZXPORT002',
        providerReference: 'ref_01HQZXPORT002',
      }),
    ),
    (error: unknown) => codeOf(error) === 'idempotency-key-reuse',
  );
  assert.equal(repository.bindings().length, 1);
});

test('the port exposes no way to delete anything, and no general session update', () => {
  const repository = new InMemoryAuthenticationRepository();
  const operations = new Set<string>();

  return repository.withTransaction((tx) => {
    let proto: object | null = Object.getPrototypeOf(tx) as object | null;
    while (proto !== null && proto !== Object.prototype) {
      for (const key of Object.getOwnPropertyNames(proto)) operations.add(key);
      proto = Object.getPrototypeOf(proto) as object | null;
    }

    const forbidden = [...operations].filter((name) =>
      /delete|remove|purge|truncate|updateSession|setSession|extend|renew|bypass|impersonat/i.test(
        name,
      ),
    );
    assert.deepEqual(
      forbidden,
      [],
      'a general session update is how a session acquires a longer absolute expiry',
    );

    // Exactly two mutating operations on a session, both guarded.
    assert.ok(operations.has('rotateSession'));
    assert.ok(operations.has('revokeSession'));
    return Promise.resolve();
  });
});

test('a failed transaction writes nothing', async () => {
  const repository = new InMemoryAuthenticationRepository();
  await assert.rejects(
    repository.withTransaction(async (tx) => {
      await tx.insertBinding({
        bindingId: 'bind_01HQZXROLLBK1',
        subjectId: 'sub_01HQZXROLLBK1',
        provider: 'passkey',
        providerReference: 'ref_01HQZXROLLBK1',
        createdAt: '2026-04-01T12:00:00Z',
        idempotencyKey: 'idem_01HQZXROLLBK1',
      });
      throw new Error('something went wrong after the insert');
    }),
    /something went wrong/,
  );

  assert.equal(repository.bindings().length, 0);
  assert.equal(repository.transactionsRolledBack, 1);
  assert.equal(repository.transactionsCommitted, 0);
});

// ---------------------------------------------------------------------------
// Adapter queries
// ---------------------------------------------------------------------------

test('every read projects its timestamps as UTC text, never as a driver Date', async () => {
  const database = new RecordingDatabase({
    selects: [
      { match: /FROM kernel_authentication\.authentication_binding/i, rows: [bindingRow()] },
      { match: /FROM kernel_authentication\.authentication_evidence/i, rows: [evidenceRow()] },
      { match: /FROM kernel_authentication\.authentication_session/i, rows: [sessionRow()] },
    ],
  });

  await new PostgresAuthenticationRepository(database).withTransaction(async (tx) => {
    await tx.findBindingById('bind_01HQZXTESTROW');
    await tx.findEvidenceByAssertionId('passkey', 'asrt_01HQZXTESTROW');
    await tx.findSessionById('sess_01HQZXTESTROW');
    await tx.listBindingsForSubject('sub_01HQZXTESTROW');
  });

  const selects = database.statements().filter((sql) => sql.startsWith('SELECT'));
  assert.equal(selects.length, 4);

  for (const sql of selects) {
    for (const column of TIMESTAMP_COLUMNS) {
      if (!sql.includes(column)) continue;
      assert.match(
        sql,
        new RegExp(
          `to_char\\(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS\\.US"Z"'\\) AS ${column}`,
        ),
        `${column} must be projected as text`,
      );
      assert.ok(
        !new RegExp(`(SELECT|,)\\s*${column}\\s*(,|FROM)`).test(sql),
        `${column} is also selected raw`,
      );
    }
  }
});

test('no statement K-02 issues names another unit’s schema', async () => {
  const database = new RecordingDatabase({ selects: [{ match: /SELECT/i, rows: [] }] });

  await new PostgresAuthenticationRepository(database).withTransaction(async (tx) => {
    await tx.findBindingByReference('passkey', 'ref_01HQZXSCHEMA1');
    await tx.findEvidenceByIdempotencyKey('idem_01HQZXSCHEMA1');
    await tx.findSessionByTokenHash('a'.repeat(64));
    await tx.revokeSession({
      sessionId: 'sess_01HQZXSCHEMA1',
      revokedAt: '2026-04-01T12:00:00Z',
      reason: 'signed-out',
    });
  });

  assert.ok(database.statements().length > 0);
  for (const sql of database.statements()) {
    for (const schema of knownSchemas()) {
      if (schema === AUTH_SCHEMA) continue;
      assert.ok(!sql.includes(`${schema}.`), `a K-02 statement reaches ${schema}: ${sql}`);
    }
  }
});

test('the guarded updates carry their guard in the WHERE clause', async () => {
  // The decision has to be the database's. A read followed by an unguarded update would let two
  // callers both pass the read.
  const database = new RecordingDatabase();
  await new PostgresAuthenticationRepository(database).withTransaction(async (tx) => {
    await tx.rotateSession({
      sessionId: 'sess_01HQZXGUARD01',
      expectedTokenHash: 'b'.repeat(64),
      nextTokenHash: 'c'.repeat(64),
      nextIdleExpiresAt: '2026-04-01T13:00:00Z',
      nextRotationCount: 1,
    });
    await tx.revokeSession({
      sessionId: 'sess_01HQZXGUARD01',
      revokedAt: '2026-04-01T12:00:00Z',
      reason: 'signed-out',
    });
  });

  const updates = database.statements().filter((sql) => sql.startsWith('UPDATE'));
  assert.equal(updates.length, 2);

  const rotation = updates[0] as string;
  assert.match(rotation, /WHERE session_id = \$4 AND token_hash = \$5 AND revoked_at IS NULL;/);
  assert.ok(
    !/SET[^W]*absolute_expires_at/.test(rotation),
    'a rotation that moved the absolute expiry would mean a session with no hard stop',
  );
  assert.ok(!/SET[^W]*subject_id/.test(rotation), 'and it must not repoint the session');

  assert.match(updates[1] as string, /WHERE session_id = \$3 AND revoked_at IS NULL;/);
});

test('a unique violation becomes the refusal it actually is', async () => {
  for (const [constraint, expected] of [
    ['authentication_binding_reference_unique', 'duplicate-binding'],
    ['authentication_evidence_assertion_unique', 'assertion-replayed'],
    ['authentication_session_token_unique', 'insufficient-entropy'],
    ['authentication_session_idempotency_unique', 'idempotency-key-reuse'],
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
      new PostgresAuthenticationRepository(database).withTransaction((tx) =>
        tx.insertSession({
          sessionId: 'sess_01HQZXCONFL01',
          bindingId: 'bind_01HQZXCONFL01',
          subjectId: 'sub_01HQZXCONFL01',
          evidenceId: 'evid_01HQZXCONFL01',
          assurance: 'single-factor',
          factors: ['possession'],
          tokenHash: 'd'.repeat(64),
          issuedAt: '2026-04-01T12:00:00Z',
          absoluteExpiresAt: '2026-04-02T00:00:00Z',
          idleExpiresAt: '2026-04-01T12:30:00Z',
          rotationCount: 0,
          revokedAt: null,
          revocationReason: null,
          idempotencyKey: 'idem_01HQZXCONFL01',
        }),
      ),
      (error: unknown) => codeOf(error) === expected,
      `${constraint} must surface as ${expected}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

test('well-formed rows decode, sealed', () => {
  const binding = toBinding(bindingRow());
  const evidence = toEvidence(evidenceRow());
  const session = toSession(sessionRow());

  assert.equal(binding.bindingId, 'bind_01HQZXTESTROW');
  assert.equal(evidence.assurance, 'single-factor');
  assert.equal(session.createdAt as unknown, undefined);
  assert.equal(session.issuedAt, '2026-04-01T12:00:00Z');
  assert.ok(Object.isFrozen(session) && Object.isFrozen(session.factors));
  assert.ok(Object.isFrozen(evidence.factors));
});

test('a malformed persisted row is refused rather than authenticated on', () => {
  // A session decoded from a row is about to be treated as proof of who somebody is.
  const malformed: ReadonlyArray<readonly [string, Record<string, unknown>, RegExp]> = [
    ['a token hash that is not a SHA-256', { token_hash: 'not-a-hash' }, /not a SHA-256/],
    ['a raw secret in the hash column', { token_hash: 'A'.repeat(43) }, /not a SHA-256/],
    ['an unknown assurance level', { assurance: 'very-sure' }, /expected one of/],
    ['an unknown factor category', { factors: ['telepathy'] }, /expected knowledge/],
    ['no factors at all', { factors: [] }, /non-empty array/],
    ['a duplicated factor', { factors: ['possession', 'possession'] }, /twice/],
    ['factors that are not an array', { factors: 'possession' }, /rather than an array/],
    [
      'an expiry before its issue',
      { absolute_expires_at: '2026-04-01T11:00:00.000000Z' },
      /not after issuedAt/,
    ],
    [
      'an idle window past the absolute stop',
      { idle_expires_at: '2026-04-03T00:00:00.000000Z' },
      /absolute expiry is the hard stop/,
    ],
    ['a negative rotation count', { rotation_count: -1 }, /whole number of rotations/],
    [
      'half a revocation',
      { revoked_at: '2026-04-01T12:05:00.000000Z', revocation_reason: null },
      /half a record/,
    ],
    [
      'an unknown revocation reason',
      { revoked_at: '2026-04-01T12:05:00.000000Z', revocation_reason: 'felt-like-it' },
      /expected one of/,
    ],
    ['a Date instead of text', { issued_at: new Date() }, /rather than text/],
    ['a millisecond timestamp', { issued_at: '2026-04-01T12:00:00.000Z' }, /projected form/],
  ];

  for (const [why, columns, message] of malformed) {
    assert.throws(
      () => toSession(sessionRow(columns)),
      (error: unknown) => {
        assert.ok(
          ['malformed-record', 'malformed-instant'].includes(String(codeOf(error))),
          `${why} got ${String(codeOf(error))}`,
        );
        assert.match((error as AuthenticationError).message, message, why);
        assert.match(
          (error as AuthenticationError).message,
          /not written by this component/i,
          `${why}: the refusal must send the reader to the database`,
        );
        return true;
      },
      `${why} must be refused`,
    );
  }
});

test('a stored identifier that creation would refuse is refused on decode', () => {
  for (const [column, value] of [
    ['binding_id', 'alice@example.com'],
    ['subject_id', 'alice.smith'],
    ['provider_reference', 'api_key_for_alice'],
  ] as const) {
    assert.throws(
      () => toBinding(bindingRow({ [column]: value })),
      (error: unknown) =>
        ['natural-identifier', 'secret-bearing-input', 'malformed-identifier'].includes(
          String(codeOf(error)),
        ),
      `${column} = ${value} must not decode`,
    );
  }
});

test('the adapter refuses a bad row on the read paths that matter', async () => {
  const database = new RecordingDatabase({
    selects: [{ match: /SELECT/i, rows: [sessionRow({ token_hash: 'nope' })] }],
  });
  const repository = new PostgresAuthenticationRepository(database);

  await assert.rejects(
    repository.withTransaction((tx) => tx.findSessionByTokenHash('a'.repeat(64))),
    (error: unknown) => codeOf(error) === 'malformed-record',
  );
  await assert.rejects(
    repository.withTransaction((tx) => tx.findSessionById('sess_01HQZXTESTROW')),
    (error: unknown) => codeOf(error) === 'malformed-record',
  );
});

// ---------------------------------------------------------------------------
// Module contract
// ---------------------------------------------------------------------------

test('K-02 owns exactly one schema, derived from the manifest', () => {
  const component = KERNEL_COMPONENTS.find((entry) => entry.id === 'K-02');
  assert.ok(component !== undefined);
  assert.equal(component.dir, 'authentication');
  assert.equal(AUTH_SCHEMA, `${KERNEL_SCHEMA_PREFIX}${component.dir}`);
  assert.ok(knownSchemas().includes(AUTH_SCHEMA));
  assert.equal(BINDING_TABLE, `${AUTH_SCHEMA}.authentication_binding`);
  assert.equal(EVIDENCE_TABLE, `${AUTH_SCHEMA}.authentication_evidence`);
  assert.equal(SESSION_TABLE, `${AUTH_SCHEMA}.authentication_session`);
});

test('neither the adapter nor the migration names another unit’s schema', () => {
  const migrationCode = stripNoise(MIGRATION_UP);
  const rollbackCode = stripNoise(MIGRATION_DOWN);
  const adapterCode = stripComments(ADAPTER_SOURCE);

  for (const schema of knownSchemas()) {
    if (schema === AUTH_SCHEMA) continue;
    assert.ok(!adapterCode.includes(`${schema}.`), `the adapter touches ${schema}`);
    assert.ok(!migrationCode.includes(`${schema}.`), `the forward migration touches ${schema}`);
    assert.ok(!rollbackCode.includes(`${schema}.`), `the rollback touches ${schema}`);
  }
  assert.ok(
    !/REFERENCES/i.test(migrationCode),
    'no foreign key: a cross-schema one would make K-01 unable to roll back without K-02',
  );
  assert.match(MIGRATION_UP, /^-- owner: kernel_authentication$/m);
});

test('the K-01 dependency is a port, not a table read', () => {
  assert.ok(
    !stripComments(ADAPTER_SOURCE).includes('identity'),
    'the adapter must know nothing about K-01',
  );
  assert.match(SERVICE_SOURCE, /SubjectLookup/);
  assert.match(SERVICE_SOURCE, /this\.#subjects\.exists\(/);
});

test('no source file in this component can delete a record', () => {
  for (const [name, source] of [
    ['postgres-repository.ts', ADAPTER_SOURCE],
    ['repository.ts', PORT_SOURCE],
    ['service.ts', SERVICE_SOURCE],
  ] as const) {
    const code = stripComments(source)
      .replace(/'[^']*'/g, "''")
      .replace(/`[^`]*`/g, '``');
    for (const forbidden of [/\bDELETE\s+FROM\b/i, /\bTRUNCATE\b/i, /\bDROP\s+TABLE\b/i]) {
      assert.ok(!forbidden.test(code), `${name} contains ${String(forbidden)}`);
    }
  }
});

test('the migration enforces the session contract in the database, not only in the service', () => {
  assert.match(MIGRATION_UP, /CONSTRAINT authentication_session_token_unique UNIQUE \(token_hash\)/);
  assert.match(
    MIGRATION_UP,
    /CONSTRAINT authentication_evidence_assertion_unique UNIQUE \(provider, assertion_id\)/,
    'replay protection has to be a constraint: two replays can both pass a read',
  );
  assert.match(
    MIGRATION_UP,
    /CONSTRAINT authentication_binding_reference_unique UNIQUE \(provider, provider_reference\)/,
  );
  assert.match(
    MIGRATION_UP,
    /CHECK \(absolute_expires_at > issued_at AND idle_expires_at <= absolute_expires_at\)/,
  );
  assert.match(MIGRATION_UP, /CHECK \(\(revoked_at IS NULL\) = \(revocation_reason IS NULL\)\)/);
  assert.match(MIGRATION_UP, /factors <@ ARRAY\['knowledge', 'possession', 'inherence'\]/);
});

test('the database permits only rotation and revocation on a session', () => {
  // The trigger is what stops a hand-written UPDATE lengthening a session or repointing it.
  assert.match(MIGRATION_UP, /CREATE OR REPLACE FUNCTION kernel_authentication\.refuse_session_rewrite/);
  for (const immutable of [
    'session_id',
    'binding_id',
    'subject_id',
    'evidence_id',
    'assurance',
    'factors',
    'issued_at',
    'absolute_expires_at',
    'idempotency_key',
  ]) {
    assert.match(
      MIGRATION_UP,
      new RegExp(`NEW\\.${immutable} IS DISTINCT FROM OLD\\.${immutable}`),
      `${immutable} must be immutable under the session trigger`,
    );
  }
  assert.match(MIGRATION_UP, /a revoked session cannot be rotated back into use/);
  assert.match(MIGRATION_UP, /a revocation is final/);
  assert.match(MIGRATION_UP, /rotation_count may not go backwards/);
  assert.match(MIGRATION_UP, /sessions are never deleted/);

  // Bindings and evidence get the stricter trigger.
  assert.match(MIGRATION_UP, /CREATE TRIGGER authentication_binding_is_write_once/);
  assert.match(MIGRATION_UP, /CREATE TRIGGER authentication_evidence_is_write_once/);
});

test('K-02’s opacity rules are character-for-character K-01’s and K-03’s', () => {
  const body = (sql: string): string => {
    const found = /AS \$rules\$([\s\S]*?)\$rules\$/.exec(sql);
    assert.ok(found !== null, 'is_opaque_identifier was not found');
    return String(found[1]);
  };

  const identity = readFileSync(
    path.join(MIGRATIONS, '0006_create_kernel_identity_schema.up.sql'),
    'utf8',
  );
  const accounts = readFileSync(
    path.join(MIGRATIONS, '0007_create_kernel_accounts_schema.up.sql'),
    'utf8',
  );

  assert.equal(body(MIGRATION_UP), body(identity));
  assert.equal(body(MIGRATION_UP), body(accounts));
});

test('the rollback reverses exactly what the forward migration created', () => {
  const created = [...MIGRATION_UP.matchAll(/CREATE TABLE IF NOT EXISTS ([\w.]+)/g)].map((m) =>
    String(m[1]),
  );
  const dropped = [...MIGRATION_DOWN.matchAll(/DROP TABLE IF EXISTS ([\w.]+)/g)].map((m) =>
    String(m[1]),
  );
  assert.deepEqual([...created].sort(), [...dropped].sort());

  for (const match of MIGRATION_UP.matchAll(/CREATE INDEX IF NOT EXISTS (\w+)/g)) {
    assert.ok(MIGRATION_DOWN.includes(String(match[1])), `${String(match[1])} is never dropped`);
  }
  assert.ok(
    MIGRATION_DOWN.indexOf('DROP TRIGGER') < MIGRATION_DOWN.indexOf('DROP TABLE'),
    'triggers reference their functions and tables',
  );
  assert.ok(
    MIGRATION_DOWN.indexOf('DROP TABLE') <
      MIGRATION_DOWN.indexOf('DROP FUNCTION IF EXISTS kernel_authentication.is_opaque_identifier'),
    'the CHECK constraints reference the rule function, so the tables must go first',
  );
  assert.match(MIGRATION_DOWN, /DROP SCHEMA IF EXISTS kernel_authentication RESTRICT/);
});

test('CONTRACT.md records the refusals the code raises and the integrations it lacks', () => {
  for (const code of [
    'unknown-subject',
    'unknown-provider',
    'unknown-binding',
    'duplicate-binding',
    'caller-asserted-authentication',
    'invalid-assertion',
    'assertion-replayed',
    'assertion-expired',
    'insufficient-factors',
    'invalid-token',
    'session-expired',
    'session-revoked',
    'stale-session-state',
    'insufficient-entropy',
    'idempotency-key-reuse',
    'nested-transaction',
    'malformed-record',
  ]) {
    assert.ok(CONTRACT.includes(`\`${code}\``), `CONTRACT.md does not document ${code}`);
  }

  for (const deferred of ['K-01', 'K-03', 'K-04', 'K-08', 'K-09']) {
    assert.ok(CONTRACT.includes(deferred), `CONTRACT.md does not name ${deferred}`);
  }
  assert.match(CONTRACT, /no verifier/i, 'the absence of any provider must be stated');
  assert.match(CONTRACT, /threat/i, 'the threat assumptions must be recorded');
  assert.match(CONTRACT, /once/i, 'the one-time presentation of the secret must be recorded');
});
