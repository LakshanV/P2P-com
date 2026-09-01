/**
 * M-04 Universal Listing — slices A and B outbox event and audit definitions.
 *
 * These definitions describe the facts M-04 publishes when a listing is created, a version is
 * published, a listing is suspended or withdrawn, or inventory moves. They are declared separately
 * from the service so a relay can register them without importing M-04 internals.
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

import type { InventoryMovement, Listing, ListingVersion } from './types.ts';

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
      name: 'inventory_mode',
      kind: 'string',
      required: true,
      description:
        'How fulfilment of this version relates to stock: tracked, untracked, external, ' +
        'made-to-order or digital. Published so a consumer can tell whether an order line against ' +
        'this version needs a reservation without reading M-04 back.',
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
      name: 'inventory_mode',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'How fulfilment of this version relates to stock.',
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

const INVENTORY_EVENT_FIELDS = [
  {
    name: 'listing_id',
    kind: 'string',
    required: true,
    description: 'The listing identifier.',
  },
  {
    name: 'version_id',
    kind: 'string',
    required: true,
    description: 'The version identifier.',
  },
  {
    name: 'quantity',
    kind: 'string',
    required: true,
    description: 'How many units moved, as a string.',
  },
  {
    name: 'reservation_id',
    kind: 'string',
    required: false,
    description: 'The reservation identifier, when the movement carries one.',
  },
  {
    name: 'occurred_at',
    kind: 'string',
    required: true,
    description: 'ISO-8601 instant when the movement happened.',
  },
  {
    name: 'idempotency_key',
    kind: 'string',
    required: true,
    description: 'The idempotency key supplied when recording the movement.',
  },
] satisfies PayloadField[];

const INVENTORY_AUDIT_FIELDS = [
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
    description: 'The version identifier.',
  },
  {
    name: 'quantity',
    kind: 'string',
    required: true,
    classification: 'internal',
    description: 'How many units moved, as a string.',
  },
  {
    name: 'reservation_id',
    kind: 'string',
    required: false,
    classification: 'internal',
    description: 'The reservation identifier, when the movement carries one.',
  },
  {
    name: 'occurred_at',
    kind: 'string',
    required: true,
    classification: 'internal',
    description: 'ISO-8601 instant when the movement happened.',
  },
  {
    name: 'idempotency_key',
    kind: 'string',
    required: true,
    classification: 'internal',
    description: 'The idempotency key supplied when recording the movement.',
  },
] as const;

export const INVENTORY_RECEIVED_EVENT: EventTypeDefinition = {
  type: 'inventory.received',
  schemaVersion: 1,
  owner: 'M-04',
  description: 'Stock was received into a listing version.',
  payloadFields: INVENTORY_EVENT_FIELDS,
};

export const INVENTORY_ADJUSTED_EVENT: EventTypeDefinition = {
  type: 'inventory.adjusted',
  schemaVersion: 1,
  owner: 'M-04',
  description: 'Inventory was adjusted up or down.',
  payloadFields: INVENTORY_EVENT_FIELDS,
};

export const INVENTORY_RESERVED_EVENT: EventTypeDefinition = {
  type: 'inventory.reserved',
  schemaVersion: 1,
  owner: 'M-04',
  description: 'Stock was reserved for a caller.',
  payloadFields: INVENTORY_EVENT_FIELDS,
};

export const INVENTORY_RELEASED_EVENT: EventTypeDefinition = {
  type: 'inventory.released',
  schemaVersion: 1,
  owner: 'M-04',
  description: 'A reservation was released.',
  payloadFields: INVENTORY_EVENT_FIELDS,
};

export const INVENTORY_COMMITTED_EVENT: EventTypeDefinition = {
  type: 'inventory.committed',
  schemaVersion: 1,
  owner: 'M-04',
  description: 'A reservation was committed to a sale.',
  payloadFields: INVENTORY_EVENT_FIELDS,
};

export const INVENTORY_RECEIVED_ACTION: AuditActionDefinition = {
  action: 'inventory.received',
  owner: 'M-04',
  authority: 'business-authoritative',
  description: 'Stock was received into a listing version.',
  resourceTypes: ['inventory'],
  evidenceFields: [...INVENTORY_AUDIT_FIELDS],
};

export const INVENTORY_ADJUSTED_ACTION: AuditActionDefinition = {
  action: 'inventory.adjusted',
  owner: 'M-04',
  authority: 'business-authoritative',
  description: 'Inventory was adjusted up or down.',
  resourceTypes: ['inventory'],
  evidenceFields: [...INVENTORY_AUDIT_FIELDS],
};

export const INVENTORY_RESERVED_ACTION: AuditActionDefinition = {
  action: 'inventory.reserved',
  owner: 'M-04',
  authority: 'business-authoritative',
  description: 'Stock was reserved for a caller.',
  resourceTypes: ['inventory'],
  evidenceFields: [...INVENTORY_AUDIT_FIELDS],
};

export const INVENTORY_RELEASED_ACTION: AuditActionDefinition = {
  action: 'inventory.released',
  owner: 'M-04',
  authority: 'business-authoritative',
  description: 'A reservation was released.',
  resourceTypes: ['inventory'],
  evidenceFields: [...INVENTORY_AUDIT_FIELDS],
};

export const INVENTORY_COMMITTED_ACTION: AuditActionDefinition = {
  action: 'inventory.committed',
  owner: 'M-04',
  authority: 'business-authoritative',
  description: 'A reservation was committed to a sale.',
  resourceTypes: ['inventory'],
  evidenceFields: [...INVENTORY_AUDIT_FIELDS],
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
        inventory_mode: version.inventoryMode,
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
        inventory_mode: version.inventoryMode,
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

function inventoryEventId(movement: InventoryMovement): string {
  return `${movement.movementId}:${movement.kind}`;
}

function inventoryPayload(movement: InventoryMovement): Record<string, string | undefined> {
  return {
    listing_id: movement.listingId,
    version_id: movement.versionId,
    quantity: String(movement.quantity),
    reservation_id: movement.reservationId ?? undefined,
    occurred_at: movement.occurredAt,
    idempotency_key: movement.idempotencyKey,
  };
}

/** The event reporting that inventory was received. */
export function makeInventoryReceivedEvent(
  movement: InventoryMovement,
  correlationId: string,
  causationId: string | null,
): OutboxEntry {
  const eventId = inventoryEventId(movement);
  const recordedAt = movement.occurredAt;

  return eventOutboxEntry({
    outboxId: `M-04:${eventId}`,
    idempotencyKey: `M-04:${eventId}`,
    payload: {
      eventId,
      type: INVENTORY_RECEIVED_EVENT.type,
      schemaVersion: INVENTORY_RECEIVED_EVENT.schemaVersion,
      occurredAt: recordedAt,
      recordedAt,
      producer: 'M-04',
      correlationId,
      causationId,
      origin: 'system',
      actor: { kind: 'system', id: 'M-04' },
      idempotencyKey: `M-04:${eventId}`,
      now: recordedAt,
      payload: inventoryPayload(movement),
    },
    occurredAt: recordedAt,
    recordedAt,
    producer: 'M-04',
    correlationId,
    causationId,
  });
}

/** The event reporting that inventory was adjusted. */
export function makeInventoryAdjustedEvent(
  movement: InventoryMovement,
  correlationId: string,
  causationId: string | null,
): OutboxEntry {
  const eventId = inventoryEventId(movement);
  const recordedAt = movement.occurredAt;

  return eventOutboxEntry({
    outboxId: `M-04:${eventId}`,
    idempotencyKey: `M-04:${eventId}`,
    payload: {
      eventId,
      type: INVENTORY_ADJUSTED_EVENT.type,
      schemaVersion: INVENTORY_ADJUSTED_EVENT.schemaVersion,
      occurredAt: recordedAt,
      recordedAt,
      producer: 'M-04',
      correlationId,
      causationId,
      origin: 'system',
      actor: { kind: 'system', id: 'M-04' },
      idempotencyKey: `M-04:${eventId}`,
      now: recordedAt,
      payload: inventoryPayload(movement),
    },
    occurredAt: recordedAt,
    recordedAt,
    producer: 'M-04',
    correlationId,
    causationId,
  });
}

/** The event reporting that inventory was reserved. */
export function makeInventoryReservedEvent(
  movement: InventoryMovement,
  correlationId: string,
  causationId: string | null,
): OutboxEntry {
  const eventId = inventoryEventId(movement);
  const recordedAt = movement.occurredAt;

  return eventOutboxEntry({
    outboxId: `M-04:${eventId}`,
    idempotencyKey: `M-04:${eventId}`,
    payload: {
      eventId,
      type: INVENTORY_RESERVED_EVENT.type,
      schemaVersion: INVENTORY_RESERVED_EVENT.schemaVersion,
      occurredAt: recordedAt,
      recordedAt,
      producer: 'M-04',
      correlationId,
      causationId,
      origin: 'system',
      actor: { kind: 'system', id: 'M-04' },
      idempotencyKey: `M-04:${eventId}`,
      now: recordedAt,
      payload: inventoryPayload(movement),
    },
    occurredAt: recordedAt,
    recordedAt,
    producer: 'M-04',
    correlationId,
    causationId,
  });
}

/** The event reporting that a reservation was released. */
export function makeInventoryReleasedEvent(
  movement: InventoryMovement,
  correlationId: string,
  causationId: string | null,
): OutboxEntry {
  const eventId = inventoryEventId(movement);
  const recordedAt = movement.occurredAt;

  return eventOutboxEntry({
    outboxId: `M-04:${eventId}`,
    idempotencyKey: `M-04:${eventId}`,
    payload: {
      eventId,
      type: INVENTORY_RELEASED_EVENT.type,
      schemaVersion: INVENTORY_RELEASED_EVENT.schemaVersion,
      occurredAt: recordedAt,
      recordedAt,
      producer: 'M-04',
      correlationId,
      causationId,
      origin: 'system',
      actor: { kind: 'system', id: 'M-04' },
      idempotencyKey: `M-04:${eventId}`,
      now: recordedAt,
      payload: inventoryPayload(movement),
    },
    occurredAt: recordedAt,
    recordedAt,
    producer: 'M-04',
    correlationId,
    causationId,
  });
}

/** The event reporting that a reservation was committed to a sale. */
export function makeInventoryCommittedEvent(
  movement: InventoryMovement,
  correlationId: string,
  causationId: string | null,
): OutboxEntry {
  const eventId = inventoryEventId(movement);
  const recordedAt = movement.occurredAt;

  return eventOutboxEntry({
    outboxId: `M-04:${eventId}`,
    idempotencyKey: `M-04:${eventId}`,
    payload: {
      eventId,
      type: INVENTORY_COMMITTED_EVENT.type,
      schemaVersion: INVENTORY_COMMITTED_EVENT.schemaVersion,
      occurredAt: recordedAt,
      recordedAt,
      producer: 'M-04',
      correlationId,
      causationId,
      origin: 'system',
      actor: { kind: 'system', id: 'M-04' },
      idempotencyKey: `M-04:${eventId}`,
      now: recordedAt,
      payload: inventoryPayload(movement),
    },
    occurredAt: recordedAt,
    recordedAt,
    producer: 'M-04',
    correlationId,
    causationId,
  });
}

/** The audit record for one inventory movement. */
function makeInventoryAction(
  movement: InventoryMovement,
  definition: AuditActionDefinition,
  correlationId: string,
  causationId: string | null,
): OutboxEntry {
  const recordId = inventoryEventId(movement);
  const outboxId = `M-04:audit:${recordId}`;
  const recordedAt = movement.occurredAt;

  return auditOutboxEntry({
    outboxId,
    idempotencyKey: outboxId,
    payload: {
      recordId,
      action: definition.action,
      recordedAt,
      actor: { kind: 'system', id: 'M-04', authentication: 'unauthenticated', sessionId: null },
      resource: { owner: 'M-04', type: 'inventory', id: movement.listingId },
      outcome: 'succeeded',
      reason: `inventory ${movement.kind} of ${String(movement.quantity)} for listing ${movement.listingId}`,
      correlationId,
      causationId,
      idempotencyKey: outboxId,
      evidence: inventoryPayload(movement),
    },
    recordedAt,
    producer: 'M-04',
    correlationId,
    causationId,
  });
}

/** The audit record for one receive movement. */
export function makeInventoryReceivedAction(
  movement: InventoryMovement,
  correlationId: string,
  causationId: string | null,
): OutboxEntry {
  return makeInventoryAction(movement, INVENTORY_RECEIVED_ACTION, correlationId, causationId);
}

/** The audit record for one adjust movement. */
export function makeInventoryAdjustedAction(
  movement: InventoryMovement,
  correlationId: string,
  causationId: string | null,
): OutboxEntry {
  return makeInventoryAction(movement, INVENTORY_ADJUSTED_ACTION, correlationId, causationId);
}

/** The audit record for one reserve movement. */
export function makeInventoryReservedAction(
  movement: InventoryMovement,
  correlationId: string,
  causationId: string | null,
): OutboxEntry {
  return makeInventoryAction(movement, INVENTORY_RESERVED_ACTION, correlationId, causationId);
}

/** The audit record for one release movement. */
export function makeInventoryReleasedAction(
  movement: InventoryMovement,
  correlationId: string,
  causationId: string | null,
): OutboxEntry {
  return makeInventoryAction(movement, INVENTORY_RELEASED_ACTION, correlationId, causationId);
}

/** The audit record for one commit movement. */
export function makeInventoryCommittedAction(
  movement: InventoryMovement,
  correlationId: string,
  causationId: string | null,
): OutboxEntry {
  return makeInventoryAction(movement, INVENTORY_COMMITTED_ACTION, correlationId, causationId);
}
