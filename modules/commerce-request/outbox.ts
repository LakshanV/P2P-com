/**
 * M-03 Commerce Request — the facts this module publishes.
 *
 * **The raw text is not in any of them.** It is what a person wrote in their own words, so it can
 * contain a telephone number, an address, a medical detail or a grievance about a supplier — and an
 * event is fanned out to every subscriber, forwarded to the audit log and kept indefinitely.
 * Publishing it would take a field that is deliberately exempt from the identifier rules and spray
 * it across the platform. A consumer that genuinely needs the words asks M-03 for them, through a
 * call somebody authorised.
 *
 * The structured interpretation is not published either, for a weaker version of the same reason: it
 * is derived from the raw text and can quote it. What travels is the **shape** of what happened —
 * which Need, whose, what status, how confident — which is what a consumer needs in order to decide
 * whether to ask for more.
 *
 * Owned by: M-03 Commerce Request.
 */

import type { AuditActionDefinition } from '../../kernel/audit-foundation/registry.ts';
import { auditOutboxEntry, eventOutboxEntry } from '../../platform/outbox/builder.ts';
import type { OutboxEntry } from '../../platform/outbox/types.ts';
import type {
  EventTypeDefinition,
  PayloadField,
} from '../../kernel/event-infrastructure/registry.ts';

import type { CommerceRequest, RequestInterpretation } from './types.ts';

const REQUEST_EVENT_FIELDS: readonly PayloadField[] = [
  { name: 'request_id', kind: 'string', required: true, description: 'The Need.' },
  { name: 'account_id', kind: 'string', required: true, description: 'Who asked.' },
  {
    name: 'channel',
    kind: 'string',
    required: true,
    description: 'How it arrived: text, voice, image, document, barcode, link or conversation.',
  },
  { name: 'status', kind: 'string', required: true, description: 'The status after the change.' },
  {
    name: 'raw_text_length',
    kind: 'string',
    required: true,
    description:
      'How long the request is, in characters, as a string. The length rather than the text: a ' +
      'consumer can tell a one-word request from a specification without the words being fanned ' +
      'out across the platform.',
  },
  {
    name: 'has_media',
    kind: 'string',
    required: true,
    description: '"true" when the Need carries attachments, so a consumer knows to look.',
  },
  { name: 'occurred_at', kind: 'string', required: true, description: 'When the fact happened.' },
  {
    name: 'idempotency_key',
    kind: 'string',
    required: true,
    description: 'The key the originating request converged on.',
  },
];

const INTERPRETATION_EVENT_FIELDS: readonly PayloadField[] = [
  { name: 'request_id', kind: 'string', required: true, description: 'The Need interpreted.' },
  {
    name: 'interpretation_id',
    kind: 'string',
    required: true,
    description: 'The reading itself.',
  },
  {
    name: 'version',
    kind: 'string',
    required: true,
    description: 'Which reading of this Need it is, as a string. 1 for the first.',
  },
  {
    name: 'origin',
    kind: 'string',
    required: true,
    description: 'model, rule or human. A human correction outranks both of the others.',
  },
  {
    name: 'confidence_per_mille',
    kind: 'string',
    required: true,
    description:
      'How sure the reading is, 0 to 1000, as a string. Published because a consumer that ' +
      'treated a 0.35 reading like a 0.98 one would source against a guess.',
  },
  {
    name: 'ai_run_id',
    kind: 'string',
    required: false,
    description: 'The K-13 run behind a model reading, so a wrong one is traceable.',
  },
  { name: 'occurred_at', kind: 'string', required: true, description: 'When the fact happened.' },
  {
    name: 'idempotency_key',
    kind: 'string',
    required: true,
    description: 'The key the originating request converged on.',
  },
];

export const NEED_CAPTURED_EVENT: EventTypeDefinition = {
  type: 'need.captured',
  schemaVersion: 1,
  owner: 'M-03',
  description: 'Somebody said what they want. The words themselves are not in this event.',
  payloadFields: REQUEST_EVENT_FIELDS,
};

export const NEED_INTERPRETED_EVENT: EventTypeDefinition = {
  type: 'need.interpreted',
  schemaVersion: 1,
  owner: 'M-03',
  description: 'A reading of a Need was recorded. Earlier readings are untouched.',
  payloadFields: INTERPRETATION_EVENT_FIELDS,
};

export const NEED_READY_EVENT: EventTypeDefinition = {
  type: 'need.ready',
  schemaVersion: 1,
  owner: 'M-03',
  description: 'A Need is understood well enough to source against. The ladder starts here.',
  payloadFields: REQUEST_EVENT_FIELDS,
};

export const NEED_CLOSED_EVENT: EventTypeDefinition = {
  type: 'need.closed',
  schemaVersion: 1,
  owner: 'M-03',
  description:
    'A Need ended: fulfilled, cancelled or expired. The three are distinct because "they changed ' +
    'their mind" and "we were too slow" are different failures and only one of them is ours.',
  payloadFields: REQUEST_EVENT_FIELDS,
};

/**
 * The event fields, as audit evidence.
 *
 * Every one is `internal` rather than `personal`, and that is only true because the raw text is not
 * among them. A length, a channel and a status say nothing about a person; the words would.
 */
const REQUEST_EVIDENCE = REQUEST_EVENT_FIELDS.map((field) => ({
  name: field.name,
  kind: 'string' as const,
  required: field.required,
  classification: 'internal' as const,
  description: field.description,
}));

const INTERPRETATION_EVIDENCE = INTERPRETATION_EVENT_FIELDS.map((field) => ({
  name: field.name,
  kind: 'string' as const,
  required: field.required,
  classification: 'internal' as const,
  description: field.description,
}));

export const NEED_CAPTURED_ACTION: AuditActionDefinition = {
  action: 'need.captured',
  owner: 'M-03',
  authority: 'business-authoritative',
  description: 'A Need was captured.',
  resourceTypes: ['commerce_request'],
  evidenceFields: REQUEST_EVIDENCE,
};

export const NEED_INTERPRETED_ACTION: AuditActionDefinition = {
  action: 'need.interpreted',
  owner: 'M-03',
  authority: 'business-authoritative',
  description: 'A reading of a Need was recorded.',
  resourceTypes: ['commerce_request'],
  evidenceFields: INTERPRETATION_EVIDENCE,
};

export const NEED_STATUS_ACTION: AuditActionDefinition = {
  action: 'need.status_changed',
  owner: 'M-03',
  authority: 'business-authoritative',
  description: 'A Need moved between statuses.',
  resourceTypes: ['commerce_request'],
  evidenceFields: REQUEST_EVIDENCE,
};

/** The shape every request event shares. Note what is absent: the words. */
function requestPayload(
  request: CommerceRequest,
  occurredAt: string,
  hasMedia: boolean,
): Record<string, string> {
  return {
    request_id: request.requestId,
    account_id: request.accountId,
    channel: request.channel,
    status: request.status,
    // The length, not the text. A consumer can tell a one-word request from a specification, and
    // nobody downstream ends up holding a copy of what a customer wrote.
    raw_text_length: String([...request.rawText].length),
    has_media: hasMedia ? 'true' : 'false',
    occurred_at: occurredAt,
    idempotency_key: request.idempotencyKey,
  };
}

function interpretationPayload(
  interpretation: RequestInterpretation,
  occurredAt: string,
): Record<string, string> {
  return {
    request_id: interpretation.requestId,
    interpretation_id: interpretation.interpretationId,
    version: String(interpretation.version),
    origin: interpretation.origin,
    confidence_per_mille: String(interpretation.confidencePerMille),
    ai_run_id: interpretation.aiRunId ?? '',
    occurred_at: occurredAt,
    idempotency_key: interpretation.idempotencyKey,
  };
}

/**
 * Build an event entry.
 *
 * The outbox id derives from the **fact** — a transition, an interpretation — and never from the
 * Need alone: one Need is captured, interpreted, made ready and closed, and an id derived from the
 * Need would collide with itself on the second fact. M-01 shipped exactly that bug and `outbox_pkey`
 * refused the write.
 */
function requestEventEntry(
  request: CommerceRequest,
  factId: string,
  definition: EventTypeDefinition,
  occurredAt: string,
  hasMedia: boolean,
): OutboxEntry {
  const eventId = `${factId}:${definition.type}`;
  return eventOutboxEntry({
    outboxId: `M-03:${eventId}`,
    idempotencyKey: `M-03:${eventId}`,
    payload: {
      eventId,
      type: definition.type,
      schemaVersion: definition.schemaVersion,
      occurredAt,
      recordedAt: occurredAt,
      producer: 'M-03',
      correlationId: request.correlationId,
      causationId: null,
      origin: 'system',
      actor: { kind: 'system', id: 'M-03' },
      idempotencyKey: `M-03:${eventId}`,
      now: occurredAt,
      payload: requestPayload(request, occurredAt, hasMedia),
    },
    occurredAt,
    recordedAt: occurredAt,
    producer: 'M-03',
    correlationId: request.correlationId,
    causationId: null,
  });
}

function requestAuditEntry(
  request: CommerceRequest,
  factId: string,
  definition: AuditActionDefinition,
  occurredAt: string,
  hasMedia: boolean,
): OutboxEntry {
  const recordId = `${factId}:${definition.action}`;
  const outboxId = `M-03:audit:${recordId}`;
  return auditOutboxEntry({
    outboxId,
    idempotencyKey: outboxId,
    payload: {
      recordId,
      action: definition.action,
      subjectId: request.accountId,
      resourceType: 'commerce_request',
      resourceId: request.requestId,
      occurredAt,
      recordedAt: occurredAt,
      actor: { kind: 'system', id: 'M-03' },
      correlationId: request.correlationId,
      idempotencyKey: outboxId,
      now: occurredAt,
      evidence: requestPayload(request, occurredAt, hasMedia),
    },
    recordedAt: occurredAt,
    producer: 'M-03',
    correlationId: request.correlationId,
    causationId: null,
  });
}

export function makeNeedCapturedEvent(request: CommerceRequest, hasMedia: boolean): OutboxEntry {
  return requestEventEntry(
    request,
    request.requestId,
    NEED_CAPTURED_EVENT,
    request.capturedAt,
    hasMedia,
  );
}

export function makeNeedCapturedAction(request: CommerceRequest, hasMedia: boolean): OutboxEntry {
  return requestAuditEntry(
    request,
    request.requestId,
    NEED_CAPTURED_ACTION,
    request.capturedAt,
    hasMedia,
  );
}

export function makeStatusEvent(
  request: CommerceRequest,
  factId: string,
  occurredAt: string,
  hasMedia: boolean,
): OutboxEntry {
  const definition = request.status === 'ready' ? NEED_READY_EVENT : NEED_CLOSED_EVENT;
  return requestEventEntry(request, factId, definition, occurredAt, hasMedia);
}

export function makeStatusAction(
  request: CommerceRequest,
  factId: string,
  occurredAt: string,
  hasMedia: boolean,
): OutboxEntry {
  return requestAuditEntry(request, factId, NEED_STATUS_ACTION, occurredAt, hasMedia);
}

export function makeInterpretedEvent(interpretation: RequestInterpretation): OutboxEntry {
  const eventId = `${interpretation.interpretationId}:${NEED_INTERPRETED_EVENT.type}`;
  return eventOutboxEntry({
    outboxId: `M-03:${eventId}`,
    idempotencyKey: `M-03:${eventId}`,
    payload: {
      eventId,
      type: NEED_INTERPRETED_EVENT.type,
      schemaVersion: NEED_INTERPRETED_EVENT.schemaVersion,
      occurredAt: interpretation.interpretedAt,
      recordedAt: interpretation.interpretedAt,
      producer: 'M-03',
      correlationId: interpretation.correlationId,
      causationId: null,
      origin: 'system',
      actor: { kind: 'system', id: 'M-03' },
      idempotencyKey: `M-03:${eventId}`,
      now: interpretation.interpretedAt,
      payload: interpretationPayload(interpretation, interpretation.interpretedAt),
    },
    occurredAt: interpretation.interpretedAt,
    recordedAt: interpretation.interpretedAt,
    producer: 'M-03',
    correlationId: interpretation.correlationId,
    causationId: null,
  });
}

/**
 * The audit record for a reading.
 *
 * Takes the account rather than the whole Need, because an audit row says who a thing happened to
 * and that is the only part of the Need it needs — passing the request would carry the raw text
 * into a function whose entire purpose is to publish something that does not contain it.
 */
export function makeInterpretedAction(
  accountId: string,
  interpretation: RequestInterpretation,
): OutboxEntry {
  const recordId = `${interpretation.interpretationId}:${NEED_INTERPRETED_ACTION.action}`;
  const outboxId = `M-03:audit:${recordId}`;
  return auditOutboxEntry({
    outboxId,
    idempotencyKey: outboxId,
    payload: {
      recordId,
      action: NEED_INTERPRETED_ACTION.action,
      subjectId: accountId,
      resourceType: 'commerce_request',
      resourceId: interpretation.requestId,
      occurredAt: interpretation.interpretedAt,
      recordedAt: interpretation.interpretedAt,
      actor: { kind: 'system', id: 'M-03' },
      correlationId: interpretation.correlationId,
      idempotencyKey: outboxId,
      now: interpretation.interpretedAt,
      evidence: interpretationPayload(interpretation, interpretation.interpretedAt),
    },
    recordedAt: interpretation.interpretedAt,
    producer: 'M-03',
    correlationId: interpretation.correlationId,
    causationId: null,
  });
}
