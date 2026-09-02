/**
 * M-07 Matching — the facts a sourcing run publishes.
 *
 * **The Need's words are not here, and neither is the structured reading.** The same rule M-03
 * applies to its own events applies with more force downstream: a match run is the point where the
 * platform starts talking to suppliers, and a supplier must never receive the sentence a customer
 * wrote. What travels is which Need, whose, how it ended, and how many rungs it took.
 *
 * **`escalate-to-rfq` is published as a distinct fact**, because it is the one M-09 subscribes to.
 * A consumer that had to infer "no match" from the absence of an event would be a consumer that
 * silently does nothing when the ladder fails.
 *
 * Owned by: M-07 Matching.
 */

import type { AuditActionDefinition } from '../../kernel/audit-foundation/registry.ts';
import { auditOutboxEntry, eventOutboxEntry } from '../../platform/outbox/builder.ts';
import type { OutboxEntry } from '../../platform/outbox/types.ts';
import type {
  EventTypeDefinition,
  PayloadField,
} from '../../kernel/event-infrastructure/registry.ts';

import type { MatchRun } from './types.ts';

const RUN_FIELDS: readonly PayloadField[] = [
  { name: 'run_id', kind: 'string', required: true, description: 'This run of the ladder.' },
  { name: 'request_id', kind: 'string', required: true, description: 'The Need it ran against.' },
  { name: 'account_id', kind: 'string', required: true, description: 'Who asked.' },
  {
    name: 'outcome',
    kind: 'string',
    required: true,
    description: 'matched, escalate-to-rfq or exhausted.',
  },
  {
    name: 'satisfied_by',
    kind: 'string',
    required: false,
    description: 'The rung that answered, when one did. Empty on an escalation.',
  },
  {
    name: 'sufficiency_per_mille',
    kind: 'string',
    required: true,
    description: 'How good a candidate had to be for the run to stop, as a string.',
  },
  {
    name: 'rungs_attempted',
    kind: 'string',
    required: true,
    description: 'How many rungs were recorded, as a string.',
  },
  {
    name: 'candidates_found',
    kind: 'string',
    required: true,
    description:
      'How many candidates met the threshold, as a string. Zero on an escalation, which is what ' +
      'makes the escalation legitimate.',
  },
  { name: 'occurred_at', kind: 'string', required: true, description: 'When the run completed.' },
  {
    name: 'idempotency_key',
    kind: 'string',
    required: true,
    description: 'The key the originating request converged on.',
  },
];

export const MATCH_FOUND_EVENT: EventTypeDefinition = {
  type: 'matching.match_found',
  schemaVersion: 1,
  owner: 'M-07',
  description:
    'The sourcing ladder solved a Need without troubling the market. The words are not in this ' +
    'event, and neither is the structured reading.',
  payloadFields: RUN_FIELDS,
};

export const ESCALATE_TO_RFQ_EVENT: EventTypeDefinition = {
  type: 'matching.escalated_to_rfq',
  schemaVersion: 1,
  owner: 'M-07',
  description:
    'Every rung was tried and none answered, so asking the market is now the right thing to do. ' +
    'M-09 subscribes to this; M-07 recommends and never creates a tender itself.',
  payloadFields: RUN_FIELDS,
};

export const MATCH_RUN_ACTION: AuditActionDefinition = {
  action: 'matching.run_completed',
  owner: 'M-07',
  authority: 'business-authoritative',
  description: 'The sourcing ladder ran against a Need.',
  resourceTypes: ['commerce_request'],
  evidenceFields: RUN_FIELDS.map((field) => ({
    name: field.name,
    kind: 'string' as const,
    required: field.required,
    classification: 'internal' as const,
    description: field.description,
  })),
};

function runPayload(
  run: MatchRun,
  rungsAttempted: number,
  candidatesFound: number,
): Record<string, string> {
  return {
    run_id: run.runId,
    request_id: run.requestId,
    account_id: run.accountId,
    outcome: run.outcome,
    satisfied_by: run.satisfiedBy ?? '',
    sufficiency_per_mille: String(run.sufficiencyPerMille),
    rungs_attempted: String(rungsAttempted),
    candidates_found: String(candidatesFound),
    occurred_at: run.completedAt,
    idempotency_key: run.idempotencyKey,
  };
}

export function makeMatchRunEvent(
  run: MatchRun,
  rungsAttempted: number,
  candidatesFound: number,
): OutboxEntry {
  // Two event types rather than one with a status field, because M-09 subscribes to exactly one of
  // them. A consumer filtering a shared type on a payload field is a consumer that receives every
  // successful match it has no use for.
  const definition = run.outcome === 'matched' ? MATCH_FOUND_EVENT : ESCALATE_TO_RFQ_EVENT;
  const eventId = `${run.runId}:${definition.type}`;
  return eventOutboxEntry({
    outboxId: `M-07:${eventId}`,
    idempotencyKey: `M-07:${eventId}`,
    payload: {
      eventId,
      type: definition.type,
      schemaVersion: definition.schemaVersion,
      occurredAt: run.completedAt,
      recordedAt: run.completedAt,
      producer: 'M-07',
      correlationId: run.correlationId,
      causationId: null,
      origin: 'system',
      actor: { kind: 'system', id: 'M-07' },
      idempotencyKey: `M-07:${eventId}`,
      now: run.completedAt,
      payload: runPayload(run, rungsAttempted, candidatesFound),
    },
    occurredAt: run.completedAt,
    recordedAt: run.completedAt,
    producer: 'M-07',
    correlationId: run.correlationId,
    causationId: null,
  });
}

export function makeMatchRunAction(
  run: MatchRun,
  rungsAttempted: number,
  candidatesFound: number,
): OutboxEntry {
  const recordId = `${run.runId}:${MATCH_RUN_ACTION.action}`;
  const outboxId = `M-07:audit:${recordId}`;
  return auditOutboxEntry({
    outboxId,
    idempotencyKey: outboxId,
    payload: {
      recordId,
      action: MATCH_RUN_ACTION.action,
      subjectId: run.accountId,
      resourceType: 'commerce_request',
      resourceId: run.requestId,
      occurredAt: run.completedAt,
      recordedAt: run.completedAt,
      actor: { kind: 'system', id: 'M-07' },
      correlationId: run.correlationId,
      idempotencyKey: outboxId,
      now: run.completedAt,
      evidence: runPayload(run, rungsAttempted, candidatesFound),
    },
    recordedAt: run.completedAt,
    producer: 'M-07',
    correlationId: run.correlationId,
    causationId: null,
  });
}
