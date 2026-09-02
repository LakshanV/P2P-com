/**
 * M-49 Organisations — the public surface.
 *
 * Owned by: M-49 Organisations.
 */

export {
  ACTING_STATUSES,
  MAY_CONFER_OWNERSHIP,
  MAY_INVITE,
  MEMBERSHIP_ROLES,
  MEMBERSHIP_STATUSES,
  MEMBERSHIP_TRANSITIONS,
  ORGANISATION_KINDS,
  ORGANISATION_STATUSES,
  ORGANISATION_TRANSITIONS,
  OrganisationError,
} from './types.ts';
export type {
  MembershipEvent,
  MembershipRole,
  MembershipStatus,
  Organisation,
  OrganisationErrorCode,
  OrganisationEvent,
  OrganisationKind,
  OrganisationMembership,
  OrganisationStatus,
} from './types.ts';

export {
  FOREIGN_FIELDS,
  MAXIMUM_NAME_LENGTH,
  MINIMUM_REASON_LENGTH,
  assertMembershipRole,
  assertMembershipStatus,
  assertName,
  assertOrganisationIdentifier,
  assertOrganisationKind,
  assertOrganisationStatus,
  assertReason,
  assertRoles,
} from './registry.ts';

export {
  STORED_ROW_NOTE,
  validateMembership,
  validateMembershipEvent,
  validateOrganisation,
  validateOrganisationEvent,
} from './validate.ts';
export type { RecordSource } from './validate.ts';

export {
  sealMembership,
  sealMembershipEvent,
  sealMembershipEvents,
  sealMemberships,
  sealOrganisation,
  sealOrganisationEvent,
  sealOrganisationEvents,
  sealOrganisations,
} from './immutable.ts';

export { OrganisationService } from './service.ts';
export type {
  AcceptMembershipRequest,
  ChangeRolesRequest,
  CreateOrganisationRequest,
  InviteMemberRequest,
  MembershipResult,
  MembershipTransitionRequest,
  OrganisationResult,
  OrganisationTransitionRequest,
} from './service.ts';

export { InMemoryOrganisationRepository } from './repository.ts';
export type { OrganisationRepository, OrganisationTransaction } from './repository.ts';

export {
  MEMBERSHIP_ACTION,
  MEMBER_INVITED_EVENT,
  MEMBER_JOINED_EVENT,
  MEMBER_REMOVED_EVENT,
  MEMBER_SUSPENDED_EVENT,
  ORGANISATION_ACTION,
  ORGANISATION_ACTIVATED_EVENT,
  ORGANISATION_CLOSED_EVENT,
  ORGANISATION_CREATED_EVENT,
  ORGANISATION_SUSPENDED_EVENT,
} from './outbox.ts';

export {
  EnlistedOrganisationRepository,
  MEMBERSHIP_EVENT_TABLE,
  MEMBERSHIP_TABLE,
  ORGANISATION_EVENT_TABLE,
  ORGANISATION_SCHEMA,
  ORGANISATION_TABLE,
  PostgresOrganisationRepository,
  toMembership,
  toMembershipEvent,
  toOrganisation,
  toOrganisationEvent,
} from './postgres-repository.ts';
