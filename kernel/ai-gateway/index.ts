/**
 * K-13 AI Gateway — public surface.
 *
 * Everything another unit may depend on is re-exported here. Anything not listed is internal and may
 * change without notice; see kernel/ai-gateway/CONTRACT.md for the contract this fixes.
 *
 * K-13 is the single boundary to model providers: task registry, model bindings, routing, provider
 * adapters, cost capture, and AI decision recording. It depends only on the platform substrate, K-05
 * Configuration, K-06 Policy Engine and K-09 Audit Foundation, and does not import any business
 * module or financial module.
 *
 * Owned by: K-13 AI Gateway.
 */

export {
  AUTHORITY_LEVELS,
  AUTHORITY_MEANINGS,
  CAPABILITIES,
  PROVIDERS,
  RUN_STATUSES,
  AIGatewayError,
  type AICost,
  type AIDecision,
  type AIRun,
  type AIGatewayErrorCode,
  type AuthorityLevel,
  type Capability,
  type ModelBinding,
  type Provider,
  type RunStatus,
  type TaskAuthority,
  type TaskDefinition,
} from './types.ts';

export {
  FOREIGN_FIELDS,
  assertAssetTypeId,
  assertOpaqueIdentifier,
  assertTaskId,
} from './registry.ts';

export {
  isAuthoritySealed,
  isBindingSealed,
  isDecisionSealed,
  isRunSealed,
  isTaskSealed,
  sealAuthorities,
  sealAuthority,
  sealBinding,
  sealBindings,
  sealCost,
  sealDecision,
  sealDecisions,
  sealRun,
  sealRuns,
  sealTask,
  sealTasks,
} from './immutable.ts';

export {
  validateAuthority,
  validateBinding,
  validateDecision,
  validateRun,
  validateTask,
} from './validate.ts';
export type { RecordSource } from './validate.ts';

export { AIGatewayService } from './service.ts';
export type {
  GrantAuthorityRequest,
  GrantAuthorityResult,
  ExecuteTaskRequest,
  ExecuteTaskResult,
  RecordDecisionRequest,
  RecordDecisionResult,
  RegisterModelRequest,
  RegisterModelResult,
  RegisterTaskRequest,
  RegisterTaskResult,
} from './service.ts';

export { InMemoryAIGatewayRepository } from './repository.ts';
export type { AIGatewayRepository, AIGatewayTransaction } from './repository.ts';

export {
  AI_GATEWAY_SCHEMA,
  BINDING_TABLE,
  DECISION_TABLE,
  EnlistedAIGatewayRepository,
  OUTBOX_TABLE,
  PostgresAIGatewayRepository,
  RUN_TABLE,
  TASK_TABLE,
  TIMESTAMP_COLUMNS,
  enlistedClient,
  toBinding,
  toDecision,
  toRun,
  toTask,
} from './postgres-repository.ts';

export {
  AI_DECISION_RECORDED_ACTION,
  AI_DECISION_RECORDED_EVENT,
  AI_TASK_EXECUTED_ACTION,
  AI_TASK_EXECUTED_EVENT,
  makeAIDecisionRecordedAction,
  makeAIDecisionRecordedEvent,
  makeAITaskExecutedAction,
  makeAITaskExecutedEvent,
} from './outbox.ts';

export type { AIProvider, AIProviderResult } from './adapters/ai-provider.ts';
export { MockAIProvider } from './adapters/mock-ai-provider.ts';
