/**
 * K-15 Search Foundation — port conformance, adapter queries, and the module contract.
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
  DOCUMENT_TABLE,
  QUERY_LOG_TABLE,
  SEARCH_SCHEMA,
  SearchError,
  InMemorySearchRepository,
  PostgresSearchRepository,
  TIMESTAMP_COLUMNS,
  toDocument,
  toQueryLog,
} from '../kernel/search-foundation/index.ts';

import {
  documentRecord,
  documentRow,
  queryLogRecord,
  queryLogRow,
} from './helpers/search-foundation-fixtures.ts';
import { RecordingDatabase, sqlstateError } from './helpers/recording-database.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE_DIR = path.join(HERE, '..', 'kernel', 'search-foundation');
const ADAPTER_SOURCE = readFileSync(path.join(MODULE_DIR, 'postgres-repository.ts'), 'utf8');
const PORT_SOURCE = readFileSync(path.join(MODULE_DIR, 'repository.ts'), 'utf8');
const SERVICE_SOURCE = readFileSync(path.join(MODULE_DIR, 'service.ts'), 'utf8');
const CONTRACT = readFileSync(path.join(MODULE_DIR, 'CONTRACT.md'), 'utf8');
const MIGRATIONS = path.join(HERE, '..', 'db', 'migrations');
const MIGRATION_UP = readFileSync(
  path.join(MIGRATIONS, '0021_create_kernel_search_foundation_schema.up.sql'),
  'utf8',
);
const MIGRATION_DOWN = readFileSync(
  path.join(MIGRATIONS, '0021_create_kernel_search_foundation_schema.down.sql'),
  'utf8',
);

const codeOf = (error: unknown): string | undefined =>
  error instanceof SearchError ? error.code : undefined;

const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)\/\/[^\n]*/g, ' ');

// ---------------------------------------------------------------------------
// Port conformance
// ---------------------------------------------------------------------------

test('a document is upserted by document_id and idempotency_key is unique', async () => {
  const repository = new InMemorySearchRepository();
  const first = documentRecord({ documentId: 'doc_01HQZXPORT01' });
  await repository.withTransaction((tx) => tx.insertDocument(first));

  await assert.rejects(
    repository.withTransaction((tx) =>
      tx.insertDocument(
        documentRecord({
          documentId: 'doc_01HQZXPORT02',
          idempotencyKey: first.idempotencyKey,
        }),
      ),
    ),
    (error: unknown) => codeOf(error) === 'idempotency-key-reuse',
  );

  await repository.withTransaction((tx) =>
    tx.insertDocument(
      documentRecord({
        documentId: 'doc_01HQZXPORT01',
        title: 'Updated title',
        updatedAt: '2026-04-01T12:00:01Z',
        idempotencyKey: 'idem_doc_port_02',
      }),
    ),
  );

  assert.equal(repository.documents().length, 1);
  assert.equal(repository.documents()[0]?.title, 'Updated title');
});

test('a query log is created once and never rewritten', async () => {
  const repository = new InMemorySearchRepository();
  const first = queryLogRecord({ queryId: 'qry_01HQZXPORT01' });
  await repository.withTransaction((tx) => tx.insertQueryLog(first));

  await assert.rejects(
    repository.withTransaction((tx) =>
      tx.insertQueryLog(
        queryLogRecord({
          queryId: 'qry_01HQZXPORT01',
          idempotencyKey: 'idem_qry_port_02',
        }),
      ),
    ),
    (error: unknown) => codeOf(error) === 'duplicate-query-id',
  );
  await assert.rejects(
    repository.withTransaction((tx) =>
      tx.insertQueryLog(
        queryLogRecord({
          queryId: 'qry_01HQZXPORT02',
          idempotencyKey: first.idempotencyKey,
        }),
      ),
    ),
    (error: unknown) => codeOf(error) === 'idempotency-key-reuse',
  );

  assert.equal(repository.queryLogs().length, 1);
});

test('the port exposes no way to change or remove a query log', () => {
  const repository = new InMemorySearchRepository();
  const operations = new Set<string>();

  return repository.withTransaction((tx) => {
    let proto: object | null = Object.getPrototypeOf(tx) as object | null;
    while (proto !== null && proto !== Object.prototype) {
      for (const key of Object.getOwnPropertyNames(proto)) operations.add(key);
      proto = Object.getPrototypeOf(proto) as object | null;
    }

    const mutators = [...operations]
      .filter((operation) => /update|delete|remove|amend|edit|rewrite|set[A-Z]/i.test(operation))
      .filter((operation) => operation !== 'deleteDocument');
    assert.deepEqual(mutators, [], 'a query log is append-only; a mutation path would break that');

    assert.ok(operations.has('insertDocument'));
    assert.ok(operations.has('deleteDocument'));
    assert.ok(operations.has('insertQueryLog'));
    assert.ok(operations.has('insertOutbox'));
    assert.ok(operations.has('searchDocuments'));
    return Promise.resolve();
  });
});

test('a failed transaction writes nothing', async () => {
  const repository = new InMemorySearchRepository();
  await assert.rejects(
    repository.withTransaction(async (tx) => {
      await tx.insertDocument(documentRecord({ documentId: 'doc_01HQZXROLLBK' }));
      throw new Error('something went wrong after the insert');
    }),
    /something went wrong/,
  );

  assert.equal(repository.documents().length, 0);
  assert.equal(repository.transactionsRolledBack, 1);
  assert.equal(repository.transactionsCommitted, 0);
});

test('lookups inside a transaction see what that transaction wrote', async () => {
  const repository = new InMemorySearchRepository();
  const document = documentRecord({ documentId: 'doc_01HQZXINTX' });

  const found = await repository.withTransaction(async (tx) => {
    await tx.insertDocument(document);
    return {
      byId: await tx.findDocumentById('doc_01HQZXINTX'),
      byKey: await tx.findDocumentByIdempotencyKey(document.idempotencyKey),
      missing: await tx.findDocumentById('doc_01HQZXNOSUCH'),
    };
  });

  assert.equal(found.byId?.documentId, 'doc_01HQZXINTX');
  assert.equal(found.byKey?.documentId, 'doc_01HQZXINTX');
  assert.equal(found.missing, null);
});

test('search documents are ranked by score, then time, then id', async () => {
  const repository = new InMemorySearchRepository();

  const result = await repository.withTransaction(async (tx) => {
    await tx.insertDocument(
      documentRecord({
        documentId: 'doc_rank_a',
        title: 'table table',
        description: 'a table',
        keywords: ['table'],
        updatedAt: '2026-04-01T12:00:00Z',
        idempotencyKey: 'idem_rank_a',
      }),
    );
    await tx.insertDocument(
      documentRecord({
        documentId: 'doc_rank_b',
        title: 'table',
        description: 'one table',
        keywords: [],
        updatedAt: '2026-04-01T12:00:01Z',
        idempotencyKey: 'idem_rank_b',
      }),
    );
    return tx.searchDocuments('table', {}, { limit: 10, offset: 0 });
  });

  assert.equal(result.documents.length, 2);
  assert.equal(result.documents[0]?.documentId, 'doc_rank_a');
});

// ---------------------------------------------------------------------------
// Adapter queries
// ---------------------------------------------------------------------------

test('every read projects timestamps as UTC text, never as a driver Date', async () => {
  const database = new RecordingDatabase({
    selects: [
      { match: /SELECT.*FROM.*\.document\b/i, rows: [documentRow()] },
      { match: /SELECT.*FROM.*\.query_log\b/i, rows: [queryLogRow()] },
    ],
  });
  await new PostgresSearchRepository(database).withTransaction(async (tx) => {
    await tx.findDocumentById('doc_01HQZXTESTROW');
    await tx.findDocumentByIdempotencyKey('idem_01HQZXTESTROW');
    await tx.findQueryLogById('qry_01HQZXTESTROW');
    await tx.findQueryLogByIdempotencyKey('idem_01HQZXTESTROW');
    await tx.searchDocuments('table', {}, { limit: 10, offset: 0 });
  });

  const selects = database.statements().filter((sql) => sql.startsWith('SELECT'));
  assert.equal(selects.length, 5, 'all read paths were exercised');

  for (const sql of selects) {
    const columnsInSql = TIMESTAMP_COLUMNS.filter((column) => sql.includes(`AS ${column}`));
    assert.ok(columnsInSql.length > 0, `no timestamp columns projected in: ${sql}`);

    for (const column of columnsInSql) {
      assert.match(
        sql,
        new RegExp(
          `to_char\\(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS\\.US"Z"'\\) AS ${column}`,
        ),
        `${column} must be projected as text: a Date holds milliseconds where the column holds microseconds`,
      );
      assert.ok(
        !new RegExp(`(SELECT|,)\\s*${column}\\s*(,|FROM)`).test(sql),
        `${column} is also selected raw, which would hand the driver something to parse`,
      );
    }
  }
});

test('no statement K-15 issues names another unit schema', async () => {
  const database = new RecordingDatabase({
    selects: [
      { match: /SELECT.*FROM.*\.document\b/i, rows: [documentRow()] },
      { match: /SELECT.*FROM.*\.query_log\b/i, rows: [queryLogRow()] },
    ],
  });
  const repository = new PostgresSearchRepository(database);

  await repository.withTransaction(async (tx) => {
    await tx.findDocumentById('doc_01HQZXTESTROW');
    await tx.findDocumentByIdempotencyKey('idem_01HQZXTESTROW');
    await tx.findQueryLogById('qry_01HQZXTESTROW');
    await tx.findQueryLogByIdempotencyKey('idem_01HQZXTESTROW');
    await tx.searchDocuments('table', {}, { limit: 10, offset: 0 });
    await tx.insertDocument(documentRecord({ documentId: 'doc_01HQZXSCHEMA' }));
  });

  assert.ok(database.statements().length > 0, 'statements were actually issued');
  for (const sql of database.statements()) {
    for (const schema of knownSchemas()) {
      if (schema === SEARCH_SCHEMA) continue;
      assert.ok(!sql.includes(`${schema}.`), `a K-15 statement reaches ${schema}: ${sql}`);
    }
  }
});

test('reads are parameterised and never interpolate the caller value', async () => {
  const database = new RecordingDatabase({ selects: [{ match: /SELECT/i, rows: [] }] });
  await new PostgresSearchRepository(database).withTransaction((tx) =>
    tx.findDocumentById("doc_01' OR 1=1--"),
  );

  const select = database.queries.find((query) => query.sql.startsWith('SELECT'));
  assert.ok(select !== undefined);
  assert.match(select.sql, /WHERE document_id = \$1;/);
  assert.deepEqual(select.params, ["doc_01' OR 1=1--"]);
});

test('document insert is one INSERT with bound parameters, inside BEGIN/COMMIT', async () => {
  const database = new RecordingDatabase();
  const document = documentRecord({ documentId: 'doc_01HQZXINSERT' });
  await new PostgresSearchRepository(database).withTransaction((tx) => tx.insertDocument(document));

  const statements = database.statements();
  assert.equal(statements[0], 'BEGIN;');
  assert.equal(statements[statements.length - 1], 'COMMIT;');

  const insert = database.queries.find((query) => /INSERT INTO/i.test(query.sql));
  assert.ok(insert !== undefined);
  assert.match(insert.sql, new RegExp(`INSERT INTO ${DOCUMENT_TABLE.replace('.', '\\.')}`));
  assert.equal(insert.params.length, 14);
  assert.equal(database.sessionsReleased, 1, 'the connection is released whatever happens');
});

test('a failure rolls back and still releases the connection', async () => {
  const database = new RecordingDatabase({ failOn: /INSERT INTO/i });
  await assert.rejects(
    new PostgresSearchRepository(database).withTransaction((tx) =>
      tx.insertDocument(documentRecord({ documentId: 'doc_01HQZXFAILED' })),
    ),
  );

  assert.ok(database.indexOf(/^ROLLBACK;$/m) > -1, 'the transaction was rolled back');
  assert.equal(database.indexOf(/^COMMIT;$/m), -1, 'and never committed');
  assert.equal(database.sessionsReleased, 1);
});

test('a unique violation becomes the refusal it actually is', async () => {
  for (const [constraint, expected] of [
    ['document_idempotency_unique', 'idempotency-key-reuse'],
    ['query_log_pkey', 'duplicate-query-id'],
    ['query_log_idempotency_unique', 'idempotency-key-reuse'],
    ['outbox_pkey', 'idempotency-key-reuse'],
    ['outbox_idempotency_unique', 'idempotency-key-reuse'],
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
      new PostgresSearchRepository(database).withTransaction((tx) =>
        tx.insertDocument(documentRecord({ documentId: 'doc_01HQZXCONFLICT' })),
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
    new PostgresSearchRepository(database).withTransaction((tx) =>
      tx.insertDocument(documentRecord({ documentId: 'doc_01HQZXCONNGONE' })),
    ),
    /connection terminated/,
  );
});

// ---------------------------------------------------------------------------
// Decoding — fail-closed, against the creation rules
// ---------------------------------------------------------------------------

test('a well-formed document row decodes, and comes back sealed', () => {
  const decoded = toDocument(documentRow());
  assert.equal(decoded.documentId, 'doc_01HQZXTESTROW');
  assert.equal(decoded.createdAt, '2026-04-01T12:00:00.000000Z');
  assert.ok(Object.isFrozen(decoded));
  assert.ok(Object.isFrozen(decoded.keywords));
});

test('a stored document row is held to exactly what creation demands', () => {
  const refused: ReadonlyArray<readonly [string, Record<string, unknown>, string]> = [
    ['an email as a document id', { document_id: 'alice@example.com' }, 'natural-identifier'],
    ['a short document id', { document_id: 'doc_1' }, 'malformed-identifier'],
    [
      'a credential as an idempotency key',
      { idempotency_key: 'bearer-zzzzzzzzzzzz' },
      'secret-bearing-input',
    ],
    ['an empty title', { title: '' }, 'malformed-record'],
    ['an array as attributes', { attributes: [] }, 'malformed-record'],
  ];

  for (const [why, columns, code] of refused) {
    assert.throws(
      () => toDocument({ ...documentRow(), ...columns }),
      (error: unknown) => {
        assert.equal(codeOf(error), code, why);
        return true;
      },
      `${why} must not come back as a real document`,
    );
  }
});

test('a well-formed query log row decodes, and comes back sealed', () => {
  const decoded = toQueryLog(queryLogRow());
  assert.equal(decoded.queryId, 'qry_01HQZXTESTROW');
  assert.equal(decoded.executedAt, '2026-04-01T12:00:10.000000Z');
  assert.ok(Object.isFrozen(decoded));
});

test('a stored query log row is held to exactly what creation demands', () => {
  const refused: ReadonlyArray<readonly [string, Record<string, unknown>, string]> = [
    ['an email as a query id', { query_id: 'alice@example.com' }, 'natural-identifier'],
    ['a short query id', { query_id: 'qry_1' }, 'malformed-identifier'],
    ['a negative result count', { result_count: -1 }, 'malformed-record'],
    ['an array as filters', { filters: [] }, 'malformed-record'],
  ];

  for (const [why, columns, code] of refused) {
    assert.throws(
      () => toQueryLog({ ...queryLogRow(), ...columns }),
      (error: unknown) => {
        assert.equal(codeOf(error), code, why);
        return true;
      },
      `${why} must not come back as a real query log`,
    );
  }
});

test('a malformed persisted timestamp is refused rather than approximated', () => {
  const malformed: ReadonlyArray<readonly [string, Record<string, unknown>, RegExp]> = [
    [
      'a Date instead of text',
      { created_at: new Date('2026-04-01T12:00:00Z') },
      /rather than text/,
    ],
    ['a millisecond timestamp', { created_at: '2026-04-01T12:00:00.000Z' }, /projected form/],
    ['an impossible date', { created_at: '2026-02-30T00:00:00.000000Z' }, /createdAt/],
  ];

  for (const [why, columns, message] of malformed) {
    assert.throws(
      () => toDocument({ ...documentRow(), ...columns }),
      (error: unknown) => {
        assert.equal(codeOf(error), 'malformed-record', why);
        assert.match((error as SearchError).message, message, why);
        return true;
      },
      `${why} must be refused`,
    );
  }
});

// ---------------------------------------------------------------------------
// Module contract
// ---------------------------------------------------------------------------

test('K-15 owns exactly one schema, derived from the manifest', () => {
  const component = KERNEL_COMPONENTS.find((entry) => entry.id === 'K-15');
  assert.ok(component !== undefined, 'K-15 is registered in the architecture manifest');
  assert.equal(component.dir, 'search-foundation');
  assert.equal(SEARCH_SCHEMA, `${KERNEL_SCHEMA_PREFIX}${component.dir.replace(/-/g, '_')}`);
  assert.ok(knownSchemas().includes(SEARCH_SCHEMA), 'the schema is one the platform knows about');
  assert.equal(DOCUMENT_TABLE, `${SEARCH_SCHEMA}.document`);
  assert.equal(QUERY_LOG_TABLE, `${SEARCH_SCHEMA}.query_log`);
});

test('neither the adapter nor the migration names another unit schema', () => {
  const MIGRATION_UP_CODE = stripNoise(MIGRATION_UP);
  const MIGRATION_DOWN_CODE = stripNoise(MIGRATION_DOWN);
  const ADAPTER_CODE = stripComments(ADAPTER_SOURCE);

  for (const schema of knownSchemas()) {
    if (schema === SEARCH_SCHEMA) continue;
    assert.ok(!ADAPTER_CODE.includes(`${schema}.`), `the adapter touches ${schema}`);
    assert.ok(!MIGRATION_UP_CODE.includes(`${schema}.`), `the forward migration touches ${schema}`);
    assert.ok(!MIGRATION_DOWN_CODE.includes(`${schema}.`), `the rollback touches ${schema}`);
  }
  assert.match(MIGRATION_UP, /^-- owner: kernel_search_foundation$/m);
  assert.match(MIGRATION_DOWN, /^-- owner: kernel_search_foundation$/m);

  assert.ok(
    !/REFERENCES/i.test(MIGRATION_UP_CODE),
    'no foreign key: a cross-schema one would make another schema unable to roll back',
  );
});

test('no source file in this component mutates or deletes a query log', () => {
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

    for (const forbidden of [
      /\bUPDATE\s+kernel_search_foundation\.query_log\b/i,
      /\bDELETE\s+FROM\s+kernel_search_foundation\.query_log\b/i,
      /\bTRUNCATE\s+kernel_search_foundation\.query_log\b/i,
    ]) {
      assert.ok(
        !forbidden.test(code),
        `${name} contains ${String(forbidden)} — a query log is append-only`,
      );
    }
  }
});

test('the migration enforces the document contract in the database', () => {
  assert.match(MIGRATION_UP, /CONSTRAINT document_pkey PRIMARY KEY \(document_id\)/);
  assert.match(MIGRATION_UP, /CONSTRAINT document_idempotency_unique UNIQUE \(idempotency_key\)/);

  for (const column of ['document_id', 'owner_id', 'idempotency_key']) {
    assert.match(
      MIGRATION_UP,
      new RegExp(`CHECK \\(kernel_search_foundation\\.is_opaque_identifier\\(${column}\\)\\)`),
      `${column} does not go through is_opaque_identifier`,
    );
  }

  assert.match(
    MIGRATION_UP,
    /CONSTRAINT document_title_present\s+CHECK \(length\(btrim\(title\)\) > 0\)/,
  );
  assert.match(
    MIGRATION_UP,
    /CONSTRAINT document_description_present\s+CHECK \(length\(btrim\(description\)\) > 0\)/,
  );

  for (const column of ['attributes', 'vectors', 'ranking']) {
    assert.match(
      MIGRATION_UP,
      new RegExp(
        `CONSTRAINT document_${column}_object\\s+CHECK \\(jsonb_typeof\\(${column}\\) = 'object'\\)`,
      ),
      `${column} must be checked as a JSON object`,
    );
  }
});

test('the migration enforces the query log contract in the database', () => {
  assert.match(MIGRATION_UP, /CONSTRAINT query_log_pkey PRIMARY KEY \(query_id\)/);
  assert.match(MIGRATION_UP, /CONSTRAINT query_log_idempotency_unique UNIQUE \(idempotency_key\)/);

  for (const column of ['query_id', 'correlation_id', 'idempotency_key']) {
    assert.match(
      MIGRATION_UP,
      new RegExp(`CHECK \\(kernel_search_foundation\\.is_opaque_identifier\\(${column}\\)\\)`),
      `${column} does not go through is_opaque_identifier`,
    );
  }

  assert.match(
    MIGRATION_UP,
    /CONSTRAINT query_log_result_count_non_negative\s+CHECK \(result_count >= 0\)/,
  );
  assert.match(
    MIGRATION_UP,
    /CONSTRAINT query_log_filters_object\s+CHECK \(jsonb_typeof\(filters\) = 'object'\)/,
  );
});

test('the migration creates the full-text search surface and outbox', () => {
  assert.match(MIGRATION_UP, /tsv\s+tsvector\s+GENERATED ALWAYS AS/);
  assert.match(MIGRATION_UP, /CREATE INDEX IF NOT EXISTS document_tsv_idx/);
  assert.match(MIGRATION_UP, /CREATE TABLE IF NOT EXISTS kernel_search_foundation\.outbox/);
  assert.match(MIGRATION_UP, /CONSTRAINT outbox_pkey PRIMARY KEY \(outbox_id\)/);
  assert.match(MIGRATION_UP, /CONSTRAINT outbox_idempotency_unique UNIQUE \(idempotency_key\)/);
});

test('the migration refuses mutation on the append-only query log', () => {
  assert.match(
    MIGRATION_UP,
    /CREATE OR REPLACE FUNCTION kernel_search_foundation\.refuse_mutation/,
  );
  assert.match(MIGRATION_UP, /RAISE EXCEPTION/);
  assert.match(
    MIGRATION_UP,
    /CREATE TRIGGER query_log_is_append_only\s+BEFORE UPDATE OR DELETE ON kernel_search_foundation\.query_log/,
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

  assert.ok(
    MIGRATION_DOWN.indexOf('DROP TRIGGER') < MIGRATION_DOWN.indexOf('DROP FUNCTION'),
    'a function cannot be dropped while a trigger still references it',
  );
  assert.ok(
    MIGRATION_DOWN.indexOf('DROP TABLE') <
      MIGRATION_DOWN.indexOf(
        'DROP FUNCTION IF EXISTS kernel_search_foundation.is_opaque_identifier',
      ),
    'the CHECK constraints reference the rule function, so the table must go first',
  );
  assert.match(MIGRATION_DOWN, /DROP SCHEMA IF EXISTS kernel_search_foundation RESTRICT/);
});

test('CONTRACT.md records the refusals the code actually raises', () => {
  for (const code of [
    'malformed-identifier',
    'natural-identifier',
    'secret-bearing-input',
    'malformed-instant',
    'foreign-concern',
    'malformed-record',
    'idempotency-key-reuse',
    'duplicate-query-id',
    'nested-transaction',
  ]) {
    assert.ok(CONTRACT.includes(`\`${code}\``), `CONTRACT.md does not document ${code}`);
  }
});
