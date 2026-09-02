/**
 * M-48 — vocabularies, identifier rules and the foreign-field table.
 *
 * Owned by: M-48 Supplier & Merchant Directory.
 */

import { AccountError, assertAccountIdentifier } from '../../kernel/accounts/index.ts';

import {
  DIRECTORY_KINDS,
  DIRECTORY_STATUSES,
  DirectoryError,
  FACET_KINDS,
  FACET_STATUSES,
  type DirectoryErrorCode,
  type DirectoryKind,
  type DirectoryStatus,
  type FacetKind,
  type FacetStatus,
} from './types.ts';

export const IDENTIFIER_REFUSALS: Readonly<Record<string, DirectoryErrorCode>> = Object.freeze({
  'malformed-identifier': 'malformed-identifier',
  'natural-identifier': 'natural-identifier',
  'secret-bearing-input': 'secret-bearing-input',
});

export function assertDirectoryIdentifier(value: unknown, field: string): string {
  try {
    return assertAccountIdentifier(value, field);
  } catch (error) {
    if (!(error instanceof AccountError)) throw error;
    const code = IDENTIFIER_REFUSALS[error.code];
    if (code === undefined) throw error;
    throw new DirectoryError(code, error.message);
  }
}

export function assertDirectoryKind(value: unknown, field: string): DirectoryKind {
  if (typeof value !== 'string' || !(DIRECTORY_KINDS as readonly string[]).includes(value)) {
    throw new DirectoryError(
      'unknown-kind',
      `${field} is "${String(value)}"; expected one of ${DIRECTORY_KINDS.join(', ')}`,
    );
  }
  return value as DirectoryKind;
}

export function assertDirectoryStatus(value: unknown, field: string): DirectoryStatus {
  if (typeof value !== 'string' || !(DIRECTORY_STATUSES as readonly string[]).includes(value)) {
    throw new DirectoryError(
      'unknown-status',
      `${field} is "${String(value)}"; expected one of ${DIRECTORY_STATUSES.join(', ')}`,
    );
  }
  return value as DirectoryStatus;
}

export function assertFacetKind(value: unknown, field: string): FacetKind {
  if (typeof value !== 'string' || !(FACET_KINDS as readonly string[]).includes(value)) {
    throw new DirectoryError(
      'unknown-facet-kind',
      `${field} is "${String(value)}"; expected one of ${FACET_KINDS.join(', ')}`,
    );
  }
  return value as FacetKind;
}

export function assertFacetStatus(value: unknown, field: string): FacetStatus {
  if (typeof value !== 'string' || !(FACET_STATUSES as readonly string[]).includes(value)) {
    throw new DirectoryError(
      'unknown-status',
      `${field} is "${String(value)}"; expected one of ${FACET_STATUSES.join(', ')}`,
    );
  }
  return value as FacetStatus;
}

/** The longest a trading name or a branch name may be. */
export const MAXIMUM_NAME_LENGTH = 200;

/**
 * A public-facing name.
 *
 * The one field in this module held to a length rather than to the opacity rule, because it is
 * meant to be read by a person: "Matale Cement Works" is the point. Bounded because a name field
 * long enough to hold a paragraph is one somebody will paste a paragraph into.
 */
export function assertName(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new DirectoryError('malformed-name', `${field} must be a non-empty name`);
  }
  if (value.length > MAXIMUM_NAME_LENGTH) {
    throw new DirectoryError(
      'malformed-name',
      `${field} is ${String(value.length)} characters; the limit is ` +
        `${String(MAXIMUM_NAME_LENGTH)}. A name field long enough to hold a paragraph will hold one`,
    );
  }
  return value;
}

/**
 * A code a supplier declares: a category, a brand, a capability, a district.
 *
 * **Deliberately not the identifier rule.** That rule requires at least eight characters, because an
 * identity space anybody can enumerate lets them count the platform's parties and address one they
 * were never given. A shared vocabulary is the opposite case: `cement` and `matale` are meant to be
 * enumerable — a buyer picks from a list of them — and forcing them to eight characters would mean
 * inventing padded nonsense for the words the product actually uses.
 *
 * What does still apply is that these travel into tenders and into match explanations, so a code
 * that was somebody's email address or telephone number would publish it into every invitation the
 * supplier ever received. Those are refused here by shape.
 */
const FACET_CODE = /^[a-z0-9][a-z0-9-]{1,63}$/;

export function assertCode(value: unknown, field: string): string {
  if (typeof value !== 'string' || !FACET_CODE.test(value)) {
    throw new DirectoryError(
      'malformed-record',
      `${field} is "${String(value)}"; expected a lower-case code of 2 to 64 characters such as ` +
        '"cement", "opc-43" or "matale"',
    );
  }
  // A code with no letter in it is a number wearing a word's clothes, and the numbers that end up
  // in a field like this are telephone numbers.
  if (!/[a-z]/.test(value)) {
    throw new DirectoryError(
      'malformed-record',
      `${field} is "${value}", which contains no letters. A code is a word; the digits that reach ` +
        'a field like this are telephone numbers, and this one would travel into every invitation',
    );
  }
  if (/\d{7,}/.test(value)) {
    throw new DirectoryError(
      'natural-identifier',
      `${field} contains a long run of digits, which is how a telephone number arrives`,
    );
  }
  return value;
}

/** A daily capacity, or null. Non-negative integer; a negative capacity is not a smaller one. */
export function assertCapacity(value: unknown, field: string): bigint | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') {
    if (value < 0n) {
      throw new DirectoryError(
        'malformed-capacity',
        `${field} is negative; a supplier who can take nothing says so by closing`,
      );
    }
    return value;
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  throw new DirectoryError(
    'malformed-capacity',
    `${field} is a ${typeof value}; expected a non-negative whole number of units per day, or null`,
  );
}

export const MINIMUM_REASON_LENGTH = 8;

/**
 * Why a supplier's status changed.
 *
 * Required and bounded below, because a suspended supplier is entitled to know why. "suspended" is
 * not a reason, and a platform that suspends without one is one nobody can appeal to.
 */
export function assertReason(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length < MINIMUM_REASON_LENGTH) {
    throw new DirectoryError(
      'malformed-reason',
      `${field} must say why, in at least ${String(MINIMUM_REASON_LENGTH)} characters. A supplier ` +
        'whose status changed is entitled to a reason, and "suspended" is not one',
    );
  }
  if (value.length > 1000) {
    throw new DirectoryError('malformed-reason', `${field} is longer than 1000 characters`);
  }
  return value;
}

/** Fields belonging to another component. */
export const FOREIGN_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  verified: 'M-02 Capability & Verification decides whether a supplier is verified',
  verificationLevel: 'M-02 Capability & Verification owns the level',
  evidence: 'M-02 Capability & Verification owns verification evidence',

  reliabilityPerMille:
    'a delivery record is computed from what actually happened in M-11, not declared here',
  priorOrders: 'M-11 Orders owns what was actually traded; this module holds only claims',
  rating: 'a rating is derived from completed orders, and a supplier does not state their own',

  listingId: 'M-04 Universal Listing owns supply; the directory says what a supplier deals in',
  quantityAvailable: 'M-04 Universal Listing owns stock; capacity here is a daily ceiling',

  capability: 'M-01 Universal Account owns which roles an account holds — a different thing',
  capabilities: 'M-01 Universal Account owns roles; the facets here are trading capabilities',
  role: 'K-04 Permissions owns roles and grants',
  subjectId: 'K-01 Identity owns the subject; the directory references an account by account id',

  address: 'a precise address is personal data and is not held here; a location carries a district',
  latitude: 'the platform routes on districts, not coordinates',
  longitude: 'the platform routes on districts, not coordinates',
});
