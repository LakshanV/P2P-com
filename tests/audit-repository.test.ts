/**
 * K-09 Audit Foundation — port conformance, adapter queries, pagination and module contract.
 *
 * Four kinds of assertion, covering four different risks:
 *
 *   - **Port conformance.** The in-memory repository is the reference implementation, so every
 *     guarantee proved against it is worth exactly what its guards are worth.
 *   - **Immutability.** The strongest claim this component makes. Asserted by inspecting the
 *     transaction object at runtime, because a rule enforced only by a type is a rule a cast undoes.
 *   - **Adapter queries.** Statement shape is behaviour and cannot be read off the source: the real
 *     adapter runs against a recording fake and what it sends is inspected.
 *   - **Module contract.** Ownership, schema, migration and immutability trigger, asserted
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
  AUDIT_SCHEMA,
  AUDIT_TABLE,
  AuditError,
  EnlistedAuditRepository,
  InMemoryAuditRepository,
  PostgresAuditRepository,
  TIMESTAMP_COLUMNS,
  decodeEvidence,
  enlistedClient,
  fingerprintRecord,
  toRecord,
} from '../kernel/audit-foundation/index.ts';
import type { AuditRecord, AuditRepository } from '../kernel/audit-foundation/index.ts';

import { RecordingDatabase } from './helpers/recording-database.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE_DIR = path.join(HERE, '..', 'kernel', 'audit-foundation');
const ADAPTER_SOURCE = readFileSync(path.join(MODULE_DIR, 'postgres-repository.ts'), 'utf8');
const PORT_SOURCE = readFileSync(path.join(MODULE_DIR, 'repository.ts'), 'utf8');
const SERVICE_SOURCE = readFileSync(path.join(MODULE_DIR, 'service.ts'), 'utf8');
const CONTRACT = readFileSync(path.join(MODULE_DIR, 'CONTRACT.md'), 'utf8');
const MIGRATION_UP = readFileSync(
  path.join(HERE, '..', 'db', 'migrations', '0005_create_kernel_audit_foundation_schema.up.sql'),
  'utf8',
);
const MIGRATION_DOWN = readFileSync(
  path.join(HERE, '..', 'db', 'migrations', '0005_create_kernel_audit_foundation_schema.down.sql'),
  'utf8',
);

const codeOf = (error: unknown): string | undefined =>
  error instanceof AuditError ? error.code : undefined;

const record = (overrides: Partial<AuditRecord> = {}): AuditRecord => ({
  recordId: 'aud-1',
  action: 'configuration.version_published',
  recordedAt: '2026-04-01T12:00:00Z',
  actor: { kind: 'system', id: 'K-05', authentication: 'unauthenticated', sessionId: null },
  resource: { owner: 'K-05', type: 'configuration_version', id: 'ver-1' },
  outcome: 'succeeded',
  reason: 'published',
  correlationId: 'corr-1',
  causationId: null,
  evidence: { config_key: 'session.timeout_seconds' },
  contentFingerprint: 'a'.repeat(64),
  idempotencyKey: 'idem-1',
  ...overrides,
});

/**
 * A stored row, carrying a fingerprint of its own decoded content.
 *
 * Computed rather than hard-coded, because decoding now recomputes and compares: a fixture with a
 * stale fingerprint would be refused, and the test would be reporting the fixture rather than the
 * code. `fingerprintFor` mirrors what the decoder will reconstruct from these columns.
 */
const fingerprintFor = (columns: Record<string, unknown>): string =>
  fingerprintRecord({
    recordId: String(columns.record_id),
    action: String(columns.action),
    recordedAt: '2026-04-01T12:00:00Z',
    actor: {
      kind: columns.actor_kind as AuditRecord['actor']['kind'],
      id: String(columns.actor_id),
      authentication: columns.actor_authentication as AuditRecord['actor']['authentication'],
      sessionId: (columns.actor_session_id ?? null) as string | null,
    },
    resource: {
      owner: String(columns.resource_owner),
      type: String(columns.resource_type),
      id: String(columns.resource_id),
    },
    outcome: columns.outcome as AuditRecord['outcome'],
    reason: String(columns.reason),
    correlationId: String(columns.correlation_id),
    causationId: (columns.causation_id ?? null) as string | null,
    evidence: columns.evidence as AuditRecord['evidence'],
    idempotencyKey: String(columns.idempotency_key),
  });

const rawRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  record_id: 'aud-1',
  action: 'configuration.version_published',
  recorded_at: '2026-04-01T12:00:00.000000Z',
  actor_kind: 'system',
  actor_id: 'K-05',
  actor_authentication: 'unauthenticated',
  actor_session_id: null,
  resource_owner: 'K-05',
  resource_type: 'configuration_version',
  resource_id: 'ver-1',
  outcome: 'succeeded',
  reason: 'published',
  correlation_id: 'corr-1',
  causation_id: null,
  evidence: { config_key: 'session.timeout_seconds' },
  content_fingerprint: 'a'.repeat(64),
  idempotency_key: 'idem-1',
  ...overrides,
});

/** The same row, with its fingerprint made consistent unless the test overrode it deliberately. */
const row = (overrides: Record<string, unknown> = {}): Record<string, unknown> => {
  const columns = rawRow(overrides);
  return 'content_fingerprint' in overrides
    ? columns
    : { ...columns, content_fingerprint: fingerprintFor(columns) };
};

// ---------------------------------------------------------------------------
// Port conformance
// ---------------------------------------------------------------------------

const conformance = (name: string, make: () => AuditRepository & InMemoryAuditRepository): void => {
  test(`${name}: a record is appended once and never rewritten`, async () => {
    const repository = make();
    await repository.withTransaction((tx) => tx.insertRecord(record()));

    await assert.rejects(
      repository.withTransaction((tx) => tx.insertRecord(record({ idempotencyKey: 'idem-2' }))),
      (error: unknown) => codeOf(error) === 'duplicate-record-id',
    );
    await assert.rejects(
      repository.withTransaction((tx) => tx.insertRecord(record({ recordId: 'aud-2' }))),
      (error: unknown) => codeOf(error) === 'idempotency-key-reuse',
    );

    assert.equal(repository.records().length, 1);
  });

  test(`${name}: the port exposes no way to change or remove a record`, () => {
    const repository = make();
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
        /update|delete|remove|amend|redact|purge|expire|truncate|set[A-Z]/i.test(operation),
      );
      assert.deepEqual(mutators, [], 'an audit trail that can be amended is not evidence');
      assert.ok(operations.has('insertRecord'));
      assert.ok(operations.has('queryRecords'));
      return Promise.resolve();
    });
  });

  test(`${name}: a failed transaction writes nothing`, async () => {
    const repository = make();
    await assert.rejects(
      repository.withTransaction(async (tx) => {
        await tx.insertRecord(record());
        throw new Error('something went wrong after the write');
      }),
    );
    assert.equal(repository.records().length, 0);
    assert.equal(repository.transactionsRolledBack, 1);
  });

  test(`${name}: retrieval orders by instant then id, so equal instants are stable`, async () => {
    const repository = make();
    // Deliberately inserted out of order, and three sharing one instant.
    await repository.withTransaction(async (tx) => {
      for (const [id, at] of [
        ['aud-c', '2026-04-01T12:00:00Z'],
        ['aud-a', '2026-04-01T12:00:00Z'],
        ['aud-z', '2026-04-01T11:00:00Z'],
        ['aud-b', '2026-04-01T12:00:00Z'],
      ] as const) {
        await tx.insertRecord(record({ recordId: id, recordedAt: at, idempotencyKey: `k-${id}` }));
      }
    });

    const page = await repository.withTransaction((tx) => tx.queryRecords({ limit: 10 }));
    assert.deepEqual(
      page.records.map((entry) => entry.recordId),
      ['aud-z', 'aud-a', 'aud-b', 'aud-c'],
      'earliest first, and ties broken by id rather than by insertion order',
    );

    // Repeatable: the same query returns the same order every time.
    for (let i = 0; i < 3; i += 1) {
      const again = await repository.withTransaction((tx) => tx.queryRecords({ limit: 10 }));
      assert.deepEqual(
        again.records.map((entry) => entry.recordId),
        page.records.map((entry) => entry.recordId),
      );
    }
  });

  test(`${name}: pagination walks every record exactly once, across equal instants`, async () => {
    const repository = make();
    const ids = ['aud-1', 'aud-2', 'aud-3', 'aud-4', 'aud-5', 'aud-6', 'aud-7'];
    await repository.withTransaction(async (tx) => {
      for (const id of ids) {
        // Every record shares one instant: the case where ordering on time alone breaks.
        await tx.insertRecord(
          record({ recordId: id, recordedAt: '2026-04-01T12:00:00Z', idempotencyKey: `k-${id}` }),
        );
      }
    });

    const seen: string[] = [];
    let after = undefined as { recordedAt: string; recordId: string } | undefined;
    let pages = 0;

    do {
      const page = await repository.withTransaction((tx) =>
        tx.queryRecords({ limit: 3, ...(after === undefined ? {} : { after }) }),
      );
      seen.push(...page.records.map((entry) => entry.recordId));
      after = page.next ?? undefined;
      pages += 1;
      assert.ok(pages < 10, 'pagination terminated');
    } while (after !== undefined);

    assert.deepEqual(seen, ids, 'every record once, in order, with nothing skipped or repeated');
    assert.equal(new Set(seen).size, ids.length);
  });

  test(`${name}: filters combine, and a bad limit is refused`, async () => {
    const repository = make();
    await repository.withTransaction(async (tx) => {
      await tx.insertRecord(
        record({ recordId: 'aud-1', idempotencyKey: 'k-1', outcome: 'succeeded' }),
      );
      await tx.insertRecord(
        record({
          recordId: 'aud-2',
          idempotencyKey: 'k-2',
          outcome: 'denied',
          actor: {
            kind: 'human',
            id: 'ops-alice',
            authentication: 'unauthenticated',
            sessionId: null,
          },
        }),
      );
      await tx.insertRecord(
        record({
          recordId: 'aud-3',
          idempotencyKey: 'k-3',
          outcome: 'denied',
          recordedAt: '2026-05-01T00:00:00Z',
        }),
      );
    });

    const denied = await repository.withTransaction((tx) =>
      tx.queryRecords({ outcome: 'denied', limit: 10 }),
    );
    assert.deepEqual(
      denied.records.map((entry) => entry.recordId),
      ['aud-2', 'aud-3'],
    );

    const deniedByActor = await repository.withTransaction((tx) =>
      tx.queryRecords({ outcome: 'denied', actorId: 'ops-alice', limit: 10 }),
    );
    assert.deepEqual(
      deniedByActor.records.map((entry) => entry.recordId),
      ['aud-2'],
      'filters combine with AND',
    );

    const window = await repository.withTransaction((tx) =>
      tx.queryRecords({ from: '2026-04-01T12:00:00Z', before: '2026-05-01T00:00:00Z', limit: 10 }),
    );
    assert.deepEqual(
      window.records.map((entry) => entry.recordId),
      ['aud-1', 'aud-2'],
      'from is inclusive and before is exclusive, so adjacent windows cannot double-count',
    );

    for (const limit of [0, -1, 1.5, Number.NaN]) {
      await assert.rejects(
        repository.withTransaction((tx) => tx.queryRecords({ limit })),
        (error: unknown) => codeOf(error) === 'invalid-query',
        `limit ${String(limit)} must be refused`,
      );
    }
  });
};

conformance('in-memory', () => new InMemoryAuditRepository());

// ---------------------------------------------------------------------------
// Immutability, at every level that can be checked without a server
// ---------------------------------------------------------------------------

test('no source in this component issues an UPDATE or a DELETE', () => {
  for (const [name, source] of [
    ['postgres-repository.ts', ADAPTER_SOURCE],
    ['repository.ts', PORT_SOURCE],
    ['service.ts', SERVICE_SOURCE],
  ] as const) {
    assert.ok(
      !/\bUPDATE\s+kernel_audit_foundation/i.test(source),
      `${name} contains an UPDATE against the audit table`,
    );
    assert.ok(!/\bDELETE\s+FROM/i.test(source), `${name} contains a DELETE`);
    assert.ok(!/\bTRUNCATE\b/i.test(source), `${name} contains a TRUNCATE`);
  }
});

test('the migration refuses mutation at the database as well', () => {
  // The application refuses because it has no such operation. This refuses a connection that never
  // went through the application at all.
  assert.match(MIGRATION_UP, /CREATE OR REPLACE FUNCTION kernel_audit_foundation\.refuse_mutation/);
  assert.match(MIGRATION_UP, /RAISE EXCEPTION/);
  assert.match(
    MIGRATION_UP,
    /CREATE TRIGGER audit_record_is_append_only\s+BEFORE UPDATE OR DELETE ON kernel_audit_foundation\.audit_record/,
  );
  assert.match(MIGRATION_DOWN, /DROP TRIGGER IF EXISTS audit_record_is_append_only/);
  assert.match(MIGRATION_DOWN, /DROP FUNCTION IF EXISTS kernel_audit_foundation\.refuse_mutation/);
});

// ---------------------------------------------------------------------------
// Adapter queries
// ---------------------------------------------------------------------------

async function issuedStatements(): Promise<string[]> {
  const database = new RecordingDatabase({ selects: [{ match: /SELECT/i, rows: [] }] });
  const repository = new PostgresAuditRepository(database);
  await repository.withTransaction(async (tx) => {
    await tx.findRecordById('aud-1');
    await tx.findRecordByIdempotencyKey('idem-1');
    await tx.queryRecords({ limit: 10 });
    await tx.queryRecords({
      action: 'configuration.version_published',
      actorId: 'K-05',
      outcome: 'denied',
      from: '2026-04-01T00:00:00Z',
      before: '2026-05-01T00:00:00Z',
      after: { recordedAt: '2026-04-01T12:00:00Z', recordId: 'aud-1' },
      limit: 5,
    });
  });
  return database.statements();
}

test('every timestamp column is projected as UTC text in every SELECT', async () => {
  for (const sql of (await issuedStatements()).filter((statement) => /^SELECT/i.test(statement))) {
    const selectList = sql.slice(0, sql.search(/\bFROM\b/i));
    for (const column of TIMESTAMP_COLUMNS) {
      const projected = `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${column}`;
      assert.ok(selectList.includes(projected), `${column} is not projected as text in: ${sql}`);
      assert.ok(
        !new RegExp(`(^|[\\s,(])${column}(\\s*,|\\s*$)`).test(
          selectList.split(projected).join(' '),
        ),
        `${column} also appears bare in: ${sql}`,
      );
    }
  }
});

test('retrieval orders on the columns, with the id breaking ties', async () => {
  const ordered = (await issuedStatements()).filter((sql) => /ORDER BY/i.test(sql));
  assert.ok(ordered.length >= 2, 'both query forms order their results');

  for (const sql of ordered) {
    assert.match(
      sql,
      /ORDER BY audit_record\.recorded_at ASC, audit_record\.record_id ASC/,
      'unqualified names would bind to the projected text column, and time alone is not a stable order',
    );
    assert.match(sql, /LIMIT \$\d+/, 'the page size is bound, not interpolated');
  }
});

test('the cursor predicate compares the pair, not the instant alone', async () => {
  const paged = (await issuedStatements()).find((sql) =>
    sql.includes('(recorded_at, record_id) >'),
  );
  assert.ok(
    paged !== undefined,
    'a cursor must compare (recorded_at, record_id) as a tuple; comparing the instant alone would ' +
      'skip or repeat rows that share it',
  );
  assert.match(paged, /\$\d+::timestamptz/, 'the cursor instant is cast, not compared as text');
});

test('every filter is a bound parameter, and the SQL carries no caller data', async () => {
  const filtered = (await issuedStatements()).find((sql) => sql.includes('correlation_id = $'));
  assert.ok(filtered === undefined || /correlation_id = \$\d+/.test(filtered));

  for (const sql of await issuedStatements()) {
    assert.ok(!sql.includes('${'), `an unresolved interpolation reached SQL: ${sql}`);
    // Every literal value in a WHERE clause must be a placeholder.
    const where = /WHERE([\s\S]*?)(ORDER BY|LIMIT|;)/i.exec(sql)?.[1] ?? '';
    assert.ok(
      !/=\s*'/.test(where),
      `a quoted literal reached a WHERE clause instead of a parameter: ${sql}`,
    );
  }

  const statements = [
    ...ADAPTER_SOURCE.matchAll(/client\.query(?:<[^>]*>)?\(\s*`([\s\S]*?)`/g),
  ].map((match) => match[1] ?? '');
  const permitted = new Set([
    'AUDIT_TABLE',
    'AUDIT_SCHEMA',
    'COLUMNS',
    'PROJECTION',
    'where',
    'limit',
  ]);
  for (const sql of statements) {
    for (const match of sql.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
      assert.ok(
        permitted.has(String(match[1])),
        `SQL interpolates ${String(match[1])}, which is not a fixed constant`,
      );
    }
  }
});

test('a fetched page asks for one row beyond the limit, to know whether more exist', async () => {
  const database = new RecordingDatabase({
    selects: [
      {
        match: /SELECT/i,
        rows: [row({ record_id: 'aud-1' }), row({ record_id: 'aud-2', idempotency_key: 'idem-2' })],
      },
    ],
  });
  const repository = new PostgresAuditRepository(database);

  const page = await repository.withTransaction((tx) => tx.queryRecords({ limit: 1 }));

  assert.equal(page.records.length, 1, 'the extra row is not returned to the caller');
  assert.deepEqual(page.next, { recordedAt: '2026-04-01T12:00:00Z', recordId: 'aud-1' });
  const limitParam = database.queries.find((query) => /LIMIT/i.test(query.sql))?.params.at(-1);
  assert.equal(limitParam, 2, 'limit + 1, rather than a second count(*) over the same predicate');
});

test('a row that does not decode is refused rather than approximated', () => {
  const cases: ReadonlyArray<{
    readonly why: string;
    readonly overrides: Record<string, unknown>;
  }> = [
    { why: 'a Date instead of projected text', overrides: { recorded_at: new Date() } },
    { why: 'an infinite timestamp', overrides: { recorded_at: 'infinity' } },
    { why: 'a session-formatted timestamp', overrides: { recorded_at: '2026-04-01 12:00:00+00' } },
    { why: 'an unknown actor kind', overrides: { actor_kind: 'daemon' } },
    { why: 'an unknown authentication method', overrides: { actor_authentication: 'magic' } },
    { why: 'an unknown outcome', overrides: { outcome: 'partially' } },
    { why: 'an empty reason', overrides: { reason: '' } },
    { why: 'a null required column', overrides: { correlation_id: null } },
    { why: 'a fingerprint that is not a SHA-256', overrides: { content_fingerprint: 'nope' } },
    { why: 'evidence that is an array', overrides: { evidence: [1, 2] } },
    { why: 'evidence with a nested value', overrides: { evidence: { a: { b: 1 } } } },
    { why: 'evidence that is not JSON', overrides: { evidence: 'not json' } },
  ];

  for (const scenario of cases) {
    assert.throws(
      () => toRecord(row(scenario.overrides) as unknown as Parameters<typeof toRecord>[0]),
      (error: unknown) => {
        assert.ok(error instanceof AuditError, `${scenario.why}: not an AuditError`);
        return true;
      },
      `accepted ${scenario.why}`,
    );
  }

  // A well-formed row still decodes, so the refusals above are about what they claim.
  const decoded = toRecord(row() as unknown as Parameters<typeof toRecord>[0]);
  assert.equal(decoded.recordId, 'aud-1');
  assert.equal(
    decoded.recordedAt,
    '2026-04-01T12:00:00Z',
    'trailing zeros trimmed to one spelling',
  );
  assert.deepEqual(decoded.evidence, { config_key: 'session.timeout_seconds' });
});

test('evidence decoding accepts flat scalars and nothing else', () => {
  assert.deepEqual(decodeEvidence('{"a":1,"b":"x","c":true,"d":null}', 'aud-1'), {
    a: 1,
    b: 'x',
    c: true,
    d: null,
  });
  for (const bad of ['[1]', 'null', '"text"', 'not json', '{"a":{"n":1}}', '{"a":[1]}']) {
    assert.throws(
      () => decodeEvidence(bad, 'aud-1'),
      (error: unknown) => codeOf(error) === 'invalid-evidence',
      `${bad} is not validatable evidence`,
    );
  }
});

// ---------------------------------------------------------------------------
// Transaction composition
// ---------------------------------------------------------------------------

test('an enlisted append issues no transaction control of its own', async () => {
  const database = new RecordingDatabase({ selects: [{ match: /SELECT/i, rows: [] }] });

  // The caller opens the transaction. This is the producing unit's own `db.withTransaction(...)`.
  const client = await database.connect();
  await client.query('BEGIN;');

  await PostgresAuditRepository.enlist(client).withTransaction((tx) => tx.insertRecord(record()));

  await client.query('COMMIT;');

  assert.deepEqual(
    database.statements().filter((sql) => /^(BEGIN|COMMIT|ROLLBACK)/i.test(sql)),
    ['BEGIN;', 'COMMIT;'],
    "exactly the caller's two statements; the append added none of its own",
  );
  assert.equal(database.sessionsOpened, 1, 'and it opened no second connection');
  assert.equal(
    database.sessionsReleased,
    0,
    "the caller's connection was not released underneath it",
  );
  assert.ok(database.statements().some((sql) => /^INSERT INTO kernel_audit_foundation/i.test(sql)));
});

test('a failure inside an enlisted append propagates, so the caller rolls back', async () => {
  const database = new RecordingDatabase({
    selects: [{ match: /SELECT/i, rows: [] }],
    failOn: /INSERT INTO kernel_audit_foundation/i,
  });
  const client = await database.connect();
  await client.query('BEGIN;');

  await assert.rejects(
    PostgresAuditRepository.enlist(client).withTransaction((tx) => tx.insertRecord(record())),
    // Swallowing this would commit the caller's domain rows with no audit record — the exact
    // outcome the shared transaction exists to prevent.
    (error: unknown) => error instanceof Error,
  );

  await client.query('ROLLBACK;');
  assert.deepEqual(
    database.statements().filter((sql) => /^(BEGIN|COMMIT|ROLLBACK)/i.test(sql)),
    ['BEGIN;', 'ROLLBACK;'],
    "no COMMIT was issued by the append, and the rollback is the caller's",
  );
});

test('nested transaction control is rejected, not passed through', async () => {
  const database = new RecordingDatabase();
  const client = enlistedClient(await database.connect());

  for (const sql of [
    'BEGIN;',
    '  begin;',
    'START TRANSACTION;',
    'COMMIT;',
    'commit;',
    'END;',
    'ROLLBACK;',
    'SAVEPOINT before_audit;',
    'RELEASE SAVEPOINT before_audit;',
  ]) {
    await assert.rejects(
      client.query(sql),
      (error: unknown) => codeOf(error) === 'nested-transaction',
      `${sql} must be refused: PostgreSQL has no nested transactions`,
    );
  }

  await client.query('SELECT 1;');
  assert.deepEqual(
    database.statements().filter((sql) => /^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT)/i.test(sql)),
    [],
    'not one of the refused statements reached the database',
  );
});

test('an enlisted repository never releases the connection it was handed', async () => {
  const database = new RecordingDatabase({ selects: [{ match: /SELECT/i, rows: [] }] });
  const client = await database.connect();

  await new EnlistedAuditRepository(client).withTransaction((tx) => tx.findRecordById('aud-1'));

  assert.equal(
    database.sessionsReleased,
    0,
    'the connection belongs to the caller; releasing it would abort work this component cannot see',
  );
});

test('the repository-owned path still owns its transaction, unchanged', async () => {
  const database = new RecordingDatabase({ selects: [{ match: /SELECT/i, rows: [] }] });

  await new PostgresAuditRepository(database).withTransaction((tx) => tx.findRecordById('aud-1'));

  assert.deepEqual(
    database.statements().filter((sql) => /^(BEGIN|COMMIT|ROLLBACK)/i.test(sql)),
    ['BEGIN;', 'COMMIT;'],
    'adding the enlisted path must not have changed the standalone one',
  );
  assert.equal(database.sessionsReleased, 1, 'the path that opened the connection closes it');
});

test('a failed repository-owned transaction rolls back and releases', async () => {
  const database = new RecordingDatabase({ failOn: /INSERT INTO/i });

  await assert.rejects(
    new PostgresAuditRepository(database).withTransaction((tx) => tx.insertRecord(record())),
  );

  const statements = database.statements();
  assert.ok(statements.includes('ROLLBACK;'));
  assert.ok(!statements.includes('COMMIT;'));
  assert.equal(database.sessionsReleased, 1);
});

// ---------------------------------------------------------------------------
// Module contract
// ---------------------------------------------------------------------------

test('the K-09 schema is the one the architecture manifest derives', () => {
  const component = KERNEL_COMPONENTS.find((entry) => entry.id === 'K-09');
  assert.ok(component !== undefined);
  assert.equal(AUDIT_SCHEMA, `${KERNEL_SCHEMA_PREFIX}${component.dir.replace(/-/g, '_')}`);
  assert.ok(knownSchemas().includes(AUDIT_SCHEMA), 'the schema is owned by a manifest unit');
  assert.equal(AUDIT_TABLE, `${AUDIT_SCHEMA}.audit_record`);
});

test('the adapter and the migration name their own schema and no other', () => {
  const others = knownSchemas().filter((schema) => schema !== AUDIT_SCHEMA);
  const statements = [
    ...ADAPTER_SOURCE.matchAll(/client\.query(?:<[^>]*>)?\(\s*`([\s\S]*?)`/g),
  ].map((match) => match[1] ?? '');

  for (const schema of others) {
    for (const sql of statements) {
      assert.ok(!sql.includes(`${schema}.`), `the adapter reaches into ${schema}`);
    }
    assert.ok(!MIGRATION_UP.includes(`${schema}.`), `the forward migration touches ${schema}`);
    assert.ok(!MIGRATION_DOWN.includes(`${schema}.`), `the rollback touches ${schema}`);
  }
  assert.match(MIGRATION_UP, /^-- owner: kernel_audit_foundation$/m);
  assert.match(MIGRATION_DOWN, /^-- owner: kernel_audit_foundation$/m);
});

test('the migration enforces the record contract in the database, not only in the service', () => {
  assert.match(MIGRATION_UP, /CONSTRAINT audit_record_pkey PRIMARY KEY \(record_id\)/);
  assert.match(
    MIGRATION_UP,
    /CONSTRAINT audit_record_idempotency_unique UNIQUE \(idempotency_key\)/,
  );
  // AI may not author a record, at the database level as well as in the service.
  assert.match(MIGRATION_UP, /CHECK \(actor_kind <> 'ai'\)/);
  // The placeholder, enforced exactly rather than as an implication.
  assert.match(MIGRATION_UP, /CHECK \(actor_authentication = 'unauthenticated'\)/);
  assert.match(MIGRATION_UP, /CHECK \(actor_session_id IS NULL\)/);
  assert.match(MIGRATION_UP, /CHECK \(outcome IN \('succeeded', 'failed', 'denied'\)\)/);
  assert.match(MIGRATION_UP, /CHECK \(btrim\(reason\) <> ''\)/);
  assert.match(MIGRATION_UP, /CHECK \(jsonb_typeof\(evidence\) = 'object'\)/);
  // The index that makes pagination stable.
  assert.match(MIGRATION_UP, /audit_record_chronological_idx[\s\S]*\(recorded_at, record_id\)/);
});

test('every actor-authentication combination but the documented placeholder is refused', () => {
  // The live suite proves this against PostgreSQL and skips without a server, so the refusal is
  // also evaluated here from the migration text — otherwise the only thing standing between the
  // schema and a weakened constraint is a server nobody in this environment has.
  //
  // The evaluator understands exactly the three predicate forms the actor constraints use. Anything
  // else fails loudly rather than being read as satisfied, so rewriting a constraint into a form
  // this cannot check is a failure and not a silent pass.
  const evaluate = (
    predicate: string,
    row: { readonly actor_authentication: string; readonly actor_session_id: string | null },
  ): boolean => {
    const equality = /^(\w+) = '([^']*)'$/.exec(predicate);
    if (equality !== null) return row[equality[1] as keyof typeof row] === equality[2];

    const isNull = /^(\w+) IS NULL$/.exec(predicate);
    if (isNull !== null) return row[isNull[1] as keyof typeof row] === null;

    const membership = /^(\w+) IN \((.+)\)$/.exec(predicate);
    if (membership !== null) {
      const allowed = String(membership[2])
        .split(',')
        .map((literal) => literal.trim().replace(/^'|'$/g, ''));
      return allowed.includes(String(row[membership[1] as keyof typeof row]));
    }

    throw new Error(
      `the actor constraint uses a predicate this test cannot evaluate: ${predicate}`,
    );
  };

  // Pulled from the file, so weakening a constraint weakens what is evaluated below.
  const predicates = [
    ...MIGRATION_UP.matchAll(/CONSTRAINT (audit_record_\w+)\s*\n?\s*CHECK \(([^\n]+?)\),/g),
  ]
    .filter(
      ([, name]) => String(name).includes('authentication') || String(name).includes('session'),
    )
    .map(([, , predicate]) => String(predicate));

  assert.ok(predicates.length >= 2, 'the actor constraints were not found in the migration');

  const METHODS = ['unauthenticated', 'session', 'service-credential', 'bearer-token'];
  const SESSIONS = [null, 'sess-1'];
  const accepted: string[] = [];

  for (const actor_authentication of METHODS) {
    for (const actor_session_id of SESSIONS) {
      const row = { actor_authentication, actor_session_id };
      if (predicates.every((predicate) => evaluate(predicate, row))) {
        accepted.push(`(${actor_authentication}, ${actor_session_id ?? 'NULL'})`);
      }
    }
  }

  assert.deepEqual(
    accepted,
    ['(unauthenticated, NULL)'],
    'exactly the documented K-09 placeholder may be written, including around the service',
  );
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

  // The trigger references the function, so it must be dropped first.
  assert.ok(
    MIGRATION_DOWN.indexOf('DROP TRIGGER') < MIGRATION_DOWN.indexOf('DROP FUNCTION'),
    'a function cannot be dropped while a trigger still references it',
  );
  assert.match(MIGRATION_DOWN, /DROP SCHEMA IF EXISTS kernel_audit_foundation RESTRICT/);
});

test('the module contract records what is deferred rather than implying it exists', () => {
  for (const deferred of ['K-02', 'K-04', 'retention', 'K-05', 'K-08']) {
    assert.ok(CONTRACT.includes(deferred), `CONTRACT.md does not mention ${deferred}`);
  }
  assert.match(
    CONTRACT,
    /no unit (records|emits)|nothing records|no producer/i,
    'the contract must not imply that any unit already emits audit records',
  );
  assert.match(CONTRACT, /append-only/i);
  assert.match(CONTRACT, /never been applied|no PostgreSQL runtime|unproven/i);
});
