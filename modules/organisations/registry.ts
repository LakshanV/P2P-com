/**
 * M-49 — vocabularies, identifier rules and the foreign-field table.
 *
 * Owned by: M-49 Organisations.
 */

import { AccountError, assertAccountIdentifier } from '../../kernel/accounts/index.ts';

import {
  MEMBERSHIP_ROLES,
  MEMBERSHIP_STATUSES,
  ORGANISATION_KINDS,
  ORGANISATION_STATUSES,
  OrganisationError,
  type MembershipRole,
  type MembershipStatus,
  type OrganisationErrorCode,
  type OrganisationKind,
  type OrganisationStatus,
} from './types.ts';

const IDENTIFIER_REFUSALS: Readonly<Record<string, OrganisationErrorCode>> = Object.freeze({
  'malformed-identifier': 'malformed-identifier',
  'natural-identifier': 'natural-identifier',
  'secret-bearing-input': 'secret-bearing-input',
});

export function assertOrganisationIdentifier(value: unknown, field: string): string {
  try {
    return assertAccountIdentifier(value, field);
  } catch (error) {
    if (!(error instanceof AccountError)) throw error;
    const code = IDENTIFIER_REFUSALS[error.code];
    if (code === undefined) throw error;
    throw new OrganisationError(code, error.message);
  }
}

export function assertOrganisationKind(value: unknown, field: string): OrganisationKind {
  if (typeof value !== 'string' || !(ORGANISATION_KINDS as readonly string[]).includes(value)) {
    throw new OrganisationError(
      'unknown-kind',
      `${field} is "${String(value)}"; expected one of ${ORGANISATION_KINDS.join(', ')}`,
    );
  }
  return value as OrganisationKind;
}

export function assertOrganisationStatus(value: unknown, field: string): OrganisationStatus {
  if (typeof value !== 'string' || !(ORGANISATION_STATUSES as readonly string[]).includes(value)) {
    throw new OrganisationError(
      'unknown-status',
      `${field} is "${String(value)}"; expected one of ${ORGANISATION_STATUSES.join(', ')}`,
    );
  }
  return value as OrganisationStatus;
}

export function assertMembershipStatus(value: unknown, field: string): MembershipStatus {
  if (typeof value !== 'string' || !(MEMBERSHIP_STATUSES as readonly string[]).includes(value)) {
    throw new OrganisationError(
      'unknown-status',
      `${field} is "${String(value)}"; expected one of ${MEMBERSHIP_STATUSES.join(', ')}`,
    );
  }
  return value as MembershipStatus;
}

export function assertMembershipRole(value: unknown, field: string): MembershipRole {
  if (typeof value !== 'string' || !(MEMBERSHIP_ROLES as readonly string[]).includes(value)) {
    throw new OrganisationError(
      'unknown-role',
      `${field} is "${String(value)}"; expected one of ${MEMBERSHIP_ROLES.join(', ')}`,
    );
  }
  return value as MembershipRole;
}

/**
 * The roles one membership holds.
 *
 * At least one, because a membership that permits nothing is a membership somebody holds without
 * being able to do anything — which reads to them as a platform that is broken rather than as a
 * decision anybody made. Deduplicated and ordered by the vocabulary, so two memberships with the
 * same roles compare equal however the caller listed them, which is what makes a retry converge.
 */
export function assertRoles(value: unknown, field: string): readonly MembershipRole[] {
  if (!Array.isArray(value)) {
    throw new OrganisationError(
      'malformed-record',
      `${field} must be an array of roles, got ${value === null ? 'null' : typeof value}`,
    );
  }
  const roles = value.map((entry, index) => assertMembershipRole(entry, `${field}[${index}]`));
  if (roles.length === 0) {
    throw new OrganisationError(
      'no-roles',
      `${field} is empty. A membership that permits nothing is one nobody should hold: say what ` +
        'the person does, or do not invite them',
    );
  }
  const unique = [...new Set(roles)];
  return Object.freeze(
    unique.sort((left, right) => MEMBERSHIP_ROLES.indexOf(left) - MEMBERSHIP_ROLES.indexOf(right)),
  );
}

export const MAXIMUM_NAME_LENGTH = 200;

/** What a business trades as. Bounded, for the reason every bounded name field here is bounded. */
export function assertName(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new OrganisationError('malformed-name', `${field} must be a non-empty name`);
  }
  if (value.length > MAXIMUM_NAME_LENGTH) {
    throw new OrganisationError(
      'malformed-name',
      `${field} is ${String(value.length)} characters; the limit is ` +
        `${String(MAXIMUM_NAME_LENGTH)}. A name field long enough to hold a paragraph will hold one`,
    );
  }
  return value;
}

export const MINIMUM_REASON_LENGTH = 8;

/**
 * Why something changed.
 *
 * Required and bounded below, because the person on the other end of a suspension or a removal is
 * entitled to know why. "removed" is not a reason, and a business that removes people without one
 * is one nobody can argue with.
 */
export function assertReason(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length < MINIMUM_REASON_LENGTH) {
    throw new OrganisationError(
      'malformed-reason',
      `${field} must say why, in at least ${String(MINIMUM_REASON_LENGTH)} characters. Somebody ` +
        'whose place in a business changed is entitled to a reason, and "removed" is not one',
    );
  }
  if (value.length > 1000) {
    throw new OrganisationError('malformed-reason', `${field} is longer than 1000 characters`);
  }
  return value;
}

/** Fields belonging to another component. */
export const FOREIGN_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  verified: 'M-02 Capability & Verification decides whether a business is verified',
  verificationLevel: 'M-02 Capability & Verification owns the level',
  evidence: 'M-02 Capability & Verification owns verification evidence',

  categories: 'M-48 Supplier & Merchant Directory owns what a business deals in',
  brands: 'M-48 Supplier & Merchant Directory owns what a business deals in',
  districts: 'M-48 Supplier & Merchant Directory owns where a business serves',
  acceptsOrders: 'M-48 owns market presence; this module owns the business and who acts for it',

  listingId: 'M-04 Universal Listing owns supply',
  balance: 'K-10 derives every balance; nothing here holds one',
  rating: 'a rating is derived from completed orders, and a business does not state its own',

  password: 'K-02 Authentication owns credentials, and holds them as a hash it never returns',
  token: 'K-02 Authentication owns sessions',
  grants: 'K-04 Permissions owns authority. A membership is what a grant is made *from*',
  permissions: 'K-04 Permissions owns authority',

  email: 'no component stores an email address; a contact channel is recorded with its consent',
  phone: 'no component stores a telephone number',
  address: 'an address is not held here; a directory location carries a district',
});
