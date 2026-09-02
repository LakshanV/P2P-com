/**
 * M-49 — the immutability boundary.
 *
 * Owned by: M-49 Organisations.
 */

import type {
  MembershipEvent,
  Organisation,
  OrganisationEvent,
  OrganisationMembership,
} from './types.ts';

export function sealOrganisation(organisation: Organisation): Organisation {
  return Object.freeze({ ...organisation });
}

export function sealOrganisations(organisations: readonly Organisation[]): readonly Organisation[] {
  return Object.freeze(organisations.map(sealOrganisation));
}

/**
 * A membership carries a list of roles, so a shallow freeze would hand a caller a frozen wrapper
 * around a mutable list of what somebody may do for a business. Authority read from a mutable array
 * is authority anybody holding the object can widen.
 */
export function sealMembership(membership: OrganisationMembership): OrganisationMembership {
  return Object.freeze({ ...membership, roles: Object.freeze([...membership.roles]) });
}

export function sealMemberships(
  memberships: readonly OrganisationMembership[],
): readonly OrganisationMembership[] {
  return Object.freeze(memberships.map(sealMembership));
}

export function sealMembershipEvent(event: MembershipEvent): MembershipEvent {
  return Object.freeze({ ...event, roles: Object.freeze([...event.roles]) });
}

export function sealMembershipEvents(
  events: readonly MembershipEvent[],
): readonly MembershipEvent[] {
  return Object.freeze(events.map(sealMembershipEvent));
}

export function sealOrganisationEvent(event: OrganisationEvent): OrganisationEvent {
  return Object.freeze({ ...event });
}

export function sealOrganisationEvents(
  events: readonly OrganisationEvent[],
): readonly OrganisationEvent[] {
  return Object.freeze(events.map(sealOrganisationEvent));
}
