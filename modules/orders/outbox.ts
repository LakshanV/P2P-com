/**
 * M-11 Orders — outbox event and audit definitions.
 *
 * These definitions describe the facts M-11 publishes when an order is created, placed, confirmed,
 * starts fulfilment, completes or cancels. They are declared separately from the service so a relay
 * can register them without importing M-11 internals.
 *
 * Owned by: M-11 Orders.
 */

import type { AuditActionDefinition } from '../../kernel/audit-foundation/registry.ts';
import { auditOutboxEntry, eventOutboxEntry } from '../../platform/outbox/builder.ts';
import type { OutboxEntry } from '../../platform/outbox/types.ts';
import type {
  EventTypeDefinition,
  PayloadField,
} from '../../kernel/event-infrastructure/registry.ts';

import type { Order, OrderEvent } from './types.ts';

const ORDER_EVENT_FIELDS = [
  {
    name: 'order_id',
    kind: 'string',
    required: true,
    description: 'The order identifier.',
  },
  {
    name: 'buyer_account_id',
    kind: 'string',
    required: true,
    description: 'The buying account.',
  },
  {
    name: 'seller_account_id',
    kind: 'string',
    required: true,
    description: 'The selling account.',
  },
  {
    name: 'status',
    kind: 'string',
    required: true,
    description: 'The order status after the transition.',
  },
  {
    name: 'total_minor',
    kind: 'string',
    required: true,
    description: 'The amount owed in integer minor units, as a string.',
  },
  {
    name: 'currency',
    kind: 'string',
    required: true,
    description: 'The ISO-4217 currency code.',
  },
  {
    name: 'occurred_at',
    kind: 'string',
    required: true,
    description: 'ISO-8601 instant when the transition happened.',
  },
  {
    name: 'idempotency_key',
    kind: 'string',
    required: true,
    description: 'The idempotency key supplied for the transition.',
  },
] satisfies PayloadField[];

const CANCELLATION_EVENT_FIELDS = [
  ...ORDER_EVENT_FIELDS,
  {
    name: 'reason',
    kind: 'string',
    required: true,
    description: 'Why the order was cancelled.',
  },
] satisfies PayloadField[];

const ORDER_AUDIT_FIELDS = [
  {
    name: 'order_id',
    kind: 'string',
    required: true,
    classification: 'internal',
    description: 'The order identifier.',
  },
  {
    name: 'buyer_account_id',
    kind: 'string',
    required: true,
    classification: 'internal',
    description: 'The buying account.',
  },
  {
    name: 'seller_account_id',
    kind: 'string',
    required: true,
    classification: 'internal',
    description: 'The selling account.',
  },
  {
    name: 'status',
    kind: 'string',
    required: true,
    classification: 'internal',
    description: 'The order status after the transition.',
  },
  {
    name: 'total_minor',
    kind: 'string',
    required: true,
    classification: 'internal',
    description: 'The amount owed in integer minor units, as a string.',
  },
  {
    name: 'currency',
    kind: 'string',
    required: true,
    classification: 'internal',
    description: 'The ISO-4217 currency code.',
  },
  {
    name: 'occurred_at',
    kind: 'string',
    required: true,
    classification: 'internal',
    description: 'ISO-8601 instant when the transition happened.',
  },
  {
    name: 'idempotency_key',
    kind: 'string',
    required: true,
    classification: 'internal',
    description: 'The idempotency key supplied for the transition.',
  },
] as const;

const CANCELLATION_AUDIT_FIELDS = [
  ...ORDER_AUDIT_FIELDS,
  {
    name: 'reason',
    kind: 'string',
    required: true,
    classification: 'internal',
    description: 'Why the order was cancelled.',
  },
] as const;

export const ORDER_CREATED_EVENT: EventTypeDefinition = {
  type: 'order.created',
  schemaVersion: 1,
  owner: 'M-11',
  description: 'An order was created as a draft.',
  payloadFields: ORDER_EVENT_FIELDS,
};

export const ORDER_PLACED_EVENT: EventTypeDefinition = {
  type: 'order.placed',
  schemaVersion: 1,
  owner: 'M-11',
  description: 'An order was placed and its commercial snapshot captured.',
  payloadFields: ORDER_EVENT_FIELDS,
};

export const ORDER_CONFIRMED_EVENT: EventTypeDefinition = {
  type: 'order.confirmed',
  schemaVersion: 1,
  owner: 'M-11',
  description: 'An order was confirmed by the seller.',
  payloadFields: ORDER_EVENT_FIELDS,
};

export const ORDER_FULFILLING_EVENT: EventTypeDefinition = {
  type: 'order.fulfilling',
  schemaVersion: 1,
  owner: 'M-11',
  description: 'Fulfilment of an order has started.',
  payloadFields: ORDER_EVENT_FIELDS,
};

export const ORDER_COMPLETED_EVENT: EventTypeDefinition = {
  type: 'order.completed',
  schemaVersion: 1,
  owner: 'M-11',
  description: 'An order was completed.',
  payloadFields: ORDER_EVENT_FIELDS,
};

export const ORDER_CANCELLED_EVENT: EventTypeDefinition = {
  type: 'order.cancelled',
  schemaVersion: 1,
  owner: 'M-11',
  description: 'An order was cancelled.',
  payloadFields: CANCELLATION_EVENT_FIELDS,
};

export const ORDER_CREATED_ACTION: AuditActionDefinition = {
  action: 'order.created',
  owner: 'M-11',
  authority: 'business-authoritative',
  description: 'An order was created as a draft.',
  resourceTypes: ['order'],
  evidenceFields: [...ORDER_AUDIT_FIELDS],
};

export const ORDER_PLACED_ACTION: AuditActionDefinition = {
  action: 'order.placed',
  owner: 'M-11',
  authority: 'business-authoritative',
  description: 'An order was placed and its commercial snapshot captured.',
  resourceTypes: ['order'],
  evidenceFields: [...ORDER_AUDIT_FIELDS],
};

export const ORDER_CONFIRMED_ACTION: AuditActionDefinition = {
  action: 'order.confirmed',
  owner: 'M-11',
  authority: 'business-authoritative',
  description: 'An order was confirmed by the seller.',
  resourceTypes: ['order'],
  evidenceFields: [...ORDER_AUDIT_FIELDS],
};

export const ORDER_FULFILLING_ACTION: AuditActionDefinition = {
  action: 'order.fulfilling',
  owner: 'M-11',
  authority: 'business-authoritative',
  description: 'Fulfilment of an order has started.',
  resourceTypes: ['order'],
  evidenceFields: [...ORDER_AUDIT_FIELDS],
};

export const ORDER_COMPLETED_ACTION: AuditActionDefinition = {
  action: 'order.completed',
  owner: 'M-11',
  authority: 'business-authoritative',
  description: 'An order was completed.',
  resourceTypes: ['order'],
  evidenceFields: [...ORDER_AUDIT_FIELDS],
};

export const ORDER_CANCELLED_ACTION: AuditActionDefinition = {
  action: 'order.cancelled',
  owner: 'M-11',
  authority: 'business-authoritative',
  description: 'An order was cancelled.',
  resourceTypes: ['order'],
  evidenceFields: [...CANCELLATION_AUDIT_FIELDS],
};

function orderEventPayload(order: Order, event: OrderEvent): Record<string, string> {
  return {
    order_id: order.orderId,
    buyer_account_id: order.buyerAccountId,
    seller_account_id: order.sellerAccountId,
    status: order.status,
    total_minor: String(order.totalMinor),
    currency: order.currency,
    occurred_at: event.occurredAt,
    idempotency_key: event.idempotencyKey,
  };
}

function orderEventOutboxEntry(
  order: Order,
  event: OrderEvent,
  definition: EventTypeDefinition,
  extraPayload: Record<string, string> = {},
): OutboxEntry {
  const eventId = `${event.eventId}:${event.kind}`;
  const recordedAt = event.occurredAt;

  return eventOutboxEntry({
    outboxId: `M-11:${eventId}`,
    idempotencyKey: `M-11:${eventId}`,
    payload: {
      eventId,
      type: definition.type,
      schemaVersion: definition.schemaVersion,
      occurredAt: recordedAt,
      recordedAt,
      producer: 'M-11',
      correlationId: event.correlationId,
      causationId: null,
      origin: 'system',
      actor: { kind: 'system', id: 'M-11' },
      idempotencyKey: `M-11:${eventId}`,
      now: recordedAt,
      payload: {
        ...orderEventPayload(order, event),
        ...extraPayload,
      },
    },
    occurredAt: recordedAt,
    recordedAt,
    producer: 'M-11',
    correlationId: event.correlationId,
    causationId: null,
  });
}

function orderAuditOutboxEntry(
  order: Order,
  event: OrderEvent,
  definition: AuditActionDefinition,
  extraEvidence: Record<string, string> = {},
): OutboxEntry {
  const recordId = `${event.eventId}:${event.kind}`;
  const outboxId = `M-11:audit:${recordId}`;
  const recordedAt = event.occurredAt;

  return auditOutboxEntry({
    outboxId,
    idempotencyKey: outboxId,
    payload: {
      recordId,
      action: definition.action,
      recordedAt,
      actor: { kind: 'system', id: 'M-11', authentication: 'unauthenticated', sessionId: null },
      resource: { owner: 'M-11', type: 'order', id: order.orderId },
      outcome: 'succeeded',
      reason: `order ${order.orderId} ${event.kind}`,
      correlationId: event.correlationId,
      causationId: null,
      idempotencyKey: outboxId,
      evidence: {
        ...orderEventPayload(order, event),
        ...extraEvidence,
      },
    },
    recordedAt,
    producer: 'M-11',
    correlationId: event.correlationId,
    causationId: null,
  });
}

/** The event reporting that an order was created. */
export function makeOrderCreatedEvent(order: Order, event: OrderEvent): OutboxEntry {
  return orderEventOutboxEntry(order, event, ORDER_CREATED_EVENT);
}

/** The event reporting that an order was placed. */
export function makeOrderPlacedEvent(order: Order, event: OrderEvent): OutboxEntry {
  return orderEventOutboxEntry(order, event, ORDER_PLACED_EVENT);
}

/** The event reporting that an order was confirmed. */
export function makeOrderConfirmedEvent(order: Order, event: OrderEvent): OutboxEntry {
  return orderEventOutboxEntry(order, event, ORDER_CONFIRMED_EVENT);
}

/** The event reporting that fulfilment has started. */
export function makeOrderFulfillingEvent(order: Order, event: OrderEvent): OutboxEntry {
  return orderEventOutboxEntry(order, event, ORDER_FULFILLING_EVENT);
}

/** The event reporting that an order was completed. */
export function makeOrderCompletedEvent(order: Order, event: OrderEvent): OutboxEntry {
  return orderEventOutboxEntry(order, event, ORDER_COMPLETED_EVENT);
}

/** The event reporting that an order was cancelled. */
export function makeOrderCancelledEvent(
  order: Order,
  event: OrderEvent,
  cancellationReason: string,
): OutboxEntry {
  return orderEventOutboxEntry(order, event, ORDER_CANCELLED_EVENT, {
    reason: cancellationReason,
  });
}

/** The audit record for one order creation. */
export function makeOrderCreatedAction(order: Order, event: OrderEvent): OutboxEntry {
  return orderAuditOutboxEntry(order, event, ORDER_CREATED_ACTION);
}

/** The audit record for one order placement. */
export function makeOrderPlacedAction(order: Order, event: OrderEvent): OutboxEntry {
  return orderAuditOutboxEntry(order, event, ORDER_PLACED_ACTION);
}

/** The audit record for one order confirmation. */
export function makeOrderConfirmedAction(order: Order, event: OrderEvent): OutboxEntry {
  return orderAuditOutboxEntry(order, event, ORDER_CONFIRMED_ACTION);
}

/** The audit record for one fulfilment start. */
export function makeOrderFulfillingAction(order: Order, event: OrderEvent): OutboxEntry {
  return orderAuditOutboxEntry(order, event, ORDER_FULFILLING_ACTION);
}

/** The audit record for one order completion. */
export function makeOrderCompletedAction(order: Order, event: OrderEvent): OutboxEntry {
  return orderAuditOutboxEntry(order, event, ORDER_COMPLETED_ACTION);
}

/** The audit record for one order cancellation. */
export function makeOrderCancelledAction(
  order: Order,
  event: OrderEvent,
  cancellationReason: string,
): OutboxEntry {
  return orderAuditOutboxEntry(order, event, ORDER_CANCELLED_ACTION, {
    reason: cancellationReason,
  });
}
