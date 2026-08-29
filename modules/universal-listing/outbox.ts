/**
 * M-04 Universal Listing — slice A outbox event and audit definitions.
 *
 * These definitions describe the facts M-04 publishes when a listing is created, a version is
 * published, or a listing is suspended or withdrawn. They are declared separately from the service
 * so a relay can register them without importing M-04 internals.
 *
 * Owned by: M-04 Universal Listing.
 */

import type { AuditActionDefinition } from '../../kernel/audit-foundation/registry.ts';
import { auditOutboxEntry, eventOutboxEntry } from '../../platform/outbox/builder.ts';
import type { OutboxEntry } from '../../platform/outbox/types.ts';
import type {
  EventTypeDefinition,
  PayloadField,
} from '../../kernel/event-infrastructure/registry.ts';

import type { Listing, ListingVersion } from './types.ts';

export const LISTING_CREATED_EVENT: EventTypeDefinition = {
  type: 'listing.created',
  schemaVersion: 1,
  owner: 'M-04',
  description: 'A listing was created as a draft.',
  payloadFields: [
    { name: 'listing_id', kind: 'string', required: true, description: 'The listing identifier.' },
    { name: 'account_id', kind: 'string', required: true, description: 'The supplying account.' },
    {
      name: 'commerce_unit_type_id',
      kind: 'string',
      required: true,
      description: 'The commerce unit type this listing offers.',
    },
    {
      name: 'created_at',
      kind: 'string',
      required: true,
      description: 'ISO-8601 instant when the listing was created.',
    },
    {
      name: 'idempotency_key',
      kind: 'string',
      required: true,
      description: 'The idempotency key supplied when creating the listing.',
    },
  ] satisfies PayloadField[],
};

export const LISTING_PUBLISHED_EVENT: EventTypeDefinition = {
  type: 'listing.published',
  schemaVersion: 1,
  owner: 'M-04',
  description: 'A new version of a listing was published.',
  payloadFields: [
    { name: 'listing_id', kind: 'string', required: true, description: 'The listing identifier.' },
    {
      name: 'version_id',
      kind: 'string',
      required: true,
      description: 'The published version identifier.',
    },
    {
      name: 'version_number',
      kind: 'integer',
      required: true,
      description: 'The version number within the listing.',
    },
    { name: 'account_id', kind: 'string', required: true, description: 'The supplying account.' },
    {
      name: 'unit_price_minor',
      kind: 'string',
      required: true,
      description: 'The unit price in integer minor units, as a string.',
    },
    {
      name: 'currency',
      kind: 'string',
      required: true,
      description: 'The ISO-4217 currency code.',
    },
    {
      name: 'quantity_available',
      kind: 'string',
      required: true,
      description: 'How many units are offered, as a string.',
    },
    {
      name: 'published_at',
      kind: 'string',
      required: true,
      description: 'ISO-8601 instant when the version was published.',
    },
    {
      name: 'idempotency_key',
      kind: 'string',
      required: true,
      description: 'The idempotency key supplied when publishing the version.',
    },
  ] satisfies PayloadField[],
};

export const LISTING_SUSPENDED_EVENT: EventTypeDefinition = {
  type: 'listing.suspended',
  schemaVersion: 1,
  owner: 'M-04',
  description: 'A listing was suspended.',
  payloadFields: [
    { name: 'listing_id', kind: 'string', required: true, description: 'The listing identifier.' },
    { name: 'account_id', kind: 'string', required: true, description: 'The supplying account.' },
    {
      name: 'occurred_at',
      kind: 'string',
      required: true,
      description: 'ISO-8601 instant when the suspension happened.',
    },
    {
      name: 'reason',
      kind: 'string',
      required: true,
      description: 'Why the listing was suspended.',
    },
    {
      name: 'idempotency_key',
      kind: 'string',
      required: true,
      description: 'The idempotency key supplied when suspending the listing.',
    },
  ] satisfies PayloadField[],
};

export const LISTING_WITHDRAWN_EVENT: EventTypeDefinition = {
  type: 'listing.withdrawn',
  schemaVersion: 1,
  owner: 'M-04',
  description: 'A listing was withdrawn.',
  payloadFields: [
    { name: 'listing_id', kind: 'string', required: true, description: 'The listing identifier.' },
    { name: 'account_id', kind: 'string', required: true, description: 'The supplying account.' },
    {
      name: 'occurred_at',
      kind: 'string',
      required: true,
      description: 'ISO-8601 instant when the withdrawal happened.',
    },
    {
      name: 'reason',
      kind: 'string',
      required: true,
      description: 'Why the listing was withdrawn.',
    },
    {
      name: 'idempotency_key',
      kind: 'string',
      required: true,
      description: 'The idempotency key supplied when withdrawing the listing.',
    },
  ] satisfies PayloadField[],
};

export const LISTING_CREATED_ACTION: AuditActionDefinition = {
  action: 'listing.created',
  owner: 'M-04',
  authority: 'business-authoritative',
  description: 'A listing was created as a draft.',
  resourceTypes: ['listing'],
  evidenceFields: [
    {
      name: 'listing_id',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The listing identifier.',
    },
    {
      name: 'account_id',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The supplying account.',
    },
    {
      name: 'commerce_unit_type_id',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The commerce unit type this listing offers.',
    },
    {
      name: 'created_at',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'ISO-8601 instant when the listing was created.',
    },
    {
      name: 'idempotency_key',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The idempotency key supplied when creating the listing.',
    },
  ],
};

export const LISTING_PUBLISHED_ACTION: AuditActionDefinition = {
  action: 'listing.published',
  owner: 'M-04',
  authority: 'business-authoritative',
  description: 'A new version of a listing was published.',
  resourceTypes: ['listing_version'],
  evidenceFields: [
    {
      name: 'listing_id',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The listing identifier.',
    },
    {
      name: 'version_id',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The published version identifier.',
    },
    {
      name: 'version_number',
      kind: 'integer',
      required: true,
      classification: 'internal',
      description: 'The version number within the listing.',
    },
    {
      name: 'account_id',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The supplying account.',
    },
    {
      name: 'unit_price_minor',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The unit price in integer minor units, as a string.',
    },
    {
      name: 'currency',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The ISO-4217 currency code.',
    },
    {
      name: 'quantity_available',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'How many units are offered, as a string.',
    },
    {
      name: 'published_at',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'ISO-8601 instant when the version was published.',
    },
    {
      name: 'idempotency_key',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The idempotency key supplied when publishing the version.',
    },
  ],
};

export const LISTING_SUSPENDED_ACTION: AuditActionDefinition = {
  action: 'listing.suspended',
  owner: 'M-04',
  authority: 'business-authoritative',
  description: 'A listing was suspended.',
  resourceTypes: ['listing'],
  evidenceFields: [
    {
      name: 'listing_id',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The listing identifier.',
    },
    {
      name: 'account_id',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The supplying account.',
    },
    {
      name: 'occurred_at',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'ISO-8601 instant when the suspension happened.',
    },
    {
      name: 'reason',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'Why the listing was suspended.',
    },
    {
      name: 'idempotency_key',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The idempotency key supplied when suspending the listing.',
    },
  ],
};

export const LISTING_WITHDRAWN_ACTION: AuditActionDefinition = {
  action: 'listing.withdrawn',
  owner: 'M-04',
  authority: 'business-authoritative',
  description: 'A listing was withdrawn.',
  resourceTypes: ['listing'],
  evidenceFields: [
    {
      name: 'listing_id',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The listing identifier.',
    },
    {
      name: 'account_id',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The supplying account.',
    },
    {
      name: 'occurred_at',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'ISO-8601 instant when the withdrawal happened.',
    },
    {
      name: 'reason',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'Why the listing was withdrawn.',
    },
    {
      name: 'idempotency_key',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The idempotency key supplied when withdrawing the listing.',
    },
  ],
};

/**
 * The event reporting that a listing was created.
 *
 * The outbox id is derived from the caller-supplied decision id, because a listing produces many
 * facts over its life and an id derived from the listing id alone would collide on the next fact.
 */
export function makeListingCreatedEvent(
  listing: Listing,
  recordId: string,
  correlationId: string,
  causationId: string | null,
): OutboxEntry {
  const eventId = `${recordId}:created`;
  const recordedAt = listing.createdAt;

  return eventOutboxEntry({
    outboxId: `M-04:${eventId}`,
    idempotencyKey: `M-04:${eventId}`,
    payload: {
      eventId,
      type: LISTING_CREATED_EVENT.type,
      schemaVersion: LISTING_CREATED_EVENT.schemaVersion,
      occurredAt: recordedAt,
      recordedAt,
      producer: 'M-04',
      correlationId,
      causationId,
      origin: 'system',
      actor: { kind: 'system', id: 'M-04' },
      idempotencyKey: `M-04:${eventId}`,
      now: recordedAt,
      payload: {
        listing_id: listing.listingId,
        account_id: listing.accountId,
        commerce_unit_type_id: listing.commerceUnitTypeId,
        created_at: listing.createdAt,
        idempotency_key: listing.idempotencyKey,
      },
    },
    occurredAt: recordedAt,
    recordedAt,
    producer: 'M-04',
    correlationId,
    causationId,
  });
}

/**
 * The event reporting that a version was published.
 *
 * The outbox id is derived from the version id, because one listing may be published many times and
 * each publication is a distinct fact.
 */
export function makeListingPublishedEvent(
  listing: Listing,
  version: ListingVersion,
  correlationId: string,
  causationId: string | null,
): OutboxEntry {
  const eventId = `${version.versionId}:published`;
  const recordedAt = version.publishedAt;

  return eventOutboxEntry({
    outboxId: `M-04:${eventId}`,
    idempotencyKey: `M-04:${eventId}`,
    payload: {
      eventId,
      type: LISTING_PUBLISHED_EVENT.type,
      schemaVersion: LISTING_PUBLISHED_EVENT.schemaVersion,
      occurredAt: recordedAt,
      recordedAt,
      producer: 'M-04',
      correlationId,
      causationId,
      origin: 'system',
      actor: { kind: 'system', id: 'M-04' },
      idempotencyKey: `M-04:${eventId}`,
      now: recordedAt,
      payload: {
        listing_id: listing.listingId,
        version_id: version.versionId,
        version_number: version.versionNumber,
        account_id: listing.accountId,
        unit_price_minor: String(version.unitPriceMinor),
        currency: version.currency,
        quantity_available: String(version.quantityAvailable),
        published_at: version.publishedAt,
        idempotency_key: version.idempotencyKey,
      },
    },
    occurredAt: recordedAt,
    recordedAt,
    producer: 'M-04',
    correlationId,
    causationId,
  });
}

/**
 * The event reporting that a listing was suspended.
 *
 * The outbox id is derived from the caller-supplied decision id, because suspension writes no
 * append-only row to hold a stable id.
 */
export function makeListingSuspendedEvent(
  listing: Listing,
  recordId: string,
  reason: string,
  occurredAt: string,
  correlationId: string,
  causationId: string | null,
  idempotencyKey: string,
): OutboxEntry {
  const eventId = `${recordId}:suspended`;

  return eventOutboxEntry({
    outboxId: `M-04:${eventId}`,
    idempotencyKey: `M-04:${eventId}`,
    payload: {
      eventId,
      type: LISTING_SUSPENDED_EVENT.type,
      schemaVersion: LISTING_SUSPENDED_EVENT.schemaVersion,
      occurredAt,
      recordedAt: occurredAt,
      producer: 'M-04',
      correlationId,
      causationId,
      origin: 'system',
      actor: { kind: 'system', id: 'M-04' },
      idempotencyKey: `M-04:${eventId}`,
      now: occurredAt,
      payload: {
        listing_id: listing.listingId,
        account_id: listing.accountId,
        occurred_at: occurredAt,
        reason,
        idempotency_key: idempotencyKey,
      },
    },
    occurredAt,
    recordedAt: occurredAt,
    producer: 'M-04',
    correlationId,
    causationId,
  });
}

/**
 * The event reporting that a listing was withdrawn.
 *
 * The outbox id is derived from the caller-supplied decision id, because withdrawal writes no
 * append-only row to hold a stable id.
 */
export function makeListingWithdrawnEvent(
  listing: Listing,
  recordId: string,
  reason: string,
  occurredAt: string,
  correlationId: string,
  causationId: string | null,
  idempotencyKey: string,
): OutboxEntry {
  const eventId = `${recordId}:withdrawn`;

  return eventOutboxEntry({
    outboxId: `M-04:${eventId}`,
    idempotencyKey: `M-04:${eventId}`,
    payload: {
      eventId,
      type: LISTING_WITHDRAWN_EVENT.type,
      schemaVersion: LISTING_WITHDRAWN_EVENT.schemaVersion,
      occurredAt,
      recordedAt: occurredAt,
      producer: 'M-04',
      correlationId,
      causationId,
      origin: 'system',
      actor: { kind: 'system', id: 'M-04' },
      idempotencyKey: `M-04:${eventId}`,
      now: occurredAt,
      payload: {
        listing_id: listing.listingId,
        account_id: listing.accountId,
        occurred_at: occurredAt,
        reason,
        idempotency_key: idempotencyKey,
      },
    },
    occurredAt,
    recordedAt: occurredAt,
    producer: 'M-04',
    correlationId,
    causationId,
  });
}

/** The audit record for one listing creation, keyed by the caller-supplied decision id. */
export function makeListingCreatedAction(
  listing: Listing,
  recordId: string,
  correlationId: string,
  causationId: string | null,
): OutboxEntry {
  const auditRecordId = `${recordId}:created`;
  const outboxId = `M-04:audit:${auditRecordId}`;
  const recordedAt = listing.createdAt;

  return auditOutboxEntry({
    outboxId,
    idempotencyKey: outboxId,
    payload: {
      recordId: auditRecordId,
      action: LISTING_CREATED_ACTION.action,
      recordedAt,
      actor: { kind: 'system', id: 'M-04', authentication: 'unauthenticated', sessionId: null },
      resource: { owner: 'M-04', type: 'listing', id: listing.listingId },
      outcome: 'succeeded',
      reason: `listing ${listing.listingId} created for account ${listing.accountId}`,
      correlationId,
      causationId,
      idempotencyKey: outboxId,
      evidence: {
        listing_id: listing.listingId,
        account_id: listing.accountId,
        commerce_unit_type_id: listing.commerceUnitTypeId,
        created_at: listing.createdAt,
        idempotency_key: listing.idempotencyKey,
      },
    },
    recordedAt,
    producer: 'M-04',
    correlationId,
    causationId,
  });
}

/** The audit record for one version publication, keyed by the version id. */
export function makeListingPublishedAction(
  listing: Listing,
  version: ListingVersion,
  correlationId: string,
  causationId: string | null,
): OutboxEntry {
  const recordId = `${version.versionId}:published`;
  const outboxId = `M-04:audit:${recordId}`;
  const recordedAt = version.publishedAt;

  return auditOutboxEntry({
    outboxId,
    idempotencyKey: outboxId,
    payload: {
      recordId,
      action: LISTING_PUBLISHED_ACTION.action,
      recordedAt,
      actor: { kind: 'system', id: 'M-04', authentication: 'unauthenticated', sessionId: null },
      resource: { owner: 'M-04', type: 'listing_version', id: version.versionId },
      outcome: 'succeeded',
      reason: `listing ${listing.listingId} published version ${version.versionNumber}`,
      correlationId,
      causationId,
      idempotencyKey: outboxId,
      evidence: {
        listing_id: listing.listingId,
        version_id: version.versionId,
        version_number: version.versionNumber,
        account_id: listing.accountId,
        unit_price_minor: String(version.unitPriceMinor),
        currency: version.currency,
        quantity_available: String(version.quantityAvailable),
        published_at: version.publishedAt,
        idempotency_key: version.idempotencyKey,
      },
    },
    recordedAt,
    producer: 'M-04',
    correlationId,
    causationId,
  });
}

/** The audit record for one listing suspension, keyed by the caller-supplied decision id. */
export function makeListingSuspendedAction(
  listing: Listing,
  recordId: string,
  reason: string,
  occurredAt: string,
  correlationId: string,
  causationId: string | null,
  idempotencyKey: string,
): OutboxEntry {
  const auditRecordId = `${recordId}:suspended`;
  const outboxId = `M-04:audit:${auditRecordId}`;

  return auditOutboxEntry({
    outboxId,
    idempotencyKey: outboxId,
    payload: {
      recordId: auditRecordId,
      action: LISTING_SUSPENDED_ACTION.action,
      recordedAt: occurredAt,
      actor: { kind: 'system', id: 'M-04', authentication: 'unauthenticated', sessionId: null },
      resource: { owner: 'M-04', type: 'listing', id: listing.listingId },
      outcome: 'succeeded',
      reason: `listing ${listing.listingId} suspended: ${reason}`,
      correlationId,
      causationId,
      idempotencyKey: outboxId,
      evidence: {
        listing_id: listing.listingId,
        account_id: listing.accountId,
        occurred_at: occurredAt,
        reason,
        idempotency_key: idempotencyKey,
      },
    },
    recordedAt: occurredAt,
    producer: 'M-04',
    correlationId,
    causationId,
  });
}

/** The audit record for one listing withdrawal, keyed by the caller-supplied decision id. */
export function makeListingWithdrawnAction(
  listing: Listing,
  recordId: string,
  reason: string,
  occurredAt: string,
  correlationId: string,
  causationId: string | null,
  idempotencyKey: string,
): OutboxEntry {
  const auditRecordId = `${recordId}:withdrawn`;
  const outboxId = `M-04:audit:${auditRecordId}`;

  return auditOutboxEntry({
    outboxId,
    idempotencyKey: outboxId,
    payload: {
      recordId: auditRecordId,
      action: LISTING_WITHDRAWN_ACTION.action,
      recordedAt: occurredAt,
      actor: { kind: 'system', id: 'M-04', authentication: 'unauthenticated', sessionId: null },
      resource: { owner: 'M-04', type: 'listing', id: listing.listingId },
      outcome: 'succeeded',
      reason: `listing ${listing.listingId} withdrawn: ${reason}`,
      correlationId,
      causationId,
      idempotencyKey: outboxId,
      evidence: {
        listing_id: listing.listingId,
        account_id: listing.accountId,
        occurred_at: occurredAt,
        reason,
        idempotency_key: idempotencyKey,
      },
    },
    recordedAt: occurredAt,
    producer: 'M-04',
    correlationId,
    causationId,
  });
}
