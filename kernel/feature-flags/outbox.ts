/**
 * K-07 Feature Flags — outbox event and audit definitions (FND-003d).
 *
 * These definitions describe the facts K-07 publishes to the platform event log and audit log.
 * They are declared separately from the service so a relay can register them without importing
 * K-07 internals, and so the payloads stay stable once consumers depend on them.
 *
 * Owned by: K-07 Feature Flags.
 */

import type { AuditActionDefinition, EvidenceField } from '../audit-foundation/registry.ts';
import { auditOutboxEntry, eventOutboxEntry } from '../../platform/outbox/builder.ts';
import type { OutboxEntry } from '../../platform/outbox/types.ts';
import type { EventTypeDefinition, PayloadField } from '../event-infrastructure/registry.ts';

import type { Activation, FlagVersion, LifecycleEvent } from './types.ts';

export const FEATURE_FLAG_VERSION_PUBLISHED_EVENT: EventTypeDefinition = {
  type: 'featureflag.version_published',
  schemaVersion: 1,
  owner: 'K-07',
  description: 'A feature flag version was published and is now available for activation.',
  payloadFields: [
    { name: 'flag_key', kind: 'string', required: true, description: 'The flag key.' },
    {
      name: 'flag_version_id',
      kind: 'string',
      required: true,
      description: 'The published flag version id.',
    },
    {
      name: 'version',
      kind: 'integer',
      required: true,
      description: 'The version number within the flag key.',
    },
    { name: 'state', kind: 'string', required: true, description: 'The flag state.' },
    {
      name: 'published_at',
      kind: 'string',
      required: true,
      description: 'ISO-8601 instant when the version was published.',
    },
    {
      name: 'published_by_kind',
      kind: 'string',
      required: true,
      description: 'The actor kind that published the version.',
    },
    {
      name: 'published_by_id',
      kind: 'string',
      required: true,
      description: 'The actor id that published the version.',
    },
    {
      name: 'not_before',
      kind: 'string',
      required: false,
      description: 'Optional start of the activation window, ISO-8601.',
    },
    {
      name: 'not_after',
      kind: 'string',
      required: false,
      description: 'Optional end of the activation window, ISO-8601.',
    },
  ] satisfies PayloadField[],
};

export const FEATURE_FLAG_VERSION_PUBLISHED_ACTION: AuditActionDefinition = {
  action: 'featureflag.version_published',
  owner: 'K-07',
  authority: 'business-authoritative',
  description: 'A feature flag version was published.',
  resourceTypes: ['feature_flag_version'],
  evidenceFields: [
    {
      name: 'flag_key',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The flag key.',
    },
    {
      name: 'flag_version_id',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The published flag version id.',
    },
    {
      name: 'version',
      kind: 'integer',
      required: true,
      classification: 'internal',
      description: 'The version number within the flag key.',
    },
    {
      name: 'state',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The flag state.',
    },
    {
      name: 'published_at',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'When the version was published.',
    },
    {
      name: 'published_by_kind',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The actor kind that published the version.',
    },
    {
      name: 'published_by_id',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The actor id that published the version.',
    },
    {
      name: 'not_before',
      kind: 'string',
      required: false,
      classification: 'internal',
      description: 'Optional start of the activation window.',
    },
    {
      name: 'not_after',
      kind: 'string',
      required: false,
      classification: 'internal',
      description: 'Optional end of the activation window.',
    },
  ] satisfies EvidenceField[],
};

export const FEATURE_FLAG_VERSION_ACTIVATED_EVENT: EventTypeDefinition = {
  type: 'featureflag.version_activated',
  schemaVersion: 1,
  owner: 'K-07',
  description: 'A feature flag version became the current one for its flag key.',
  payloadFields: [
    { name: 'flag_key', kind: 'string', required: true, description: 'The flag key.' },
    {
      name: 'flag_version_id',
      kind: 'string',
      required: true,
      description: 'The activated flag version id.',
    },
    {
      name: 'version',
      kind: 'integer',
      required: true,
      description: 'The version number within the flag key.',
    },
    { name: 'state', kind: 'string', required: true, description: 'The flag state.' },
    {
      name: 'activated_at',
      kind: 'string',
      required: true,
      description: 'ISO-8601 instant when the version was activated.',
    },
    {
      name: 'activated_by_kind',
      kind: 'string',
      required: true,
      description: 'The actor kind that activated the version.',
    },
    {
      name: 'activated_by_id',
      kind: 'string',
      required: true,
      description: 'The actor id that activated the version.',
    },
    {
      name: 'supersedes_version_id',
      kind: 'string',
      required: false,
      description: 'The version this activation replaces, or null.',
    },
  ] satisfies PayloadField[],
};

export const FEATURE_FLAG_VERSION_ACTIVATED_ACTION: AuditActionDefinition = {
  action: 'featureflag.version_activated',
  owner: 'K-07',
  authority: 'business-authoritative',
  description: 'A feature flag version became the current one for its flag key.',
  resourceTypes: ['feature_flag_activation'],
  evidenceFields: [
    {
      name: 'flag_key',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The flag key.',
    },
    {
      name: 'flag_version_id',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The activated flag version id.',
    },
    {
      name: 'version',
      kind: 'integer',
      required: true,
      classification: 'internal',
      description: 'The version number within the flag key.',
    },
    {
      name: 'state',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The flag state.',
    },
    {
      name: 'activated_at',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'When the version was activated.',
    },
    {
      name: 'activated_by_kind',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The actor kind that activated the version.',
    },
    {
      name: 'activated_by_id',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The actor id that activated the version.',
    },
    {
      name: 'supersedes_version_id',
      kind: 'string',
      required: false,
      classification: 'internal',
      description: 'The version this activation replaces, or null.',
    },
  ] satisfies EvidenceField[],
};

export const FEATURE_FLAG_RETIRED_EVENT: EventTypeDefinition = {
  type: 'featureflag.retired',
  schemaVersion: 1,
  owner: 'K-07',
  description: 'A feature flag was retired and will answer off from now on.',
  payloadFields: [
    { name: 'flag_key', kind: 'string', required: true, description: 'The flag key.' },
    { name: 'event_id', kind: 'string', required: true, description: 'The lifecycle event id.' },
    {
      name: 'reason',
      kind: 'string',
      required: true,
      description: 'Why the flag was retired.',
    },
    {
      name: 'recorded_at',
      kind: 'string',
      required: true,
      description: 'ISO-8601 instant when the flag was retired.',
    },
    {
      name: 'recorded_by_kind',
      kind: 'string',
      required: true,
      description: 'The actor kind that retired the flag.',
    },
    {
      name: 'recorded_by_id',
      kind: 'string',
      required: true,
      description: 'The actor id that retired the flag.',
    },
  ] satisfies PayloadField[],
};

export const FEATURE_FLAG_RETIRED_ACTION: AuditActionDefinition = {
  action: 'featureflag.retired',
  owner: 'K-07',
  authority: 'business-authoritative',
  description: 'A feature flag was retired.',
  resourceTypes: ['feature_flag_lifecycle'],
  evidenceFields: [
    {
      name: 'flag_key',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The flag key.',
    },
    {
      name: 'event_id',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The lifecycle event id.',
    },
    {
      name: 'reason',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'Why the flag was retired.',
    },
    {
      name: 'recorded_at',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'When the flag was retired.',
    },
    {
      name: 'recorded_by_kind',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The actor kind that retired the flag.',
    },
    {
      name: 'recorded_by_id',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The actor id that retired the flag.',
    },
  ] satisfies EvidenceField[],
};

export interface OutboxOptions {
  readonly correlationId?: string;
  readonly causationId?: string | null;
}

export function makeFeatureFlagVersionPublishedEvent(
  version: FlagVersion,
  options: OutboxOptions = {},
): OutboxEntry {
  const eventId = `${version.flagVersionId}:published`;
  const outboxId = `K-07:${eventId}`;
  const correlationId = options.correlationId ?? version.flagVersionId;
  const causationId = options.causationId ?? null;
  const recordedAt = version.publishedAt;

  return eventOutboxEntry({
    outboxId,
    idempotencyKey: outboxId,
    recordedAt,
    occurredAt: recordedAt,
    producer: 'K-07',
    correlationId,
    causationId,
    payload: {
      eventId,
      type: FEATURE_FLAG_VERSION_PUBLISHED_EVENT.type,
      schemaVersion: FEATURE_FLAG_VERSION_PUBLISHED_EVENT.schemaVersion,
      occurredAt: recordedAt,
      recordedAt,
      producer: 'K-07',
      correlationId,
      causationId,
      origin: 'system',
      actor: { kind: 'system', id: 'K-07' },
      idempotencyKey: outboxId,
      now: recordedAt,
      payload: {
        flag_key: version.flagKey,
        flag_version_id: version.flagVersionId,
        version: version.version,
        state: version.state,
        published_at: version.publishedAt,
        published_by_kind: version.publishedBy.kind,
        published_by_id: version.publishedBy.id,
        not_before: version.notBefore,
        not_after: version.notAfter,
      },
    },
  });
}

export function makeFeatureFlagVersionPublishedAction(
  version: FlagVersion,
  options: OutboxOptions = {},
): OutboxEntry {
  const recordId = `${version.flagVersionId}:published`;
  const outboxId = `K-07:audit:${recordId}`;
  const correlationId = options.correlationId ?? version.flagVersionId;
  const causationId = options.causationId ?? null;
  const recordedAt = version.publishedAt;

  return auditOutboxEntry({
    outboxId,
    idempotencyKey: outboxId,
    recordedAt,
    producer: 'K-07',
    correlationId,
    causationId,
    payload: {
      recordId,
      action: FEATURE_FLAG_VERSION_PUBLISHED_ACTION.action,
      recordedAt,
      actor: {
        kind: 'system',
        id: 'K-07',
        authentication: 'unauthenticated',
        sessionId: null,
      },
      resource: {
        owner: 'K-07',
        type: 'feature_flag_version',
        id: version.flagVersionId,
      },
      outcome: 'succeeded',
      reason: `feature flag version ${version.flagVersionId} (${version.version}) published for ${version.flagKey}`,
      correlationId,
      causationId,
      idempotencyKey: outboxId,
      evidence: {
        flag_key: version.flagKey,
        flag_version_id: version.flagVersionId,
        version: version.version,
        state: version.state,
        published_at: version.publishedAt,
        published_by_kind: version.publishedBy.kind,
        published_by_id: version.publishedBy.id,
        not_before: version.notBefore,
        not_after: version.notAfter,
      },
    },
  });
}

export function makeFeatureFlagVersionActivatedEvent(
  version: FlagVersion,
  activation: Activation,
  options: OutboxOptions = {},
): OutboxEntry {
  const eventId = `${activation.activationId}:activated`;
  const outboxId = `K-07:${eventId}`;
  const correlationId = options.correlationId ?? activation.activationId;
  const causationId = options.causationId ?? null;
  const recordedAt = activation.activatedAt;

  return eventOutboxEntry({
    outboxId,
    idempotencyKey: outboxId,
    recordedAt,
    occurredAt: recordedAt,
    producer: 'K-07',
    correlationId,
    causationId,
    payload: {
      eventId,
      type: FEATURE_FLAG_VERSION_ACTIVATED_EVENT.type,
      schemaVersion: FEATURE_FLAG_VERSION_ACTIVATED_EVENT.schemaVersion,
      occurredAt: recordedAt,
      recordedAt,
      producer: 'K-07',
      correlationId,
      causationId,
      origin: 'system',
      actor: { kind: 'system', id: 'K-07' },
      idempotencyKey: outboxId,
      now: recordedAt,
      payload: {
        flag_key: activation.flagKey,
        flag_version_id: activation.flagVersionId,
        version: version.version,
        state: version.state,
        activated_at: activation.activatedAt,
        activated_by_kind: activation.activatedBy.kind,
        activated_by_id: activation.activatedBy.id,
        supersedes_version_id: activation.supersedesVersionId,
      },
    },
  });
}

export function makeFeatureFlagVersionActivatedAction(
  version: FlagVersion,
  activation: Activation,
  options: OutboxOptions = {},
): OutboxEntry {
  const recordId = `${activation.activationId}:activated`;
  const outboxId = `K-07:audit:${recordId}`;
  const correlationId = options.correlationId ?? activation.activationId;
  const causationId = options.causationId ?? null;
  const recordedAt = activation.activatedAt;

  return auditOutboxEntry({
    outboxId,
    idempotencyKey: outboxId,
    recordedAt,
    producer: 'K-07',
    correlationId,
    causationId,
    payload: {
      recordId,
      action: FEATURE_FLAG_VERSION_ACTIVATED_ACTION.action,
      recordedAt,
      actor: {
        kind: 'system',
        id: 'K-07',
        authentication: 'unauthenticated',
        sessionId: null,
      },
      resource: {
        owner: 'K-07',
        type: 'feature_flag_activation',
        id: activation.activationId,
      },
      outcome: 'succeeded',
      reason: `feature flag version ${activation.flagVersionId} (${version.version}) activated for ${activation.flagKey}`,
      correlationId,
      causationId,
      idempotencyKey: outboxId,
      evidence: {
        flag_key: activation.flagKey,
        flag_version_id: activation.flagVersionId,
        version: version.version,
        state: version.state,
        activated_at: activation.activatedAt,
        activated_by_kind: activation.activatedBy.kind,
        activated_by_id: activation.activatedBy.id,
        supersedes_version_id: activation.supersedesVersionId,
      },
    },
  });
}

export function makeFeatureFlagRetiredEvent(
  event: LifecycleEvent,
  options: OutboxOptions = {},
): OutboxEntry {
  const eventId = `${event.eventId}:retired`;
  const outboxId = `K-07:${eventId}`;
  const correlationId = options.correlationId ?? event.eventId;
  const causationId = options.causationId ?? null;
  const recordedAt = event.recordedAt;

  return eventOutboxEntry({
    outboxId,
    idempotencyKey: outboxId,
    recordedAt,
    occurredAt: recordedAt,
    producer: 'K-07',
    correlationId,
    causationId,
    payload: {
      eventId,
      type: FEATURE_FLAG_RETIRED_EVENT.type,
      schemaVersion: FEATURE_FLAG_RETIRED_EVENT.schemaVersion,
      occurredAt: recordedAt,
      recordedAt,
      producer: 'K-07',
      correlationId,
      causationId,
      origin: 'system',
      actor: { kind: 'system', id: 'K-07' },
      idempotencyKey: outboxId,
      now: recordedAt,
      payload: {
        flag_key: event.flagKey,
        event_id: event.eventId,
        reason: event.reason,
        recorded_at: event.recordedAt,
        recorded_by_kind: event.recordedBy.kind,
        recorded_by_id: event.recordedBy.id,
      },
    },
  });
}

export function makeFeatureFlagRetiredAction(
  event: LifecycleEvent,
  options: OutboxOptions = {},
): OutboxEntry {
  const recordId = `${event.eventId}:retired`;
  const outboxId = `K-07:audit:${recordId}`;
  const correlationId = options.correlationId ?? event.eventId;
  const causationId = options.causationId ?? null;
  const recordedAt = event.recordedAt;

  return auditOutboxEntry({
    outboxId,
    idempotencyKey: outboxId,
    recordedAt,
    producer: 'K-07',
    correlationId,
    causationId,
    payload: {
      recordId,
      action: FEATURE_FLAG_RETIRED_ACTION.action,
      recordedAt,
      actor: {
        kind: 'system',
        id: 'K-07',
        authentication: 'unauthenticated',
        sessionId: null,
      },
      resource: {
        owner: 'K-07',
        type: 'feature_flag_lifecycle',
        id: event.eventId,
      },
      outcome: 'succeeded',
      reason: `feature flag ${event.flagKey} retired: ${event.reason}`,
      correlationId,
      causationId,
      idempotencyKey: outboxId,
      evidence: {
        flag_key: event.flagKey,
        event_id: event.eventId,
        reason: event.reason,
        recorded_at: event.recordedAt,
        recorded_by_kind: event.recordedBy.kind,
        recorded_by_id: event.recordedBy.id,
      },
    },
  });
}
