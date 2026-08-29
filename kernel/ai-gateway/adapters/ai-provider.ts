/**
 * K-13 AI Gateway — provider adapter port.
 *
 * A provider adapter turns a task and a binding into an AI run result. Live adapters for OpenAI,
 * Anthropic, Kimi, DeepSeek and local models live here; the mock adapter is the reference
 * implementation for tests.
 *
 * No adapter may call a business module or a financial module. Provider SDKs are confined to this
 * directory.
 *
 * Owned by: K-13 AI Gateway.
 */

import type { ModelBinding, TaskDefinition } from '../types.ts';

/** The deterministic result of executing a task through one binding. */
export interface AIProviderResult {
  /** Structured output returned by the model. */
  readonly output: Readonly<Record<string, unknown>>;
  /** Approximate input tokens consumed. */
  readonly inputTokens: number;
  /** Approximate output tokens produced. */
  readonly outputTokens: number;
}

/** A provider adapter executes one task against one binding without calling any other module. */
export interface AIProvider {
  execute(binding: ModelBinding, task: TaskDefinition, input: unknown): Promise<AIProviderResult>;
}
