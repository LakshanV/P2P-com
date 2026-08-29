/**
 * M-01 Universal Account — outbox event and audit definitions.
 *
 * These definitions describe the facts M-01 publishes when a capability is activated or deactivated.
 * They are declared separately from the service so a relay can register them without importing M-01
 * internals.
 *
 * Owned by: M-01 Universal Account.
 */

import type {
  AuditActionDefinition,
  EvidenceField,
} from '../../kernel/audit-foundation/registry.ts';
import { auditOutboxEntry, eventOutboxEntry } from '../../platform/outbox/builder.ts';
import type { OutboxEntry } from '../../platform/outbox/types.ts';
import type {
  EventTypeDefinition,
  PayloadField,
} from '../../kernel/event-infrastructure/registry.ts';

import type { AccountCapability, CapabilityState } from './types.ts';

export const CAPABILITY_ACTIVATED_EVENT: EventTypeDefinition = {
  type: 'capability.activated',
  schemaVersion: 1,
  owner: 'M-01',
  description: 'A capability was activated or reactivated.',
  payloadFields: [
    {
      name: 'capability_id',
      kind: 'string',
      required: true,
      description: 'The capability identifier.',
    },
    {
      name: 'account_id',
      kind: 'string',
      required: true,
      description: 'The universal account that holds the capability.',
    },
    {
      name: 'capability',
      kind: 'string',
      required: true,
      description: 'The role that was activated.',
    },
    {
      name: 'status',
      kind: 'string',
      required: true,
      description: 'The lifecycle status after activation.',
    },
    {
      name: 'activated_at',
      kind: 'string',
      required: true,
      description: 'ISO-8601 instant when the capability was activated.',
    },
    {
      name: 'idempotency_key',
      kind: 'string',
      required: true,
      description: 'The idempotency key supplied when activating the capability.',
    },
  ] satisfies PayloadField[],
};

export const CAPABILITY_DEACTIVATED_EVENT: EventTypeDefinition = {
  type: 'capability.deactivated',
  schemaVersion: 1,
  owner: 'M-01',
  description: 'A capability was deactivated.',
  payloadFields: [
    {
      name: 'capability_id',
      kind: 'string',
      required: true,
      description: 'The capability identifier.',
    },
    {
      name: 'account_id',
      kind: 'string',
      required: true,
      description: 'The universal account that holds the capability.',
    },
    {
      name: 'capability',
      kind: 'string',
      required: true,
      description: 'The role that was deactivated.',
    },
    {
      name: 'deactivated_at',
      kind: 'string',
      required: true,
      description: 'ISO-8601 instant when the capability was deactivated.',
    },
    {
      name: 'reason',
      kind: 'string',
      required: true,
      description: 'Why the capability was deactivated.',
    },
    {
      name: 'idempotency_key',
      kind: 'string',
      required: true,
      description: 'The idempotency key supplied when deactivating the capability.',
    },
  ] satisfies PayloadField[],
};

export const CAPABILITY_ACTIVATED_ACTION: AuditActionDefinition = {
  action: 'capability.activated',
  owner: 'M-01',
  authority: 'business-authoritative',
  description: 'A capability was activated or reactivated.',
  resourceTypes: ['capability'],
  evidenceFields: [
    {
      name: 'capability_id',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The capability identifier.',
    },
    {
      name: 'account_id',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The universal account that holds the capability.',
    },
    {
      name: 'capability',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The role that was activated.',
    },
    {
      name: 'status',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The lifecycle status after activation.',
    },
    {
      name: 'activated_at',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'ISO-8601 instant when the capability was activated.',
    },
    {
      name: 'idempotency_key',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The idempotency key supplied when activating the capability.',
    },
  ] satisfies EvidenceField[],
};

export const CAPABILITY_DEACTIVATED_ACTION: AuditActionDefinition = {
  action: 'capability.deactivated',
  owner: 'M-01',
  authority: 'business-authoritative',
  description: 'A capability was deactivated.',
  resourceTypes: ['capability'],
  evidenceFields: [
    {
      name: 'capability_id',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The capability identifier.',
    },
    {
      name: 'account_id',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The universal account that holds the capability.',
    },
    {
      name: 'capability',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The role that was deactivated.',
    },
    {
      name: 'deactivated_at',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'ISO-8601 instant when the capability was deactivated.',
    },
    {
      name: 'reason',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'Why the capability was deactivated.',
    },
    {
      name: 'idempotency_key',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The idempotency key supplied when deactivating the capability.',
    },
  ] satisfies EvidenceField[],
};

/**
 * The event reporting one activation.
 *
 * The outbox id is derived from the **transition**, not from the capability. A capability may be
 * activated, deactivated and activated again, and each of those is a separate fact the relay must
 * deliver; an id derived from the capability id alone collides with itself on the second
 * activation, and `outbox_pkey` refuses the write.
 */
export function makeCapabilityActivatedEvent(
  capability: AccountCapability,
  state: CapabilityState,
  correlationId: string,
  causationId: string | null,
): OutboxEntry {
  const eventId = `${state.stateId}:activated`;
  const recordedAt = capability.activatedAt;

  return eventOutboxEntry({
    outboxId: `M-01:${eventId}`,
    idempotencyKey: `M-01:${eventId}`,
    payload: {
      eventId,
      type: CAPABILITY_ACTIVATED_EVENT.type,
      schemaVersion: CAPABILITY_ACTIVATED_EVENT.schemaVersion,
      occurredAt: recordedAt,
      recordedAt,
      producer: 'M-01',
      correlationId,
      causationId,
      origin: 'system',
      actor: { kind: 'system', id: 'M-01' },
      idempotencyKey: `M-01:${eventId}`,
      now: recordedAt,
      payload: {
        capability_id: capability.capabilityId,
        account_id: capability.accountId,
        capability: capability.capability,
        status: capability.status,
        activated_at: capability.activatedAt,
        idempotency_key: capability.idempotencyKey,
      },
    },
    occurredAt: recordedAt,
    recordedAt,
    producer: 'M-01',
    correlationId,
    causationId,
  });
}

export function makeCapabilityDeactivatedEvent(
  capability: AccountCapability,
  state: CapabilityState,
  correlationId: string,
  causationId: string | null,
): OutboxEntry {
  const eventId = `${state.stateId}:deactivated`;
  const recordedAt = capability.deactivatedAt ?? state.occurredAt;

  return eventOutboxEntry({
    outboxId: `M-01:${eventId}`,
    idempotencyKey: `M-01:${eventId}`,
    payload: {
      eventId,
      type: CAPABILITY_DEACTIVATED_EVENT.type,
      schemaVersion: CAPABILITY_DEACTIVATED_EVENT.schemaVersion,
      occurredAt: recordedAt,
      recordedAt,
      producer: 'M-01',
      correlationId,
      causationId,
      origin: 'system',
      actor: { kind: 'system', id: 'M-01' },
      idempotencyKey: `M-01:${eventId}`,
      now: recordedAt,
      payload: {
        capability_id: capability.capabilityId,
        account_id: capability.accountId,
        capability: capability.capability,
        deactivated_at: capability.deactivatedAt ?? state.occurredAt,
        reason: state.reason,
        idempotency_key: state.idempotencyKey,
      },
    },
    occurredAt: recordedAt,
    recordedAt,
    producer: 'M-01',
    correlationId,
    causationId,
  });
}

/** The audit record for one activation, keyed by the transition for the reason given above. */
export function makeCapabilityActivatedAction(
  capability: AccountCapability,
  state: CapabilityState,
  correlationId: string,
  causationId: string | null,
): OutboxEntry {
  const recordId = `${state.stateId}:activated`;
  const outboxId = `M-01:audit:${recordId}`;
  const recordedAt = capability.activatedAt;

  return auditOutboxEntry({
    outboxId,
    idempotencyKey: outboxId,
    payload: {
      recordId,
      action: CAPABILITY_ACTIVATED_ACTION.action,
      recordedAt,
      actor: { kind: 'system', id: 'M-01', authentication: 'unauthenticated', sessionId: null },
      resource: { owner: 'M-01', type: 'capability', id: capability.capabilityId },
      outcome: 'succeeded',
      reason: `capability ${capability.capabilityId} activated as ${capability.capability}`,
      correlationId,
      causationId,
      idempotencyKey: outboxId,
      evidence: {
        capability_id: capability.capabilityId,
        account_id: capability.accountId,
        capability: capability.capability,
        status: capability.status,
        activated_at: capability.activatedAt,
        idempotency_key: capability.idempotencyKey,
      },
    },
    recordedAt,
    producer: 'M-01',
    correlationId,
    causationId,
  });
}

export function makeCapabilityDeactivatedAction(
  capability: AccountCapability,
  state: CapabilityState,
  correlationId: string,
  causationId: string | null,
): OutboxEntry {
  const recordId = `${state.stateId}:deactivated`;
  const outboxId = `M-01:audit:${recordId}`;
  const recordedAt = capability.deactivatedAt ?? state.occurredAt;

  return auditOutboxEntry({
    outboxId,
    idempotencyKey: outboxId,
    payload: {
      recordId,
      action: CAPABILITY_DEACTIVATED_ACTION.action,
      recordedAt,
      actor: { kind: 'system', id: 'M-01', authentication: 'unauthenticated', sessionId: null },
      resource: { owner: 'M-01', type: 'capability', id: capability.capabilityId },
      outcome: 'succeeded',
      reason: `capability ${capability.capabilityId} deactivated as ${capability.capability}: ${state.reason}`,
      correlationId,
      causationId,
      idempotencyKey: outboxId,
      evidence: {
        capability_id: capability.capabilityId,
        account_id: capability.accountId,
        capability: capability.capability,
        deactivated_at: capability.deactivatedAt ?? state.occurredAt,
        reason: state.reason,
        idempotency_key: state.idempotencyKey,
      },
    },
    recordedAt,
    producer: 'M-01',
    correlationId,
    causationId,
  });
}
