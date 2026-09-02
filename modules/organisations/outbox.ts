/**
 * M-49 — the facts the organisation module publishes.
 *
 * **A membership event carries the human and the business, and no roles.** Who acts for a company
 * is commercially sensitive — it tells a competitor who to approach and who has just left — and the
 * event log is read by every subscriber and kept indefinitely. What travels is enough for a
 * consumer to route on: the organisation, the person, and what happened to their place in it. A
 * consumer that needs the roles reads them through a route that can check who is asking.
 *
 * **The audit record does carry the roles**, because it answers a different question: what
 * authority was actually conferred, and by whom. That is the record an argument about "who let them
 * do that" is settled from, and it is not a subscription anybody can read.
 *
 * Owned by: M-49 Organisations.
 */

import type { AuditActionDefinition } from '../../kernel/audit-foundation/registry.ts';
import type {
  EventTypeDefinition,
  PayloadField,
} from '../../kernel/event-infrastructure/registry.ts';
import { auditOutboxEntry, eventOutboxEntry } from '../../platform/outbox/builder.ts';
import type { OutboxEntry } from '../../platform/outbox/types.ts';

import type { Organisation, OrganisationMembership } from './types.ts';

const ORGANISATION_FIELDS: readonly PayloadField[] = [
  { name: 'organisation_id', kind: 'string', required: true, description: 'The business.' },
  {
    name: 'account_id',
    kind: 'string',
    required: true,
    description: 'The K-03 account it trades under. What every commercial record already names.',
  },
  { name: 'kind', kind: 'string', required: true, description: 'supplier, merchant, logistics…' },
  { name: 'status', kind: 'string', required: true, description: 'The status after the change.' },
  { name: 'occurred_at', kind: 'string', required: true, description: 'When the fact happened.' },
  {
    name: 'idempotency_key',
    kind: 'string',
    required: true,
    description: 'The key the originating request converged on.',
  },
];

export const ORGANISATION_CREATED_EVENT: EventTypeDefinition = {
  type: 'organisation.created',
  schemaVersion: 1,
  owner: 'M-49',
  description:
    'A business exists, with an owner. It is not yet one the platform vouches for: creating a ' +
    'business is not being admitted to the market.',
  payloadFields: ORGANISATION_FIELDS,
};

export const ORGANISATION_ACTIVATED_EVENT: EventTypeDefinition = {
  type: 'organisation.activated',
  schemaVersion: 1,
  owner: 'M-49',
  description:
    'A business has been admitted. Subscribers that gate on standing — the supplier directory ' +
    'among them — act on this rather than making an operator repeat the decision.',
  payloadFields: ORGANISATION_FIELDS,
};

export const ORGANISATION_SUSPENDED_EVENT: EventTypeDefinition = {
  type: 'organisation.suspended',
  schemaVersion: 1,
  owner: 'M-49',
  description:
    'A business is temporarily not in good standing. Reversible, and not the same as closed.',
  payloadFields: ORGANISATION_FIELDS,
};

export const ORGANISATION_CLOSED_EVENT: EventTypeDefinition = {
  type: 'organisation.closed',
  schemaVersion: 1,
  owner: 'M-49',
  description: 'A business has stopped. Terminal, and the record stays: orders still name it.',
  payloadFields: ORGANISATION_FIELDS,
};

const MEMBERSHIP_FIELDS: readonly PayloadField[] = [
  {
    name: 'membership_id',
    kind: 'string',
    required: true,
    description: 'The place in the business.',
  },
  { name: 'organisation_id', kind: 'string', required: true, description: 'The business.' },
  {
    name: 'person_subject_id',
    kind: 'string',
    required: true,
    description: 'The human. What a notification consumer routes on.',
  },
  { name: 'status', kind: 'string', required: true, description: 'The status after the change.' },
  { name: 'occurred_at', kind: 'string', required: true, description: 'When the fact happened.' },
  {
    name: 'idempotency_key',
    kind: 'string',
    required: true,
    description: 'The key the originating request converged on.',
  },
];

export const MEMBER_INVITED_EVENT: EventTypeDefinition = {
  type: 'organisation.member_invited',
  schemaVersion: 1,
  owner: 'M-49',
  description:
    'Somebody was asked to act for a business. They hold nothing until they accept: an invitation ' +
    'that took effect on its own would put a person’s name on acts they never agreed to.',
  payloadFields: MEMBERSHIP_FIELDS,
};

export const MEMBER_JOINED_EVENT: EventTypeDefinition = {
  type: 'organisation.member_joined',
  schemaVersion: 1,
  owner: 'M-49',
  description: 'Somebody accepted, and may now act for the business in the roles they were given.',
  payloadFields: MEMBERSHIP_FIELDS,
};

export const MEMBER_SUSPENDED_EVENT: EventTypeDefinition = {
  type: 'organisation.member_suspended',
  schemaVersion: 1,
  owner: 'M-49',
  description: 'Somebody may not act for the business for now. Reversible.',
  payloadFields: MEMBERSHIP_FIELDS,
};

export const MEMBER_REMOVED_EVENT: EventTypeDefinition = {
  type: 'organisation.member_removed',
  schemaVersion: 1,
  owner: 'M-49',
  description:
    'Somebody’s place in the business has ended — revoked by the business, or left by them. ' +
    'Whichever it was is on the record; the event says only that it ended.',
  payloadFields: MEMBERSHIP_FIELDS,
};

export const ORGANISATION_ACTION: AuditActionDefinition = {
  action: 'organisation.status_changed',
  owner: 'M-49',
  authority: 'business-authoritative',
  description: 'A business was created, admitted, suspended or closed.',
  resourceTypes: ['organisation'],
  evidenceFields: [
    ...ORGANISATION_FIELDS.map((field) => ({
      name: field.name,
      kind: 'string' as const,
      required: field.required,
      classification: 'internal' as const,
      description: field.description,
    })),
    {
      name: 'display_name',
      kind: 'string' as const,
      required: true,
      classification: 'internal' as const,
      description: 'What it trades as. Public by design: a buyer sees it on an invitation.',
    },
    {
      name: 'reason',
      kind: 'string' as const,
      required: true,
      classification: 'internal' as const,
      description: 'Why the standing changed. A suspended business is entitled to know.',
    },
  ],
};

export const MEMBERSHIP_ACTION: AuditActionDefinition = {
  action: 'organisation.membership_changed',
  owner: 'M-49',
  authority: 'business-authoritative',
  description:
    'Somebody’s place in a business was created, accepted, changed, suspended or ended — with the ' +
    'roles it carries and the human who decided it.',
  resourceTypes: ['organisation_membership'],
  evidenceFields: [
    ...MEMBERSHIP_FIELDS.map((field) => ({
      name: field.name,
      kind: 'string' as const,
      required: field.required,
      classification: 'internal' as const,
      description: field.description,
    })),
    {
      name: 'roles',
      kind: 'string' as const,
      required: true,
      classification: 'internal' as const,
      description:
        'What the person may do for the business, comma-separated. Here and not in the event: ' +
        'who holds what authority in a company is not a subscription anybody may read.',
    },
    {
      name: 'actor_subject_id',
      kind: 'string' as const,
      required: true,
      classification: 'internal' as const,
      description:
        'The human who made the change. Never the organisation: a business does not act, people ' +
        'act for it, and an audit trail that lost the person answers nothing.',
    },
    {
      name: 'reason',
      kind: 'string' as const,
      required: true,
      classification: 'internal' as const,
      description: 'Why. Somebody removed from a business they worked for is entitled to it.',
    },
  ],
};

const ORGANISATION_EVENT_FOR_STATUS: Readonly<Record<string, EventTypeDefinition>> = Object.freeze({
  pending: ORGANISATION_CREATED_EVENT,
  active: ORGANISATION_ACTIVATED_EVENT,
  suspended: ORGANISATION_SUSPENDED_EVENT,
  closed: ORGANISATION_CLOSED_EVENT,
});

const MEMBERSHIP_EVENT_FOR_STATUS: Readonly<Record<string, EventTypeDefinition>> = Object.freeze({
  invited: MEMBER_INVITED_EVENT,
  active: MEMBER_JOINED_EVENT,
  suspended: MEMBER_SUSPENDED_EVENT,
  revoked: MEMBER_REMOVED_EVENT,
  left: MEMBER_REMOVED_EVENT,
});

function organisationPayload(organisation: Organisation): Record<string, string> {
  return {
    organisation_id: organisation.organisationId,
    account_id: organisation.accountId,
    kind: organisation.kind,
    status: organisation.status,
    occurred_at: organisation.updatedAt,
    idempotency_key: organisation.idempotencyKey,
  };
}

/** When the membership last moved. The most recent stamp it carries, in lifecycle order. */
function membershipInstant(membership: OrganisationMembership): string {
  return (
    membership.endedAt ?? membership.suspendedAt ?? membership.acceptedAt ?? membership.invitedAt
  );
}

function membershipPayload(membership: OrganisationMembership): Record<string, string> {
  return {
    membership_id: membership.membershipId,
    organisation_id: membership.organisationId,
    person_subject_id: membership.personSubjectId,
    status: membership.status,
    occurred_at: membershipInstant(membership),
    idempotency_key: membership.idempotencyKey,
  };
}

/**
 * Keyed on the caller's **transition** id rather than on the status.
 *
 * A membership genuinely cycles — active, suspended, active again — and so does an organisation.
 * Keying on `id:status` would refuse the second activation as a duplicate outbox row, and the
 * platform would silently stop publishing reinstatements. M-48 had exactly that defect, found by a
 * suspend-then-reactivate test; this module was written with it already known.
 */
export function makeOrganisationEvent(organisation: Organisation, factId: string): OutboxEntry {
  const definition =
    ORGANISATION_EVENT_FOR_STATUS[organisation.status] ?? ORGANISATION_CREATED_EVENT;
  const eventId = `${factId}:${definition.type}`;
  return eventOutboxEntry({
    outboxId: `M-49:${eventId}`,
    idempotencyKey: `M-49:${eventId}`,
    payload: {
      eventId,
      type: definition.type,
      schemaVersion: definition.schemaVersion,
      occurredAt: organisation.updatedAt,
      recordedAt: organisation.updatedAt,
      producer: 'M-49',
      correlationId: organisation.correlationId,
      causationId: null,
      origin: 'system',
      actor: { kind: 'system', id: 'M-49' },
      idempotencyKey: `M-49:${eventId}`,
      now: organisation.updatedAt,
      payload: organisationPayload(organisation),
    },
    occurredAt: organisation.updatedAt,
    recordedAt: organisation.updatedAt,
    producer: 'M-49',
    correlationId: organisation.correlationId,
    causationId: null,
  });
}

export function makeOrganisationAction(
  organisation: Organisation,
  reason: string,
  factId: string,
): OutboxEntry {
  const recordId = `${factId}:${ORGANISATION_ACTION.action}`;
  const outboxId = `M-49:audit:${recordId}`;
  return auditOutboxEntry({
    outboxId,
    idempotencyKey: outboxId,
    payload: {
      recordId,
      action: ORGANISATION_ACTION.action,
      subjectId: organisation.accountId,
      resourceType: 'organisation',
      resourceId: organisation.organisationId,
      occurredAt: organisation.updatedAt,
      recordedAt: organisation.updatedAt,
      actor: { kind: 'system', id: 'M-49' },
      correlationId: organisation.correlationId,
      idempotencyKey: outboxId,
      now: organisation.updatedAt,
      evidence: {
        ...organisationPayload(organisation),
        display_name: organisation.displayName,
        reason,
      },
    },
    recordedAt: organisation.updatedAt,
    producer: 'M-49',
    correlationId: organisation.correlationId,
    causationId: null,
  });
}

export function makeMembershipEvent(
  membership: OrganisationMembership,
  factId: string,
): OutboxEntry {
  const definition = MEMBERSHIP_EVENT_FOR_STATUS[membership.status] ?? MEMBER_INVITED_EVENT;
  const eventId = `${factId}:${definition.type}`;
  const at = membershipInstant(membership);
  return eventOutboxEntry({
    outboxId: `M-49:${eventId}`,
    idempotencyKey: `M-49:${eventId}`,
    payload: {
      eventId,
      type: definition.type,
      schemaVersion: definition.schemaVersion,
      occurredAt: at,
      recordedAt: at,
      producer: 'M-49',
      correlationId: membership.correlationId,
      causationId: null,
      origin: 'system',
      actor: { kind: 'system', id: 'M-49' },
      idempotencyKey: `M-49:${eventId}`,
      now: at,
      payload: membershipPayload(membership),
    },
    occurredAt: at,
    recordedAt: at,
    producer: 'M-49',
    correlationId: membership.correlationId,
    causationId: null,
  });
}

export function makeMembershipAction(
  membership: OrganisationMembership,
  actorSubjectId: string,
  reason: string,
  factId: string,
): OutboxEntry {
  const recordId = `${factId}:${MEMBERSHIP_ACTION.action}`;
  const outboxId = `M-49:audit:${recordId}`;
  const at = membershipInstant(membership);
  return auditOutboxEntry({
    outboxId,
    idempotencyKey: outboxId,
    payload: {
      recordId,
      action: MEMBERSHIP_ACTION.action,
      // The **person**, not the business. K-09's subject is who the record is about, and a
      // membership record is about somebody's place in a company.
      subjectId: membership.personSubjectId,
      resourceType: 'organisation_membership',
      resourceId: membership.membershipId,
      occurredAt: at,
      recordedAt: at,
      actor: { kind: 'system', id: 'M-49' },
      correlationId: membership.correlationId,
      idempotencyKey: outboxId,
      now: at,
      evidence: {
        ...membershipPayload(membership),
        roles: membership.roles.join(','),
        actor_subject_id: actorSubjectId,
        reason,
      },
    },
    recordedAt: at,
    producer: 'M-49',
    correlationId: membership.correlationId,
    causationId: null,
  });
}
