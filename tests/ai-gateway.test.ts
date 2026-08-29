/**
 * K-13 AI Gateway — contract tests.
 *
 * Proves the public API, every refusal, idempotency, routing, cost capture, and the fact that the
 * gateway carries no business-module fields.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AIGatewayError,
  AIGatewayService,
  FOREIGN_FIELDS,
  InMemoryAIGatewayRepository,
} from '../kernel/ai-gateway/index.ts';

import {
  build,
  executeTaskRequest,
  grantAuthorityRequest,
  recordDecisionRequest,
  registerModelRequest,
  registerTaskRequest,
  resolveMockProvider,
  taskRecord,
} from './helpers/ai-gateway-fixtures.ts';

const codeOf = (error: unknown): string | undefined =>
  error instanceof AIGatewayError ? error.code : undefined;

function service(): AIGatewayService {
  return new AIGatewayService(new InMemoryAIGatewayRepository(), resolveMockProvider);
}

/**
 * Register a task and authorise it to run.
 *
 * Both, because a task that has not been granted authority does not execute — that is the point of
 * the authority model, and it is proved on its own in ai-gateway-authority.test.ts rather than
 * incidentally by every test that wanted a working task. The ceiling is the maximum so these tests
 * exercise routing, cost and idempotency rather than the gate.
 */
async function registerTask(
  svc: AIGatewayService,
  overrides = {},
): Promise<{ taskId: string; idempotencyKey: string }> {
  const result = await svc.registerTask(registerTaskRequest(overrides));
  assert.equal(result.deduplicated, false);
  await svc.grantAuthority(
    grantAuthorityRequest({ taskId: result.task.taskId, maxAuthority: 4, suspended: false }),
  );
  return { taskId: result.task.taskId, idempotencyKey: result.task.idempotencyKey };
}

async function registerModel(
  svc: AIGatewayService,
  overrides = {},
): Promise<{ bindingId: string; idempotencyKey: string }> {
  const result = await svc.registerModel(registerModelRequest(overrides));
  assert.equal(result.deduplicated, false);
  return { bindingId: result.binding.bindingId, idempotencyKey: result.binding.idempotencyKey };
}

// ---------------------------------------------------------------------------
// registerTask
// ---------------------------------------------------------------------------

test('registerTask stores a task and returns it', async () => {
  const svc = service();
  const request = registerTaskRequest();
  const result = await svc.registerTask(request);
  assert.equal(result.deduplicated, false);
  assert.equal(result.task.taskId, request.taskId);
  assert.equal(result.task.capability, 'text');
  assert.deepEqual(Object.keys(result.task).sort(), [
    'capability',
    'createdAt',
    'description',
    'idempotencyKey',
    'inputSchema',
    'outputSchema',
    'taskId',
    'taskName',
  ]);
});

test('registerTask is idempotent for identical requests', async () => {
  const svc = service();
  const request = registerTaskRequest();
  const first = await svc.registerTask(request);
  const second = await svc.registerTask(request);
  assert.equal(first.task.taskId, second.task.taskId);
  assert.equal(second.deduplicated, true);
});

test('registerTask refuses a task id that is not dotted lowercase', async () => {
  const svc = service();
  await assert.rejects(
    svc.registerTask(registerTaskRequest({ taskId: 'NotDotted' })),
    (error: unknown) => codeOf(error) === 'malformed-task-id',
  );
});

test('registerTask refuses a malformed instant', async () => {
  const svc = service();
  await assert.rejects(
    svc.registerTask(registerTaskRequest({ createdAt: 'tomorrow' })),
    (error: unknown) => codeOf(error) === 'malformed-instant',
  );
});

test('registerTask refuses an unknown capability', async () => {
  const svc = service();
  await assert.rejects(
    svc.registerTask(registerTaskRequest({ capability: 'time-travel' as unknown as 'text' })),
    (error: unknown) => codeOf(error) === 'invalid-capability',
  );
});

test('registerTask refuses a foreign field', async () => {
  const svc = service();
  await assert.rejects(
    svc.registerTask({ ...registerTaskRequest(), orderId: 'ord_12345678' } as unknown as ReturnType<
      typeof registerTaskRequest
    >),
    (error: unknown) => codeOf(error) === 'foreign-concern',
  );
});

test('registerTask refuses an idempotency key reused for a different task', async () => {
  const svc = service();
  const key = 'idem_reused_task_0001';
  await svc.registerTask(registerTaskRequest({ idempotencyKey: key }));
  await assert.rejects(
    svc.registerTask(registerTaskRequest({ idempotencyKey: key })),
    (error: unknown) => codeOf(error) === 'idempotency-key-reuse',
  );
});

test('registerTask refuses a duplicate task id with different content', async () => {
  const svc = service();
  const taskId = 'need.interpret_dup_01';
  await svc.registerTask(registerTaskRequest({ taskId }));
  await assert.rejects(
    svc.registerTask(registerTaskRequest({ taskId, taskName: 'Different' })),
    (error: unknown) => codeOf(error) === 'duplicate-task-id',
  );
});

// ---------------------------------------------------------------------------
// registerModel
// ---------------------------------------------------------------------------

test('registerModel stores a binding and returns it', async () => {
  const svc = service();
  const request = registerModelRequest();
  const result = await svc.registerModel(request);
  assert.equal(result.deduplicated, false);
  assert.equal(result.binding.bindingId, request.bindingId);
  assert.equal(result.binding.costPer1KInput, 5n);
});

test('registerModel is idempotent for identical requests', async () => {
  const svc = service();
  const request = registerModelRequest();
  const first = await svc.registerModel(request);
  const second = await svc.registerModel(request);
  assert.equal(first.binding.bindingId, second.binding.bindingId);
  assert.equal(second.deduplicated, true);
});

test('registerModel refuses an unknown provider', async () => {
  const svc = service();
  await assert.rejects(
    svc.registerModel(registerModelRequest({ provider: 'unknown' as unknown as 'mock' })),
    (error: unknown) => codeOf(error) === 'invalid-provider',
  );
});

test('registerModel refuses an empty capabilities array', async () => {
  const svc = service();
  await assert.rejects(
    svc.registerModel(registerModelRequest({ capabilities: [] })),
    (error: unknown) => codeOf(error) === 'invalid-capability',
  );
});

test('registerModel refuses a negative cost', async () => {
  const svc = service();
  await assert.rejects(
    svc.registerModel(registerModelRequest({ costPer1KInput: -1n })),
    (error: unknown) => codeOf(error) === 'invalid-cost',
  );
});

test('registerModel refuses a reused idempotency key for a different binding', async () => {
  const svc = service();
  const key = 'idem_reused_bind_0001';
  await svc.registerModel(registerModelRequest({ idempotencyKey: key }));
  await assert.rejects(
    svc.registerModel(registerModelRequest({ idempotencyKey: key })),
    (error: unknown) => codeOf(error) === 'idempotency-key-reuse',
  );
});

test('registerModel refuses a duplicate binding id with different content', async () => {
  const svc = service();
  const bindingId = 'bind_01HQZXDUPLICATE01';
  await svc.registerModel(registerModelRequest({ bindingId }));
  await assert.rejects(
    svc.registerModel(registerModelRequest({ bindingId, modelId: 'different' })),
    (error: unknown) => codeOf(error) === 'duplicate-binding-id',
  );
});

// ---------------------------------------------------------------------------
// executeTask
// ---------------------------------------------------------------------------

test('executeTask routes to the only capable binding and captures cost', async () => {
  const svc = service();
  const { taskId } = await registerTask(svc);
  const { bindingId } = await registerModel(svc);
  const request = executeTaskRequest({ taskId });
  const result = await svc.executeTask(request);

  assert.equal(result.deduplicated, false);
  assert.equal(result.run.taskId, taskId);
  assert.equal(result.run.bindingId, bindingId);
  assert.equal(result.run.status, 'success');
  assert.equal(result.run.correlationId, request.correlationId);
  assert.ok(result.run.cost.inputTokens > 0);
  assert.ok(result.run.cost.outputTokens > 0);
  assert.ok(result.run.cost.totalCost > 0n);
  assert.equal(result.run.cost.assetTypeId, 'usd');
});

test('executeTask is idempotent for identical requests', async () => {
  const svc = service();
  const { taskId } = await registerTask(svc);
  await registerModel(svc);
  const request = executeTaskRequest({ taskId });
  const first = await svc.executeTask(request);
  const second = await svc.executeTask(request);
  assert.equal(first.run.runId, second.run.runId);
  assert.equal(second.deduplicated, true);
});

test('executeTask selects the lowest-priority capable binding', async () => {
  const svc = service();
  const { taskId } = await registerTask(svc);
  const low = await registerModel(svc, { bindingId: 'bind_01HQZXLOW00001', priority: 5 });
  const high = await registerModel(svc, { bindingId: 'bind_01HQZXHIGH0001', priority: 1 });
  const result = await svc.executeTask(executeTaskRequest({ taskId }));
  assert.equal(result.run.bindingId, high.bindingId);
  assert.notEqual(result.run.bindingId, low.bindingId);
});

test('executeTask skips disabled bindings', async () => {
  const svc = service();
  const { taskId } = await registerTask(svc);
  await registerModel(svc, { bindingId: 'bind_01HQZXDISABLED1', enabled: false });
  const active = await registerModel(svc, { bindingId: 'bind_01HQZXACTIVE001' });
  const result = await svc.executeTask(executeTaskRequest({ taskId }));
  assert.equal(result.run.bindingId, active.bindingId);
});

test('executeTask refuses when the task does not exist', async () => {
  const svc = service();
  await assert.rejects(
    svc.executeTask(executeTaskRequest({ taskId: 'need.interpret_missing' })),
    (error: unknown) => codeOf(error) === 'no-such-task',
  );
});

test('executeTask refuses when no binding supports the capability', async () => {
  const svc = service();
  const { taskId } = await registerTask(svc, { capability: 'vision' });
  await registerModel(svc, { capabilities: ['text'] });
  await assert.rejects(
    svc.executeTask(executeTaskRequest({ taskId })),
    (error: unknown) => codeOf(error) === 'no-capable-binding',
  );
});

test('executeTask refuses a reused idempotency key for a different run', async () => {
  const svc = service();
  const { taskId } = await registerTask(svc);
  await registerModel(svc);
  const key = 'idem_reused_run_0001';
  await svc.executeTask(executeTaskRequest({ taskId, idempotencyKey: key }));
  await assert.rejects(
    svc.executeTask(executeTaskRequest({ taskId, idempotencyKey: key })),
    (error: unknown) => codeOf(error) === 'idempotency-key-reuse',
  );
});

test('executeTask refuses a duplicate run id with different content', async () => {
  const svc = service();
  const { taskId } = await registerTask(svc);
  await registerModel(svc);
  const runId = 'run_01HQZXDUPLICATE1';
  await svc.executeTask(executeTaskRequest({ taskId, runId }));
  await assert.rejects(
    svc.executeTask(executeTaskRequest({ taskId, runId, input: { text: 'different' } })),
    (error: unknown) => codeOf(error) === 'duplicate-run-id',
  );
});

test('executeTask output is deterministic for the same input and task', async () => {
  const svc = service();
  const { taskId } = await registerTask(svc, { taskId: 'need.interpret_determine' });
  await registerModel(svc);
  const request = executeTaskRequest({ taskId, input: { text: 'same input' } });
  const first = await svc.executeTask(request);
  const second = await svc.executeTask(
    executeTaskRequest({
      taskId,
      input: { text: 'same input' },
      runId: 'run_01HQZXDETERMINE2',
      idempotencyKey: 'idem_run_determine_02',
    }),
  );
  assert.deepEqual(first.run.output, second.run.output);
  assert.equal(first.run.cost.inputTokens, second.run.cost.inputTokens);
});

// ---------------------------------------------------------------------------
// recordDecision
// ---------------------------------------------------------------------------

test('recordDecision stores a decision and returns it', async () => {
  const svc = service();
  const { taskId } = await registerTask(svc);
  const request = recordDecisionRequest({ taskId });
  const result = await svc.recordDecision(request);
  assert.equal(result.deduplicated, false);
  assert.equal(result.decision.taskId, taskId);
  assert.equal(result.decision.policyLevel, 2);
  assert.equal(result.decision.approved, true);
});

test('recordDecision is idempotent for identical requests', async () => {
  const svc = service();
  const { taskId } = await registerTask(svc);
  const request = recordDecisionRequest({ taskId });
  const first = await svc.recordDecision(request);
  const second = await svc.recordDecision(request);
  assert.equal(first.decision.decisionId, second.decision.decisionId);
  assert.equal(second.deduplicated, true);
});

test('recordDecision refuses a policy level outside 0-4', async () => {
  const svc = service();
  const { taskId } = await registerTask(svc);
  await assert.rejects(
    svc.recordDecision(recordDecisionRequest({ taskId, policyLevel: 5 })),
    (error: unknown) => codeOf(error) === 'invalid-policy-level',
  );
});

test('recordDecision refuses when the task does not exist', async () => {
  const svc = service();
  await assert.rejects(
    svc.recordDecision(recordDecisionRequest({ taskId: 'need.interpret_missing' })),
    (error: unknown) => codeOf(error) === 'no-such-task',
  );
});

test('recordDecision refuses when the referenced run does not exist', async () => {
  const svc = service();
  const { taskId } = await registerTask(svc);
  await assert.rejects(
    svc.recordDecision(recordDecisionRequest({ taskId, runId: 'run_01HQZXMISSING1' })),
    (error: unknown) => codeOf(error) === 'no-such-binding',
  );
});

test('recordDecision refuses when the referenced run executed a different task', async () => {
  const svc = service();
  const taskA = await registerTask(svc, { taskId: 'need.interpret_a_001' });
  const taskB = await registerTask(svc, { taskId: 'need.interpret_b_001' });
  await registerModel(svc);
  const run = await svc.executeTask(
    executeTaskRequest({ taskId: taskA.taskId, runId: 'run_01HQZXMISMATCH' }),
  );
  await assert.rejects(
    svc.recordDecision(recordDecisionRequest({ taskId: taskB.taskId, runId: run.run.runId })),
    (error: unknown) => codeOf(error) === 'malformed-record',
  );
});

test('recordDecision allows a decision with a valid referenced run', async () => {
  const svc = service();
  const { taskId } = await registerTask(svc);
  await registerModel(svc);
  const run = await svc.executeTask(executeTaskRequest({ taskId }));
  const result = await svc.recordDecision(recordDecisionRequest({ taskId, runId: run.run.runId }));
  assert.equal(result.decision.runId, run.run.runId);
});

// ---------------------------------------------------------------------------
// Surface and foreign-field scans
// ---------------------------------------------------------------------------

test('the service exposes only the six declared operations', () => {
  const svc = service();
  const operations = new Set<string>();
  let proto: object | null = Object.getPrototypeOf(svc) as object | null;
  while (proto !== null && proto !== Object.prototype) {
    for (const key of Object.getOwnPropertyNames(proto)) operations.add(key);
    proto = Object.getPrototypeOf(proto) as object | null;
  }
  operations.delete('constructor');
  assert.deepEqual([...operations].sort(), [
    'executeTask',
    'grantAuthority',
    'recordDecision',
    'registerModel',
    'registerTask',
    'resolveAuthority',
  ]);
});

test('the in-memory port exposes no update, delete, relink or merge operations', async () => {
  const repository = new InMemoryAIGatewayRepository();
  await repository.withTransaction((tx) => {
    const operations = new Set<string>();
    let proto: object | null = Object.getPrototypeOf(tx) as object | null;
    while (proto !== null && proto !== Object.prototype) {
      for (const key of Object.getOwnPropertyNames(proto)) operations.add(key);
      proto = Object.getPrototypeOf(proto) as object | null;
    }
    const mutators = [...operations].filter((op) =>
      /update|delete|remove|relink|merge|amend|close|suspend|purge|truncate|set[A-Z]/i.test(op),
    );
    assert.deepEqual(mutators, [], 'gateway records are append-only');
    assert.ok(operations.has('insertRun'));
    assert.ok(operations.has('findBindingsByCapability'));
    return Promise.resolve();
  });
});

test('FOREIGN_FIELDS names an owner for every listed field', () => {
  for (const [field, owner] of Object.entries(FOREIGN_FIELDS)) {
    assert.ok(owner.length > 0, `FOREIGN_FIELDS["${field}"] must name an owner`);
    assert.match(owner, /(K-\d+|module|Module|owns|belongs)/i);
  }
});

test('records returned by the service are deeply frozen', async () => {
  const svc = service();
  const { taskId } = await registerTask(svc);
  await registerModel(svc);
  const run = await svc.executeTask(executeTaskRequest({ taskId }));
  assert.ok(Object.isFrozen(run.run));
  assert.ok(Object.isFrozen(run.run.input));
  assert.ok(Object.isFrozen(run.run.output));
  assert.ok(Object.isFrozen(run.run.cost));
});

test('a failed transaction writes nothing', async () => {
  const { repository } = build();
  await assert.rejects(
    repository.withTransaction(async (tx) => {
      await tx.insertTask(taskRecord());
      throw new Error('rollback');
    }),
    /rollback/,
  );
  assert.equal(repository.tasks().length, 0);
  assert.equal(repository.transactionsRolledBack, 1);
  assert.equal(repository.transactionsCommitted, 0);
});

test('lookups inside a transaction see what that transaction wrote', async () => {
  const { repository } = build();
  const task = taskRecord();
  await repository.withTransaction(async (tx) => {
    await tx.insertTask(task);
    const found = await tx.findTaskById(task.taskId);
    assert.equal(found?.taskId, task.taskId);
    const byKey = await tx.findTaskByIdempotencyKey(task.idempotencyKey);
    assert.equal(byKey?.taskId, task.taskId);
    return Promise.resolve();
  });
});
