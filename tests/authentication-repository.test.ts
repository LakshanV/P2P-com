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
import { existsSync, readFileSync } from 'node:fs';
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

import { bindingRow, evidenceRow, sessionRow } from './helpers/authentication-fixtures.ts';
import { RecordingDatabase, sqlstateError } from './helpers/recording-database.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE_DIR = path.join(HERE, '..', 'kernel', 'authentication');
const ADAPTER_SOURCE = readFileSync(path.join(MODULE_DIR, 'postgres-repository.ts'), 'utf8');
const PORT_SOURCE = readFileSync(path.join(MODULE_DIR, 'repository.ts'), 'utf8');
const SERVICE_SOURCE = readFileSync(path.join(MODULE_DIR, 'service.ts'), 'utf8');
const CONTRACT = readFileSync(path.join(MODULE_DIR, 'CONTRACT.md'), 'utf8');
const TYPES_SOURCE = readFileSync(path.join(MODULE_DIR, 'types.ts'), 'utf8');
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

/**
 * A decoded record as a bag of properties, for asserting about the ones its type does not declare.
 *
 * Half of what a decoder must get right is what it *does not* produce, and a typed value cannot be
 * asked about a property the type has never heard of. Reading through this view keeps those probes
 * runtime probes rather than compile-time tautologies.
 */
const asRecord = (value: object): Record<string, unknown> =>
  value as unknown as Record<string, unknown>;

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
  // A runtime probe for a property the type does not declare, so it is read through a record view
  // rather than off the typed value: a decoder that copied the row wholesale would carry
  // `created_at` across as `createdAt`, and the type would never have mentioned it.
  assert.equal(asRecord(session).createdAt, undefined);
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
  assert.match(
    MIGRATION_UP,
    /CONSTRAINT authentication_session_token_unique UNIQUE \(token_hash\)/,
  );
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
  assert.match(
    MIGRATION_UP,
    /CREATE OR REPLACE FUNCTION kernel_authentication\.refuse_session_rewrite/,
  );
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

/** Every member of the `AuthenticationErrorCode` union, read out of the source that declares it. */
function declaredErrorCodes(): readonly string[] {
  const start = TYPES_SOURCE.indexOf('export type AuthenticationErrorCode =');
  assert.ok(start !== -1, 'the error-code union moved; this extraction needs updating');
  const block = TYPES_SOURCE.slice(start, TYPES_SOURCE.indexOf(';', start));
  const codes = [...block.matchAll(/\|\s*'([a-z-]+)'/g)].map((match) => match[1] as string);
  assert.ok(
    codes.length >= 20,
    `expected the union to yield every code, extracted ${codes.length} — the extraction is broken`,
  );
  return codes;
}

test('CONTRACT.md documents every refusal the union declares, not a chosen subset', () => {
  // The test above lists codes by hand, so a code added later is documented only if somebody
  // remembers to extend that list. This one derives the set from `types.ts`: a new refusal that
  // reaches callers without reaching the contract fails here, which is the direction that matters.
  const undocumented = declaredErrorCodes().filter((code) => !CONTRACT.includes(`\`${code}\``));
  assert.deepEqual(
    undocumented,
    [],
    `CONTRACT.md does not document ${undocumented.join(', ')} — a refusal a caller can receive ` +
      'and cannot look up is a refusal it will guess at',
  );
});

/**
 * A phrase, matched across the line breaks Markdown puts in it.
 *
 * A regex with a literal space in it passes until somebody reflows the paragraph, and then fails
 * for a reason that has nothing to do with what it was checking.
 */
function phrase(words: string): RegExp {
  const parts = words.trim().split(/\s+/);
  return new RegExp(parts.join(String.raw`\s+`), 'i');
}

test('CONTRACT.md records the security claims the code actually makes', () => {
  // Each is a property this component's value rests on, is enforced somewhere in the source, and
  // is not covered by the code-list assertion above. Matched on the claim rather than on wording,
  // so the contract can be rewritten without these becoming a prose lock.
  const claims: ReadonlyArray<readonly [string, RegExp]> = [
    [
      'the verifier decides and the caller never states the outcome',
      phrase('caller never states the outcome'),
    ],
    ['the stored representation is a SHA-256', /SHA-256/],
    ['the secret is presented once and never stored', phrase('never written, logged or echoed')],
    ['no secret is ever a SQL parameter', phrase('no secret is ever a SQL parameter')],
    ['rotation never extends the absolute expiry', phrase('absolute expiry is never extended')],
    ['a stale rotation or revocation loses rather than clobbering', /`stale-session-state`/],
    ['a retry receives a spent token', phrase('spent token')],
    ['exactly one usable token is issued', phrase('exactly one usable token')],
    ['convergence compares the assurance', phrase('Assurance, and the canonical factor set')],
    ['convergence compares the chronology', phrase('Chronology')],
    ['the MFA floor may be raised and never lowered', phrase('can only be raised')],
    ['the K-01 dependency is a port, not a foreign key', phrase('no foreign key')],
    ['enlisted writes may not control the transaction', /`nested-transaction`/],
    ['the identity lookup fails closed', phrase('fail-closed default')],
  ];

  for (const [claim, pattern] of claims) {
    assert.match(CONTRACT, pattern, `CONTRACT.md does not record that ${claim}`);
  }
});

test('CONTRACT.md names every deferred integration, and does not over-claim', () => {
  // The contract is the document a consumer reads before depending on this component. Under-stating
  // what is missing is the failure that matters here: a reader who believes a verifier ships will
  // wire a login to something that refuses everything.
  const deferred: ReadonlyArray<readonly [string, RegExp]> = [
    ['no verifier ships', phrase('no verifier ships')],
    ['no recovery flow', phrase('no recovery')],
    ['no registration', phrase('no registration')],
    ['no permissions, which K-04 owns', /\bK-04\b/],
    ['no audit trail, which K-09 owns', /\bK-09\b/],
    ['no events, which K-08 owns', /\bK-08\b/],
    ['no API and no UI', phrase('no API and no UI')],
    ['no rate limiting or lockout', phrase('no rate limiting')],
    [
      'nothing has run against a live PostgreSQL server',
      phrase('Nothing has run against a live PostgreSQL server'),
    ],
    ['the enlisted path has no caller', phrase('No unit uses it')],
  ];

  for (const [claim, pattern] of deferred) {
    assert.match(CONTRACT, pattern, `CONTRACT.md does not record that ${claim}`);
  }

  // Every mention of authenticating a real person must be a denial. Checked this way rather than
  // by banning the phrase, because the contract has to *say* it cannot, and a naive ban would fire
  // on the sentence that says so.
  // The window runs back to the previous full stop rather than to the previous line break, because
  // Markdown wraps mid-sentence and the negation is often on the line above.
  for (const mention of CONTRACT.matchAll(/[^.]{0,90}authenticate\s+a\s+real\s+person/gi)) {
    assert.match(
      mention[0],
      /\b(no|not|nothing|cannot|never)\b/i,
      `CONTRACT.md claims "${mention[0].trim()}" — no verifier ships, so nothing here can`,
    );
  }

  for (const overclaim of [
    /\bK-02\b[^.]{0,40}\bis complete\b/i,
    /\bfully implemented\b/i,
    /\bproduction[- ]ready\b/i,
  ]) {
    assert.ok(
      !overclaim.test(CONTRACT),
      `CONTRACT.md over-claims via ${String(overclaim)} — this is a foundation, not a component ` +
        'anybody can sign in through',
    );
  }
});

test('every file CONTRACT.md links to exists', () => {
  // docs/tools/validate-doc-links.mjs walks /docs and never sees this file, so a contract that
  // points at a migration or a suite that has been renamed would rot silently — and the links are
  // how a reader checks the document against the code.
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
});

test('the suites CONTRACT.md tells a reader to run are the suites that exist', () => {
  // §10 is the "check this yourself" section. A command naming a suite that has been renamed sends
  // a reader to an error message instead of to evidence.
  const suites = [...CONTRACT.matchAll(/node --test (tests\/[\w.-]+\.ts)/g)].map(
    (match) => match[1] as string,
  );
  assert.ok(
    suites.length >= 4,
    `expected the verification section to name the suites, found ${suites.length}`,
  );

  const repoRoot = path.join(MODULE_DIR, '..', '..');
  for (const suite of suites) {
    assert.ok(
      existsSync(path.join(repoRoot, suite)),
      `CONTRACT.md tells a reader to run ${suite}, which does not exist`,
    );
  }
  assert.ok(
    suites.includes('tests/authentication-repository.test.ts'),
    'including this one, which is what checks the contract itself',
  );
});
