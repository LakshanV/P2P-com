/**
 * M-10 Quotes — the facts an offer publishes.
 *
 * **No price travels in an event.** A quote event says an offer exists against a tender, from which
 * supplier, at what status — and stops there. What a supplier quoted is the single most commercially
 * sensitive number they give this platform, and the event log is read by every subscriber and kept
 * indefinitely. A competitor's consumer that could read the log could read the market. The buyer sees
 * the price through a route that checks the tender is theirs; M-11 reads it from this module when it
 * opens the order.
 *
 * The **audit record does** carry the amount, and deliberately: it is a separate, access-controlled
 * store whose whole purpose is to answer "what was actually agreed" months later, and an audit trail
 * of an accepted offer that omitted the price would not answer the only question anyone asks of it.
 *
 * Owned by: M-10 Quotes.
 */

import type { AuditActionDefinition } from '../../kernel/audit-foundation/registry.ts';
import type {
  EventTypeDefinition,
  PayloadField,
} from '../../kernel/event-infrastructure/registry.ts';
import { auditOutboxEntry, eventOutboxEntry } from '../../platform/outbox/builder.ts';
import type { OutboxEntry } from '../../platform/outbox/types.ts';

import type { Quote } from './types.ts';

const QUOTE_FIELDS: readonly PayloadField[] = [
  { name: 'quote_id', kind: 'string', required: true, description: 'The offer.' },
  { name: 'rfq_id', kind: 'string', required: true, description: 'The tender it answers.' },
  {
    name: 'supplier_account_id',
    kind: 'string',
    required: true,
    description: 'Who offered. This is what a notification consumer routes on.',
  },
  {
    name: 'kind',
    kind: 'string',
    required: true,
    description: 'full, partial or substitute.',
  },
  { name: 'status', kind: 'string', required: true, description: 'The status after the change.' },
  {
    name: 'currency',
    kind: 'string',
    required: true,
    description: 'The currency offered in. The amount itself is not published.',
  },
  {
    name: 'valid_until',
    kind: 'string',
    required: true,
    description: 'When the offer stops binding, so a consumer can schedule expiry.',
  },
  { name: 'occurred_at', kind: 'string', required: true, description: 'When the fact happened.' },
  {
    name: 'idempotency_key',
    kind: 'string',
    required: true,
    description: 'The key the originating request converged on.',
  },
];

export const QUOTE_SUBMITTED_EVENT: EventTypeDefinition = {
  type: 'quote.submitted',
  schemaVersion: 1,
  owner: 'M-10',
  description:
    'A supplier offered against a tender. The price is not in this event; the buyer reads it ' +
    'through a route that checks the tender is theirs.',
  payloadFields: QUOTE_FIELDS,
};

export const QUOTE_WITHDRAWN_EVENT: EventTypeDefinition = {
  type: 'quote.withdrawn',
  schemaVersion: 1,
  owner: 'M-10',
  description:
    'The supplier took the offer back before it was accepted. A ranking a buyer is looking at ' +
    'must stop showing it as available.',
  payloadFields: QUOTE_FIELDS,
};

export const QUOTE_EXPIRED_EVENT: EventTypeDefinition = {
  type: 'quote.expired',
  schemaVersion: 1,
  owner: 'M-10',
  description: 'The offer stopped binding because its validity passed.',
  payloadFields: QUOTE_FIELDS,
};

export const QUOTE_ACCEPTED_EVENT: EventTypeDefinition = {
  type: 'quote.accepted',
  schemaVersion: 1,
  owner: 'M-10',
  description:
    'The buyer took this offer. M-11 subscribes to this to open the order, and reads the terms ' +
    'from this module rather than from the event.',
  payloadFields: QUOTE_FIELDS,
};

export const QUOTE_REJECTED_EVENT: EventTypeDefinition = {
  type: 'quote.rejected',
  schemaVersion: 1,
  owner: 'M-10',
  description:
    'The buyer took another offer. Distinct from expiry, because a supplier is owed the ' +
    'difference between losing and being too slow.',
  payloadFields: QUOTE_FIELDS,
};

export const QUOTE_ACTION: AuditActionDefinition = {
  action: 'quote.status_changed',
  owner: 'M-10',
  authority: 'business-authoritative',
  description: 'An offer was submitted, withdrawn, expired, accepted or rejected.',
  resourceTypes: ['quote'],
  evidenceFields: [
    ...QUOTE_FIELDS.map((field) => ({
      name: field.name,
      kind: 'string' as const,
      required: field.required,
      classification: 'internal' as const,
      description: field.description,
    })),
    {
      name: 'quantity',
      kind: 'string' as const,
      required: true,
      classification: 'internal' as const,
      description: 'How many units the offer covers, as a string.',
    },
    {
      name: 'unit_price_minor',
      kind: 'string' as const,
      required: true,
      classification: 'internal' as const,
      description: 'Price per unit in integer minor units, as a string.',
    },
    {
      name: 'total_minor',
      kind: 'string' as const,
      required: true,
      classification: 'internal' as const,
      description:
        'What the buyer pays all in, as a string. The audit trail answers what was agreed, and ' +
        'without this it would not.',
    },
    {
      name: 'lead_time_days',
      kind: 'string' as const,
      required: true,
      classification: 'internal' as const,
      description: 'Days from acceptance to delivery, as the supplier stated it.',
    },
    {
      name: 'closure_reason',
      kind: 'string' as const,
      required: false,
      classification: 'internal' as const,
      description: 'Why the offer ended, where it has ended.',
    },
  ],
};

const EVENT_FOR_STATUS: Readonly<Record<string, EventTypeDefinition>> = Object.freeze({
  submitted: QUOTE_SUBMITTED_EVENT,
  withdrawn: QUOTE_WITHDRAWN_EVENT,
  expired: QUOTE_EXPIRED_EVENT,
  accepted: QUOTE_ACCEPTED_EVENT,
  rejected: QUOTE_REJECTED_EVENT,
});

/** What a subscriber is told. Deliberately not the price. */
function publishedPayload(quote: Quote): Record<string, string> {
  return {
    quote_id: quote.quoteId,
    rfq_id: quote.rfqId,
    supplier_account_id: quote.supplierAccountId,
    kind: quote.kind,
    status: quote.status,
    currency: quote.currency,
    valid_until: quote.validUntil,
    occurred_at: quote.updatedAt,
    idempotency_key: quote.idempotencyKey,
  };
}

export function makeQuoteEvent(quote: Quote): OutboxEntry {
  const definition = EVENT_FOR_STATUS[quote.status] ?? QUOTE_SUBMITTED_EVENT;
  // Keyed on the status as well as the quote, so each transition publishes exactly once and a retry
  // of the same transition converges on the row already written.
  const eventId = `${quote.quoteId}:${definition.type}`;
  return eventOutboxEntry({
    outboxId: `M-10:${eventId}`,
    idempotencyKey: `M-10:${eventId}`,
    payload: {
      eventId,
      type: definition.type,
      schemaVersion: definition.schemaVersion,
      occurredAt: quote.updatedAt,
      recordedAt: quote.updatedAt,
      producer: 'M-10',
      correlationId: quote.correlationId,
      causationId: null,
      origin: 'system',
      actor: { kind: 'system', id: 'M-10' },
      idempotencyKey: `M-10:${eventId}`,
      now: quote.updatedAt,
      payload: publishedPayload(quote),
    },
    occurredAt: quote.updatedAt,
    recordedAt: quote.updatedAt,
    producer: 'M-10',
    correlationId: quote.correlationId,
    causationId: null,
  });
}

export function makeQuoteAction(quote: Quote): OutboxEntry {
  const recordId = `${quote.quoteId}:${quote.status}:${QUOTE_ACTION.action}`;
  const outboxId = `M-10:audit:${recordId}`;
  return auditOutboxEntry({
    outboxId,
    idempotencyKey: outboxId,
    payload: {
      recordId,
      action: QUOTE_ACTION.action,
      subjectId: quote.supplierAccountId,
      resourceType: 'quote',
      resourceId: quote.quoteId,
      occurredAt: quote.updatedAt,
      recordedAt: quote.updatedAt,
      actor: { kind: 'system', id: 'M-10' },
      correlationId: quote.correlationId,
      idempotencyKey: outboxId,
      now: quote.updatedAt,
      evidence: {
        ...publishedPayload(quote),
        quantity: String(quote.quantity),
        unit_price_minor: String(quote.unitPriceMinor),
        total_minor: String(quote.totalMinor),
        lead_time_days: String(quote.leadTimeDays),
        closure_reason: quote.closureReason ?? '',
      },
    },
    recordedAt: quote.updatedAt,
    producer: 'M-10',
    correlationId: quote.correlationId,
    causationId: null,
  });
}
