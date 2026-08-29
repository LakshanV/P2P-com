/**
 * K-06 Policy Engine — outbox event and audit definitions (FND-003d).
 *
 * These definitions describe the facts K-06 publishes to the platform event log and audit log.
 * They are declared separately from the service so a relay can register them without importing K-06
 * internals, and so the payloads stay stable once consumers depend on them.
 *
 * Owned by: K-06 Policy Engine.
 */

import type { AuditActionDefinition, EvidenceField } from '../audit-foundation/registry.ts';
import type { EventTypeDefinition, PayloadField } from '../event-infrastructure/registry.ts';
import { auditOutboxEntry, eventOutboxEntry } from '../../platform/outbox/builder.ts';
import type { OutboxEntry } from '../../platform/outbox/types.ts';

import type { PolicyActivation, PolicyRetirement, PolicyVersion } from './types.ts';

export const POLICY_VERSION_PUBLISHED_EVENT: EventTypeDefinition = {
  type: 'policy.version_published',
  schemaVersion: 1,
  owner: 'K-06',
  description: 'A policy version was published from a reviewed draft.',
  payloadFields: [
    {
      name: 'policy_key',
      kind: 'string',
      required: true,
      description: 'The policy key.',
    },
    {
      name: 'policy_version_id',
      kind: 'string',
      required: true,
      description: 'The published version id.',
    },
    {
      name: 'version',
      kind: 'integer',
      required: true,
      description: 'The version number within the policy key.',
    },
    {
      name: 'draft_id',
      kind: 'string',
      required: true,
      description: 'The draft this version was published from.',
    },
    {
      name: 'effective_from',
      kind: 'string',
      required: false,
      description: 'ISO-8601 instant from which the version applies, if bounded.',
    },
    {
      name: 'effective_until',
      kind: 'string',
      required: false,
      description: 'ISO-8601 instant until which the version applies, if bounded.',
    },
    {
      name: 'published_at',
      kind: 'string',
      required: true,
      description: 'When the version was published.',
    },
  ] satisfies PayloadField[],
};

export const POLICY_VERSION_PUBLISHED_ACTION: AuditActionDefinition = {
  action: 'policy.version_published',
  owner: 'K-06',
  authority: 'business-authoritative',
  description: 'A policy version was published from a reviewed draft.',
  resourceTypes: ['policy_version'],
  evidenceFields: [
    {
      name: 'policy_key',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The policy key.',
    },
    {
      name: 'policy_version_id',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The published version id.',
    },
    {
      name: 'version',
      kind: 'integer',
      required: true,
      classification: 'internal',
      description: 'The version number within the policy key.',
    },
    {
      name: 'draft_id',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The draft this version was published from.',
    },
    {
      name: 'effective_from',
      kind: 'string',
      required: false,
      classification: 'internal',
      description: 'ISO-8601 instant from which the version applies, if bounded.',
    },
    {
      name: 'effective_until',
      kind: 'string',
      required: false,
      classification: 'internal',
      description: 'ISO-8601 instant until which the version applies, if bounded.',
    },
    {
      name: 'published_at',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'When the version was published.',
    },
  ] satisfies EvidenceField[],
};

export const POLICY_ACTIVATED_EVENT: EventTypeDefinition = {
  type: 'policy.activated',
  schemaVersion: 1,
  owner: 'K-06',
  description: 'A published policy version became the version in force.',
  payloadFields: [
    {
      name: 'policy_key',
      kind: 'string',
      required: true,
      description: 'The policy key.',
    },
    {
      name: 'policy_version_id',
      kind: 'string',
      required: true,
      description: 'The version that became active.',
    },
    {
      name: 'version',
      kind: 'integer',
      required: true,
      description: 'The version number within the policy key.',
    },
    {
      name: 'activation_id',
      kind: 'string',
      required: true,
      description: 'The activation record.',
    },
    {
      name: 'supersedes_version_id',
      kind: 'string',
      required: false,
      description: 'The version this activation replaced, if any.',
    },
    {
      name: 'activated_at',
      kind: 'string',
      required: true,
      description: 'When the version became active.',
    },
  ] satisfies PayloadField[],
};

export const POLICY_ACTIVATED_ACTION: AuditActionDefinition = {
  action: 'policy.activated',
  owner: 'K-06',
  authority: 'business-authoritative',
  description: 'A published policy version became the version in force.',
  resourceTypes: ['policy_activation'],
  evidenceFields: [
    {
      name: 'policy_key',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The policy key.',
    },
    {
      name: 'policy_version_id',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The version that became active.',
    },
    {
      name: 'version',
      kind: 'integer',
      required: true,
      classification: 'internal',
      description: 'The version number within the policy key.',
    },
    {
      name: 'activation_id',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The activation record.',
    },
    {
      name: 'supersedes_version_id',
      kind: 'string',
      required: false,
      classification: 'internal',
      description: 'The version this activation replaced, if any.',
    },
    {
      name: 'activated_at',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'When the version became active.',
    },
  ] satisfies EvidenceField[],
};

export const POLICY_RETIRED_EVENT: EventTypeDefinition = {
  type: 'policy.retired',
  schemaVersion: 1,
  owner: 'K-06',
  description: 'A policy key was retired and will no longer decide new evaluations.',
  payloadFields: [
    {
      name: 'policy_key',
      kind: 'string',
      required: true,
      description: 'The retired policy key.',
    },
    {
      name: 'retirement_id',
      kind: 'string',
      required: true,
      description: 'The retirement record.',
    },
    {
      name: 'reason',
      kind: 'string',
      required: true,
      description: 'Why the policy was retired.',
    },
    {
      name: 'retired_at',
      kind: 'string',
      required: true,
      description: 'When the policy was retired.',
    },
  ] satisfies PayloadField[],
};

export const POLICY_RETIRED_ACTION: AuditActionDefinition = {
  action: 'policy.retired',
  owner: 'K-06',
  authority: 'business-authoritative',
  description: 'A policy key was retired and will no longer decide new evaluations.',
  resourceTypes: ['policy_retirement'],
  evidenceFields: [
    {
      name: 'policy_key',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The retired policy key.',
    },
    {
      name: 'retirement_id',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The retirement record.',
    },
    {
      name: 'reason',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'Why the policy was retired.',
    },
    {
      name: 'retired_at',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'When the policy was retired.',
    },
  ] satisfies EvidenceField[],
};

export function makePolicyVersionPublishedEvent(
  version: PolicyVersion,
  correlationId: string,
  causationId: string | null,
): OutboxEntry {
  const eventId = `${version.policyVersionId}:published`;
  const occurredAt = version.publishedAt;
  return eventOutboxEntry({
    outboxId: `K-06:${eventId}`,
    idempotencyKey: `K-06:${eventId}`,
    recordedAt: occurredAt,
    occurredAt,
    producer: 'K-06',
    correlationId,
    causationId,
    payload: {
      eventId,
      type: POLICY_VERSION_PUBLISHED_EVENT.type,
      schemaVersion: POLICY_VERSION_PUBLISHED_EVENT.schemaVersion,
      occurredAt,
      recordedAt: occurredAt,
      producer: 'K-06',
      correlationId,
      causationId,
      origin: 'system',
      actor: { kind: 'system', id: 'K-06' },
      idempotencyKey: `K-06:${eventId}`,
      now: occurredAt,
      payload: {
        policy_key: version.policyKey,
        policy_version_id: version.policyVersionId,
        version: version.version,
        draft_id: version.draftId,
        effective_from: version.effectiveFrom,
        effective_until: version.effectiveUntil,
        published_at: version.publishedAt,
      },
    },
  });
}

export function makePolicyVersionPublishedAction(
  version: PolicyVersion,
  correlationId: string,
  causationId: string | null,
): OutboxEntry {
  const recordId = `${version.policyVersionId}:published`;
  const outboxId = `K-06:audit:${recordId}`;
  const recordedAt = version.publishedAt;
  return auditOutboxEntry({
    outboxId,
    idempotencyKey: outboxId,
    recordedAt,
    producer: 'K-06',
    correlationId,
    causationId,
    payload: {
      recordId,
      action: POLICY_VERSION_PUBLISHED_ACTION.action,
      recordedAt,
      actor: {
        kind: 'system',
        id: 'K-06',
        authentication: 'unauthenticated',
        sessionId: null,
      },
      resource: {
        owner: 'K-06',
        type: 'policy_version',
        id: version.policyVersionId,
      },
      outcome: 'succeeded',
      reason: `policy version ${version.policyVersionId} published for ${version.policyKey}`,
      correlationId,
      causationId,
      idempotencyKey: outboxId,
      evidence: {
        policy_key: version.policyKey,
        policy_version_id: version.policyVersionId,
        version: version.version,
        draft_id: version.draftId,
        effective_from: version.effectiveFrom,
        effective_until: version.effectiveUntil,
        published_at: version.publishedAt,
      },
    },
  });
}

export function makePolicyActivatedEvent(
  version: PolicyVersion,
  activation: PolicyActivation,
  correlationId: string,
  causationId: string | null,
): OutboxEntry {
  const eventId = `${activation.activationId}:activated`;
  const occurredAt = activation.activatedAt;
  return eventOutboxEntry({
    outboxId: `K-06:${eventId}`,
    idempotencyKey: `K-06:${eventId}`,
    recordedAt: occurredAt,
    occurredAt,
    producer: 'K-06',
    correlationId,
    causationId,
    payload: {
      eventId,
      type: POLICY_ACTIVATED_EVENT.type,
      schemaVersion: POLICY_ACTIVATED_EVENT.schemaVersion,
      occurredAt,
      recordedAt: occurredAt,
      producer: 'K-06',
      correlationId,
      causationId,
      origin: 'system',
      actor: { kind: 'system', id: 'K-06' },
      idempotencyKey: `K-06:${eventId}`,
      now: occurredAt,
      payload: {
        policy_key: activation.policyKey,
        policy_version_id: activation.policyVersionId,
        version: version.version,
        activation_id: activation.activationId,
        supersedes_version_id: activation.supersedesVersionId,
        activated_at: activation.activatedAt,
      },
    },
  });
}

export function makePolicyActivatedAction(
  version: PolicyVersion,
  activation: PolicyActivation,
  correlationId: string,
  causationId: string | null,
): OutboxEntry {
  const recordId = `${activation.activationId}:activated`;
  const outboxId = `K-06:audit:${recordId}`;
  const recordedAt = activation.activatedAt;
  return auditOutboxEntry({
    outboxId,
    idempotencyKey: outboxId,
    recordedAt,
    producer: 'K-06',
    correlationId,
    causationId,
    payload: {
      recordId,
      action: POLICY_ACTIVATED_ACTION.action,
      recordedAt,
      actor: {
        kind: 'system',
        id: 'K-06',
        authentication: 'unauthenticated',
        sessionId: null,
      },
      resource: {
        owner: 'K-06',
        type: 'policy_activation',
        id: activation.activationId,
      },
      outcome: 'succeeded',
      reason: `${activation.policyKey} activated version ${activation.policyVersionId}`,
      correlationId,
      causationId,
      idempotencyKey: outboxId,
      evidence: {
        policy_key: activation.policyKey,
        policy_version_id: activation.policyVersionId,
        version: version.version,
        activation_id: activation.activationId,
        supersedes_version_id: activation.supersedesVersionId,
        activated_at: activation.activatedAt,
      },
    },
  });
}

export function makePolicyRetiredEvent(
  retirement: PolicyRetirement,
  correlationId: string,
  causationId: string | null,
): OutboxEntry {
  const eventId = `${retirement.retirementId}:retired`;
  const occurredAt = retirement.retiredAt;
  return eventOutboxEntry({
    outboxId: `K-06:${eventId}`,
    idempotencyKey: `K-06:${eventId}`,
    recordedAt: occurredAt,
    occurredAt,
    producer: 'K-06',
    correlationId,
    causationId,
    payload: {
      eventId,
      type: POLICY_RETIRED_EVENT.type,
      schemaVersion: POLICY_RETIRED_EVENT.schemaVersion,
      occurredAt,
      recordedAt: occurredAt,
      producer: 'K-06',
      correlationId,
      causationId,
      origin: 'system',
      actor: { kind: 'system', id: 'K-06' },
      idempotencyKey: `K-06:${eventId}`,
      now: occurredAt,
      payload: {
        policy_key: retirement.policyKey,
        retirement_id: retirement.retirementId,
        reason: retirement.reason,
        retired_at: retirement.retiredAt,
      },
    },
  });
}

export function makePolicyRetiredAction(
  retirement: PolicyRetirement,
  correlationId: string,
  causationId: string | null,
): OutboxEntry {
  const recordId = `${retirement.retirementId}:retired`;
  const outboxId = `K-06:audit:${recordId}`;
  const recordedAt = retirement.retiredAt;
  return auditOutboxEntry({
    outboxId,
    idempotencyKey: outboxId,
    recordedAt,
    producer: 'K-06',
    correlationId,
    causationId,
    payload: {
      recordId,
      action: POLICY_RETIRED_ACTION.action,
      recordedAt,
      actor: {
        kind: 'system',
        id: 'K-06',
        authentication: 'unauthenticated',
        sessionId: null,
      },
      resource: {
        owner: 'K-06',
        type: 'policy_retirement',
        id: retirement.retirementId,
      },
      outcome: 'succeeded',
      reason: `${retirement.policyKey} was retired: ${retirement.reason}`,
      correlationId,
      causationId,
      idempotencyKey: outboxId,
      evidence: {
        policy_key: retirement.policyKey,
        retirement_id: retirement.retirementId,
        reason: retirement.reason,
        retired_at: retirement.retiredAt,
      },
    },
  });
}
