/**
 * K-03 Accounts — port conformance, adapter queries, and the module contract (FND-004b).
 *
 * Four kinds of assertion, covering four different risks:
 *
 *   - **Port conformance.** The in-memory repository is the reference implementation, so every
 *     guarantee proved against it is worth exactly what its guards are worth.
 *   - **No mutation capability.** Orders and payments will name these account ids. Asserted by
 *     inspecting the transaction object at runtime, because a rule enforced only by a type is a
 *     rule a cast undoes.
 *   - **Adapter queries.** Statement shape is behaviour and cannot be read off the source — the
 *     projection is interpolated, so `SELECT ${PROJECTION}` in a file proves nothing. The real
 *     adapter runs against a recording fake and what it *sends* is inspected. That includes the
 *     claim this component makes loudest: **no SQL of K-03's reaches `kernel_identity`.**
 *   - **Module contract.** Ownership, schema, migration and write-once trigger, asserted
 *     mechanically so CONTRACT.md cannot drift away from the code.
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
  ACCOUNT_SCHEMA,
  ACCOUNT_TABLE,
  AccountError,
  InMemoryAccountRepository,
  PostgresAccountRepository,
  TIMESTAMP_COLUMNS,
  toAccount,
} from '../kernel/accounts/index.ts';
import type { AccountRepository, UniversalAccount } from '../kernel/accounts/index.ts';
import { IDENTITY_SCHEMA, IDENTITY_TABLE } from '../kernel/identity/index.ts';

import { account, row } from './helpers/account-fixtures.ts';
import { RecordingDatabase, sqlstateError } from './helpers/recording-database.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE_DIR = path.join(HERE, '..', 'kernel', 'accounts');
const ADAPTER_SOURCE = readFileSync(path.join(MODULE_DIR, 'postgres-repository.ts'), 'utf8');
const PORT_SOURCE = readFileSync(path.join(MODULE_DIR, 'repository.ts'), 'utf8');
const SERVICE_SOURCE = readFileSync(path.join(MODULE_DIR, 'service.ts'), 'utf8');
const CONTRACT = readFileSync(path.join(MODULE_DIR, 'CONTRACT.md'), 'utf8');
const MIGRATIONS = path.join(HERE, '..', 'db', 'migrations');
const MIGRATION_UP = readFileSync(
  path.join(MIGRATIONS, '0007_create_kernel_accounts_schema.up.sql'),
  'utf8',
);
const MIGRATION_DOWN = readFileSync(
  path.join(MIGRATIONS, '0007_create_kernel_accounts_schema.down.sql'),
  'utf8',
);
const IDENTITY_MIGRATION_UP = readFileSync(
  path.join(MIGRATIONS, '0006_create_kernel_identity_schema.up.sql'),
  'utf8',
);

const codeOf = (error: unknown): string | undefined =>
  error instanceof AccountError ? error.code : undefined;

/** Source with comments blanked, so a scan sees code and not prose. */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)\/\/[^\n]*/g, ' ');

const decode = (columns: Record<string, unknown>): UniversalAccount =>
  toAccount(columns as unknown as Parameters<typeof toAccount>[0]);

// ---------------------------------------------------------------------------
// Port conformance
// ---------------------------------------------------------------------------

test('an account is created once and never rewritten', async () => {
  const repository = new InMemoryAccountRepository();
  const first = account({ accountId: 'acct_01HQZXPORT01', subjectId: 'sub_01HQZXPORT01' });
  await repository.withTransaction((tx) => tx.insertAccount(first));

  await assert.rejects(
    repository.withTransaction((tx) =>
      tx.insertAccount({ ...first, subjectId: 'sub_01HQZXPORT02', idempotencyKey: 'idem_PORT02X' }),
    ),
    (error: unknown) => codeOf(error) === 'duplicate-account-id',
  );
  await assert.rejects(
    repository.withTransaction((tx) =>
      tx.insertAccount({
        ...first,
        accountId: 'acct_01HQZXPORT02',
        idempotencyKey: 'idem_PORT03X',
      }),
    ),
    (error: unknown) => codeOf(error) === 'subject-already-has-account',
  );
  await assert.rejects(
    repository.withTransaction((tx) =>
      tx.insertAccount({ ...first, accountId: 'acct_01HQZXPORT03', subjectId: 'sub_01HQZXPORT03' }),
    ),
    (error: unknown) => codeOf(error) === 'idempotency-key-reuse',
  );

  assert.equal(repository.accounts().length, 1);
});

test('the port exposes no way to change, remove, relink or merge an account', () => {
  const repository = new InMemoryAccountRepository();
  const operations = new Set<string>();

  return repository.withTransaction((tx) => {
    let proto: object | null = Object.getPrototypeOf(tx) as object | null;
    while (proto !== null && proto !== Object.prototype) {
      for (const key of Object.getOwnPropertyNames(proto)) operations.add(key);
      proto = Object.getPrototypeOf(proto) as object | null;
    }

    const mutators = [...operations].filter((operation) =>
      /update|delete|remove|relink|merge|amend|close|suspend|purge|truncate|set[A-Z]/i.test(
        operation,
      ),
    );
    assert.deepEqual(
      mutators,
      [],
      'orders and payments name these ids; an account that can be relinked reattributes all of them',
    );

    // And no capability, role, balance or credential operation, because there is no such state.
    const foreign = [...operations].filter((operation) =>
      /capabilit|role|grant|permission|verif|balance|credit|password|session|token/i.test(
        operation,
      ),
    );
    assert.deepEqual(foreign, [], 'the port would be where the one-account rule started bending');

    assert.ok(operations.has('insertAccount'));
    assert.ok(operations.has('findAccountBySubjectId'));
    return Promise.resolve();
  });
});

test('a failed transaction writes nothing', async () => {
  const repository = new InMemoryAccountRepository();
  await assert.rejects(
    repository.withTransaction(async (tx) => {
      await tx.insertAccount(account({ accountId: 'acct_01HQZXROLLBK' }));
      throw new Error('something went wrong after the insert');
    }),
    /something went wrong/,
  );

  assert.equal(repository.accounts().length, 0, 'a caller that sees a failure assumes nothing ran');
  assert.equal(repository.transactionsRolledBack, 1);
  assert.equal(repository.transactionsCommitted, 0);
});

test('lookups inside a transaction see what that transaction wrote', async () => {
  const repository = new InMemoryAccountRepository();
  const written = account({
    accountId: 'acct_01HQZXINTX',
    subjectId: 'sub_01HQZXINTX',
    idempotencyKey: 'idem_01HQZXINTX',
  });

  const found = await repository.withTransaction(async (tx) => {
    await tx.insertAccount(written);
    return {
      byId: await tx.findAccountById('acct_01HQZXINTX'),
      bySubject: await tx.findAccountBySubjectId('sub_01HQZXINTX'),
      byKey: await tx.findAccountByIdempotencyKey('idem_01HQZXINTX'),
      missing: await tx.findAccountById('acct_01HQZXNOSUCH'),
    };
  });

  assert.equal(found.byId?.accountId, 'acct_01HQZXINTX');
  assert.equal(found.bySubject?.accountId, 'acct_01HQZXINTX');
  assert.equal(found.byKey?.accountId, 'acct_01HQZXINTX');
  assert.equal(found.missing, null);
});

// ---------------------------------------------------------------------------
// Adapter queries — asserted on the SQL as issued, not as written
// ---------------------------------------------------------------------------

test('every read projects created_at as UTC text, never as a driver Date', async () => {
  const database = new RecordingDatabase({ selects: [{ match: /SELECT/i, rows: [row()] }] });
  await new PostgresAccountRepository(database).withTransaction(async (tx) => {
    await tx.findAccountById('acct_01HQZXTESTROW');
    await tx.findAccountBySubjectId('sub_01HQZXTESTROW');
    await tx.findAccountByIdempotencyKey('idem_01HQZXTESTROW');
  });

  const selects = database.statements().filter((sql) => sql.startsWith('SELECT'));
  assert.equal(selects.length, 3, 'all three read paths were exercised');

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

test('no statement K-03 issues names another unit’s schema', async () => {
  // The central claim of the design. K-03 depends on K-01 through an injected lookup; if any SQL
  // here reached `kernel_identity`, the port would be decoration and the two schemas would be one.
  const database = new RecordingDatabase({ selects: [{ match: /SELECT/i, rows: [row()] }] });
  const repository = new PostgresAccountRepository(database);

  await repository.withTransaction(async (tx) => {
    await tx.findAccountById('acct_01HQZXTESTROW');
    await tx.findAccountBySubjectId('sub_01HQZXTESTROW');
    await tx.findAccountByIdempotencyKey('idem_01HQZXTESTROW');
    await tx.insertAccount(account({ accountId: 'acct_01HQZXSCHEMA' }));
  });

  assert.ok(database.statements().length > 0, 'statements were actually issued');
  for (const sql of database.statements()) {
    for (const schema of knownSchemas()) {
      if (schema === ACCOUNT_SCHEMA) continue;
      assert.ok(!sql.includes(`${schema}.`), `a K-03 statement reaches ${schema}: ${sql}`);
    }
    assert.ok(!sql.includes(IDENTITY_TABLE), 'and never K-01’s table in particular');
  }
});

test('reads are parameterised and never interpolate the caller’s value', async () => {
  const database = new RecordingDatabase({ selects: [{ match: /SELECT/i, rows: [] }] });
  await new PostgresAccountRepository(database).withTransaction((tx) =>
    tx.findAccountById("acct_01' OR 1=1--"),
  );

  const select = database.queries.find((query) => query.sql.startsWith('SELECT'));
  assert.ok(select !== undefined);
  assert.match(select.sql, /WHERE account_id = \$1;/);
  assert.deepEqual(select.params, ["acct_01' OR 1=1--"]);
});

test('the three reads differ only by column, and the column is never caller-supplied', async () => {
  const database = new RecordingDatabase({ selects: [{ match: /SELECT/i, rows: [] }] });
  await new PostgresAccountRepository(database).withTransaction(async (tx) => {
    await tx.findAccountById('acct_01HQZXSHAPE1');
    await tx.findAccountBySubjectId('sub_01HQZXSHAPE1');
    await tx.findAccountByIdempotencyKey('idem_01HQZXSHAPE1');
  });

  const columns = database
    .statements()
    .filter((sql) => sql.startsWith('SELECT'))
    .map((sql) => /WHERE (\w+) = \$1;/.exec(sql)?.[1]);
  assert.deepEqual(columns, ['account_id', 'subject_id', 'idempotency_key']);
});

test('an opening is one INSERT with six bound parameters, inside BEGIN/COMMIT', async () => {
  const database = new RecordingDatabase();
  const written = account({
    accountId: 'acct_01HQZXINSERT',
    subjectId: 'sub_01HQZXINSERT',
    idempotencyKey: 'idem_01HQZXINSERT',
  });
  await new PostgresAccountRepository(database).withTransaction((tx) => tx.insertAccount(written));

  const statements = database.statements();
  assert.equal(statements[0], 'BEGIN;');
  assert.equal(statements[statements.length - 1], 'COMMIT;');

  const insert = database.queries.find((query) => /INSERT INTO/i.test(query.sql));
  assert.ok(insert !== undefined);
  assert.match(insert.sql, new RegExp(`INSERT INTO ${ACCOUNT_TABLE.replace('.', '\\.')}`));
  assert.deepEqual(insert.params, [
    'acct_01HQZXINSERT',
    'sub_01HQZXINSERT',
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
    new PostgresAccountRepository(database).withTransaction((tx) =>
      tx.insertAccount(account({ accountId: 'acct_01HQZXFAILED' })),
    ),
  );

  assert.ok(database.indexOf(/^ROLLBACK;$/) > -1, 'the transaction was rolled back');
  assert.equal(database.indexOf(/^COMMIT;$/), -1, 'and never committed');
  assert.equal(database.sessionsReleased, 1);
});

test('a unique violation becomes the refusal it actually is', async () => {
  for (const [constraint, expected] of [
    ['universal_account_pkey', 'duplicate-account-id'],
    ['universal_account_subject_unique', 'subject-already-has-account'],
    ['universal_account_idempotency_unique', 'idempotency-key-reuse'],
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
      new PostgresAccountRepository(database).withTransaction((tx) =>
        tx.insertAccount(account({ accountId: 'acct_01HQZXCONFLICT' })),
      ),
      (error: unknown) => codeOf(error) === expected,
      `${constraint} must surface as ${expected}, not as a raw driver error`,
    );
  }
});

test('an error the adapter does not understand is passed through unchanged', async () => {
  const database = new RecordingDatabase({
    failures: [{ match: /INSERT INTO/i, error: sqlstateError('connection terminated', '08006') }],
  });

  await assert.rejects(
    new PostgresAccountRepository(database).withTransaction((tx) =>
      tx.insertAccount(account({ accountId: 'acct_01HQZXCONNGONE' })),
    ),
    /connection terminated/,
  );
});

// ---------------------------------------------------------------------------
// Decoding — fail-closed, against the creation rules
// ---------------------------------------------------------------------------

test('a well-formed row decodes, and comes back sealed', () => {
  const decoded = decode(row());

  assert.equal(decoded.accountId, 'acct_01HQZXTESTROW');
  assert.equal(decoded.subjectId, 'sub_01HQZXTESTROW');
  assert.equal(
    decoded.createdAt,
    '2026-04-01T12:00:00Z',
    'trailing zeros are not part of the value',
  );
  assert.ok(Object.isFrozen(decoded) && Object.isFrozen(decoded.origin));
});

test('a stored row is held to exactly what creation demands', () => {
  // K-01 needed a correction to reach this (§11.22): its decoder asked far less than its creation
  // path, so a row written around the adapter came back carrying a natural key. K-03 starts here.
  const refused: ReadonlyArray<readonly [string, Record<string, unknown>, string]> = [
    ['an email as an account id', { account_id: 'alice@example.com' }, 'natural-identifier'],
    ['a personal name as an account id', { account_id: 'alice.smith' }, 'natural-identifier'],
    ['a domain as a subject id', { subject_id: 'example.com' }, 'natural-identifier'],
    ['a telephone number as a subject id', { subject_id: '0771234567' }, 'natural-identifier'],
    ['a credential as an origin id', { origin_id: 'api_key_for_alice' }, 'secret-bearing-input'],
    [
      'a token as an idempotency key',
      { idempotency_key: 'bearer-zzzzzzzzzzzz' },
      'secret-bearing-input',
    ],
    ['a guessably short account id', { account_id: 'acct_1' }, 'malformed-identifier'],
    ['an AI origin', { origin_kind: 'ai' }, 'ai-not-permitted'],
  ];

  for (const [why, columns, code] of refused) {
    assert.throws(
      () => decode(row(columns)),
      (error: unknown) => {
        assert.equal(codeOf(error), code, why);
        assert.match(
          (error as AccountError).message,
          /not written by this component/i,
          `${why}: the refusal must send the reader to the database`,
        );
        return true;
      },
      `${why} must not come back as a real account`,
    );
  }
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
    ['a null account id', { account_id: null }, /expected non-empty text/],
    ['a numeric subject id', { subject_id: 42 }, /expected non-empty text/],
    ['an unknown origin kind', { origin_kind: 'daemon' }, /origin\.kind is "daemon"/],
    ['an empty origin id', { origin_id: '' }, /expected non-empty text/],
  ];

  for (const [why, columns, message] of malformed) {
    assert.throws(
      () => decode(row(columns)),
      (error: unknown) => {
        assert.equal(codeOf(error), 'malformed-record', why);
        assert.match((error as AccountError).message, message, why);
        return true;
      },
      `${why} must be refused`,
    );
  }
});

test('the adapter refuses a bad row on every read path', async () => {
  const database = new RecordingDatabase({
    selects: [{ match: /SELECT/i, rows: [row({ account_id: 'alice@example.com' })] }],
  });
  const repository: AccountRepository = new PostgresAccountRepository(database);

  await assert.rejects(
    repository.withTransaction((tx) => tx.findAccountById('alice@example.com')),
    (error: unknown) => codeOf(error) === 'natural-identifier',
  );
  await assert.rejects(
    repository.withTransaction((tx) => tx.findAccountBySubjectId('sub_01HQZXTESTROW')),
    (error: unknown) => codeOf(error) === 'natural-identifier',
  );
  await assert.rejects(
    repository.withTransaction((tx) => tx.findAccountByIdempotencyKey('idem_01HQZXTESTROW')),
    (error: unknown) => codeOf(error) === 'natural-identifier',
  );
});

// ---------------------------------------------------------------------------
// Module contract
// ---------------------------------------------------------------------------

test('K-03 owns exactly one schema, derived from the manifest', () => {
  const component = KERNEL_COMPONENTS.find((entry) => entry.id === 'K-03');
  assert.ok(component !== undefined, 'K-03 is registered in the architecture manifest');
  assert.equal(component.dir, 'accounts');
  assert.equal(ACCOUNT_SCHEMA, `${KERNEL_SCHEMA_PREFIX}${component.dir}`);
  assert.ok(knownSchemas().includes(ACCOUNT_SCHEMA), 'the schema is one the platform knows about');
  assert.equal(ACCOUNT_TABLE, `${ACCOUNT_SCHEMA}.universal_account`);
});

test('neither the adapter nor the migration names another unit’s schema', () => {
  // Scanned with comments stripped. The comments *should* name kernel_identity — the decision not
  // to reference it is the interesting thing about this component and it is explained where it is
  // made. What must not appear is a statement.
  // stripNoise is the migration checker's own stripper: comments and string-literal content
  // blanked, line structure preserved. Using it means this test and `npm run check:migrations`
  // agree about what counts as a statement rather than as prose.
  const MIGRATION_UP_CODE = stripNoise(MIGRATION_UP);
  const MIGRATION_DOWN_CODE = stripNoise(MIGRATION_DOWN);
  const ADAPTER_CODE = stripComments(ADAPTER_SOURCE);

  for (const schema of knownSchemas()) {
    if (schema === ACCOUNT_SCHEMA) continue;
    assert.ok(!ADAPTER_CODE.includes(`${schema}.`), `the adapter touches ${schema}`);
    assert.ok(!MIGRATION_UP_CODE.includes(`${schema}.`), `the forward migration touches ${schema}`);
    assert.ok(!MIGRATION_DOWN_CODE.includes(`${schema}.`), `the rollback touches ${schema}`);
  }
  assert.match(MIGRATION_UP, /^-- owner: kernel_accounts$/m);
  assert.match(MIGRATION_DOWN, /^-- owner: kernel_accounts$/m);

  // Named explicitly, because this is the schema it would be most tempting to reach into.
  assert.ok(
    !MIGRATION_UP_CODE.includes(IDENTITY_SCHEMA),
    'no statement in K-03’s migration names K-01’s schema',
  );
  assert.ok(
    !/REFERENCES/i.test(MIGRATION_UP_CODE),
    'no foreign key: a cross-schema one would make K-01 unable to roll back without K-03',
  );
});

test('the K-01 dependency is a port, not a table read', () => {
  // Structural, so a future refactor cannot quietly swap the port for a join.
  assert.ok(
    !stripComments(ADAPTER_SOURCE).includes('identity'),
    'the adapter must know nothing about K-01 — the lookup is injected into the service',
  );
  assert.match(SERVICE_SOURCE, /SubjectLookup/, 'the service takes the lookup as a port');
  assert.match(SERVICE_SOURCE, /this\.#subjects\.exists\(/, 'and asks it the one question');
});

test('no source file in this component can change or remove an account', () => {
  for (const [name, source] of [
    ['postgres-repository.ts', ADAPTER_SOURCE],
    ['repository.ts', PORT_SOURCE],
    ['service.ts', SERVICE_SOURCE],
  ] as const) {
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|\s)\/\/[^\n]*/g, ' ')
      .replace(/'[^']*'/g, "''")
      .replace(/`[^`]*`/g, '``');

    for (const forbidden of [/\bUPDATE\s+kernel_/i, /\bDELETE\s+FROM\b/i, /\bTRUNCATE\b/i]) {
      assert.ok(
        !forbidden.test(code),
        `${name} contains ${String(forbidden)} — an account is written once`,
      );
    }
  }
});

test('the migration enforces the account contract in the database, not only in the service', () => {
  assert.match(MIGRATION_UP, /CONSTRAINT universal_account_pkey PRIMARY KEY \(account_id\)/);
  assert.match(
    MIGRATION_UP,
    /CONSTRAINT universal_account_subject_unique UNIQUE \(subject_id\)/,
    'one party, one account — the invariant the whole component exists to hold',
  );
  assert.match(
    MIGRATION_UP,
    /CONSTRAINT universal_account_idempotency_unique UNIQUE \(idempotency_key\)/,
  );
  assert.match(MIGRATION_UP, /CHECK \(origin_kind <> 'ai'\)/);

  for (const column of ['account_id', 'subject_id', 'origin_id', 'idempotency_key']) {
    assert.match(
      MIGRATION_UP,
      new RegExp(`CHECK \\(kernel_accounts\\.is_opaque_identifier\\(${column}\\)\\)`),
      `${column} does not go through is_opaque_identifier`,
    );
  }

  // No column that would imply state this component does not have.
  for (const forbidden of [
    'status',
    'closed_at',
    'deleted_at',
    'merged_into',
    'capabilities',
    'verification_level',
    'balance',
    'email',
    'display_name',
    'updated_at',
  ]) {
    assert.ok(
      !new RegExp(`^\\s+${forbidden}\\s`, 'm').test(MIGRATION_UP),
      `the table declares a "${forbidden}" column, which is where the one-account rule bends`,
    );
  }
});

test('K-03’s opacity rules are character-for-character K-01’s', () => {
  // An unavoidable duplication — a CHECK cannot call another schema's function without coupling
  // the two migrations — converted into a guarded one. If either is edited alone, this fails.
  const body = (sql: string): string => {
    const found = /AS \$rules\$([\s\S]*?)\$rules\$/.exec(sql);
    assert.ok(found !== null, 'is_opaque_identifier was not found');
    return String(found[1]);
  };

  assert.equal(
    body(MIGRATION_UP),
    body(IDENTITY_MIGRATION_UP),
    'K-03 and K-01 must judge an identifier identically; they are the same rule, written twice ' +
      'only because each schema must be independently creatable and droppable',
  );
});

test('the migration refuses mutation at the database as well', () => {
  assert.match(MIGRATION_UP, /CREATE OR REPLACE FUNCTION kernel_accounts\.refuse_mutation/);
  assert.match(MIGRATION_UP, /RAISE EXCEPTION/);
  assert.match(
    MIGRATION_UP,
    /CREATE TRIGGER universal_account_is_write_once\s+BEFORE UPDATE OR DELETE ON kernel_accounts\.universal_account/,
  );
  assert.match(MIGRATION_DOWN, /DROP TRIGGER IF EXISTS universal_account_is_write_once/);
  assert.match(MIGRATION_DOWN, /DROP FUNCTION IF EXISTS kernel_accounts\.refuse_mutation/);
});

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

  assert.ok(
    MIGRATION_DOWN.indexOf('DROP TRIGGER') < MIGRATION_DOWN.indexOf('DROP FUNCTION'),
    'a function cannot be dropped while a trigger still references it',
  );
  assert.ok(
    MIGRATION_DOWN.indexOf('DROP TABLE') <
      MIGRATION_DOWN.indexOf('DROP FUNCTION IF EXISTS kernel_accounts.is_opaque_identifier'),
    'the CHECK constraints reference the rule function, so the table must go first',
  );
  assert.match(MIGRATION_DOWN, /DROP SCHEMA IF EXISTS kernel_accounts RESTRICT/);
});

test('CONTRACT.md records the refusals the code actually raises', () => {
  for (const code of [
    'unknown-subject',
    'subject-already-has-account',
    'malformed-identifier',
    'natural-identifier',
    'secret-bearing-input',
    'malformed-instant',
    'ai-not-permitted',
    'foreign-concern',
    'duplicate-account-id',
    'idempotency-key-reuse',
    'no-such-account',
    'nested-transaction',
    'malformed-record',
  ]) {
    assert.ok(CONTRACT.includes(`\`${code}\``), `CONTRACT.md does not document ${code}`);
  }

  for (const deferred of ['K-02', 'K-04', 'K-08', 'K-09']) {
    assert.ok(
      CONTRACT.includes(deferred),
      `CONTRACT.md does not name the deferred ${deferred} work`,
    );
  }
  assert.match(CONTRACT, /No unit opens an account/i);
  assert.match(CONTRACT, /no foreign key/i, 'the K-01 coupling decision must be recorded');
});
