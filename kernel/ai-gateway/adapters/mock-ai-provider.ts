/**
 * K-13 AI Gateway — mock provider adapter.
 *
 * A deterministic, network-free provider used for tests and for environments that have no live
 * model credentials. It returns a structured output derived from a hash of the input and task id, and
 * computes cost using the binding's rates.
 *
 * Owned by: K-13 AI Gateway.
 */

import type { AIProvider, AIProviderResult } from './ai-provider.ts';
import type { ModelBinding, TaskDefinition } from '../types.ts';

/** Cheap token approximation: one token per four characters of JSON text. */
function tokenize(value: unknown): number {
  const text = JSON.stringify(value) ?? 'null';
  return Math.max(1, Math.ceil(text.length / 4));
}

/** Deterministic djb2 hash of a string, returned as a bigint for downstream integer math. */
function hashOf(value: string): bigint {
  let hash = 5381n;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash << 5n) + hash + BigInt(value.charCodeAt(i));
  }
  return hash < 0n ? -hash : hash;
}

/** Round up to the next 1K-token bucket. */
function costForTokens(tokens: number, costPer1K: bigint): bigint {
  const buckets = BigInt(Math.ceil(tokens / 1000));
  return buckets * costPer1K;
}

export class MockAIProvider implements AIProvider {
  execute(binding: ModelBinding, task: TaskDefinition, input: unknown): Promise<AIProviderResult> {
    const inputTokens = tokenize(input);

    const hash = hashOf(JSON.stringify({ taskId: task.taskId, input }));
    const confidence = Number(hash % 1000n) / 1000;
    const output = {
      result: `mock-result-${hash % 1000000n}`,
      confidence,
      task: task.taskId,
      provider: binding.provider,
      model: binding.modelId,
    };

    const outputTokens = tokenize(output);
    return Promise.resolve({
      output,
      inputTokens,
      outputTokens,
    });
  }
}

export { costForTokens, tokenize };
