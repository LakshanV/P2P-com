/**
 * K-13 AI Gateway — the service.
 *
 * Four operations:
 *
 *   `registerTask`    — create a task definition, refusing duplicates and malformed fields.
 *   `registerModel`   — create a model binding, refusing duplicates and malformed fields.
 *   `executeTask`     — validate the task, route to a capable binding, execute through the
 *                       provider adapter, capture cost, and emit an event and audit record.
 *   `recordDecision`  — store an AI decision with explanation, policy level and approval status,
 *                       and emit an event and audit record.
 *
 * Deterministic by construction: the caller supplies the identifiers and the instants. Nothing here
 * reads a clock or generates randomness.
 *
 * Owned by: K-13 AI Gateway.
 */

import { InvalidInstantError, parseInstant } from '../../platform/time/instant.ts';

import type { AIProvider } from './adapters/ai-provider.ts';
import {
  makeAIAuthorityGrantedAction,
  makeAIAuthorityGrantedEvent,
  makeAIDecisionRecordedAction,
  makeAIDecisionRecordedEvent,
  makeAITaskExecutedAction,
  makeAITaskExecutedEvent,
} from './outbox.ts';
import { FOREIGN_FIELDS, assertOpaqueIdentifier, assertTaskId } from './registry.ts';
import type { AIGatewayRepository } from './repository.ts';
import { sealAuthority, sealBinding, sealDecision, sealRun, sealTask } from './immutable.ts';
import {
  validateAuthority,
  validateBinding,
  validateDecision,
  validateExecuteRequest,
  validateRun,
  validateTask,
} from './validate.ts';
import {
  AIGatewayError,
  AUTHORITY_MEANINGS,
  type AICost,
  type AIDecision,
  type AIRun,
  type AuthorityLevel,
  type TaskAuthority,
  type Capability,
  type ModelBinding,
  type Provider,
  type TaskDefinition,
} from './types.ts';

export interface RegisterTaskRequest {
  readonly taskId: string;
  readonly taskName: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema: Readonly<Record<string, unknown>>;
  readonly capability: Capability;
  readonly createdAt: string;
  readonly idempotencyKey: string;
}

export interface RegisterTaskResult {
  readonly task: TaskDefinition;
  readonly deduplicated: boolean;
}

export interface RegisterModelRequest {
  readonly bindingId: string;
  readonly provider: Provider;
  readonly modelId: string;
  readonly capabilities: readonly Capability[];
  readonly costPer1KInput: bigint | number | string;
  readonly costPer1KOutput: bigint | number | string;
  readonly costAssetTypeId: string;
  readonly priority: number;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly idempotencyKey: string;
}

export interface RegisterModelResult {
  readonly binding: ModelBinding;
  readonly deduplicated: boolean;
}

export interface ExecuteTaskRequest {
  readonly runId: string;
  readonly taskId: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  /**
   * The authority the caller is asking to act with.
   *
   * Not optional and not defaulted. A run whose authority nobody stated is a run nobody authorised,
   * and a default here would put the gateway's guess into the audit record.
   */
  readonly requestedAuthority: AuthorityLevel;
}

export interface GrantAuthorityRequest {
  readonly authorityId: string;
  readonly taskId: string;
  readonly maxAuthority: AuthorityLevel;
  /** The kill switch. While true, the task refuses every level, including 0. */
  readonly suspended: boolean;
  readonly rationale: string;
  readonly grantedBy: string;
  readonly grantedAt: string;
  readonly idempotencyKey: string;
}

export interface GrantAuthorityResult {
  readonly authority: TaskAuthority;
  readonly deduplicated: boolean;
}

export interface ExecuteTaskResult {
  readonly run: AIRun;
  readonly deduplicated: boolean;
}

export interface RecordDecisionRequest {
  readonly decisionId: string;
  readonly taskId: string;
  readonly runId?: string | null;
  readonly policyLevel: number;
  readonly approved: boolean;
  readonly explanation: string;
  readonly recordedAt: string;
  readonly idempotencyKey: string;
}

export interface RecordDecisionResult {
  readonly decision: AIDecision;
  readonly deduplicated: boolean;
}

const REGISTER_TASK_KEYS: readonly string[] = [
  'taskId',
  'taskName',
  'description',
  'inputSchema',
  'outputSchema',
  'capability',
  'createdAt',
  'idempotencyKey',
];

const REGISTER_MODEL_KEYS: readonly string[] = [
  'bindingId',
  'provider',
  'modelId',
  'capabilities',
  'costPer1KInput',
  'costPer1KOutput',
  'costAssetTypeId',
  'priority',
  'enabled',
  'createdAt',
  'idempotencyKey',
];

const EXECUTE_TASK_KEYS: readonly string[] = [
  'runId',
  'taskId',
  'input',
  'startedAt',
  'finishedAt',
  'correlationId',
  'idempotencyKey',
  'requestedAuthority',
];

const GRANT_AUTHORITY_KEYS: readonly string[] = [
  'authorityId',
  'taskId',
  'maxAuthority',
  'suspended',
  'rationale',
  'grantedBy',
  'grantedAt',
  'idempotencyKey',
];

const RECORD_DECISION_KEYS: readonly string[] = [
  'decisionId',
  'taskId',
  'runId',
  'policyLevel',
  'approved',
  'explanation',
  'recordedAt',
  'idempotencyKey',
];

export class AIGatewayService {
  readonly #repository: AIGatewayRepository;
  readonly #resolveProvider: (provider: Provider) => AIProvider;

  constructor(
    repository: AIGatewayRepository,
    resolveProvider: (provider: Provider) => AIProvider,
  ) {
    this.#repository = repository;
    this.#resolveProvider = resolveProvider;
  }

  /**
   * Register a task definition.
   *
   * Validates, checks idempotency, and stores the task. A duplicate task id with the same content is
   * returned as a deduplication.
   */
  async registerTask(request: RegisterTaskRequest): Promise<RegisterTaskResult> {
    assertNoForeignConcerns(request, REGISTER_TASK_KEYS, 'registerTask');
    const task = sealTask(
      validateTask(
        {
          taskId: request.taskId,
          taskName: request.taskName,
          description: request.description,
          inputSchema: request.inputSchema,
          outputSchema: request.outputSchema,
          capability: request.capability,
          createdAt: request.createdAt,
          idempotencyKey: request.idempotencyKey,
        },
        'request',
      ),
    );

    try {
      return await this.#insertTask(task);
    } catch (error) {
      const conflicted =
        error instanceof AIGatewayError &&
        (error.code === 'duplicate-task-id' || error.code === 'idempotency-key-reuse');
      if (!conflicted) throw error;

      const winner = await this.#repository.withTransaction((tx) =>
        tx.findTaskByIdempotencyKey(task.idempotencyKey),
      );
      if (winner === null || !taskEquals(winner, task)) throw error;
      return { task: sealTask(winner), deduplicated: true };
    }
  }

  async #insertTask(task: TaskDefinition): Promise<RegisterTaskResult> {
    return this.#repository.withTransaction(async (tx) => {
      const existingKey = await tx.findTaskByIdempotencyKey(task.idempotencyKey);
      if (existingKey !== null) {
        if (!taskEquals(existingKey, task)) {
          throw new AIGatewayError(
            'idempotency-key-reuse',
            `idempotency key "${task.idempotencyKey}" has already been used for a different task`,
          );
        }
        return { task: sealTask(existingKey), deduplicated: true };
      }

      const existingId = await tx.findTaskById(task.taskId);
      if (existingId !== null) {
        if (taskEquals(existingId, task)) {
          return { task: sealTask(existingId), deduplicated: true };
        }
        throw new AIGatewayError(
          'duplicate-task-id',
          `task ${task.taskId} already exists. A task is created once and never rewritten`,
        );
      }

      await tx.insertTask(task);
      return { task, deduplicated: false };
    });
  }

  /**
   * Register a model binding.
   *
   * Validates, checks idempotency, and stores the binding. Capabilities must be one or more of the
   * recognised values.
   */
  async registerModel(request: RegisterModelRequest): Promise<RegisterModelResult> {
    assertNoForeignConcerns(request, REGISTER_MODEL_KEYS, 'registerModel');
    const binding = sealBinding(
      validateBinding(
        {
          bindingId: request.bindingId,
          provider: request.provider,
          modelId: request.modelId,
          capabilities: request.capabilities,
          costPer1KInput: request.costPer1KInput,
          costPer1KOutput: request.costPer1KOutput,
          costAssetTypeId: request.costAssetTypeId,
          priority: request.priority,
          enabled: request.enabled,
          createdAt: request.createdAt,
          idempotencyKey: request.idempotencyKey,
        },
        'request',
      ),
    );

    try {
      return await this.#insertBinding(binding);
    } catch (error) {
      const conflicted =
        error instanceof AIGatewayError &&
        (error.code === 'duplicate-binding-id' || error.code === 'idempotency-key-reuse');
      if (!conflicted) throw error;

      const winner = await this.#repository.withTransaction((tx) =>
        tx.findBindingByIdempotencyKey(binding.idempotencyKey),
      );
      if (winner === null || !bindingEquals(winner, binding)) throw error;
      return { binding: sealBinding(winner), deduplicated: true };
    }
  }

  async #insertBinding(binding: ModelBinding): Promise<RegisterModelResult> {
    return this.#repository.withTransaction(async (tx) => {
      const existingKey = await tx.findBindingByIdempotencyKey(binding.idempotencyKey);
      if (existingKey !== null) {
        if (!bindingEquals(existingKey, binding)) {
          throw new AIGatewayError(
            'idempotency-key-reuse',
            `idempotency key "${binding.idempotencyKey}" has already been used for a different binding`,
          );
        }
        return { binding: sealBinding(existingKey), deduplicated: true };
      }

      const existingId = await tx.findBindingById(binding.bindingId);
      if (existingId !== null) {
        if (bindingEquals(existingId, binding)) {
          return { binding: sealBinding(existingId), deduplicated: true };
        }
        throw new AIGatewayError(
          'duplicate-binding-id',
          `binding ${binding.bindingId} already exists. A binding is created once and never rewritten`,
        );
      }

      await tx.insertBinding(binding);
      return { binding, deduplicated: false };
    });
  }

  /**
   * Execute a task.
   *
   * Validates the task exists, selects a capable enabled binding with the lowest priority, executes
   * through the provider adapter, captures cost, stores the run, and emits an event and audit record.
   */
  async executeTask(request: ExecuteTaskRequest): Promise<ExecuteTaskResult> {
    assertNoForeignConcerns(request, EXECUTE_TASK_KEYS, 'executeTask');
    const partial = validateExecuteRequest(request);

    try {
      return await this.#execute(partial);
    } catch (error) {
      const conflicted =
        error instanceof AIGatewayError &&
        (error.code === 'duplicate-run-id' || error.code === 'idempotency-key-reuse');
      if (!conflicted) throw error;

      const winner = await this.#repository.withTransaction((tx) =>
        tx.findRunByIdempotencyKey(partial.idempotencyKey),
      );
      if (winner === null || !runRequestEquals(winner, partial)) throw error;
      return { run: sealRun(winner), deduplicated: true };
    }
  }

  async #execute(partial: {
    readonly runId: string;
    readonly taskId: string;
    readonly input: Readonly<Record<string, unknown>>;
    readonly startedAt: string;
    readonly finishedAt: string;
    readonly correlationId: string;
    readonly idempotencyKey: string;
    readonly requestedAuthority: AuthorityLevel;
  }): Promise<ExecuteTaskResult> {
    return this.#repository.withTransaction(async (tx) => {
      const task = await tx.findTaskById(partial.taskId);
      if (task === null) {
        throw new AIGatewayError(
          'no-such-task',
          `task ${partial.taskId} does not exist. A run must execute a task that has already been registered`,
        );
      }

      // The authority gate, before a provider is resolved and before a token is spent.
      //
      // Ordered so the most specific refusal wins: a task nobody has granted anything is a
      // different failure from a task that has been switched off, which is different again from a
      // caller reaching above a ceiling that exists.
      const grant = await tx.findAuthorityInForce(task.taskId, partial.startedAt);
      if (grant === null) {
        throw new AIGatewayError(
          'no-authority-grant',
          `task ${task.taskId} has no authority grant in force at ${partial.startedAt}. A task ` +
            'nobody has authorised does not run, at any level — grant authority before executing it',
        );
      }
      if (grant.suspended) {
        throw new AIGatewayError(
          'authority-suspended',
          `task ${task.taskId} is suspended by grant ${grant.authorityId}. A suspended task ` +
            'refuses every level, including observe: something that keeps running after being ' +
            'switched off is not switched off',
        );
      }
      if (partial.requestedAuthority > grant.maxAuthority) {
        throw new AIGatewayError(
          'authority-exceeded',
          `task ${task.taskId} was invoked at level ${partial.requestedAuthority} ` +
            `(${AUTHORITY_MEANINGS[partial.requestedAuthority] ?? 'unknown'}) but grant ` +
            `${grant.authorityId} permits at most level ${grant.maxAuthority} ` +
            `(${AUTHORITY_MEANINGS[grant.maxAuthority] ?? 'unknown'})`,
        );
      }

      const candidates = await tx.findBindingsByCapability(task.capability);
      const binding = candidates[0];
      if (binding === undefined) {
        throw new AIGatewayError(
          'no-capable-binding',
          `no enabled binding can satisfy capability "${task.capability}" for task ${task.taskId}. ` +
            'Register a binding that supports this capability',
        );
      }

      const provider = this.#resolveProvider(binding.provider);
      const providerResult = await provider.execute(binding, task, partial.input);
      const cost = computeCost(binding, providerResult.inputTokens, providerResult.outputTokens);

      // Listed field by field rather than spread. `partial` carries `requestedAuthority`, which is
      // what the caller asked for; the run records `authorityLevel`, which is what it ran under.
      // A spread would put the request's own field into the record and be refused as foreign.
      const run: AIRun = sealRun(
        validateRun(
          {
            runId: partial.runId,
            taskId: partial.taskId,
            bindingId: binding.bindingId,
            input: partial.input,
            output: providerResult.output,
            status: 'success',
            errorCode: null,
            cost,
            authorityLevel: partial.requestedAuthority,
            startedAt: partial.startedAt,
            finishedAt: partial.finishedAt,
            correlationId: partial.correlationId,
            idempotencyKey: partial.idempotencyKey,
          },
          'request',
        ),
      );

      const existingKey = await tx.findRunByIdempotencyKey(partial.idempotencyKey);
      if (existingKey !== null) {
        if (!runEquals(existingKey, run)) {
          throw new AIGatewayError(
            'idempotency-key-reuse',
            `idempotency key "${partial.idempotencyKey}" has already been used for a different run`,
          );
        }
        return { run: sealRun(existingKey), deduplicated: true };
      }

      const existingId = await tx.findRunById(partial.runId);
      if (existingId !== null) {
        if (runEquals(existingId, run)) {
          return { run: sealRun(existingId), deduplicated: true };
        }
        throw new AIGatewayError(
          'duplicate-run-id',
          `run ${partial.runId} already exists. A run is created once and never rewritten`,
        );
      }

      await tx.insertRun(run);

      const correlationId = run.correlationId;
      const causationId: string | null = null;
      await tx.insertOutbox(makeAITaskExecutedEvent(run, correlationId, causationId));
      await tx.insertOutbox(makeAITaskExecutedAction(run, correlationId, causationId));

      return { run, deduplicated: false };
    });
  }

  /**
   * Grant, change or suspend a task's authority.
   *
   * Grants are append-only versions. Raising a ceiling, lowering it and pulling the kill switch are
   * all the same operation — a new version — so "who allowed this, and when" always has an answer,
   * and a grant that was in force last week is still readable after this week's change.
   */
  async grantAuthority(request: GrantAuthorityRequest): Promise<GrantAuthorityResult> {
    assertNoForeignConcerns(request, GRANT_AUTHORITY_KEYS, 'grantAuthority');
    const authority = sealAuthority(
      validateAuthority(
        {
          authorityId: request.authorityId,
          taskId: request.taskId,
          maxAuthority: request.maxAuthority,
          suspended: request.suspended,
          rationale: request.rationale,
          grantedBy: request.grantedBy,
          grantedAt: request.grantedAt,
          idempotencyKey: request.idempotencyKey,
        },
        'request',
      ),
    );

    try {
      return await this.#grantAuthority(authority);
    } catch (error) {
      const conflicted =
        error instanceof AIGatewayError &&
        (error.code === 'duplicate-authority-id' || error.code === 'idempotency-key-reuse');
      if (!conflicted) throw error;

      const winner = await this.#repository.withTransaction((tx) =>
        tx.findAuthorityByIdempotencyKey(authority.idempotencyKey),
      );
      if (winner === null || !authorityEquals(winner, authority)) throw error;
      return { authority: sealAuthority(winner), deduplicated: true };
    }
  }

  async #grantAuthority(authority: TaskAuthority): Promise<GrantAuthorityResult> {
    return this.#repository.withTransaction(async (tx) => {
      const task = await tx.findTaskById(authority.taskId);
      if (task === null) {
        throw new AIGatewayError(
          'no-such-task',
          `task ${authority.taskId} does not exist. Authority is granted to a registered task, ` +
            'not to a name nothing answers to',
        );
      }

      const existingKey = await tx.findAuthorityByIdempotencyKey(authority.idempotencyKey);
      if (existingKey !== null) {
        if (!authorityEquals(existingKey, authority)) {
          throw new AIGatewayError(
            'idempotency-key-reuse',
            `idempotency key "${authority.idempotencyKey}" has already been used for a different grant`,
          );
        }
        return { authority: sealAuthority(existingKey), deduplicated: true };
      }

      const existingId = await tx.findAuthorityById(authority.authorityId);
      if (existingId !== null) {
        if (authorityEquals(existingId, authority)) {
          return { authority: sealAuthority(existingId), deduplicated: true };
        }
        throw new AIGatewayError(
          'duplicate-authority-id',
          `authority ${authority.authorityId} already exists. A grant is a new version, never an edit`,
        );
      }

      await tx.insertAuthority(authority);

      const correlationId = authority.taskId;
      const causationId: string | null = null;
      await tx.insertOutbox(makeAIAuthorityGrantedEvent(authority, correlationId, causationId));
      await tx.insertOutbox(makeAIAuthorityGrantedAction(authority, correlationId, causationId));

      return { authority, deduplicated: false };
    });
  }

  /**
   * The authority in force for a task at an instant, or null when it has never been granted any.
   *
   * Reading is deliberately separate from executing: an operator, a cockpit or a review needs to see
   * what a task is permitted to do without invoking it.
   */
  async resolveAuthority(taskId: string, at: string): Promise<TaskAuthority | null> {
    assertTaskId(taskId, 'taskId');
    const instant = assertInstantArgument(at, 'at');
    return this.#repository.withTransaction((tx) => tx.findAuthorityInForce(taskId, instant));
  }

  /**
   * Record an AI decision.
   *
   * Validates, checks the task exists, checks idempotency, stores the decision, and emits an event
   * and audit record.
   */
  async recordDecision(request: RecordDecisionRequest): Promise<RecordDecisionResult> {
    assertNoForeignConcerns(request, RECORD_DECISION_KEYS, 'recordDecision');
    if (request.runId !== undefined && request.runId !== null) {
      assertOpaqueIdentifier(request.runId, 'runId');
    }
    const decision = sealDecision(
      validateDecision(
        {
          decisionId: request.decisionId,
          taskId: request.taskId,
          runId: request.runId ?? null,
          policyLevel: request.policyLevel,
          approved: request.approved,
          explanation: request.explanation,
          recordedAt: request.recordedAt,
          idempotencyKey: request.idempotencyKey,
        },
        'request',
      ),
    );

    try {
      return await this.#insertDecision(decision);
    } catch (error) {
      const conflicted =
        error instanceof AIGatewayError &&
        (error.code === 'duplicate-decision-id' || error.code === 'idempotency-key-reuse');
      if (!conflicted) throw error;

      const winner = await this.#repository.withTransaction((tx) =>
        tx.findDecisionByIdempotencyKey(decision.idempotencyKey),
      );
      if (winner === null || !decisionEquals(winner, decision)) throw error;
      return { decision: sealDecision(winner), deduplicated: true };
    }
  }

  async #insertDecision(decision: AIDecision): Promise<RecordDecisionResult> {
    return this.#repository.withTransaction(async (tx) => {
      const existingKey = await tx.findDecisionByIdempotencyKey(decision.idempotencyKey);
      if (existingKey !== null) {
        if (!decisionEquals(existingKey, decision)) {
          throw new AIGatewayError(
            'idempotency-key-reuse',
            `idempotency key "${decision.idempotencyKey}" has already been used for a different decision`,
          );
        }
        return { decision: sealDecision(existingKey), deduplicated: true };
      }

      const existingId = await tx.findDecisionById(decision.decisionId);
      if (existingId !== null) {
        if (decisionEquals(existingId, decision)) {
          return { decision: sealDecision(existingId), deduplicated: true };
        }
        throw new AIGatewayError(
          'duplicate-decision-id',
          `decision ${decision.decisionId} already exists. A decision is created once and never rewritten`,
        );
      }

      const task = await tx.findTaskById(decision.taskId);
      if (task === null) {
        throw new AIGatewayError(
          'no-such-task',
          `task ${decision.taskId} does not exist. A decision must relate to a task that has already been registered`,
        );
      }

      if (decision.runId !== null) {
        const run = await tx.findRunById(decision.runId);
        if (run === null) {
          throw new AIGatewayError(
            'no-such-binding',
            `run ${decision.runId} does not exist. A decision may only reference a run that has already been executed`,
          );
        }
        if (run.taskId !== decision.taskId) {
          throw new AIGatewayError(
            'malformed-record',
            `run ${decision.runId} executed task ${run.taskId}, not ${decision.taskId}`,
          );
        }
      }

      await tx.insertDecision(decision);

      const correlationId = decision.decisionId;
      const causationId: string | null = decision.runId;
      await tx.insertOutbox(makeAIDecisionRecordedEvent(decision, correlationId, causationId));
      await tx.insertOutbox(makeAIDecisionRecordedAction(decision, correlationId, causationId));

      return { decision, deduplicated: false };
    });
  }
}

function assertNoForeignConcerns(
  request: object,
  permitted: readonly string[],
  operation: string,
): void {
  if (request === null || typeof request !== 'object') {
    throw new AIGatewayError(
      'malformed-record',
      `${operation} needs a request object, got ${request === null ? 'null' : typeof request}`,
    );
  }

  for (const key of Object.keys(request)) {
    if (permitted.includes(key)) continue;

    const owner = FOREIGN_FIELDS[key];
    if (owner !== undefined) {
      throw new AIGatewayError(
        'foreign-concern',
        `${operation} carried "${key}", but ${owner}. An AI gateway record carries only what K-13 owns`,
      );
    }
    throw new AIGatewayError(
      'foreign-concern',
      `${operation} carried the unrecognised field "${key}". The permitted fields are ` +
        `${permitted.join(', ')}; anything else would be accepted and silently dropped`,
    );
  }
}

function computeCost(binding: ModelBinding, inputTokens: number, outputTokens: number): AICost {
  const inputCost = costForTokens(inputTokens, binding.costPer1KInput);
  const outputCost = costForTokens(outputTokens, binding.costPer1KOutput);
  return {
    inputTokens,
    outputTokens,
    inputCost,
    outputCost,
    totalCost: inputCost + outputCost,
    assetTypeId: binding.costAssetTypeId,
  };
}

function costForTokens(tokens: number, costPer1K: bigint): bigint {
  const buckets = BigInt(Math.ceil(tokens / 1000));
  return buckets * costPer1K;
}

function taskEquals(a: TaskDefinition, b: TaskDefinition): boolean {
  return (
    a.taskId === b.taskId &&
    a.taskName === b.taskName &&
    a.description === b.description &&
    JSON.stringify(a.inputSchema) === JSON.stringify(b.inputSchema) &&
    JSON.stringify(a.outputSchema) === JSON.stringify(b.outputSchema) &&
    a.capability === b.capability &&
    a.createdAt === b.createdAt
  );
}

function bindingEquals(a: ModelBinding, b: ModelBinding): boolean {
  return (
    a.bindingId === b.bindingId &&
    a.provider === b.provider &&
    a.modelId === b.modelId &&
    capabilitiesEqual(a.capabilities, b.capabilities) &&
    a.costPer1KInput === b.costPer1KInput &&
    a.costPer1KOutput === b.costPer1KOutput &&
    a.costAssetTypeId === b.costAssetTypeId &&
    a.priority === b.priority &&
    a.enabled === b.enabled &&
    a.createdAt === b.createdAt
  );
}

function capabilitiesEqual(a: readonly Capability[], b: readonly Capability[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  for (let i = 0; i < sortedA.length; i += 1) {
    if (sortedA[i] !== sortedB[i]) return false;
  }
  return true;
}

function runEquals(a: AIRun, b: AIRun): boolean {
  return (
    a.runId === b.runId &&
    a.taskId === b.taskId &&
    a.bindingId === b.bindingId &&
    JSON.stringify(a.input) === JSON.stringify(b.input) &&
    JSON.stringify(a.output) === JSON.stringify(b.output) &&
    a.status === b.status &&
    a.errorCode === b.errorCode &&
    a.cost.inputTokens === b.cost.inputTokens &&
    a.cost.outputTokens === b.cost.outputTokens &&
    a.cost.inputCost === b.cost.inputCost &&
    a.cost.outputCost === b.cost.outputCost &&
    a.cost.totalCost === b.cost.totalCost &&
    a.cost.assetTypeId === b.cost.assetTypeId &&
    a.startedAt === b.startedAt &&
    a.finishedAt === b.finishedAt &&
    a.correlationId === b.correlationId
  );
}

function runRequestEquals(
  run: AIRun,
  partial: {
    readonly runId: string;
    readonly taskId: string;
    readonly input: Readonly<Record<string, unknown>>;
    readonly startedAt: string;
    readonly finishedAt: string;
    readonly correlationId: string;
    readonly idempotencyKey: string;
  },
): boolean {
  return (
    run.runId === partial.runId &&
    run.taskId === partial.taskId &&
    JSON.stringify(run.input) === JSON.stringify(partial.input) &&
    run.startedAt === partial.startedAt &&
    run.finishedAt === partial.finishedAt &&
    run.correlationId === partial.correlationId &&
    run.idempotencyKey === partial.idempotencyKey
  );
}

/**
 * Two grants are the same grant when every field a caller supplied matches.
 *
 * `grantedAt` is included: a grant made at a different instant is a different grant even if it says
 * the same thing, because it is the instant that decides which version is in force.
 */
function authorityEquals(a: TaskAuthority, b: TaskAuthority): boolean {
  return (
    a.authorityId === b.authorityId &&
    a.taskId === b.taskId &&
    a.maxAuthority === b.maxAuthority &&
    a.suspended === b.suspended &&
    a.rationale === b.rationale &&
    a.grantedBy === b.grantedBy &&
    a.grantedAt === b.grantedAt
  );
}

/** A UTC instant supplied as a bare argument rather than inside a request object. */
function assertInstantArgument(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new AIGatewayError(
      'malformed-instant',
      `${field} is ${value === null ? 'null' : typeof value}; expected a UTC instant string`,
    );
  }
  try {
    return parseInstant(value).source;
  } catch (error) {
    if (error instanceof InvalidInstantError) {
      throw new AIGatewayError('malformed-instant', `${field}: ${error.message}`);
    }
    throw error;
  }
}

function decisionEquals(a: AIDecision, b: AIDecision): boolean {
  return (
    a.decisionId === b.decisionId &&
    a.taskId === b.taskId &&
    a.runId === b.runId &&
    a.policyLevel === b.policyLevel &&
    a.approved === b.approved &&
    a.explanation === b.explanation &&
    a.recordedAt === b.recordedAt
  );
}
