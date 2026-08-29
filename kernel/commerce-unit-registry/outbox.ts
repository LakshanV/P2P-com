/**
 * K-11 Commerce Unit Registry — outbox event and audit definitions (FND-003d).
 *
 * These definitions describe the facts K-11 publishes to the platform event log and audit log.
 * They are declared separately from the service so a relay can register them without importing K-11
 * internals, and so the payloads stay stable once consumers depend on them.
 *
 * Owned by: K-11 Commerce Unit Registry.
 */

import type { AuditActionDefinition, EvidenceField } from '../audit-foundation/registry.ts';
import { auditOutboxEntry, eventOutboxEntry } from '../../platform/outbox/builder.ts';
import type { OutboxEntry } from '../../platform/outbox/types.ts';
import type { EventTypeDefinition, PayloadField } from '../event-infrastructure/registry.ts';

import {
  ownerKey,
  type UnitTypeActivation,
  type UnitTypeRetirement,
  type UnitTypeVersion,
} from './types.ts';

export const COMMERCE_UNIT_VERSION_PUBLISHED_EVENT: EventTypeDefinition = {
  type: 'commerceunitregistry.version_published',
  schemaVersion: 1,
  owner: 'K-11',
  description: 'A commerce unit type version was published and is now immutable registry history.',
  payloadFields: [
    {
      name: 'type_version_id',
      kind: 'string',
      required: true,
      description: 'The published type version id.',
    },
    { name: 'type_key', kind: 'string', required: true, description: 'The type key.' },
    {
      name: 'version',
      kind: 'integer',
      required: true,
      description: 'The version number within the type key.',
    },
    { name: 'kind', kind: 'string', required: true, description: 'The commerce unit kind.' },
    { name: 'owner', kind: 'string', required: true, description: 'platform or tenant:<id>.' },
    {
      name: 'parent_type_key',
      kind: 'string',
      required: false,
      description: 'The parent type key, or null.',
    },
    {
      name: 'risk_policy_key',
      kind: 'string',
      required: false,
      description: 'The pinned K-06 policy key, or null.',
    },
    {
      name: 'effective_from',
      kind: 'string',
      required: false,
      description: 'ISO-8601 instant from which the version applies, or null.',
    },
    {
      name: 'effective_until',
      kind: 'string',
      required: false,
      description: 'ISO-8601 instant until which the version applies, or null.',
    },
  ] satisfies PayloadField[],
};

export const COMMERCE_UNIT_VERSION_PUBLISHED_ACTION: AuditActionDefinition = {
  action: 'commerceunitregistry.version_published',
  owner: 'K-11',
  authority: 'business-authoritative',
  description: 'A commerce unit type version was published to the immutable registry.',
  resourceTypes: ['commerce_unit_type_version'],
  evidenceFields: [
    {
      name: 'type_version_id',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The published type version id.',
    },
    {
      name: 'type_key',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The type key.',
    },
    {
      name: 'version',
      kind: 'integer',
      required: true,
      classification: 'internal',
      description: 'The version number.',
    },
    {
      name: 'kind',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The commerce unit kind.',
    },
    {
      name: 'owner',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'platform or tenant:<id>.',
    },
    {
      name: 'parent_type_key',
      kind: 'string',
      required: false,
      classification: 'internal',
      description: 'The parent type key, or null.',
    },
    {
      name: 'risk_policy_key',
      kind: 'string',
      required: false,
      classification: 'internal',
      description: 'The pinned K-06 policy key, or null.',
    },
    {
      name: 'effective_from',
      kind: 'string',
      required: false,
      classification: 'internal',
      description: 'ISO-8601 instant from which the version applies, or null.',
    },
    {
      name: 'effective_until',
      kind: 'string',
      required: false,
      classification: 'internal',
      description: 'ISO-8601 instant until which the version applies, or null.',
    },
  ] satisfies EvidenceField[],
};

export const COMMERCE_UNIT_ACTIVATED_EVENT: EventTypeDefinition = {
  type: 'commerceunitregistry.type_activated',
  schemaVersion: 1,
  owner: 'K-11',
  description: 'A commerce unit type version became the one in force for its type key.',
  payloadFields: [
    {
      name: 'activation_id',
      kind: 'string',
      required: true,
      description: 'The activation record id.',
    },
    { name: 'type_key', kind: 'string', required: true, description: 'The type key.' },
    {
      name: 'type_version_id',
      kind: 'string',
      required: true,
      description: 'The version id put in force.',
    },
    {
      name: 'supersedes_version_id',
      kind: 'string',
      required: false,
      description: 'The version replaced, or null.',
    },
    {
      name: 'risk_policy_version_id',
      kind: 'string',
      required: false,
      description: 'The pinned K-06 policy version id, or null.',
    },
    {
      name: 'activated_at',
      kind: 'string',
      required: true,
      description: 'ISO-8601 instant when the activation happened.',
    },
  ] satisfies PayloadField[],
};

export const COMMERCE_UNIT_ACTIVATED_ACTION: AuditActionDefinition = {
  action: 'commerceunitregistry.type_activated',
  owner: 'K-11',
  authority: 'business-authoritative',
  description: 'A commerce unit type version was activated and is now in force.',
  resourceTypes: ['commerce_unit_type_activation'],
  evidenceFields: [
    {
      name: 'activation_id',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The activation record id.',
    },
    {
      name: 'type_key',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The type key.',
    },
    {
      name: 'type_version_id',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The version id put in force.',
    },
    {
      name: 'supersedes_version_id',
      kind: 'string',
      required: false,
      classification: 'internal',
      description: 'The version replaced, or null.',
    },
    {
      name: 'risk_policy_version_id',
      kind: 'string',
      required: false,
      classification: 'internal',
      description: 'The pinned K-06 policy version id, or null.',
    },
    {
      name: 'activated_at',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'ISO-8601 instant when the activation happened.',
    },
  ] satisfies EvidenceField[],
};

export const COMMERCE_UNIT_RETIRED_EVENT: EventTypeDefinition = {
  type: 'commerceunitregistry.type_retired',
  schemaVersion: 1,
  owner: 'K-11',
  description: 'A commerce unit type was retired and no longer describes new listings.',
  payloadFields: [
    {
      name: 'retirement_id',
      kind: 'string',
      required: true,
      description: 'The retirement record id.',
    },
    { name: 'type_key', kind: 'string', required: true, description: 'The type key.' },
    { name: 'reason', kind: 'string', required: true, description: 'Why the type was retired.' },
    {
      name: 'retired_at',
      kind: 'string',
      required: true,
      description: 'ISO-8601 instant when the retirement happened.',
    },
  ] satisfies PayloadField[],
};

export const COMMERCE_UNIT_RETIRED_ACTION: AuditActionDefinition = {
  action: 'commerceunitregistry.type_retired',
  owner: 'K-11',
  authority: 'business-authoritative',
  description: 'A commerce unit type was retired and stopped accepting new listings.',
  resourceTypes: ['commerce_unit_type_retirement'],
  evidenceFields: [
    {
      name: 'retirement_id',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The retirement record id.',
    },
    {
      name: 'type_key',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The type key.',
    },
    {
      name: 'reason',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'Why the type was retired.',
    },
    {
      name: 'retired_at',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'ISO-8601 instant when the retirement happened.',
    },
  ] satisfies EvidenceField[],
};

export function makeCommerceUnitVersionPublishedEvent(
  version: UnitTypeVersion,
  correlationId: string,
  causationId: string | null,
): OutboxEntry {
  const eventId = `${version.typeVersionId}:published`;
  const recordedAt = version.publishedAt;
  return eventOutboxEntry({
    outboxId: `K-11:${eventId}`,
    idempotencyKey: `K-11:${eventId}`,
    payload: {
      eventId,
      type: COMMERCE_UNIT_VERSION_PUBLISHED_EVENT.type,
      schemaVersion: COMMERCE_UNIT_VERSION_PUBLISHED_EVENT.schemaVersion,
      occurredAt: recordedAt,
      recordedAt,
      producer: 'K-11',
      correlationId,
      causationId,
      origin: 'system',
      actor: { kind: 'system', id: 'K-11' },
      idempotencyKey: `K-11:${eventId}`,
      now: recordedAt,
      payload: {
        type_version_id: version.typeVersionId,
        type_key: version.typeKey,
        version: version.version,
        kind: version.kind,
        owner: ownerKey(version.owner),
        parent_type_key: version.parentTypeKey,
        risk_policy_key: version.riskPolicyKey,
        effective_from: version.effectiveFrom,
        effective_until: version.effectiveUntil,
      },
    },
    occurredAt: recordedAt,
    recordedAt,
    producer: 'K-11',
    correlationId,
    causationId,
  });
}

export function makeCommerceUnitVersionPublishedAction(
  version: UnitTypeVersion,
  correlationId: string,
  causationId: string | null,
): OutboxEntry {
  const recordId = `${version.typeVersionId}:published`;
  const outboxId = `K-11:audit:${recordId}`;
  const recordedAt = version.publishedAt;
  return auditOutboxEntry({
    outboxId,
    idempotencyKey: outboxId,
    payload: {
      recordId,
      action: COMMERCE_UNIT_VERSION_PUBLISHED_ACTION.action,
      recordedAt,
      actor: { kind: 'system', id: 'K-11', authentication: 'unauthenticated', sessionId: null },
      resource: { owner: 'K-11', type: 'commerce_unit_type_version', id: version.typeVersionId },
      outcome: 'succeeded',
      reason: `commerce unit type version ${version.typeVersionId} of ${version.typeKey} published`,
      correlationId,
      causationId,
      idempotencyKey: outboxId,
      evidence: {
        type_version_id: version.typeVersionId,
        type_key: version.typeKey,
        version: version.version,
        kind: version.kind,
        owner: ownerKey(version.owner),
        parent_type_key: version.parentTypeKey,
        risk_policy_key: version.riskPolicyKey,
        effective_from: version.effectiveFrom,
        effective_until: version.effectiveUntil,
      },
    },
    recordedAt,
    producer: 'K-11',
    correlationId,
    causationId,
  });
}

export function makeCommerceUnitActivatedEvent(
  activation: UnitTypeActivation,
  correlationId: string,
  causationId: string | null,
): OutboxEntry {
  const eventId = `${activation.activationId}:activated`;
  const recordedAt = activation.activatedAt;
  return eventOutboxEntry({
    outboxId: `K-11:${eventId}`,
    idempotencyKey: `K-11:${eventId}`,
    payload: {
      eventId,
      type: COMMERCE_UNIT_ACTIVATED_EVENT.type,
      schemaVersion: COMMERCE_UNIT_ACTIVATED_EVENT.schemaVersion,
      occurredAt: recordedAt,
      recordedAt,
      producer: 'K-11',
      correlationId,
      causationId,
      origin: 'system',
      actor: { kind: 'system', id: 'K-11' },
      idempotencyKey: `K-11:${eventId}`,
      now: recordedAt,
      payload: {
        activation_id: activation.activationId,
        type_key: activation.typeKey,
        type_version_id: activation.typeVersionId,
        supersedes_version_id: activation.supersedesVersionId,
        risk_policy_version_id: activation.riskPolicyVersionId,
        activated_at: activation.activatedAt,
      },
    },
    occurredAt: recordedAt,
    recordedAt,
    producer: 'K-11',
    correlationId,
    causationId,
  });
}

export function makeCommerceUnitActivatedAction(
  activation: UnitTypeActivation,
  correlationId: string,
  causationId: string | null,
): OutboxEntry {
  const recordId = `${activation.activationId}:activated`;
  const outboxId = `K-11:audit:${recordId}`;
  const recordedAt = activation.activatedAt;
  return auditOutboxEntry({
    outboxId,
    idempotencyKey: outboxId,
    payload: {
      recordId,
      action: COMMERCE_UNIT_ACTIVATED_ACTION.action,
      recordedAt,
      actor: { kind: 'system', id: 'K-11', authentication: 'unauthenticated', sessionId: null },
      resource: {
        owner: 'K-11',
        type: 'commerce_unit_type_activation',
        id: activation.activationId,
      },
      outcome: 'succeeded',
      reason: `commerce unit type ${activation.typeKey} activated to version ${activation.typeVersionId}`,
      correlationId,
      causationId,
      idempotencyKey: outboxId,
      evidence: {
        activation_id: activation.activationId,
        type_key: activation.typeKey,
        type_version_id: activation.typeVersionId,
        supersedes_version_id: activation.supersedesVersionId,
        risk_policy_version_id: activation.riskPolicyVersionId,
        activated_at: activation.activatedAt,
      },
    },
    recordedAt,
    producer: 'K-11',
    correlationId,
    causationId,
  });
}

export function makeCommerceUnitRetiredEvent(
  retirement: UnitTypeRetirement,
  correlationId: string,
  causationId: string | null,
): OutboxEntry {
  const eventId = `${retirement.retirementId}:retired`;
  const recordedAt = retirement.retiredAt;
  return eventOutboxEntry({
    outboxId: `K-11:${eventId}`,
    idempotencyKey: `K-11:${eventId}`,
    payload: {
      eventId,
      type: COMMERCE_UNIT_RETIRED_EVENT.type,
      schemaVersion: COMMERCE_UNIT_RETIRED_EVENT.schemaVersion,
      occurredAt: recordedAt,
      recordedAt,
      producer: 'K-11',
      correlationId,
      causationId,
      origin: 'system',
      actor: { kind: 'system', id: 'K-11' },
      idempotencyKey: `K-11:${eventId}`,
      now: recordedAt,
      payload: {
        retirement_id: retirement.retirementId,
        type_key: retirement.typeKey,
        reason: retirement.reason,
        retired_at: retirement.retiredAt,
      },
    },
    occurredAt: recordedAt,
    recordedAt,
    producer: 'K-11',
    correlationId,
    causationId,
  });
}

export function makeCommerceUnitRetiredAction(
  retirement: UnitTypeRetirement,
  correlationId: string,
  causationId: string | null,
): OutboxEntry {
  const recordId = `${retirement.retirementId}:retired`;
  const outboxId = `K-11:audit:${recordId}`;
  const recordedAt = retirement.retiredAt;
  return auditOutboxEntry({
    outboxId,
    idempotencyKey: outboxId,
    payload: {
      recordId,
      action: COMMERCE_UNIT_RETIRED_ACTION.action,
      recordedAt,
      actor: { kind: 'system', id: 'K-11', authentication: 'unauthenticated', sessionId: null },
      resource: {
        owner: 'K-11',
        type: 'commerce_unit_type_retirement',
        id: retirement.retirementId,
      },
      outcome: 'succeeded',
      reason: `commerce unit type ${retirement.typeKey} retired: ${retirement.reason}`,
      correlationId,
      causationId,
      idempotencyKey: outboxId,
      evidence: {
        retirement_id: retirement.retirementId,
        type_key: retirement.typeKey,
        reason: retirement.reason,
        retired_at: retirement.retiredAt,
      },
    },
    recordedAt,
    producer: 'K-11',
    correlationId,
    causationId,
  });
}
