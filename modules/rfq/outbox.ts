/**
 * M-09 RFQ — the facts a tender publishes.
 *
 * **No specification travels in an event.** An RFQ event says a tender exists, who opened it and in
 * what category; a supplier who is invited fetches the requirement through a route that can check
 * they were invited. Publishing the specification would put a private tender's contents into the
 * event log, where every subscriber and the audit trail keep it indefinitely — and a `private` RFQ
 * whose contents are in a shared log is not private.
 *
 * Owned by: M-09 RFQ.
 */

import type { AuditActionDefinition } from '../../kernel/audit-foundation/registry.ts';
import { auditOutboxEntry, eventOutboxEntry } from '../../platform/outbox/builder.ts';
import type { OutboxEntry } from '../../platform/outbox/types.ts';
import type {
  EventTypeDefinition,
  PayloadField,
} from '../../kernel/event-infrastructure/registry.ts';

import type { Rfq, RfqInvitation } from './types.ts';

const RFQ_FIELDS: readonly PayloadField[] = [
  { name: 'rfq_id', kind: 'string', required: true, description: 'The tender.' },
  { name: 'request_id', kind: 'string', required: true, description: 'The Need behind it.' },
  { name: 'account_id', kind: 'string', required: true, description: 'The buyer.' },
  {
    name: 'category',
    kind: 'string',
    required: true,
    description: 'What it is for, as an opaque category code. Enough to route on, and no more.',
  },
  { name: 'status', kind: 'string', required: true, description: 'The status after the change.' },
  {
    name: 'visibility',
    kind: 'string',
    required: true,
    description: 'private or network. A private tender is visible only to invited suppliers.',
  },
  {
    name: 'invited_count',
    kind: 'string',
    required: true,
    description: 'How many suppliers were invited, as a string.',
  },
  { name: 'closes_at', kind: 'string', required: true, description: 'When quoting closes.' },
  { name: 'occurred_at', kind: 'string', required: true, description: 'When the fact happened.' },
  {
    name: 'idempotency_key',
    kind: 'string',
    required: true,
    description: 'The key the originating request converged on.',
  },
];

const INVITATION_FIELDS: readonly PayloadField[] = [
  { name: 'rfq_id', kind: 'string', required: true, description: 'The tender.' },
  { name: 'invitation_id', kind: 'string', required: true, description: 'The invitation.' },
  {
    name: 'supplier_account_id',
    kind: 'string',
    required: true,
    description: 'Who was asked. This is what a notification consumer routes on.',
  },
  {
    name: 'source_rung',
    kind: 'string',
    required: false,
    description: 'Which rung of the sourcing ladder found them, when one did.',
  },
  { name: 'occurred_at', kind: 'string', required: true, description: 'When they were invited.' },
  {
    name: 'idempotency_key',
    kind: 'string',
    required: true,
    description: 'The key the originating request converged on.',
  },
];

export const RFQ_CREATED_EVENT: EventTypeDefinition = {
  type: 'rfq.created',
  schemaVersion: 1,
  owner: 'M-09',
  description:
    'A tender was opened, because the sourcing ladder could not solve the Need any other way. ' +
    'The specification is not in this event.',
  payloadFields: RFQ_FIELDS,
};

export const RFQ_CLOSED_EVENT: EventTypeDefinition = {
  type: 'rfq.closed',
  schemaVersion: 1,
  owner: 'M-09',
  description: 'Quoting has ended. Offers already made stand; no new one is accepted.',
  payloadFields: RFQ_FIELDS,
};

export const RFQ_AWARDED_EVENT: EventTypeDefinition = {
  type: 'rfq.awarded',
  schemaVersion: 1,
  owner: 'M-09',
  description: 'One offer was chosen. M-11 subscribes to this to open the order.',
  payloadFields: RFQ_FIELDS,
};

export const RFQ_CANCELLED_EVENT: EventTypeDefinition = {
  type: 'rfq.cancelled',
  schemaVersion: 1,
  owner: 'M-09',
  description:
    'The buyer withdrew it. Distinct from closed, because suppliers who quoted are owed the ' +
    'difference between "somebody else won" and "it is not happening".',
  payloadFields: RFQ_FIELDS,
};

export const SUPPLIER_INVITED_EVENT: EventTypeDefinition = {
  type: 'rfq.supplier_invited',
  schemaVersion: 1,
  owner: 'M-09',
  description:
    'A named supplier was asked to quote. K-14 subscribes to this to tell them; the tender ' +
    'itself is fetched through a route that checks the invitation.',
  payloadFields: INVITATION_FIELDS,
};

export const RFQ_ACTION: AuditActionDefinition = {
  action: 'rfq.status_changed',
  owner: 'M-09',
  authority: 'business-authoritative',
  description: 'A tender was opened, closed, awarded or cancelled.',
  resourceTypes: ['rfq'],
  evidenceFields: RFQ_FIELDS.map((field) => ({
    name: field.name,
    kind: 'string' as const,
    required: field.required,
    classification: 'internal' as const,
    description: field.description,
  })),
};

export const INVITATION_ACTION: AuditActionDefinition = {
  action: 'rfq.supplier_invited',
  owner: 'M-09',
  authority: 'business-authoritative',
  description: 'A supplier was invited to quote.',
  resourceTypes: ['rfq'],
  evidenceFields: INVITATION_FIELDS.map((field) => ({
    name: field.name,
    kind: 'string' as const,
    required: field.required,
    classification: 'internal' as const,
    description: field.description,
  })),
};

function rfqPayload(rfq: Rfq, invitedCount: number, occurredAt: string): Record<string, string> {
  return {
    rfq_id: rfq.rfqId,
    request_id: rfq.requestId,
    account_id: rfq.accountId,
    // The category and nothing else from the specification. Enough for a consumer to route on, and
    // not enough for the event log to become a copy of every private tender.
    category: rfq.specification.category,
    status: rfq.status,
    visibility: rfq.visibility,
    invited_count: String(invitedCount),
    closes_at: rfq.closesAt,
    occurred_at: occurredAt,
    idempotency_key: rfq.idempotencyKey,
  };
}

const EVENT_FOR_STATUS: Readonly<Record<string, EventTypeDefinition>> = Object.freeze({
  open: RFQ_CREATED_EVENT,
  closed: RFQ_CLOSED_EVENT,
  awarded: RFQ_AWARDED_EVENT,
  cancelled: RFQ_CANCELLED_EVENT,
});

export function makeRfqEvent(rfq: Rfq, factId: string, invitedCount: number): OutboxEntry {
  const definition = EVENT_FOR_STATUS[rfq.status] ?? RFQ_CREATED_EVENT;
  const eventId = `${factId}:${definition.type}`;
  return eventOutboxEntry({
    outboxId: `M-09:${eventId}`,
    idempotencyKey: `M-09:${eventId}`,
    payload: {
      eventId,
      type: definition.type,
      schemaVersion: definition.schemaVersion,
      occurredAt: rfq.updatedAt,
      recordedAt: rfq.updatedAt,
      producer: 'M-09',
      correlationId: rfq.correlationId,
      causationId: null,
      origin: 'system',
      actor: { kind: 'system', id: 'M-09' },
      idempotencyKey: `M-09:${eventId}`,
      now: rfq.updatedAt,
      payload: rfqPayload(rfq, invitedCount, rfq.updatedAt),
    },
    occurredAt: rfq.updatedAt,
    recordedAt: rfq.updatedAt,
    producer: 'M-09',
    correlationId: rfq.correlationId,
    causationId: null,
  });
}

export function makeRfqAction(rfq: Rfq, factId: string, invitedCount: number): OutboxEntry {
  const recordId = `${factId}:${RFQ_ACTION.action}`;
  const outboxId = `M-09:audit:${recordId}`;
  return auditOutboxEntry({
    outboxId,
    idempotencyKey: outboxId,
    payload: {
      recordId,
      action: RFQ_ACTION.action,
      subjectId: rfq.accountId,
      resourceType: 'rfq',
      resourceId: rfq.rfqId,
      occurredAt: rfq.updatedAt,
      recordedAt: rfq.updatedAt,
      actor: { kind: 'system', id: 'M-09' },
      correlationId: rfq.correlationId,
      idempotencyKey: outboxId,
      now: rfq.updatedAt,
      evidence: rfqPayload(rfq, invitedCount, rfq.updatedAt),
    },
    recordedAt: rfq.updatedAt,
    producer: 'M-09',
    correlationId: rfq.correlationId,
    causationId: null,
  });
}

function invitationPayload(invitation: RfqInvitation): Record<string, string> {
  return {
    rfq_id: invitation.rfqId,
    invitation_id: invitation.invitationId,
    supplier_account_id: invitation.supplierAccountId,
    source_rung: invitation.sourceRung ?? '',
    occurred_at: invitation.invitedAt,
    idempotency_key: invitation.idempotencyKey,
  };
}

export function makeInvitationEvent(invitation: RfqInvitation): OutboxEntry {
  const eventId = `${invitation.invitationId}:${SUPPLIER_INVITED_EVENT.type}`;
  return eventOutboxEntry({
    outboxId: `M-09:${eventId}`,
    idempotencyKey: `M-09:${eventId}`,
    payload: {
      eventId,
      type: SUPPLIER_INVITED_EVENT.type,
      schemaVersion: SUPPLIER_INVITED_EVENT.schemaVersion,
      occurredAt: invitation.invitedAt,
      recordedAt: invitation.invitedAt,
      producer: 'M-09',
      correlationId: invitation.correlationId,
      causationId: null,
      origin: 'system',
      actor: { kind: 'system', id: 'M-09' },
      idempotencyKey: `M-09:${eventId}`,
      now: invitation.invitedAt,
      payload: invitationPayload(invitation),
    },
    occurredAt: invitation.invitedAt,
    recordedAt: invitation.invitedAt,
    producer: 'M-09',
    correlationId: invitation.correlationId,
    causationId: null,
  });
}

export function makeInvitationAction(
  invitation: RfqInvitation,
  buyerAccountId: string,
): OutboxEntry {
  const recordId = `${invitation.invitationId}:${INVITATION_ACTION.action}`;
  const outboxId = `M-09:audit:${recordId}`;
  return auditOutboxEntry({
    outboxId,
    idempotencyKey: outboxId,
    payload: {
      recordId,
      action: INVITATION_ACTION.action,
      subjectId: buyerAccountId,
      resourceType: 'rfq',
      resourceId: invitation.rfqId,
      occurredAt: invitation.invitedAt,
      recordedAt: invitation.invitedAt,
      actor: { kind: 'system', id: 'M-09' },
      correlationId: invitation.correlationId,
      idempotencyKey: outboxId,
      now: invitation.invitedAt,
      evidence: invitationPayload(invitation),
    },
    recordedAt: invitation.invitedAt,
    producer: 'M-09',
    correlationId: invitation.correlationId,
    causationId: null,
  });
}
