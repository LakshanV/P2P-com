/**
 * K-01 Identity — port conformance, adapter queries, and the module contract (FND-004a).
 *
 * Four kinds of assertion, covering four different risks:
 *
 *   - **Port conformance.** The in-memory repository is the reference implementation, so every
 *     guarantee proved against it is worth exactly what its guards are worth. It is driven through
 *     the same tests the contract states.
 *   - **No mutation capability.** The strongest claim this component makes. Asserted by inspecting
 *     the transaction object at runtime, because a rule enforced only by a type is a rule a cast
 *     undoes.
 *   - **Adapter queries.** Statement shape is behaviour and cannot be read off the source — the
 *     projection is interpolated, so `SELECT ${PROJECTION}` in a file proves nothing. The real
 *     adapter runs against a recording fake and what it *sends* is inspected.
 *   - **Module contract.** Ownership, schema, migration and write-once trigger, asserted
 *     mechanically so CONTRACT.md cannot drift away from the code.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { KERNEL_COMPONENTS } from '../platform/architecture/manifest.ts';
import { KERNEL_SCHEMA_PREFIX, knownSchemas } from '../platform/db/schema-namespaces.ts';
import {
  IDENTITY_SCHEMA,
  IDENTITY_TABLE,
  IdentityError,
  InMemoryIdentityRepository,
  PostgresIdentityRepository,
  TIMESTAMP_COLUMNS,
  toSubject,
} from '../kernel/identity/index.ts';
import type { IdentityRepository, IdentitySubject } from '../kernel/identity/index.ts';

import { row, subject } from './helpers/identity-fixtures.ts';
import { RecordingDatabase, sqlstateError } from './helpers/recording-database.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE_DIR = path.join(HERE, '..', 'kernel', 'identity');
const ADAPTER_SOURCE = readFileSync(path.join(MODULE_DIR, 'postgres-repository.ts'), 'utf8');
const PORT_SOURCE = readFileSync(path.join(MODULE_DIR, 'repository.ts'), 'utf8');
const SERVICE_SOURCE = readFileSync(path.join(MODULE_DIR, 'service.ts'), 'utf8');
const CONTRACT = readFileSync(path.join(MODULE_DIR, 'CONTRACT.md'), 'utf8');
const MIGRATION_UP = readFileSync(
  path.join(HERE, '..', 'db', 'migrations', '0006_create_kernel_identity_schema.up.sql'),
  'utf8',
);
const MIGRATION_DOWN = readFileSync(
  path.join(HERE, '..', 'db', 'migrations', '0006_create_kernel_identity_schema.down.sql'),
  'utf8',
);

const codeOf = (error: unknown): string | undefined =>
  error instanceof IdentityError ? error.code : undefined;

const decode = (columns: Record<string, unknown>): IdentitySubject =>
  toSubject(columns as unknown as Parameters<typeof toSubject>[0]);

// ---------------------------------------------------------------------------
// Port conformance
// ---------------------------------------------------------------------------

test('a subject is created once and never rewritten', async () => {
  const repository = new InMemoryIdentityRepository();
  const first = subject({ subjectId: 'sub_01HQZXPORT01', idempotencyKey: 'idem_01HQZXPORT01' });
  await repository.withTransaction((tx) => tx.insertSubject(first));

  await assert.rejects(
    repository.withTransaction((tx) =>
      tx.insertSubject({ ...first, idempotencyKey: 'idem_01HQZXPORT02' }),
    ),
    (error: unknown) => codeOf(error) === 'duplicate-subject-id',
  );
  await assert.rejects(
    repository.withTransaction((tx) =>
      tx.insertSubject({ ...first, subjectId: 'sub_01HQZXPORT02' }),
    ),
    (error: unknown) => codeOf(error) === 'idempotency-key-reuse',
  );

  assert.equal(repository.subjects().length, 1);
});

test('the port exposes no way to change, remove or merge a subject', () => {
  const repository = new InMemoryIdentityRepository();
  const operations = new Set<string>();

  // Inspected at runtime from inside the transaction, because a type cannot stop a cast and this
  // is the component's central claim.
  return repository.withTransaction((tx) => {
    let proto: object | null = Object.getPrototypeOf(tx) as object | null;
    while (proto !== null && proto !== Object.prototype) {
      for (const key of Object.getOwnPropertyNames(proto)) operations.add(key);
      proto = Object.getPrototypeOf(proto) as object | null;
    }

    const mutators = [...operations].filter((operation) =>
      /update|delete|remove|merge|amend|deactivate|purge|expire|truncate|set[A-Z]/i.test(operation),
    );
    assert.deepEqual(
      mutators,
      [],
      'everything downstream references these ids; one that can change reattributes history',
    );
    assert.ok(operations.has('insertSubject'));
    assert.ok(operations.has('findSubjectById'));
    return Promise.resolve();
  });
});

test('a failed transaction writes nothing', async () => {
  const repository = new InMemoryIdentityRepository();
  await assert.rejects(
    repository.withTransaction(async (tx) => {
      await tx.insertSubject(subject({ subjectId: 'sub_01HQZXROLLBK' }));
      throw new Error('something went wrong after the insert');
    }),
    /something went wrong/,
  );

  assert.equal(repository.subjects().length, 0, 'a caller that sees a failure assumes nothing ran');
  assert.equal(repository.transactionsRolledBack, 1);
  assert.equal(repository.transactionsCommitted, 0);
});

test('lookups inside a transaction see what that transaction wrote', async () => {
  const repository = new InMemoryIdentityRepository();
  const written = subject({ subjectId: 'sub_01HQZXINTX', idempotencyKey: 'idem_01HQZXINTX' });

  const found = await repository.withTransaction(async (tx) => {
    await tx.insertSubject(written);
    return {
      byId: await tx.findSubjectById('sub_01HQZXINTX'),
      byKey: await tx.findSubjectByIdempotencyKey('idem_01HQZXINTX'),
      missing: await tx.findSubjectById('sub_01HQZXNOSUCH'),
    };
  });

  assert.equal(found.byId?.subjectId, 'sub_01HQZXINTX');
  assert.equal(found.byKey?.subjectId, 'sub_01HQZXINTX');
  assert.equal(found.missing, null);
});

// ---------------------------------------------------------------------------
// Adapter queries — asserted on the SQL as issued, not as written
// ---------------------------------------------------------------------------

const drive = async (
  database: RecordingDatabase,
  body: (repository: IdentityRepository) => Promise<unknown>,
): Promise<void> => {
  await body(new PostgresIdentityRepository(database));
};

test('every read projects created_at as UTC text, never as a driver Date', async () => {
  const database = new RecordingDatabase({ selects: [{ match: /SELECT/i, rows: [row()] }] });
  await drive(database, (repository) =>
    repository.withTransaction(async (tx) => {
      await tx.findSubjectById('sub_01HQZXTESTROW');
      await tx.findSubjectByIdempotencyKey('idem_01HQZXTESTROW');
    }),
  );

  const selects = database.statements().filter((sql) => sql.startsWith('SELECT'));
  assert.equal(selects.length, 2, 'both read paths were exercised');

  for (const sql of selects) {
    for (const column of TIMESTAMP_COLUMNS) {
      assert.match(
        sql,
        new RegExp(
          `to_char\\(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS\\.US"Z"'\\) AS ${column}`,
        ),
        `${column} must be projected as text: a Date holds milliseconds where the column holds ` +
          'microseconds',
      );
      assert.ok(
        !new RegExp(`(SELECT|,)\\s*${column}\\s*(,|FROM)`).test(sql),
        `${column} is also selected raw, which would hand the driver something to parse`,
      );
    }
  }
});

test('reads are parameterised and never interpolate the caller’s value', async () => {
  const database = new RecordingDatabase({ selects: [{ match: /SELECT/i, rows: [] }] });
  await drive(database, (repository) =>
    repository.withTransaction((tx) => tx.findSubjectById("sub_01' OR 1=1--")),
  );

  const select = database.queries.find((query) => query.sql.startsWith('SELECT'));
  assert.ok(select !== undefined);
  assert.match(select.sql, /WHERE subject_id = \$1;/);
  assert.deepEqual(select.params, ["sub_01' OR 1=1--"]);
});

test('a create is one INSERT with six bound parameters, inside BEGIN/COMMIT', async () => {
  const database = new RecordingDatabase();
  const written = subject({ subjectId: 'sub_01HQZXINSERT', idempotencyKey: 'idem_01HQZXINSERT' });
  await drive(database, (repository) =>
    repository.withTransaction((tx) => tx.insertSubject(written)),
  );

  const statements = database.statements();
  assert.equal(statements[0], 'BEGIN;');
  assert.equal(statements[statements.length - 1], 'COMMIT;');

  const insert = database.queries.find((query) => /INSERT INTO/i.test(query.sql));
  assert.ok(insert !== undefined);
  assert.match(insert.sql, new RegExp(`INSERT INTO ${IDENTITY_TABLE.replace('.', '\\.')}`));
  assert.deepEqual(insert.params, [
    'sub_01HQZXINSERT',
    'person',
    written.createdAt,
    'system',
    'K-03-account-service',
    'idem_01HQZXINSERT',
  ]);
  assert.equal(database.sessionsReleased, 1, 'the connection is released whatever happens');
});

test('a failure rolls back and still releases the connection', async () => {
  const database = new RecordingDatabase({ failOn: /INSERT INTO/i });
  await assert.rejects(
    new PostgresIdentityRepository(database).withTransaction((tx) =>
      tx.insertSubject(subject({ subjectId: 'sub_01HQZXFAILED' })),
    ),
  );

  assert.ok(database.indexOf(/^ROLLBACK;$/) > -1, 'the transaction was rolled back');
  assert.equal(database.indexOf(/^COMMIT;$/), -1, 'and never committed');
  assert.equal(database.sessionsReleased, 1);
});

test('a unique violation becomes the refusal it actually is', async () => {
  for (const [constraint, expected] of [
    ['identity_subject_pkey', 'duplicate-subject-id'],
    ['identity_subject_idempotency_unique', 'idempotency-key-reuse'],
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
      new PostgresIdentityRepository(database).withTransaction((tx) =>
        tx.insertSubject(subject({ subjectId: 'sub_01HQZXCONFLICT' })),
      ),
      (error: unknown) => codeOf(error) === expected,
      `${constraint} must surface as ${expected}, not as a raw driver error`,
    );
  }
});

test('an error the adapter does not understand is passed through unchanged', async () => {
  // Translating an unrecognised failure into a refusal would claim to know why something failed.
  const database = new RecordingDatabase({
    failures: [{ match: /INSERT INTO/i, error: sqlstateError('connection terminated', '08006') }],
  });

  await assert.rejects(
    new PostgresIdentityRepository(database).withTransaction((tx) =>
      tx.insertSubject(subject({ subjectId: 'sub_01HQZXCONNGONE' })),
    ),
    /connection terminated/,
  );
});

// ---------------------------------------------------------------------------
// Decoding — fail-closed
// ---------------------------------------------------------------------------

test('a well-formed row decodes, and comes back sealed', () => {
  const decoded = decode(row());

  assert.equal(decoded.subjectId, 'sub_01HQZXTESTROW');
  assert.equal(decoded.kind, 'person');
  assert.equal(
    decoded.createdAt,
    '2026-04-01T12:00:00Z',
    'trailing zeros are not part of the value',
  );
  assert.deepEqual({ ...decoded.origin }, { kind: 'system', id: 'K-03-account-service' });
  assert.ok(Object.isFrozen(decoded) && Object.isFrozen(decoded.origin));
});

test('a malformed persisted row is refused rather than approximated', () => {
  const malformed: ReadonlyArray<readonly [string, Record<string, unknown>, RegExp]> = [
    [
      'a Date instead of text',
      { created_at: new Date('2026-04-01T12:00:00Z') },
      /rather than text/,
    ],
    ['a millisecond timestamp', { created_at: '2026-04-01T12:00:00.000Z' }, /projected form/],
    ['a local timestamp', { created_at: '2026-04-01 12:00:00+05:30' }, /projected form/],
    ['an impossible date', { created_at: '2026-02-30T00:00:00.000000Z' }, /created_at/],
    ['a null kind', { kind: null }, /expected non-empty text/],
    ['an unknown origin kind', { origin_kind: 'daemon' }, /origin.kind is "daemon"/],
    ['an empty subject id', { subject_id: '' }, /expected non-empty text/],
    ['a missing idempotency key', { idempotency_key: null }, /expected non-empty text/],
    ['an empty origin id', { origin_id: '' }, /expected non-empty text/],
  ];

  for (const [why, columns, message] of malformed) {
    assert.throws(
      () => decode(row(columns)),
      (error: unknown) => {
        assert.equal(codeOf(error), 'malformed-record', why);
        assert.match((error as IdentityError).message, message, why);
        return true;
      },
      `${why} must be refused: a wrong identity is treated as a real party`,
    );
  }
});

test('a stored row claiming an AI origin is refused on read', () => {
  // The service refuses it and so does the CHECK, so such a row was written by something that
  // reached the table another way. Refusing on read means a doctored row cannot become a real
  // party merely by being selected.
  assert.throws(
    () => decode(row({ origin_kind: 'ai' })),
    (error: unknown) => {
      assert.equal(codeOf(error), 'ai-not-permitted');
      assert.match((error as IdentityError).message, /not written by this component/i);
      return true;
    },
  );
});

test('the adapter refuses a malformed row on every read path', async () => {
  const database = new RecordingDatabase({
    selects: [{ match: /SELECT/i, rows: [row({ origin_kind: 'daemon' })] }],
  });
  const repository = new PostgresIdentityRepository(database);

  for (const [name, read] of [
    [
      'findSubjectById',
      (tx: Parameters<Parameters<typeof repository.withTransaction>[0]>[0]) =>
        tx.findSubjectById('sub_01HQZXTESTROW'),
    ],
    [
      'findSubjectByIdempotencyKey',
      (tx: Parameters<Parameters<typeof repository.withTransaction>[0]>[0]) =>
        tx.findSubjectByIdempotencyKey('idem_01HQZXTESTROW'),
    ],
  ] as const) {
    await assert.rejects(
      repository.withTransaction(read),
      (error: unknown) => codeOf(error) === 'malformed-record',
      `${name} returned a row it could not decode`,
    );
  }
});

// ---------------------------------------------------------------------------
// Module contract
// ---------------------------------------------------------------------------

test('K-01 owns exactly one schema, derived from the manifest', () => {
  const component = KERNEL_COMPONENTS.find((entry) => entry.id === 'K-01');
  assert.ok(component !== undefined, 'K-01 is registered in the architecture manifest');
  assert.equal(component.dir, 'identity');
  assert.equal(IDENTITY_SCHEMA, `${KERNEL_SCHEMA_PREFIX}${component.dir}`);
  assert.ok(knownSchemas().includes(IDENTITY_SCHEMA), 'the schema is one the platform knows about');
  assert.equal(IDENTITY_TABLE, `${IDENTITY_SCHEMA}.identity_subject`);
});

test('the adapter and the migration name their own schema and no other', () => {
  for (const schema of knownSchemas()) {
    if (schema === IDENTITY_SCHEMA) continue;
    assert.ok(!ADAPTER_SOURCE.includes(`${schema}.`), `the adapter touches ${schema}`);
    assert.ok(!MIGRATION_UP.includes(`${schema}.`), `the forward migration touches ${schema}`);
    assert.ok(!MIGRATION_DOWN.includes(`${schema}.`), `the rollback touches ${schema}`);
  }
  assert.match(MIGRATION_UP, /^-- owner: kernel_identity$/m);
  assert.match(MIGRATION_DOWN, /^-- owner: kernel_identity$/m);
});

test('no source file in this component can change or remove a subject', () => {
  for (const [name, source] of [
    ['postgres-repository.ts', ADAPTER_SOURCE],
    ['repository.ts', PORT_SOURCE],
    ['service.ts', SERVICE_SOURCE],
  ] as const) {
    // Comments say "no UPDATE, no DELETE", so the scan is over code with comments stripped.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|\s)\/\/[^\n]*/g, ' ')
      .replace(/'[^']*'/g, "''")
      .replace(/`[^`]*`/g, '``');

    for (const forbidden of [/\bUPDATE\s+kernel_/i, /\bDELETE\s+FROM\b/i, /\bTRUNCATE\b/i]) {
      assert.ok(
        !forbidden.test(code),
        `${name} contains ${String(forbidden)} — an identity is written once`,
      );
    }
  }
});

test('the migration enforces the identity contract in the database, not only in the service', () => {
  assert.match(MIGRATION_UP, /CONSTRAINT identity_subject_pkey PRIMARY KEY \(subject_id\)/);
  assert.match(
    MIGRATION_UP,
    /CONSTRAINT identity_subject_idempotency_unique UNIQUE \(idempotency_key\)/,
  );
  assert.match(MIGRATION_UP, /CHECK \(kind IN \('person', 'organisation', 'system'\)\)/);
  assert.match(MIGRATION_UP, /CHECK \(origin_kind <> 'ai'\)/);

  // Every identifier column is held to the one rule set, not to a per-column subset. The first
  // revision checked subject_id for an `@` and a 12-digit run and checked origin_id for neither,
  // so an origin id could be an email address the service would have refused.
  for (const column of ['subject_id', 'origin_id', 'idempotency_key']) {
    assert.match(
      MIGRATION_UP,
      new RegExp(`CHECK \\(kernel_identity\\.is_opaque_identifier\\(${column}\\)\\)`),
      `${column} does not go through is_opaque_identifier`,
    );
  }
  assert.match(MIGRATION_UP, /identity_subject_id_opaque/);
  assert.match(MIGRATION_UP, /identity_subject_origin_id_opaque/);
  assert.match(MIGRATION_UP, /identity_subject_idempotency_key_opaque/);
  assert.match(
    MIGRATION_UP,
    /CHECK \(created_at > '-infinity'::timestamptz AND created_at < 'infinity'::timestamptz\)/,
  );

  // No column that would imply a lifecycle this component does not have.
  for (const forbidden of ['status', 'deleted_at', 'merged_into', 'email', 'display_name']) {
    assert.ok(
      !new RegExp(`^\\s+${forbidden}\\s`, 'm').test(MIGRATION_UP),
      `the table declares a "${forbidden}" column, which implies a lifecycle K-01 does not have`,
    );
  }
});

test('the migration refuses mutation at the database as well', () => {
  assert.match(MIGRATION_UP, /CREATE OR REPLACE FUNCTION kernel_identity\.refuse_mutation/);
  assert.match(MIGRATION_UP, /RAISE EXCEPTION/);
  assert.match(
    MIGRATION_UP,
    /CREATE TRIGGER identity_subject_is_write_once\s+BEFORE UPDATE OR DELETE ON kernel_identity\.identity_subject/,
  );
  assert.match(MIGRATION_DOWN, /DROP TRIGGER IF EXISTS identity_subject_is_write_once/);
  assert.match(MIGRATION_DOWN, /DROP FUNCTION IF EXISTS kernel_identity\.refuse_mutation/);
});

// The agreement between the SQL rule set and the service is proved in
// tests/identity-persisted.test.ts, which extracts the clauses of is_opaque_identifier from the
// migration and runs the service's own accepted and rejected identifiers through them.

test('the rollback reverses exactly what the forward migration created', () => {
  const created = [...MIGRATION_UP.matchAll(/CREATE TABLE IF NOT EXISTS ([\w.]+)/g)].map((match) =>
    String(match[1]),
  );
  const dropped = [...MIGRATION_DOWN.matchAll(/DROP TABLE IF EXISTS ([\w.]+)/g)].map((match) =>
    String(match[1]),
  );
  assert.deepEqual([...created].sort(), [...dropped].sort());

  for (const match of MIGRATION_UP.matchAll(/CREATE INDEX IF NOT EXISTS (\w+)/g)) {
    assert.ok(
      MIGRATION_DOWN.includes(String(match[1])),
      `${String(match[1])} is created but never dropped`,
    );
  }

  // The trigger references the function, so it must be dropped first.
  assert.ok(
    MIGRATION_DOWN.indexOf('DROP TRIGGER') < MIGRATION_DOWN.indexOf('DROP FUNCTION'),
    'a function cannot be dropped while a trigger still references it',
  );
  assert.match(MIGRATION_DOWN, /DROP SCHEMA IF EXISTS kernel_identity RESTRICT/);
});

test('CONTRACT.md records the refusals the code actually raises', () => {
  for (const code of [
    'unknown-subject-kind',
    'malformed-identifier',
    'natural-identifier',
    'secret-bearing-input',
    'malformed-instant',
    'ai-not-permitted',
    'foreign-concern',
    'duplicate-subject-id',
    'idempotency-key-reuse',
    'no-such-subject',
    'nested-transaction',
    'malformed-record',
  ]) {
    assert.ok(CONTRACT.includes(`\`${code}\``), `CONTRACT.md does not document ${code}`);
  }

  // And the deferred integrations, so a reader cannot mistake a foundation for a component.
  for (const deferred of ['K-02', 'K-03', 'K-04', 'K-09']) {
    assert.ok(
      CONTRACT.includes(deferred),
      `CONTRACT.md does not name the deferred ${deferred} work`,
    );
  }
  assert.match(CONTRACT.split('## 7.')[1] ?? '', /No unit creates an identity subject/i);
});
