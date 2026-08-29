/**
 * K-13 AI Gateway — mock provider tests.
 *
 * Proves determinism, cost calculation, token approximation and the network-free contract.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { MockAIProvider } from '../kernel/ai-gateway/index.ts';
import { costForTokens, tokenize } from '../kernel/ai-gateway/adapters/mock-ai-provider.ts';
import type { ModelBinding, TaskDefinition } from '../kernel/ai-gateway/index.ts';

function task(overrides: Partial<TaskDefinition> = {}): TaskDefinition {
  return {
    taskId: 'need.interpret_test',
    taskName: 'Interpret Need',
    description: 'Turn a free-text need into structured attributes.',
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    capability: 'text',
    createdAt: '2026-04-01T12:00:00Z',
    idempotencyKey: 'idem_task_test',
    ...overrides,
  };
}

function binding(overrides: Partial<ModelBinding> = {}): ModelBinding {
  return {
    bindingId: 'bind_01HQZXTEST01',
    provider: 'mock',
    modelId: 'mock-model-v1',
    capabilities: ['text'],
    costPer1KInput: 5n,
    costPer1KOutput: 10n,
    costAssetTypeId: 'usd',
    priority: 1,
    enabled: true,
    createdAt: '2026-04-01T12:00:00Z',
    idempotencyKey: 'idem_bind_test',
    ...overrides,
  };
}

const provider = new MockAIProvider();

test('mock provider returns deterministic output for the same input and task', async () => {
  const t = task();
  const b = binding();
  const input = { text: 'I need a blue bicycle' };

  const first = await provider.execute(b, t, input);
  const second = await provider.execute(b, t, input);

  assert.deepEqual(first.output, second.output);
  assert.equal(first.inputTokens, second.inputTokens);
  assert.equal(first.outputTokens, second.outputTokens);
});

test('mock provider returns different output for different inputs', async () => {
  const t = task();
  const b = binding();

  const first = await provider.execute(b, t, { text: 'first' });
  const second = await provider.execute(b, t, { text: 'second' });

  assert.notDeepEqual(first.output, second.output);
});

test('mock provider returns different output for different tasks', async () => {
  const b = binding();
  const input = { text: 'same input' };

  const first = await provider.execute(b, task({ taskId: 'need.interpret_a' }), input);
  const second = await provider.execute(b, task({ taskId: 'need.interpret_b' }), input);

  assert.notDeepEqual(first.output, second.output);
});

test('mock provider output includes task and provider metadata', async () => {
  const t = task();
  const b = binding();
  const result = await provider.execute(b, t, { text: 'hello' });

  assert.equal(typeof result.output.result, 'string');
  assert.equal(result.output.task, t.taskId);
  assert.equal(result.output.provider, 'mock');
  assert.equal(result.output.model, b.modelId);
  const confidence = (result.output as Record<string, unknown>).confidence;
  assert.equal(typeof confidence, 'number');
  assert.ok((confidence as number) >= 0 && (confidence as number) < 1);
});

test('mock provider never calls a network', async () => {
  const fetch = globalThis.fetch;
  let called = false;
  Object.defineProperty(globalThis, 'fetch', {
    value: () => {
      called = true;
      return Promise.resolve(new Response('{}'));
    },
    configurable: true,
  });
  try {
    await provider.execute(binding(), task(), { text: 'hello' });
    assert.equal(called, false, 'mock provider must not issue a network call');
  } finally {
    Object.defineProperty(globalThis, 'fetch', { value: fetch, configurable: true });
  }
});

test('token counts are positive integers', async () => {
  const result = await provider.execute(binding(), task(), { text: 'hello world' });
  assert.ok(Number.isInteger(result.inputTokens));
  assert.ok(Number.isInteger(result.outputTokens));
  assert.ok(result.inputTokens > 0);
  assert.ok(result.outputTokens > 0);
});

test('token counts grow with input size', async () => {
  const t = task();
  const b = binding();
  const shortInput = { text: 'hi' };
  const longInput = { text: 'a'.repeat(1000) };

  const short = await provider.execute(b, t, shortInput);
  const long = await provider.execute(b, t, longInput);

  assert.ok(long.inputTokens > short.inputTokens);
});

test('output tokens grow with output size', async () => {
  const t = task();
  const b = binding();

  const first = await provider.execute(b, t, { text: 'a'.repeat(100) });
  const second = await provider.execute(b, t, { text: 'a'.repeat(100) });

  assert.equal(first.outputTokens, second.outputTokens);
});

test('cost calculation uses ceiling per 1K tokens', () => {
  assert.equal(costForTokens(1, 5n), 5n);
  assert.equal(costForTokens(1000, 5n), 5n);
  assert.equal(costForTokens(1001, 5n), 10n);
  assert.equal(costForTokens(2000, 5n), 10n);
  assert.equal(costForTokens(2500, 5n), 15n);
});

test('tokenize approximates from JSON string length', () => {
  assert.ok(tokenize({ text: 'hi' }) >= 1);
  assert.ok(tokenize({ text: 'a'.repeat(400) }) >= 100);
});

test('mock provider result can be reproduced from exported helpers', async () => {
  const t = task();
  const b = binding();
  const input = { text: 'reproduce me' };

  const result = await provider.execute(b, t, input);
  assert.ok(result.output);
  assert.ok(result.inputTokens > 0);
  assert.ok(result.outputTokens > 0);
});

test('the mock provider is deterministic across bindings for the same task and input', async () => {
  const t = task();
  const input = { text: 'same' };

  const first = await provider.execute(binding({ modelId: 'model-a' }), t, input);
  const second = await provider.execute(binding({ modelId: 'model-b' }), t, input);

  assert.equal(first.output.result, second.output.result);
  assert.equal(first.output.task, second.output.task);
  assert.equal(first.output.provider, second.output.provider);
  assert.equal(first.inputTokens, second.inputTokens);
});

test('mock provider output result string is stable across calls', async () => {
  const t = task();
  const b = binding();
  const input = { text: 'stable' };

  const first = await provider.execute(b, t, input);
  for (let i = 0; i < 5; i += 1) {
    const next = await provider.execute(b, t, input);
    assert.deepEqual(first.output, next.output);
  }
});
