/**
 * K-13 AI Gateway — port conformance, adapter queries, and the module contract.
 *
 * Proves the in-memory reference implementation, the PostgreSQL adapter's SQL shape, and the
 * migration/contract guarantees.
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
  AI_GATEWAY_SCHEMA,
  AIGatewayError,
  BINDING_TABLE,
  DECISION_TABLE,
  InMemoryAIGatewayRepository,
  PostgresAIGatewayRepository,
  RUN_TABLE,
  TASK_TABLE,
  toBinding,
  toDecision,
  toRun,
  toTask,
} from '../kernel/ai-gateway/index.ts';
import type { ModelBinding } from '../kernel/ai-gateway/index.ts';

import {
  bindingRow,
  decisionRow,
  modelBinding,
  runRow,
  taskRecord,
  taskRow,
} from './helpers/ai-gateway-fixtures.ts';
import { RecordingDatabase, sqlstateError } from './helpers/recording-database.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE_DIR = path.join(HERE, '..', 'kernel', 'ai-gateway');
const ADAPTER_SOURCE = readFileSync(path.join(MODULE_DIR, 'postgres-repository.ts'), 'utf8');
const PORT_SOURCE = readFileSync(path.join(MODULE_DIR, 'repository.ts'), 'utf8');
const SERVICE_SOURCE = readFileSync(path.join(MODULE_DIR, 'service.ts'), 'utf8');
const CONTRACT = readFileSync(path.join(MODULE_DIR, 'CONTRACT.md'), 'utf8');
const MIGRATIONS = path.join(HERE, '..', 'db', 'migrations');
const MIGRATION_UP = readFileSync(
  path.join(MIGRATIONS, '0019_create_kernel_ai_gateway_schema.up.sql'),
  'utf8',
);
const MIGRATION_DOWN = readFileSync(
  path.join(MIGRATIONS, '0019_create_kernel_ai_gateway_schema.down.sql'),
  'utf8',
);

const codeOf = (error: unknown): string | undefined =>
  error instanceof AIGatewayError ? error.code : undefined;

const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)\/\/[^\n]*/g, ' ');

// ---------------------------------------------------------------------------
// Port conformance
// ---------------------------------------------------------------------------

test('a task is created once and never rewritten', async () => {
  const repository = new InMemoryAIGatewayRepository();
  const first = taskRecord();
  await repository.withTransaction((tx) => tx.insertTask(first));

  await assert.rejects(
    repository.withTransaction((tx) =>
      tx.insertTask({ ...first, idempotencyKey: 'idem_task_conflict_01' }),
    ),
    (error: unknown) => codeOf(error) === 'duplicate-task-id',
  );
  await assert.rejects(
    repository.withTransaction((tx) =>
      tx.insertTask({ ...first, taskId: 'need.interpret_conflict_01' }),
    ),
    (error: unknown) => codeOf(error) === 'idempotency-key-reuse',
  );

  assert.equal(repository.tasks().length, 1);
});

test('a binding is created once and never rewritten', async () => {
  const repository = new InMemoryAIGatewayRepository();
  const first = modelBinding();
  await repository.withTransaction((tx) => tx.insertBinding(first));

  await assert.rejects(
    repository.withTransaction((tx) =>
      tx.insertBinding({ ...first, idempotencyKey: 'idem_bind_conflict_01' }),
    ),
    (error: unknown) => codeOf(error) === 'duplicate-binding-id',
  );
  await assert.rejects(
    repository.withTransaction((tx) =>
      tx.insertBinding({ ...first, bindingId: 'bind_01HQZXCONFLICT01' }),
    ),
    (error: unknown) => codeOf(error) === 'idempotency-key-reuse',
  );

  assert.equal(repository.bindings().length, 1);
});

test('the port exposes no way to mutate a gateway record', async () => {
  const repository = new InMemoryAIGatewayRepository();
  const operations = new Set<string>();

  await repository.withTransaction((tx) => {
    let proto: object | null = Object.getPrototypeOf(tx) as object | null;
    while (proto !== null && proto !== Object.prototype) {
      for (const key of Object.getOwnPropertyNames(proto)) operations.add(key);
      proto = Object.getPrototypeOf(proto) as object | null;
    }

    const mutators = [...operations].filter((op) =>
      /update|delete|remove|relink|merge|amend|close|suspend|purge|truncate|set[A-Z]/i.test(op),
    );
    assert.deepEqual(mutators, [], 'gateway records are append-only');
    assert.ok(operations.has('insertTask'));
    assert.ok(operations.has('insertBinding'));
    assert.ok(operations.has('insertRun'));
    assert.ok(operations.has('insertDecision'));
    assert.ok(operations.has('findBindingsByCapability'));
    return Promise.resolve();
  });
});

test('a failed transaction writes nothing', async () => {
  const repository = new InMemoryAIGatewayRepository();
  await assert.rejects(
    repository.withTransaction(async (tx) => {
      await tx.insertTask(taskRecord());
      throw new Error('something went wrong after the insert');
    }),
    /something went wrong/,
  );

  assert.equal(repository.tasks().length, 0, 'a caller that sees a failure assumes nothing ran');
  assert.equal(repository.transactionsRolledBack, 1);
  assert.equal(repository.transactionsCommitted, 0);
});

test('lookups inside a transaction see what that transaction wrote', async () => {
  const repository = new InMemoryAIGatewayRepository();
  const task = taskRecord();

  await repository.withTransaction(async (tx) => {
    await tx.insertTask(task);
    assert.equal((await tx.findTaskById(task.taskId))?.taskId, task.taskId);
    assert.equal((await tx.findTaskByIdempotencyKey(task.idempotencyKey))?.taskId, task.taskId);
    assert.equal(await tx.findTaskById('need.interpret_nosuch'), null);
    return Promise.resolve();
  });
});

test('findBindingsByCapability orders by priority then binding id', async () => {
  const repository = new InMemoryAIGatewayRepository();
  const bindings: ModelBinding[] = [
    modelBinding({ bindingId: 'bind_priority_03', priority: 3 }),
    modelBinding({ bindingId: 'bind_priority_01', priority: 1 }),
    modelBinding({ bindingId: 'bind_priority_01b', priority: 1 }),
  ];
  await repository.withTransaction(async (tx) => {
    for (const binding of bindings) await tx.insertBinding(binding);
    return Promise.resolve();
  });

  const found = await repository.withTransaction((tx) => tx.findBindingsByCapability('text'));
  assert.deepEqual(
    found.map((b) => b.bindingId),
    ['bind_priority_01', 'bind_priority_01b', 'bind_priority_03'],
  );
});

// ---------------------------------------------------------------------------
// Adapter queries
// ---------------------------------------------------------------------------

test('every read projects timestamps as UTC text, never as a driver Date', async () => {
  const database = new RecordingDatabase({
    selects: [
      { match: /FROM kernel_ai_gateway\.task_definition/i, rows: [taskRow()] },
      { match: /FROM kernel_ai_gateway\.model_binding/i, rows: [bindingRow()] },
      { match: /FROM kernel_ai_gateway\.ai_run/i, rows: [runRow()] },
      { match: /FROM kernel_ai_gateway\.ai_decision/i, rows: [decisionRow()] },
    ],
  });
  await new PostgresAIGatewayRepository(database).withTransaction(async (tx) => {
    await tx.findTaskById('need.interpret_testrow');
    await tx.findBindingById('bind_01HQZXTESTROW');
    await tx.findRunById('run_01HQZXTESTROW');
    await tx.findDecisionById('dec_01HQZXTESTROW');
  });

  const selects = database.statements().filter((sql) => sql.startsWith('SELECT'));
  assert.equal(selects.length, 4, 'all four read paths were exercised');

  const tableTimestamps: Readonly<Record<string, readonly string[]>> = {
    'kernel_ai_gateway.task_definition': ['created_at'],
    'kernel_ai_gateway.model_binding': ['created_at'],
    'kernel_ai_gateway.ai_run': ['started_at', 'finished_at'],
    'kernel_ai_gateway.ai_decision': ['recorded_at'],
  };

  for (const sql of selects) {
    const table = Object.keys(tableTimestamps).find((t) => sql.includes(`FROM ${t}`));
    assert.ok(table, `could not identify table for query: ${sql}`);
    const columns = tableTimestamps[table];
    assert.ok(columns, `no timestamp columns known for table ${table}`);
    for (const column of columns) {
      assert.match(
        sql,
        new RegExp(
          `to_char\\(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS\\.US"Z"'\\) AS ${column}`,
        ),
        `${column} must be projected as text`,
      );
      assert.ok(
        !new RegExp(`(SELECT|,)\\s*${column}\\s*(,|FROM)`).test(sql),
        `${column} is also selected raw, which would hand the driver something to parse`,
      );
    }
  }
});

test('no statement K-13 issues names another unit\u2019s schema', async () => {
  const database = new RecordingDatabase({
    selects: [
      { match: /FROM kernel_ai_gateway\.task_definition/i, rows: [taskRow()] },
      { match: /FROM kernel_ai_gateway\.model_binding/i, rows: [bindingRow()] },
      { match: /FROM kernel_ai_gateway\.ai_run/i, rows: [runRow()] },
      { match: /FROM kernel_ai_gateway\.ai_decision/i, rows: [decisionRow()] },
    ],
  });
  const repository = new PostgresAIGatewayRepository(database);

  await repository.withTransaction(async (tx) => {
    await tx.findTaskById('need.interpret_testrow');
    await tx.findBindingById('bind_01HQZXTESTROW');
    await tx.findRunById('run_01HQZXTESTROW');
    await tx.findDecisionById('dec_01HQZXTESTROW');
    await tx.insertTask(taskRecord());
    await tx.insertBinding(modelBinding());
  });

  assert.ok(database.statements().length > 0, 'statements were actually issued');
  for (const sql of database.statements()) {
    for (const schema of knownSchemas()) {
      if (schema === AI_GATEWAY_SCHEMA) continue;
      assert.ok(!sql.includes(`${schema}.`), `a K-13 statement reaches ${schema}: ${sql}`);
    }
  }
});

test('reads are parameterised and never interpolate the caller\u2019s value', async () => {
  const database = new RecordingDatabase({ selects: [{ match: /SELECT/i, rows: [] }] });
  await new PostgresAIGatewayRepository(database).withTransaction((tx) =>
    tx.findTaskById("need.interpret' OR 1=1--"),
  );

  const select = database.queries.find((query) => query.sql.startsWith('SELECT'));
  assert.ok(select !== undefined);
  assert.match(select.sql, /WHERE task_id = \$1;/);
  assert.deepEqual(select.params, ["need.interpret' OR 1=1--"]);
});

test('findBindingsByCapability parameterises the capability and enabled filter', async () => {
  const database = new RecordingDatabase({ selects: [{ match: /SELECT/i, rows: [] }] });
  await new PostgresAIGatewayRepository(database).withTransaction((tx) =>
    tx.findBindingsByCapability('vision'),
  );

  const select = database.queries.find((query) => query.sql.startsWith('SELECT'));
  assert.ok(select !== undefined);
  assert.match(select.sql, /WHERE \$1 = ANY\(capabilities\) AND enabled = true/);
  assert.deepEqual(select.params, ['vision']);
});

test('a write is one INSERT inside BEGIN/COMMIT and releases the connection', async () => {
  const database = new RecordingDatabase();
  const task = taskRecord({ taskId: 'need.interpret_insert' });
  await new PostgresAIGatewayRepository(database).withTransaction((tx) => tx.insertTask(task));

  const statements = database.statements();
  assert.equal(statements[0], 'BEGIN;');
  assert.equal(statements[statements.length - 1], 'COMMIT;');

  const insert = database.queries.find((query) => /INSERT INTO/i.test(query.sql));
  assert.ok(insert !== undefined);
  assert.match(insert.sql, new RegExp(`INSERT INTO ${TASK_TABLE.replace('.', '\\.')}`));
  assert.equal(database.sessionsReleased, 1, 'the connection is released whatever happens');
});

test('a failure rolls back and still releases the connection', async () => {
  const database = new RecordingDatabase({ failOn: /INSERT INTO/i });
  await assert.rejects(
    new PostgresAIGatewayRepository(database).withTransaction((tx) =>
      tx.insertTask(taskRecord({ taskId: 'need.interpret_failed' })),
    ),
  );

  assert.ok(database.indexOf(/^ROLLBACK;$/u) > -1, 'the transaction was rolled back');
  assert.equal(database.indexOf(/^COMMIT;$/u), -1, 'and never committed');
  assert.equal(database.sessionsReleased, 1);
});

test('a unique violation becomes the refusal it actually is', async () => {
  for (const [constraint, expected] of [
    ['task_definition_pkey', 'duplicate-task-id'],
    ['task_definition_idempotency_unique', 'idempotency-key-reuse'],
    ['model_binding_pkey', 'duplicate-binding-id'],
    ['model_binding_idempotency_unique', 'idempotency-key-reuse'],
    ['ai_run_pkey', 'duplicate-run-id'],
    ['ai_run_idempotency_unique', 'idempotency-key-reuse'],
    ['ai_decision_pkey', 'duplicate-decision-id'],
    ['ai_decision_idempotency_unique', 'idempotency-key-reuse'],
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
      new PostgresAIGatewayRepository(database).withTransaction((tx) =>
        tx.insertTask(taskRecord({ taskId: `need.interpret_conflict_${constraint}` })),
      ),
      (error: unknown) => codeOf(error) === expected,
      `${constraint} must surface as ${expected}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

test('a well-formed task row decodes and comes back sealed', () => {
  const decoded = toTask(taskRow());
  assert.equal(decoded.taskId, 'need.interpret_testrow');
  assert.equal(decoded.createdAt, '2026-04-01T12:00:00Z');
  assert.ok(Object.isFrozen(decoded));
});

test('a well-formed binding row decodes costs as bigint', () => {
  const decoded = toBinding(bindingRow());
  assert.equal(decoded.costPer1KInput, 5n);
  assert.equal(decoded.costPer1KOutput, 10n);
  assert.ok(Object.isFrozen(decoded));
});

test('a well-formed run row decodes and comes back sealed', () => {
  const decoded = toRun(runRow());
  assert.equal(decoded.runId, 'run_01HQZXTESTROW');
  assert.equal(decoded.cost.totalCost, 15n);
  assert.ok(Object.isFrozen(decoded));
  assert.ok(Object.isFrozen(decoded.input));
  assert.ok(Object.isFrozen(decoded.output));
  assert.ok(Object.isFrozen(decoded.cost));
});

test('a well-formed decision row decodes and comes back sealed', () => {
  const decoded = toDecision(decisionRow());
  assert.equal(decoded.decisionId, 'dec_01HQZXTESTROW');
  assert.equal(decoded.policyLevel, 2);
  assert.ok(Object.isFrozen(decoded));
});

test('a stored task row is held to exactly what creation demands', () => {
  const refused: ReadonlyArray<readonly [string, Record<string, unknown>, string]> = [
    ['a short task id', { task_id: 'x' }, 'malformed-task-id'],
    ['an unknown capability', { capability: 'time-travel' }, 'invalid-capability'],
    [
      'a Date instead of text',
      { created_at: new Date('2026-04-01T12:00:00Z') },
      'malformed-record',
    ],
    ['a millisecond timestamp', { created_at: '2026-04-01T12:00:00.000Z' }, 'malformed-record'],
  ];

  for (const [why, columns, code] of refused) {
    assert.throws(
      () => toTask(taskRow(columns)),
      (error: unknown) => {
        assert.equal(codeOf(error), code, why);
        assert.match(
          (error as AIGatewayError).message,
          /not written by this component/i,
          `${why}: the refusal must send the reader to the database`,
        );
        return true;
      },
      `${why} must not come back as a real task`,
    );
  }
});

test('a stored binding row is held to exactly what creation demands', () => {
  const refused: ReadonlyArray<readonly [string, Record<string, unknown>, string]> = [
    ['an email as a binding id', { binding_id: 'alice@example.com' }, 'natural-identifier'],
    ['an unknown provider', { provider: 'skynet' }, 'invalid-provider'],
    ['a negative cost', { cost_per_1k_input: '-1' }, 'invalid-cost'],
  ];

  for (const [why, columns, code] of refused) {
    assert.throws(
      () => toBinding(bindingRow(columns)),
      (error: unknown) => {
        assert.equal(codeOf(error), code, why);
        assert.match(
          (error as AIGatewayError).message,
          /not written by this component/i,
          `${why}: the refusal must send the reader to the database`,
        );
        return true;
      },
      `${why} must not come back as a real binding`,
    );
  }
});

test('a stored run row is held to exactly what creation demands', () => {
  const refused: ReadonlyArray<readonly [string, Record<string, unknown>, string]> = [
    [
      'a Date instead of text',
      { started_at: new Date('2026-04-01T12:00:00Z') },
      'malformed-record',
    ],
    ['a negative token count', { input_tokens: -1 }, 'malformed-record'],
  ];

  for (const [why, columns, code] of refused) {
    assert.throws(
      () => toRun(runRow(columns)),
      (error: unknown) => {
        assert.equal(codeOf(error), code, why);
        assert.match(
          (error as AIGatewayError).message,
          /not written by this component/i,
          `${why}: the refusal must send the reader to the database`,
        );
        return true;
      },
      `${why} must not come back as a real run`,
    );
  }
});

// ---------------------------------------------------------------------------
// Module contract
// ---------------------------------------------------------------------------

test('the manifest lists K-13 with the expected directory', () => {
  const component = KERNEL_COMPONENTS.find((c) => c.id === 'K-13');
  assert.ok(component);
  assert.equal(component.dir, 'ai-gateway');
});

test('CONTRACT.md names the correct schema and migration', () => {
  assert.match(CONTRACT, /\*\*Schema:\*\* `kernel_ai_gateway`/);
  assert.match(CONTRACT, /0019_create_kernel_ai_gateway_schema\.up\.sql/);
});

test('the adapter source never imports a business or financial module', () => {
  const source = stripComments(ADAPTER_SOURCE);
  assert.ok(!source.includes('modules/'), 'the adapter must not import a business module');
  assert.ok(!source.includes('kernel/ledger-foundation'), 'the adapter must not import K-10');
});

test('the service source never imports a business or financial module', () => {
  const source = stripComments(SERVICE_SOURCE);
  assert.ok(!source.includes('modules/'), 'the service must not import a business module');
  assert.ok(!source.includes('kernel/ledger-foundation'), 'the service must not import K-10');
});

test('the port source never imports a business or financial module', () => {
  const source = stripComments(PORT_SOURCE);
  assert.ok(!source.includes('modules/'), 'the port must not import a business module');
  assert.ok(!source.includes('kernel/ledger-foundation'), 'the port must not import K-10');
});

test('the migration creates the expected schema and tables', () => {
  assert.match(MIGRATION_UP, /CREATE SCHEMA IF NOT EXISTS kernel_ai_gateway/);
  assert.match(MIGRATION_UP, /CREATE TABLE IF NOT EXISTS kernel_ai_gateway\.task_definition/);
  assert.match(MIGRATION_UP, /CREATE TABLE IF NOT EXISTS kernel_ai_gateway\.model_binding/);
  assert.match(MIGRATION_UP, /CREATE TABLE IF NOT EXISTS kernel_ai_gateway\.ai_run/);
  assert.match(MIGRATION_UP, /CREATE TABLE IF NOT EXISTS kernel_ai_gateway\.ai_decision/);
  assert.match(MIGRATION_UP, /CREATE TABLE IF NOT EXISTS kernel_ai_gateway\.outbox/);
});

test('the migration has append-only triggers on the business tables', () => {
  for (const name of [
    'task_definition_is_append_only',
    'model_binding_is_append_only',
    'ai_run_is_append_only',
    'ai_decision_is_append_only',
  ]) {
    assert.match(MIGRATION_UP, new RegExp(`CREATE TRIGGER ${name}`));
  }
});

test('the migration down drops the schema cascade after triggers and tables', () => {
  assert.match(MIGRATION_DOWN, /DROP SCHEMA IF EXISTS kernel_ai_gateway CASCADE/);
  assert.match(MIGRATION_DOWN, /DROP TRIGGER IF EXISTS task_definition_is_append_only/);
  assert.match(MIGRATION_DOWN, /DROP FUNCTION IF EXISTS kernel_ai_gateway\.refuse_mutation\(\)/);
});

test('the migration copies is_opaque_identifier character-for-character', () => {
  const stripped = stripNoise(MIGRATION_UP);
  assert.match(
    stripped,
    /CREATE OR REPLACE FUNCTION kernel_ai_gateway\.is_opaque_identifier\(value text\)/,
  );
});

test('the adapter table constants match the migration schema', () => {
  assert.equal(TASK_TABLE, 'kernel_ai_gateway.task_definition');
  assert.equal(BINDING_TABLE, 'kernel_ai_gateway.model_binding');
  assert.equal(RUN_TABLE, 'kernel_ai_gateway.ai_run');
  assert.equal(DECISION_TABLE, 'kernel_ai_gateway.ai_decision');
  assert.ok(AI_GATEWAY_SCHEMA.startsWith(KERNEL_SCHEMA_PREFIX));
});
