/**
 * M-49 — validation of complete records, wherever they came from.
 *
 * Owned by: M-49 Organisations.
 */

import { formatInstant, InvalidInstantError, parseInstant } from '../../platform/time/instant.ts';

import {
  assertMembershipStatus,
  assertName,
  assertOrganisationIdentifier,
  assertOrganisationKind,
  assertOrganisationStatus,
  assertReason,
  assertRoles,
} from './registry.ts';
import {
  OrganisationError,
  type MembershipEvent,
  type Organisation,
  type OrganisationEvent,
  type OrganisationMembership,
} from './types.ts';

export type RecordSource = 'request' | 'stored row';

export const STORED_ROW_NOTE =
  'A stored row that fails this was not written by this component — refusing it rather than ' +
  'presenting it as a real record';

const STORED_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/;

const ORGANISATION_FIELDS: readonly string[] = [
  'organisationId',
  'accountId',
  'kind',
  'displayName',
  'status',
  'createdAt',
  'updatedAt',
  'closedAt',
  'closureReason',
  'correlationId',
  'idempotencyKey',
];

export function validateOrganisation(candidate: unknown, source: RecordSource): Organisation {
  try {
    const fields = asObject(candidate, 'an organisation', ORGANISATION_FIELDS);
    const status = assertOrganisationStatus(fields.status, 'status');
    const closedAt = optionalInstant(fields.closedAt, 'closedAt', source);

    if ((status === 'closed') !== (closedAt !== null)) {
      throw new OrganisationError(
        'malformed-record',
        `status is ${status} and closedAt is ${closedAt === null ? 'absent' : 'set'}; a closed ` +
          'business records when it closed, and an open one has not closed',
      );
    }

    return {
      organisationId: assertOrganisationIdentifier(fields.organisationId, 'organisationId'),
      accountId: assertOrganisationIdentifier(fields.accountId, 'accountId'),
      kind: assertOrganisationKind(fields.kind, 'kind'),
      displayName: assertName(fields.displayName, 'displayName'),
      status,
      createdAt: checkInstant(fields.createdAt, 'createdAt', source),
      updatedAt: checkInstant(fields.updatedAt, 'updatedAt', source),
      closedAt,
      closureReason:
        fields.closureReason === null || fields.closureReason === undefined
          ? null
          : assertReason(fields.closureReason, 'closureReason'),
      correlationId: assertOrganisationIdentifier(fields.correlationId, 'correlationId'),
      idempotencyKey: assertOrganisationIdentifier(fields.idempotencyKey, 'idempotencyKey'),
    };
  } catch (error) {
    if (source === 'request' || !(error instanceof OrganisationError)) throw error;
    throw new OrganisationError(error.code, `${error.message}. ${STORED_ROW_NOTE}`);
  }
}

const MEMBERSHIP_FIELDS: readonly string[] = [
  'membershipId',
  'organisationId',
  'personSubjectId',
  'personAccountId',
  'roles',
  'status',
  'invitedBy',
  'invitedAt',
  'acceptedAt',
  'suspendedAt',
  'endedAt',
  'correlationId',
  'idempotencyKey',
];

export function validateMembership(
  candidate: unknown,
  source: RecordSource,
): OrganisationMembership {
  try {
    const fields = asObject(candidate, 'a membership', MEMBERSHIP_FIELDS);
    const status = assertMembershipStatus(fields.status, 'status');
    const acceptedAt = optionalInstant(fields.acceptedAt, 'acceptedAt', source);
    const endedAt = optionalInstant(fields.endedAt, 'endedAt', source);

    // An invitation nobody has accepted has no acceptance instant, and a membership that is
    // acting has one. A row disagreeing with itself about that is a row nobody can read.
    if (status === 'invited' && acceptedAt !== null) {
      throw new OrganisationError(
        'malformed-record',
        'status is invited and acceptedAt is set; an invitation nobody accepted has no acceptance',
      );
    }
    if ((status === 'active' || status === 'suspended') && acceptedAt === null) {
      throw new OrganisationError(
        'malformed-record',
        `status is ${status} and acceptedAt is absent; joining a business is something a person ` +
          'agrees to, and the instant they did is part of the record',
      );
    }
    const ended = status === 'revoked' || status === 'left';
    if (ended !== (endedAt !== null)) {
      throw new OrganisationError(
        'malformed-record',
        `status is ${status} and endedAt is ${endedAt === null ? 'absent' : 'set'}`,
      );
    }

    return {
      membershipId: assertOrganisationIdentifier(fields.membershipId, 'membershipId'),
      organisationId: assertOrganisationIdentifier(fields.organisationId, 'organisationId'),
      personSubjectId: assertOrganisationIdentifier(fields.personSubjectId, 'personSubjectId'),
      personAccountId: assertOrganisationIdentifier(fields.personAccountId, 'personAccountId'),
      roles: assertRoles(fields.roles, 'roles'),
      status,
      invitedBy:
        fields.invitedBy === null || fields.invitedBy === undefined
          ? null
          : assertOrganisationIdentifier(fields.invitedBy, 'invitedBy'),
      invitedAt: checkInstant(fields.invitedAt, 'invitedAt', source),
      acceptedAt,
      suspendedAt: optionalInstant(fields.suspendedAt, 'suspendedAt', source),
      endedAt,
      correlationId: assertOrganisationIdentifier(fields.correlationId, 'correlationId'),
      idempotencyKey: assertOrganisationIdentifier(fields.idempotencyKey, 'idempotencyKey'),
    };
  } catch (error) {
    if (source === 'request' || !(error instanceof OrganisationError)) throw error;
    throw new OrganisationError(error.code, `${error.message}. ${STORED_ROW_NOTE}`);
  }
}

const MEMBERSHIP_EVENT_FIELDS: readonly string[] = [
  'eventId',
  'membershipId',
  'organisationId',
  'fromStatus',
  'toStatus',
  'roles',
  'actorSubjectId',
  'reason',
  'occurredAt',
  'correlationId',
  'idempotencyKey',
];

export function validateMembershipEvent(candidate: unknown, source: RecordSource): MembershipEvent {
  try {
    const fields = asObject(candidate, 'a membership event', MEMBERSHIP_EVENT_FIELDS);
    return {
      eventId: assertOrganisationIdentifier(fields.eventId, 'eventId'),
      membershipId: assertOrganisationIdentifier(fields.membershipId, 'membershipId'),
      organisationId: assertOrganisationIdentifier(fields.organisationId, 'organisationId'),
      fromStatus:
        fields.fromStatus === null || fields.fromStatus === undefined
          ? null
          : assertMembershipStatus(fields.fromStatus, 'fromStatus'),
      toStatus: assertMembershipStatus(fields.toStatus, 'toStatus'),
      roles: assertRoles(fields.roles, 'roles'),
      actorSubjectId: assertOrganisationIdentifier(fields.actorSubjectId, 'actorSubjectId'),
      reason: assertReason(fields.reason, 'reason'),
      occurredAt: checkInstant(fields.occurredAt, 'occurredAt', source),
      correlationId: assertOrganisationIdentifier(fields.correlationId, 'correlationId'),
      idempotencyKey: assertOrganisationIdentifier(fields.idempotencyKey, 'idempotencyKey'),
    };
  } catch (error) {
    if (source === 'request' || !(error instanceof OrganisationError)) throw error;
    throw new OrganisationError(error.code, `${error.message}. ${STORED_ROW_NOTE}`);
  }
}

const ORGANISATION_EVENT_FIELDS: readonly string[] = [
  'eventId',
  'organisationId',
  'fromStatus',
  'toStatus',
  'reason',
  'occurredAt',
  'correlationId',
  'idempotencyKey',
];

export function validateOrganisationEvent(
  candidate: unknown,
  source: RecordSource,
): OrganisationEvent {
  try {
    const fields = asObject(candidate, 'an organisation event', ORGANISATION_EVENT_FIELDS);
    return {
      eventId: assertOrganisationIdentifier(fields.eventId, 'eventId'),
      organisationId: assertOrganisationIdentifier(fields.organisationId, 'organisationId'),
      fromStatus:
        fields.fromStatus === null || fields.fromStatus === undefined
          ? null
          : assertOrganisationStatus(fields.fromStatus, 'fromStatus'),
      toStatus: assertOrganisationStatus(fields.toStatus, 'toStatus'),
      reason: assertReason(fields.reason, 'reason'),
      occurredAt: checkInstant(fields.occurredAt, 'occurredAt', source),
      correlationId: assertOrganisationIdentifier(fields.correlationId, 'correlationId'),
      idempotencyKey: assertOrganisationIdentifier(fields.idempotencyKey, 'idempotencyKey'),
    };
  } catch (error) {
    if (source === 'request' || !(error instanceof OrganisationError)) throw error;
    throw new OrganisationError(error.code, `${error.message}. ${STORED_ROW_NOTE}`);
  }
}

function asObject(
  candidate: unknown,
  what: string,
  permitted: readonly string[],
): Record<string, unknown> {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new OrganisationError(
      'malformed-record',
      `${what} must be an object, got ${candidate === null ? 'null' : typeof candidate}`,
    );
  }
  for (const key of Object.keys(candidate)) {
    if (!permitted.includes(key)) {
      throw new OrganisationError(
        'malformed-record',
        `${what} carried the unrecognised field "${key}"; the permitted fields are ` +
          permitted.join(', '),
      );
    }
  }
  return candidate as Record<string, unknown>;
}

function optionalInstant(value: unknown, field: string, source: RecordSource): string | null {
  return value === null || value === undefined ? null : checkInstant(value, field, source);
}

function checkInstant(value: unknown, field: string, source: RecordSource): string {
  if (source === 'stored row') {
    if (typeof value !== 'string') {
      throw new OrganisationError(
        'malformed-record',
        `${field} came back as ${value instanceof Date ? 'a Date' : typeof value} rather than ` +
          'text. Timestamps are projected through to_char precisely so the driver never parses them',
      );
    }
    if (STORED_INSTANT.exec(value) === null) {
      throw new OrganisationError(
        'malformed-record',
        `${field} holds "${value}", which is not a finite UTC timestamp in the projected form`,
      );
    }
    try {
      return formatInstant(parseInstant(value).epochMicros);
    } catch (error) {
      if (error instanceof InvalidInstantError) {
        throw new OrganisationError('malformed-record', `${field}: ${error.message}`);
      }
      throw error;
    }
  }

  if (typeof value !== 'string') {
    throw new OrganisationError(
      'malformed-instant',
      `${field} is ${value === null ? 'null' : typeof value}; expected a UTC instant string`,
    );
  }
  try {
    return parseInstant(value).source;
  } catch (error) {
    if (error instanceof InvalidInstantError) {
      throw new OrganisationError('malformed-instant', `${field}: ${error.message}`);
    }
    throw error;
  }
}
