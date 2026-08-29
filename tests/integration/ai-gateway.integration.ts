/**
 * K-13 AI Gateway against a live PostgreSQL server — opt-in, and honestly skipped otherwise.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { AIGatewayService, PostgresAIGatewayRepository } from '../../kernel/ai-gateway/index.ts';
import { MockAIProvider } from '../../kernel/ai-gateway/index.ts';
import { migrateDown, migrateUp } from '../../platform/db/runner.ts';
import type { Database } from '../../platform/db/client.ts';

import {
  executeTaskRequest,
  grantAuthorityRequest,
  recordDecisionRequest,
  registerModelRequest,
  registerTaskRequest,
} from '../helpers/ai-gateway-fixtures.ts';
import {
  developmentDatabaseName,
  developmentSnapshot,
  liveTestOptions,
  withTestDatabase,
} from './harness.ts';

function resolveProvider(provider: string): MockAIProvider {
  if (provider === 'mock') return new MockAIProvider();
  throw new Error(`provider ${provider} has no test adapter`);
}

async function count(database: Database, table: string): Promise<number> {
  const client = await database.connect();
  try {
    const result = await client.query<{ count: string }>(`SELECT count(*) AS count FROM ${table};`);
    return Number(result.rows[0]?.count ?? 0);
  } finally {
    await client.release();
  }
}

async function refuses(database: Database, sql: string): Promise<string | null> {
  const client = await database.connect();
  try {
    await client.query(sql);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  } finally {
    await client.release();
  }
}

test(
  'registers a task and binding, executes a task, and records a decision end-to-end',
  liveTestOptions,
  async () => {
    const before = await developmentSnapshot();

    await withTestDatabase(async ({ database, directory, name }) => {
      assert.notEqual(
        name,
        developmentDatabaseName(),
        'the target is never the development database',
      );
      await migrateUp(database, { directory });

      const service = new AIGatewayService(
        new PostgresAIGatewayRepository(database),
        resolveProvider,
      );

      const task = await service.registerTask(
        registerTaskRequest({ taskId: 'need.interpret_live' }),
      );
      assert.equal(task.deduplicated, false);

      const binding = await service.registerModel(
        registerModelRequest({ bindingId: 'bind_live_01' }),
      );
      assert.equal(binding.deduplicated, false);

      // A task runs only at a level a human granted it, so the grant is part of the end-to-end path.
      const grant = await service.grantAuthority(
        grantAuthorityRequest({
          authorityId: 'auth_live_01',
          taskId: task.task.taskId,
          maxAuthority: 2,
          idempotencyKey: 'idem_auth_live_01',
        }),
      );
      assert.equal(grant.deduplicated, false);

      const inForce = await service.resolveAuthority(task.task.taskId, '2026-04-01T12:00:00Z');
      assert.equal(inForce?.authorityId, 'auth_live_01');
      assert.equal(inForce?.maxAuthority, 2);

      const run = await service.executeTask(
        executeTaskRequest({
          runId: 'run_live_01',
          taskId: task.task.taskId,
          idempotencyKey: 'idem_run_live_01',
          requestedAuthority: 2,
        }),
      );
      assert.equal(run.deduplicated, false);
      assert.equal(run.run.authorityLevel, 2, 'the level must survive the round trip through SQL');
      assert.equal(run.run.taskId, task.task.taskId);
      assert.equal(run.run.bindingId, binding.binding.bindingId);
      assert.ok(run.run.cost.totalCost > 0n);

      const decision = await service.recordDecision(
        recordDecisionRequest({
          decisionId: 'dec_live_01',
          taskId: task.task.taskId,
          runId: run.run.runId,
          idempotencyKey: 'idem_dec_live_01',
        }),
      );
      assert.equal(decision.deduplicated, false);
      assert.equal(decision.decision.runId, run.run.runId);

      assert.equal(await count(database, 'kernel_ai_gateway.task_definition'), 1);
      assert.equal(await count(database, 'kernel_ai_gateway.model_binding'), 1);
      assert.equal(await count(database, 'kernel_ai_gateway.ai_run'), 1);
      assert.equal(await count(database, 'kernel_ai_gateway.ai_decision'), 1);
      assert.equal(await count(database, 'kernel_ai_gateway.task_authority'), 1);
      // Six: an event and an audit record for each of the grant, the run and the decision.
      assert.equal(await count(database, 'kernel_ai_gateway.outbox'), 6);
    });

    const after = await developmentSnapshot();
    assert.deepEqual(
      after.applied.map((entry) => entry.version),
      before.applied.map((entry) => entry.version),
      'the development database was read and never written',
    );
  },
);

test('the database refuses a duplicate task id', liveTestOptions, async () => {
  await withTestDatabase(async ({ database, directory }) => {
    await migrateUp(database, { directory });
    const service = new AIGatewayService(
      new PostgresAIGatewayRepository(database),
      resolveProvider,
    );

    await service.registerTask(registerTaskRequest({ taskId: 'need.interpret_dup' }));

    const result = await refuses(
      database,
      `INSERT INTO kernel_ai_gateway.task_definition
           (task_id, task_name, description, input_schema, output_schema, capability, created_at, idempotency_key)
         VALUES ('need.interpret_dup', 'Other', 'Other desc', '{}', '{}', 'text', '2026-04-01T12:00:00Z', 'idem_task_dup_02');`,
    );
    assert.ok(result !== null, 'a duplicate task id must be refused');
    assert.match(result, /unique constraint/i);
  });
});

test('the database refuses to mutate a task', liveTestOptions, async () => {
  await withTestDatabase(async ({ database, directory }) => {
    await migrateUp(database, { directory });
    const service = new AIGatewayService(
      new PostgresAIGatewayRepository(database),
      resolveProvider,
    );

    const task = await service.registerTask(
      registerTaskRequest({ taskId: 'need.interpret_mutate' }),
    );

    const update = await refuses(
      database,
      `UPDATE kernel_ai_gateway.task_definition SET capability = 'vision' WHERE task_id = '${task.task.taskId}';`,
    );
    assert.ok(update !== null, 'updating a task must be refused');
    assert.match(update, /append-only/i);

    const deleteTask = await refuses(
      database,
      `DELETE FROM kernel_ai_gateway.task_definition WHERE task_id = '${task.task.taskId}';`,
    );
    assert.ok(deleteTask !== null, 'deleting a task must be refused');
    assert.match(deleteTask, /append-only/i);
  });
});

test('the database enforces the policy level range', liveTestOptions, async () => {
  await withTestDatabase(async ({ database, directory }) => {
    await migrateUp(database, { directory });

    const result = await refuses(
      database,
      `INSERT INTO kernel_ai_gateway.ai_decision
           (decision_id, task_id, run_id, policy_level, approved, explanation, recorded_at, idempotency_key)
         VALUES ('dec_01HQZXBADLVL1', 'need.interpret_test', NULL, 5, true, 'x', '2026-04-01T12:00:00Z', 'idem_dec_badlevel_01');`,
    );
    assert.ok(result !== null, 'a policy level outside 0-4 must be refused');
    assert.match(result, /policy_level_range/i);
  });
});

test(
  "rolling back K-13's newest migration removes only K-13's objects",
  liveTestOptions,
  async () => {
    await withTestDatabase(async ({ database, directory }) => {
      // K-13's schema is 0019 as extended by 0023, and the repository writes what 0023 adds, so
      // this runs against the head rather than pairing today's code with yesterday's schema.
      await migrateUp(database, { directory, target: '0023' });
      const service = new AIGatewayService(
        new PostgresAIGatewayRepository(database),
        resolveProvider,
      );

      await service.registerTask(registerTaskRequest({ taskId: 'need.interpret_rollback' }));

      // What is asserted here is narrower than it once was, and deliberately so.
      //
      // The runner rolls back in strict reverse order, one version at a time. When K-13's whole
      // schema was one migration at the head, "roll K-13 back" and "roll the newest migration
      // back" were the same act, and the test could prove the schema vanished without disturbing
      // anything else. Now that 0023 extends 0019 across migrations owned by K-14, K-15 and K-10,
      // removing K-13 entirely would mean rolling those back first — which would prove nothing
      // about isolation, because it is not isolated.
      //
      // The property that still holds, and is the one worth guarding, is that rolling back K-13's
      // own newest migration takes K-13's newest objects and nothing else.
      await migrateDown(database, { directory, version: '0023' });

      const client = await database.connect();
      try {
        await assert.rejects(
          client.query('SELECT 1 FROM kernel_ai_gateway.task_authority LIMIT 1;'),
          'the table 0023 created must be gone',
        );

        const survived = await client.query<{ readonly present: number }>(
          'SELECT count(*)::int AS present FROM kernel_ai_gateway.task_definition;',
        );
        assert.equal(
          survived.rows[0]?.present,
          1,
          "0023's rollback must leave the row 0019's table is holding",
        );

        // Neighbouring schemas are untouched by K-13's rollback.
        for (const table of [
          'kernel_identity.identity_subject',
          'kernel_ledger_foundation.asset_type',
          'kernel_search_foundation.document',
        ]) {
          await client.query(`SELECT 1 FROM ${table} LIMIT 1;`);
        }
      } finally {
        await client.release();
      }
    });
  },
);
