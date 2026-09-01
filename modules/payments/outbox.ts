/**
 * M-12 Payments — outbox event and audit definitions.
 *
 * These describe the facts M-12 publishes when a payment is requested, authorised, captured,
 * failed, cancelled or refunded. They are declared separately from the service so a relay can
 * register them without importing M-12 internals.
 *
 * Amounts cross the wire as **strings**, because a `bigint` does not survive JSON and a consumer
 * that parsed a number would lose precision above 2^53 minor units — which for a satoshi-scaled
 * asset is not a hypothetical.
 *
 * The asset travels with every amount. A consumer reading `amount_minor` without `asset_code` would
 * be reading a number with no unit, and the whole point of the multi-value model is that these are
 * not interchangeable.
 *
 * Owned by: M-12 Payments.
 */

import type { AuditActionDefinition } from '../../kernel/audit-foundation/registry.ts';
import { auditOutboxEntry, eventOutboxEntry } from '../../platform/outbox/builder.ts';
import type { OutboxEntry } from '../../platform/outbox/types.ts';
import type {
  EventTypeDefinition,
  PayloadField,
} from '../../kernel/event-infrastructure/registry.ts';

import type { Payment, PaymentAttempt, Refund } from './types.ts';

const PAYMENT_EVENT_FIELDS = [
  { name: 'payment_id', kind: 'string', required: true, description: 'The payment identifier.' },
  { name: 'order_id', kind: 'string', required: true, description: 'The M-11 order being paid.' },
  {
    name: 'payer_account_id',
    kind: 'string',
    required: true,
    description: 'The paying account.',
  },
  {
    name: 'payee_account_id',
    kind: 'string',
    required: true,
    description: 'The account being paid.',
  },
  { name: 'status', kind: 'string', required: true, description: 'The status after the change.' },
  { name: 'provider', kind: 'string', required: true, description: 'The provider adapter.' },
  { name: 'rail', kind: 'string', required: true, description: 'How the value crossed the boundary.' },
  {
    name: 'asset_code',
    kind: 'string',
    required: true,
    description: 'The settlement asset. Not assumed to be a fiat code.',
  },
  {
    name: 'asset_scale',
    kind: 'string',
    required: true,
    description: 'Minor units per major unit as a power of ten.',
  },
  {
    name: 'amount_minor',
    kind: 'string',
    required: true,
    description: 'The authorised amount in integer minor units, as a string.',
  },
  {
    name: 'captured_minor',
    kind: 'string',
    required: true,
    description: 'How much has been captured, as a string.',
  },
  {
    name: 'refunded_minor',
    kind: 'string',
    required: true,
    description: 'How much has been refunded, as a string.',
  },
  {
    name: 'provider_reference',
    kind: 'string',
    required: true,
    description: 'The provider handle for reconciliation, or empty when none exists yet.',
  },
  { name: 'occurred_at', kind: 'string', required: true, description: 'ISO-8601 instant.' },
  {
    name: 'idempotency_key',
    kind: 'string',
    required: true,
    description: 'The idempotency key supplied for the operation.',
  },
] satisfies PayloadField[];

const FAILURE_EVENT_FIELDS = [
  ...PAYMENT_EVENT_FIELDS,
  {
    name: 'failure_code',
    kind: 'string',
    required: true,
    description: 'The vocabulary reason a consumer branches on.',
  },
] satisfies PayloadField[];

const REFUND_EVENT_FIELDS = [
  ...PAYMENT_EVENT_FIELDS,
  {
    name: 'refund_id',
    kind: 'string',
    required: true,
    description: 'The refund identifier.',
  },
  {
    name: 'refund_amount_minor',
    kind: 'string',
    required: true,
    description: 'This refund alone, in integer minor units, as a string.',
  },
  { name: 'reason', kind: 'string', required: true, description: 'Why the refund was made.' },
] satisfies PayloadField[];

const PAYMENT_AUDIT_FIELDS = PAYMENT_EVENT_FIELDS.map((field) => ({
  ...field,
  classification: 'internal' as const,
}));

export const PAYMENT_REQUESTED_EVENT: EventTypeDefinition = {
  type: 'payment.requested',
  schemaVersion: 1,
  owner: 'M-12',
  description: 'A payment intent was created and awaits authorisation.',
  payloadFields: PAYMENT_EVENT_FIELDS,
};

export const PAYMENT_AUTHORISED_EVENT: EventTypeDefinition = {
  type: 'payment.authorised',
  schemaVersion: 1,
  owner: 'M-12',
  description: 'A provider authorised the payment; no value has moved yet.',
  payloadFields: PAYMENT_EVENT_FIELDS,
};

export const PAYMENT_CAPTURED_EVENT: EventTypeDefinition = {
  type: 'payment.captured',
  schemaVersion: 1,
  owner: 'M-12',
  description: 'A provider captured value. This is the fact M-13 posts against.',
  payloadFields: PAYMENT_EVENT_FIELDS,
};

export const PAYMENT_FAILED_EVENT: EventTypeDefinition = {
  type: 'payment.failed',
  schemaVersion: 1,
  owner: 'M-12',
  description: 'A provider refused. `failure_code` says why.',
  payloadFields: FAILURE_EVENT_FIELDS,
};

export const PAYMENT_CANCELLED_EVENT: EventTypeDefinition = {
  type: 'payment.cancelled',
  schemaVersion: 1,
  owner: 'M-12',
  description: 'An authorised or unauthorised payment was cancelled before capture.',
  payloadFields: PAYMENT_EVENT_FIELDS,
};

export const PAYMENT_REFUNDED_EVENT: EventTypeDefinition = {
  type: 'payment.refunded',
  schemaVersion: 1,
  owner: 'M-12',
  description: 'Value was returned. Partial and full refunds both emit this.',
  payloadFields: REFUND_EVENT_FIELDS,
};

export const PAYMENT_REQUESTED_ACTION: AuditActionDefinition = {
  action: 'payment.requested',
  owner: 'M-12',
  authority: 'business-authoritative',
  description: 'A payment intent was created.',
  resourceTypes: ['payment'],
  evidenceFields: [...PAYMENT_AUDIT_FIELDS],
};

export const PAYMENT_AUTHORISED_ACTION: AuditActionDefinition = {
  action: 'payment.authorised',
  owner: 'M-12',
  authority: 'business-authoritative',
  description: 'A provider authorised the payment.',
  resourceTypes: ['payment'],
  evidenceFields: [...PAYMENT_AUDIT_FIELDS],
};

export const PAYMENT_CAPTURED_ACTION: AuditActionDefinition = {
  action: 'payment.captured',
  owner: 'M-12',
  authority: 'business-authoritative',
  description: 'A provider captured value.',
  resourceTypes: ['payment'],
  evidenceFields: [...PAYMENT_AUDIT_FIELDS],
};

export const PAYMENT_FAILED_ACTION: AuditActionDefinition = {
  action: 'payment.failed',
  owner: 'M-12',
  authority: 'business-authoritative',
  description: 'A provider refused the payment.',
  resourceTypes: ['payment'],
  evidenceFields: [
    ...PAYMENT_AUDIT_FIELDS,
    {
      name: 'failure_code',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The vocabulary reason.',
    },
  ],
};

export const PAYMENT_CANCELLED_ACTION: AuditActionDefinition = {
  action: 'payment.cancelled',
  owner: 'M-12',
  authority: 'business-authoritative',
  description: 'A payment was cancelled before capture.',
  resourceTypes: ['payment'],
  evidenceFields: [...PAYMENT_AUDIT_FIELDS],
};

export const PAYMENT_REFUNDED_ACTION: AuditActionDefinition = {
  action: 'payment.refunded',
  owner: 'M-12',
  authority: 'business-authoritative',
  description: 'Value was returned to the payer.',
  resourceTypes: ['payment'],
  evidenceFields: [
    ...PAYMENT_AUDIT_FIELDS,
    {
      name: 'refund_id',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The refund identifier.',
    },
    {
      name: 'refund_amount_minor',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'This refund alone, as a string.',
    },
  ],
};

/** The business payload every payment event shares. */
function paymentPayload(payment: Payment, occurredAt: string, idempotencyKey: string): Record<string, string> {
  return {
    payment_id: payment.paymentId,
    order_id: payment.orderId,
    payer_account_id: payment.payerAccountId,
    payee_account_id: payment.payeeAccountId,
    status: payment.status,
    provider: payment.provider,
    rail: payment.rail,
    asset_code: payment.assetCode,
    asset_scale: String(payment.assetScale),
    amount_minor: String(payment.amountMinor),
    captured_minor: String(payment.capturedMinor),
    refunded_minor: String(payment.refundedMinor),
    provider_reference: payment.providerReference ?? '',
    occurred_at: occurredAt,
    idempotency_key: idempotencyKey,
  };
}

/**
 * Build an event entry.
 *
 * The outbox id derives from the **attempt or refund** that produced the fact, never from the
 * payment alone: one payment is authorised, captured and refunded, and an id derived from the
 * payment would collide with itself on the second fact. M-01 shipped exactly that bug and
 * `outbox_pkey` refused the write.
 */
function paymentEventEntry(
  payment: Payment,
  factId: string,
  definition: EventTypeDefinition,
  occurredAt: string,
  idempotencyKey: string,
  correlationId: string,
  extra: Record<string, string> = {},
): OutboxEntry {
  const eventId = `${factId}:${definition.type}`;
  return eventOutboxEntry({
    outboxId: `M-12:${eventId}`,
    idempotencyKey: `M-12:${eventId}`,
    payload: {
      eventId,
      type: definition.type,
      schemaVersion: definition.schemaVersion,
      occurredAt,
      recordedAt: occurredAt,
      producer: 'M-12',
      correlationId,
      causationId: null,
      origin: 'system',
      actor: { kind: 'system', id: 'M-12' },
      idempotencyKey: `M-12:${eventId}`,
      now: occurredAt,
      payload: { ...paymentPayload(payment, occurredAt, idempotencyKey), ...extra },
    },
    occurredAt,
    recordedAt: occurredAt,
    producer: 'M-12',
    correlationId,
    causationId: null,
  });
}

function paymentAuditEntry(
  payment: Payment,
  factId: string,
  definition: AuditActionDefinition,
  occurredAt: string,
  idempotencyKey: string,
  correlationId: string,
  extra: Record<string, string> = {},
): OutboxEntry {
  const recordId = `${factId}:${definition.action}`;
  const outboxId = `M-12:audit:${recordId}`;
  return auditOutboxEntry({
    outboxId,
    idempotencyKey: outboxId,
    payload: {
      recordId,
      action: definition.action,
      recordedAt: occurredAt,
      actor: { kind: 'system', id: 'M-12', authentication: 'unauthenticated', sessionId: null },
      resource: { owner: 'M-12', type: 'payment', id: payment.paymentId },
      outcome: 'succeeded',
      reason: `payment ${payment.paymentId} is ${payment.status}`,
      correlationId,
      causationId: null,
      idempotencyKey: outboxId,
      evidence: { ...paymentPayload(payment, occurredAt, idempotencyKey), ...extra },
    },
    recordedAt: occurredAt,
    producer: 'M-12',
    correlationId,
    causationId: null,
  });
}

/** The event reporting that a payment intent was created. */
export function makePaymentRequestedEvent(payment: Payment): OutboxEntry {
  return paymentEventEntry(
    payment,
    payment.paymentId,
    PAYMENT_REQUESTED_EVENT,
    payment.createdAt,
    payment.idempotencyKey,
    payment.correlationId,
  );
}

/** The audit record for one payment intent. */
export function makePaymentRequestedAction(payment: Payment): OutboxEntry {
  return paymentAuditEntry(
    payment,
    payment.paymentId,
    PAYMENT_REQUESTED_ACTION,
    payment.createdAt,
    payment.idempotencyKey,
    payment.correlationId,
  );
}

/** The event for an attempt that moved the payment: authorised, captured or cancelled. */
export function makeAttemptEvent(
  payment: Payment,
  attempt: PaymentAttempt,
  definition: EventTypeDefinition,
): OutboxEntry {
  const extra =
    attempt.failureCode === null ? {} : { failure_code: attempt.failureCode };
  return paymentEventEntry(
    payment,
    attempt.attemptId,
    definition,
    attempt.attemptedAt,
    attempt.idempotencyKey,
    attempt.correlationId,
    extra,
  );
}

/** The audit record for one attempt. */
export function makeAttemptAction(
  payment: Payment,
  attempt: PaymentAttempt,
  definition: AuditActionDefinition,
): OutboxEntry {
  const extra =
    attempt.failureCode === null ? {} : { failure_code: attempt.failureCode };
  return paymentAuditEntry(
    payment,
    attempt.attemptId,
    definition,
    attempt.attemptedAt,
    attempt.idempotencyKey,
    attempt.correlationId,
    extra,
  );
}

/** The event reporting one refund, partial or full. */
export function makeRefundEvent(payment: Payment, refund: Refund): OutboxEntry {
  return paymentEventEntry(
    payment,
    refund.refundId,
    PAYMENT_REFUNDED_EVENT,
    refund.refundedAt,
    refund.idempotencyKey,
    refund.correlationId,
    {
      refund_id: refund.refundId,
      refund_amount_minor: String(refund.amountMinor),
      reason: refund.reason,
    },
  );
}

/** The audit record for one refund. */
export function makeRefundAction(payment: Payment, refund: Refund): OutboxEntry {
  return paymentAuditEntry(
    payment,
    refund.refundId,
    PAYMENT_REFUNDED_ACTION,
    refund.refundedAt,
    refund.idempotencyKey,
    refund.correlationId,
    {
      refund_id: refund.refundId,
      refund_amount_minor: String(refund.amountMinor),
    },
  );
}
