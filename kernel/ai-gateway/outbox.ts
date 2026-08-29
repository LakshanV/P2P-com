/**
 * K-13 AI Gateway — outbox event and audit definitions.
 *
 * These definitions describe the facts K-13 publishes when a task is executed or a decision is
 * recorded. They are declared separately from the service so a relay can register them without
 * importing K-13 internals.
 *
 * Owned by: K-13 AI Gateway.
 */

import type { AuditActionDefinition, EvidenceField } from '../audit-foundation/registry.ts';
import { auditOutboxEntry, eventOutboxEntry } from '../../platform/outbox/builder.ts';
import type { OutboxEntry } from '../../platform/outbox/types.ts';
import type { EventTypeDefinition, PayloadField } from '../event-infrastructure/registry.ts';

import type { AIDecision, AIRun, TaskAuthority } from './types.ts';

export const AI_TASK_EXECUTED_EVENT: EventTypeDefinition = {
  type: 'ai.task_executed',
  schemaVersion: 1,
  owner: 'K-13',
  description: 'An AI task was executed through a model binding.',
  payloadFields: [
    {
      name: 'run_id',
      kind: 'string',
      required: true,
      description: 'The AI run identifier.',
    },
    {
      name: 'task_id',
      kind: 'string',
      required: true,
      description: 'The task that was executed.',
    },
    {
      name: 'binding_id',
      kind: 'string',
      required: true,
      description: 'The model binding that served the run.',
    },
    {
      name: 'status',
      kind: 'string',
      required: true,
      description: 'Whether the run succeeded or failed.',
    },
    {
      name: 'input_tokens',
      kind: 'integer',
      required: true,
      description: 'Approximate input tokens consumed.',
    },
    {
      name: 'output_tokens',
      kind: 'integer',
      required: true,
      description: 'Approximate output tokens produced.',
    },
    {
      name: 'total_cost',
      kind: 'string',
      required: true,
      description: 'Total cost in minor units, as a decimal string.',
    },
    {
      name: 'cost_asset_type_id',
      kind: 'string',
      required: true,
      description: 'Asset type in which the cost is expressed.',
    },
    {
      name: 'correlation_id',
      kind: 'string',
      required: true,
      description: 'The correlation id supplied by the caller.',
    },
    {
      name: 'finished_at',
      kind: 'string',
      required: true,
      description: 'ISO-8601 instant when the run finished.',
    },
    {
      name: 'idempotency_key',
      kind: 'string',
      required: true,
      description: 'The idempotency key supplied when executing the task.',
    },
  ] satisfies PayloadField[],
};

export const AI_TASK_EXECUTED_ACTION: AuditActionDefinition = {
  action: 'ai.task_executed',
  owner: 'K-13',
  authority: 'business-authoritative',
  description: 'An AI task was executed through a model binding.',
  resourceTypes: ['ai_run'],
  evidenceFields: [
    {
      name: 'run_id',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The AI run identifier.',
    },
    {
      name: 'task_id',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The task that was executed.',
    },
    {
      name: 'binding_id',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The model binding that served the run.',
    },
    {
      name: 'status',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'Whether the run succeeded or failed.',
    },
    {
      name: 'input_tokens',
      kind: 'integer',
      required: true,
      classification: 'internal',
      description: 'Approximate input tokens consumed.',
    },
    {
      name: 'output_tokens',
      kind: 'integer',
      required: true,
      classification: 'internal',
      description: 'Approximate output tokens produced.',
    },
    {
      name: 'total_cost',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'Total cost in minor units, as a decimal string.',
    },
    {
      name: 'cost_asset_type_id',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'Asset type in which the cost is expressed.',
    },
    {
      name: 'correlation_id',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The correlation id supplied by the caller.',
    },
    {
      name: 'finished_at',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'ISO-8601 instant when the run finished.',
    },
    {
      name: 'idempotency_key',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The idempotency key supplied when executing the task.',
    },
  ] satisfies EvidenceField[],
};

export const AI_DECISION_RECORDED_EVENT: EventTypeDefinition = {
  type: 'ai.decision_recorded',
  schemaVersion: 1,
  owner: 'K-13',
  description: 'An AI decision was recorded.',
  payloadFields: [
    {
      name: 'decision_id',
      kind: 'string',
      required: true,
      description: 'The AI decision identifier.',
    },
    {
      name: 'task_id',
      kind: 'string',
      required: true,
      description: 'The task the decision relates to.',
    },
    {
      name: 'run_id',
      kind: 'string',
      required: false,
      description: 'The run the decision relates to, if any.',
    },
    {
      name: 'policy_level',
      kind: 'integer',
      required: true,
      description: 'Policy level on a 0-4 scale.',
    },
    {
      name: 'approved',
      kind: 'boolean',
      required: true,
      description: 'Whether the decision was approved.',
    },
    {
      name: 'recorded_at',
      kind: 'string',
      required: true,
      description: 'ISO-8601 instant when the decision was recorded.',
    },
    {
      name: 'idempotency_key',
      kind: 'string',
      required: true,
      description: 'The idempotency key supplied when recording the decision.',
    },
  ] satisfies PayloadField[],
};

export const AI_DECISION_RECORDED_ACTION: AuditActionDefinition = {
  action: 'ai.decision_recorded',
  owner: 'K-13',
  authority: 'business-authoritative',
  description: 'An AI decision was recorded.',
  resourceTypes: ['ai_decision'],
  evidenceFields: [
    {
      name: 'decision_id',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The AI decision identifier.',
    },
    {
      name: 'task_id',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The task the decision relates to.',
    },
    {
      name: 'run_id',
      kind: 'string',
      required: false,
      classification: 'internal',
      description: 'The run the decision relates to, if any.',
    },
    {
      name: 'policy_level',
      kind: 'integer',
      required: true,
      classification: 'internal',
      description: 'Policy level on a 0-4 scale.',
    },
    {
      name: 'approved',
      kind: 'boolean',
      required: true,
      classification: 'internal',
      description: 'Whether the decision was approved.',
    },
    {
      name: 'recorded_at',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'ISO-8601 instant when the decision was recorded.',
    },
    {
      name: 'idempotency_key',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The idempotency key supplied when recording the decision.',
    },
  ] satisfies EvidenceField[],
};

export function makeAITaskExecutedEvent(
  run: AIRun,
  correlationId: string,
  causationId: string | null,
): OutboxEntry {
  const eventId = `${run.runId}:executed`;
  const recordedAt = run.finishedAt;

  return eventOutboxEntry({
    outboxId: `K-13:${eventId}`,
    idempotencyKey: `K-13:${eventId}`,
    payload: {
      eventId,
      type: AI_TASK_EXECUTED_EVENT.type,
      schemaVersion: AI_TASK_EXECUTED_EVENT.schemaVersion,
      occurredAt: recordedAt,
      recordedAt,
      producer: 'K-13',
      correlationId,
      causationId,
      origin: 'system',
      actor: { kind: 'system', id: 'K-13' },
      idempotencyKey: `K-13:${eventId}`,
      now: recordedAt,
      payload: {
        run_id: run.runId,
        task_id: run.taskId,
        binding_id: run.bindingId,
        status: run.status,
        input_tokens: run.cost.inputTokens,
        output_tokens: run.cost.outputTokens,
        total_cost: run.cost.totalCost.toString(),
        cost_asset_type_id: run.cost.assetTypeId,
        correlation_id: run.correlationId,
        finished_at: run.finishedAt,
        idempotency_key: run.idempotencyKey,
      },
    },
    occurredAt: recordedAt,
    recordedAt,
    producer: 'K-13',
    correlationId,
    causationId,
  });
}

export function makeAITaskExecutedAction(
  run: AIRun,
  correlationId: string,
  causationId: string | null,
): OutboxEntry {
  const recordId = `${run.runId}:executed`;
  const outboxId = `K-13:audit:${recordId}`;
  const recordedAt = run.finishedAt;

  return auditOutboxEntry({
    outboxId,
    idempotencyKey: outboxId,
    payload: {
      recordId,
      action: AI_TASK_EXECUTED_ACTION.action,
      recordedAt,
      actor: { kind: 'system', id: 'K-13', authentication: 'unauthenticated', sessionId: null },
      resource: { owner: 'K-13', type: 'ai_run', id: run.runId },
      outcome: 'succeeded',
      reason: `AI run ${run.runId} executed task ${run.taskId} through binding ${run.bindingId}`,
      correlationId,
      causationId,
      idempotencyKey: outboxId,
      evidence: {
        run_id: run.runId,
        task_id: run.taskId,
        binding_id: run.bindingId,
        status: run.status,
        input_tokens: run.cost.inputTokens,
        output_tokens: run.cost.outputTokens,
        total_cost: run.cost.totalCost.toString(),
        cost_asset_type_id: run.cost.assetTypeId,
        correlation_id: run.correlationId,
        finished_at: run.finishedAt,
        idempotency_key: run.idempotencyKey,
      },
    },
    recordedAt,
    producer: 'K-13',
    correlationId,
    causationId,
  });
}

export function makeAIDecisionRecordedEvent(
  decision: AIDecision,
  correlationId: string,
  causationId: string | null,
): OutboxEntry {
  const eventId = `${decision.decisionId}:recorded`;
  const recordedAt = decision.recordedAt;

  return eventOutboxEntry({
    outboxId: `K-13:${eventId}`,
    idempotencyKey: `K-13:${eventId}`,
    payload: {
      eventId,
      type: AI_DECISION_RECORDED_EVENT.type,
      schemaVersion: AI_DECISION_RECORDED_EVENT.schemaVersion,
      occurredAt: recordedAt,
      recordedAt,
      producer: 'K-13',
      correlationId,
      causationId,
      origin: 'system',
      actor: { kind: 'system', id: 'K-13' },
      idempotencyKey: `K-13:${eventId}`,
      now: recordedAt,
      payload: {
        decision_id: decision.decisionId,
        task_id: decision.taskId,
        run_id: decision.runId,
        policy_level: decision.policyLevel,
        approved: decision.approved,
        recorded_at: decision.recordedAt,
        idempotency_key: decision.idempotencyKey,
      },
    },
    occurredAt: recordedAt,
    recordedAt,
    producer: 'K-13',
    correlationId,
    causationId,
  });
}

export function makeAIDecisionRecordedAction(
  decision: AIDecision,
  correlationId: string,
  causationId: string | null,
): OutboxEntry {
  const recordId = `${decision.decisionId}:recorded`;
  const outboxId = `K-13:audit:${recordId}`;
  const recordedAt = decision.recordedAt;

  return auditOutboxEntry({
    outboxId,
    idempotencyKey: outboxId,
    payload: {
      recordId,
      action: AI_DECISION_RECORDED_ACTION.action,
      recordedAt,
      actor: { kind: 'system', id: 'K-13', authentication: 'unauthenticated', sessionId: null },
      resource: { owner: 'K-13', type: 'ai_decision', id: decision.decisionId },
      outcome: 'succeeded',
      reason: `AI decision ${decision.decisionId} recorded for task ${decision.taskId}`,
      correlationId,
      causationId,
      idempotencyKey: outboxId,
      evidence: {
        decision_id: decision.decisionId,
        task_id: decision.taskId,
        run_id: decision.runId,
        policy_level: decision.policyLevel,
        approved: decision.approved,
        recorded_at: decision.recordedAt,
        idempotency_key: decision.idempotencyKey,
      },
    },
    recordedAt,
    producer: 'K-13',
    correlationId,
    causationId,
  });
}

// ---------------------------------------------------------------------------
// Authority grants
// ---------------------------------------------------------------------------

export const AI_AUTHORITY_GRANTED_EVENT: EventTypeDefinition = {
  type: 'ai.authority_granted',
  schemaVersion: 1,
  owner: 'K-13',
  description:
    "A task's authority ceiling was granted, changed or suspended. Grants are versions; this is the version that came into force.",
  payloadFields: [
    {
      name: 'authority_id',
      kind: 'string',
      required: true,
      description: 'The identifier of this version of the grant.',
    },
    {
      name: 'task_id',
      kind: 'string',
      required: true,
      description: 'The task the grant governs.',
    },
    {
      name: 'max_authority',
      kind: 'integer',
      required: true,
      description: 'The highest level the task may be invoked at, 0-4.',
    },
    {
      name: 'suspended',
      kind: 'boolean',
      required: true,
      description: 'Whether the kill switch is engaged for this task.',
    },
    {
      name: 'granted_by',
      kind: 'string',
      required: true,
      description: 'The opaque identifier of the human or role that granted it.',
    },
    {
      name: 'granted_at',
      kind: 'string',
      required: true,
      description: 'ISO-8601 instant the grant takes effect.',
    },
    {
      name: 'idempotency_key',
      kind: 'string',
      required: true,
      description: 'The idempotency key supplied when granting.',
    },
  ] satisfies PayloadField[],
};

export const AI_AUTHORITY_GRANTED_ACTION: AuditActionDefinition = {
  action: 'ai.authority_granted',
  owner: 'K-13',
  authority: 'business-authoritative',
  description: "A task's authority ceiling was granted, changed or suspended.",
  resourceTypes: ['ai_task_authority'],
  evidenceFields: [
    {
      name: 'authority_id',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The identifier of this version of the grant.',
    },
    {
      name: 'task_id',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The task the grant governs.',
    },
    {
      name: 'max_authority',
      kind: 'integer',
      required: true,
      classification: 'internal',
      description: 'The highest level the task may be invoked at, 0-4.',
    },
    {
      name: 'suspended',
      kind: 'boolean',
      required: true,
      classification: 'internal',
      description: 'Whether the kill switch is engaged for this task.',
    },
    {
      name: 'rationale',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: "Why this ceiling was set, in the granter's own words.",
    },
    {
      name: 'granted_by',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The opaque identifier of the human or role that granted it.',
    },
    {
      name: 'granted_at',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'ISO-8601 instant the grant takes effect.',
    },
    {
      name: 'idempotency_key',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The idempotency key supplied when granting.',
    },
  ] satisfies EvidenceField[],
};

export function makeAIAuthorityGrantedEvent(
  authority: TaskAuthority,
  correlationId: string,
  causationId: string | null,
): OutboxEntry {
  const eventId = `${authority.authorityId}:granted`;
  const recordedAt = authority.grantedAt;

  return eventOutboxEntry({
    outboxId: `K-13:${eventId}`,
    idempotencyKey: `K-13:${eventId}`,
    payload: {
      eventId,
      type: AI_AUTHORITY_GRANTED_EVENT.type,
      schemaVersion: AI_AUTHORITY_GRANTED_EVENT.schemaVersion,
      occurredAt: recordedAt,
      recordedAt,
      producer: 'K-13',
      correlationId,
      causationId,
      origin: 'system',
      actor: { kind: 'system', id: 'K-13' },
      idempotencyKey: `K-13:${eventId}`,
      now: recordedAt,
      payload: {
        authority_id: authority.authorityId,
        task_id: authority.taskId,
        max_authority: authority.maxAuthority,
        suspended: authority.suspended,
        granted_by: authority.grantedBy,
        granted_at: authority.grantedAt,
        idempotency_key: authority.idempotencyKey,
      },
    },
    occurredAt: recordedAt,
    recordedAt,
    producer: 'K-13',
    correlationId,
    causationId,
  });
}

export function makeAIAuthorityGrantedAction(
  authority: TaskAuthority,
  correlationId: string,
  causationId: string | null,
): OutboxEntry {
  const recordId = `${authority.authorityId}:granted`;
  const outboxId = `K-13:audit:${recordId}`;
  const recordedAt = authority.grantedAt;

  return auditOutboxEntry({
    outboxId,
    idempotencyKey: outboxId,
    payload: {
      recordId,
      action: AI_AUTHORITY_GRANTED_ACTION.action,
      recordedAt,
      actor: { kind: 'system', id: 'K-13', authentication: 'unauthenticated', sessionId: null },
      resource: { owner: 'K-13', type: 'ai_task_authority', id: authority.authorityId },
      outcome: 'succeeded',
      reason: authority.suspended
        ? `task ${authority.taskId} suspended: ${authority.rationale}`
        : `task ${authority.taskId} may be invoked at up to level ${authority.maxAuthority}: ${authority.rationale}`,
      correlationId,
      causationId,
      idempotencyKey: outboxId,
      evidence: {
        authority_id: authority.authorityId,
        task_id: authority.taskId,
        max_authority: authority.maxAuthority,
        suspended: authority.suspended,
        rationale: authority.rationale,
        granted_by: authority.grantedBy,
        granted_at: authority.grantedAt,
        idempotency_key: authority.idempotencyKey,
      },
    },
    recordedAt,
    producer: 'K-13',
    correlationId,
    causationId,
  });
}
