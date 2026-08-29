/**
 * K-13 AI Gateway — domain types.
 *
 * The single boundary to model providers. K-13 owns task definitions, model bindings, AI runs and
 * AI decisions. It does not own business outcomes, money, or conversation state; it records the cost
 * of a run and the decision a downstream module asked it to store.
 *
 * Deterministic by construction: the caller supplies every identifier and every instant. Nothing
 * here reads a clock, generates randomness, or calls a remote provider except through an injected
 * adapter.
 *
 * Owned by: K-13 AI Gateway.
 */

/** What a task can ask a model to do. */
export const CAPABILITIES = ['text', 'vision', 'speech', 'structured', 'reasoning'] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** A provider a binding can route to. */
export const PROVIDERS = ['mock', 'openai', 'anthropic', 'kimi', 'deepseek', 'local'] as const;
export type Provider = (typeof PROVIDERS)[number];

/** The result status of an AI run. */
export const RUN_STATUSES = ['success', 'failure'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/**
 * How much authority a task may be invoked with.
 *
 * The scale is deliberately ordinal: a higher number is strictly more authority than a lower one, so
 * "may this run proceed?" is a comparison rather than a table lookup.
 *
 *   0 observe                 — may look, may record what it saw, may not propose anything
 *   1 recommend               — may propose; a human decides and acts
 *   2 prepare                 — may assemble a complete action; a human approves before it executes
 *   3 execute-within-limits   — may execute an approved class of low-risk action inside stated limits
 *   4 manage-with-exceptions  — may run a defined operational area, escalating exceptions to a human
 *
 * K-13 executes models, not business actions, so what it can honestly enforce is the ceiling: it
 * refuses to run a task above the authority a human granted that task, and refuses entirely while
 * the grant is suspended. What a caller then does with a level-3 result is the caller's contract to
 * keep, and the run records the level it ran under so an audit can hold them to it.
 */
export const AUTHORITY_LEVELS = [0, 1, 2, 3, 4] as const;
export type AuthorityLevel = (typeof AUTHORITY_LEVELS)[number];

/** The name of each level, for explanations and audit evidence. */
export const AUTHORITY_MEANINGS: Readonly<Record<number, string>> = Object.freeze({
  0: 'observe',
  1: 'recommend',
  2: 'prepare',
  3: 'execute-within-limits',
  4: 'manage-with-exceptions',
});

/**
 * A grant of authority to one task.
 *
 * Grants are append-only versions, like every other decision in this platform that must be
 * reconstructable after the fact. Raising a ceiling, lowering it, or suspending a task are all new
 * versions; the grant in force at an instant is the latest version at or before it. Nothing is
 * edited, so "who allowed this, and when" always has an answer.
 *
 * `suspended` is the kill switch. A suspended task refuses every level, including 0 — an observer
 * that keeps observing after being switched off is not switched off.
 */
export interface TaskAuthority {
  /** Caller-supplied, opaque and stable identifier for this version of the grant. */
  readonly authorityId: string;
  /** The task this grant governs. */
  readonly taskId: string;
  /** The highest level the task may be invoked at. */
  readonly maxAuthority: AuthorityLevel;
  /** The kill switch. While true, the task refuses every level. */
  readonly suspended: boolean;
  /** Why this ceiling was set, in the granter's own words. Required: an unexplained grant is not reviewable. */
  readonly rationale: string;
  /** The opaque identifier of the human or role that granted it. */
  readonly grantedBy: string;
  /** When the grant takes effect, as a canonical UTC instant. */
  readonly grantedAt: string;
  /** Stable across retries of one logical grant. */
  readonly idempotencyKey: string;
}

/**
 * A task definition.
 *
 * A task is a capability-shaped unit of work identified by a dotted-lowercase name. Other modules
 * invoke a task by name; K-13 decides which binding can satisfy it.
 */
export interface TaskDefinition {
  /** Dotted-lowercase task identifier, e.g. `need.interpret`. */
  readonly taskId: string;
  /** Human-readable name. */
  readonly taskName: string;
  /** Human-readable description. */
  readonly description: string;
  /** JSON schema for the input this task accepts. */
  readonly inputSchema: Readonly<Record<string, unknown>>;
  /** JSON schema for the output this task produces. */
  readonly outputSchema: Readonly<Record<string, unknown>>;
  /** Capability required to execute this task. */
  readonly capability: Capability;
  /** When the task was registered, as a canonical UTC instant. */
  readonly createdAt: string;
  /** Stable across retries of one logical registration. */
  readonly idempotencyKey: string;
}

/**
 * A model binding.
 *
 * A binding names a provider, a model, the capabilities it can satisfy, and the cost of using it.
 * Priority ranks bindings for the same capability; lower numbers are preferred.
 */
export interface ModelBinding {
  /** Caller-supplied opaque and stable identifier. */
  readonly bindingId: string;
  /** Model provider. */
  readonly provider: Provider;
  /** Provider-specific model name. */
  readonly modelId: string;
  /** Capabilities this binding can satisfy. */
  readonly capabilities: readonly Capability[];
  /** Cost per 1,000 input tokens, in integer minor units of `costAssetTypeId`. */
  readonly costPer1KInput: bigint;
  /** Cost per 1,000 output tokens, in integer minor units of `costAssetTypeId`. */
  readonly costPer1KOutput: bigint;
  /** Asset type in which cost is expressed. */
  readonly costAssetTypeId: string;
  /** Routing priority; lower is preferred. */
  readonly priority: number;
  /** Whether this binding may be selected. */
  readonly enabled: boolean;
  /** When the binding was registered, as a canonical UTC instant. */
  readonly createdAt: string;
  /** Stable across retries of one logical registration. */
  readonly idempotencyKey: string;
}

/**
 * The cost captured for one AI run.
 *
 * All monetary amounts are integer minor units (`bigint`). Token counts are plain integers.
 */
export interface AICost {
  /** Approximate input tokens consumed. */
  readonly inputTokens: number;
  /** Approximate output tokens produced. */
  readonly outputTokens: number;
  /** Input cost in minor units of `assetTypeId`. */
  readonly inputCost: bigint;
  /** Output cost in minor units of `assetTypeId`. */
  readonly outputCost: bigint;
  /** Total cost in minor units of `assetTypeId`. */
  readonly totalCost: bigint;
  /** Asset type in which costs are expressed. */
  readonly assetTypeId: string;
}

/**
 * An AI run.
 *
 * One execution of one task through one binding. Runs are append-only; the output and cost are
 * recorded exactly as the adapter returned them.
 */
export interface AIRun {
  /** Caller-supplied opaque and stable identifier. */
  readonly runId: string;
  /** The task that was executed. */
  readonly taskId: string;
  /** The binding that served the run. */
  readonly bindingId: string;
  /** Input supplied to the task. */
  readonly input: Readonly<Record<string, unknown>>;
  /** Output returned by the provider adapter. */
  readonly output: Readonly<Record<string, unknown>>;
  /** Whether the run succeeded. */
  readonly status: RunStatus;
  /** Refusal code when status is `failure`; otherwise null. */
  readonly errorCode: string | null;
  /** Cost captured for the run. */
  readonly cost: AICost;
  /**
   * The authority level this run executed under.
   *
   * Recorded on the run, not inferred from the grant, because the grant can change afterwards and
   * the question an audit asks is what was permitted at the time.
   */
  readonly authorityLevel: AuthorityLevel;
  /** When the run started, as a canonical UTC instant. */
  readonly startedAt: string;
  /** When the run finished, as a canonical UTC instant. */
  readonly finishedAt: string;
  /** Caller-supplied correlation id. */
  readonly correlationId: string;
  /** Stable across retries of one logical execution. */
  readonly idempotencyKey: string;
}

/**
 * An AI decision.
 *
 * A record that a downstream module made, or asked K-13 to record, an AI-influenced decision.
 * Policy level is a 0-4 severity scale; approval status is captured separately.
 */
export interface AIDecision {
  /** Caller-supplied opaque and stable identifier. */
  readonly decisionId: string;
  /** The task the decision relates to, if any. */
  readonly taskId: string;
  /** The run the decision relates to, if any. */
  readonly runId: string | null;
  /** Policy level on a 0-4 scale. */
  readonly policyLevel: number;
  /** Whether the decision was approved. */
  readonly approved: boolean;
  /** Human-readable explanation. */
  readonly explanation: string;
  /** When the decision was recorded, as a canonical UTC instant. */
  readonly recordedAt: string;
  /** Stable across retries of one logical recording. */
  readonly idempotencyKey: string;
}

export type AIGatewayErrorCode =
  /** An identifier is not well formed. */
  | 'malformed-identifier'
  /** A task id is not dotted lowercase. */
  | 'malformed-task-id'
  /** An identifier looks like a natural key. */
  | 'natural-identifier'
  /** An identifier names or looks like a credential. */
  | 'secret-bearing-input'
  /** The instant is not a real UTC instant. */
  | 'malformed-instant'
  /** A request carried a field belonging to another component. */
  | 'foreign-concern'
  /** A stored row, or a candidate record, is not what this component writes. */
  | 'malformed-record'
  /** A capability is not one K-13 recognises. */
  | 'invalid-capability'
  /** A provider is not one K-13 recognises. */
  | 'invalid-provider'
  /** A cost value is negative or not an integer. */
  | 'invalid-cost'
  /** A policy level is outside 0-4. */
  | 'invalid-policy-level'
  /** An authority level is outside 0-4. */
  | 'invalid-authority-level'
  /** The task has no authority grant, so nothing has said it may run at all. */
  | 'no-authority-grant'
  /** The requested authority is above the ceiling the grant sets. */
  | 'authority-exceeded'
  /** The task's grant is suspended — the kill switch is engaged. */
  | 'authority-suspended'
  /** An authority id already exists with different content. */
  | 'duplicate-authority-id'
  /** A task id already exists with different content. */
  | 'duplicate-task-id'
  /** A binding id already exists with different content. */
  | 'duplicate-binding-id'
  /** A run id already exists with different content. */
  | 'duplicate-run-id'
  /** A decision id already exists with different content. */
  | 'duplicate-decision-id'
  /** The idempotency key was already used for a different record. */
  | 'idempotency-key-reuse'
  /** The requested task does not exist. */
  | 'no-such-task'
  /** The requested binding does not exist. */
  | 'no-such-binding'
  /** No enabled binding can satisfy the task's capability. */
  | 'no-capable-binding'
  /** An enlisted write tried to issue transaction control. */
  | 'nested-transaction';

/** A refusal the caller must act on. */
export class AIGatewayError extends Error {
  readonly code: AIGatewayErrorCode;

  constructor(code: AIGatewayErrorCode, message: string) {
    super(message);
    this.name = 'AIGatewayError';
    this.code = code;
  }
}
