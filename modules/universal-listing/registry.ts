/**
 * M-04 Universal Listing — slice A constants, identifier rules and foreign-field table.
 *
 * Identifier rules are delegated to K-03 Accounts, because every listing references a universal
 * account by id. Using K-03's rule set means an id that would be refused at account creation is also
 * refused here, in M-04's vocabulary.
 *
 * The foreign-field table is the boundary of M-04. A listing record carries only what this module
 * owns; anything else is refused by name.
 *
 * Owned by: M-04 Universal Listing.
 */

import { AccountError, assertAccountIdentifier } from '../../kernel/accounts/index.ts';

import {
  DECLARATION_KINDS,
  LISTING_STATUSES,
  MEDIA_KINDS,
  MOVEMENT_KINDS,
  UniversalListingError,
  type DeclarationKind,
  type ListingStatus,
  type MediaKind,
  type MovementKind,
  type UniversalListingErrorCode,
} from './types.ts';

export type {
  DeclarationKind,
  ListingStatus,
  MediaKind,
  MovementKind,
  UniversalListingErrorCode,
} from './types.ts';

/**
 * K-03's identifier refusals, in this module's vocabulary.
 *
 * The mapping is total over what `assertAccountIdentifier` can raise.
 */
export const IDENTIFIER_REFUSALS: Readonly<Record<string, UniversalListingErrorCode>> =
  Object.freeze({
    'malformed-identifier': 'malformed-identifier',
    'natural-identifier': 'natural-identifier',
    'secret-bearing-input': 'secret-bearing-input',
  });

/**
 * Refuse an identifier that is malformed, natural, or a credential.
 *
 * M-04 identifiers are opaque handles supplied by the caller. The same rules apply to listing ids,
 * version ids, media ids, declaration ids, account ids, idempotency keys and correlation ids.
 */
export function assertUniversalListingIdentifier(value: unknown, field: string): string {
  try {
    return assertAccountIdentifier(value, field);
  } catch (error) {
    if (!(error instanceof AccountError)) throw error;
    const code = IDENTIFIER_REFUSALS[error.code];
    if (code === undefined) throw error;
    throw new UniversalListingError(code, error.message);
  }
}

/**
 * Refuse a listing status that is not one M-04 recognises.
 */
export function assertListingStatus(value: unknown, field: string): ListingStatus {
  if (typeof value !== 'string' || !(LISTING_STATUSES as readonly string[]).includes(value)) {
    throw new UniversalListingError(
      'unknown-status',
      `${field} is "${String(value)}"; expected one of ${LISTING_STATUSES.join(', ')}`,
    );
  }
  return value as ListingStatus;
}

/**
 * Refuse a media kind that is not one M-04 recognises.
 */
export function assertMediaKind(value: unknown, field: string): MediaKind {
  if (typeof value !== 'string' || !(MEDIA_KINDS as readonly string[]).includes(value)) {
    throw new UniversalListingError(
      'unknown-media-kind',
      `${field} is "${String(value)}"; expected one of ${MEDIA_KINDS.join(', ')}`,
    );
  }
  return value as MediaKind;
}

/**
 * Refuse a declaration kind that is not one M-04 recognises.
 */
export function assertDeclarationKind(value: unknown, field: string): DeclarationKind {
  if (typeof value !== 'string' || !(DECLARATION_KINDS as readonly string[]).includes(value)) {
    throw new UniversalListingError(
      'unknown-declaration-kind',
      `${field} is "${String(value)}"; expected one of ${DECLARATION_KINDS.join(', ')}`,
    );
  }
  return value as DeclarationKind;
}

/**
 * Refuse an inventory movement kind that is not one M-04 recognises.
 */
export function assertMovementKind(value: unknown, field: string): MovementKind {
  if (typeof value !== 'string' || !(MOVEMENT_KINDS as readonly string[]).includes(value)) {
    throw new UniversalListingError(
      'unknown-movement-kind',
      `${field} is "${String(value)}"; expected one of ${MOVEMENT_KINDS.join(', ')}`,
    );
  }
  return value as MovementKind;
}

/**
 * Fields that belong to another component, with the component named.
 *
 * A listing record carries only what M-04 owns. A request carrying a field belonging to another unit
 * is refused by name because it is modelling the thing wrongly, not making a typo. M-04 stores no
 * artefact content, no credential and no monetary field beyond the price this version carries.
 */
export const FOREIGN_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  // M-01 Universal Account owns which roles an account holds.
  capability: 'M-01 Universal Account owns which capabilities an account holds',
  capabilities: 'M-01 Universal Account owns which capabilities an account holds',

  // M-02 Capability & Verification owns verification levels.
  verificationLevel: 'M-02 Capability & Verification owns verification level',
  verified: 'M-02 Capability & Verification owns verification level',

  // K-01 Identity owns the party.
  subjectId: 'K-01 Identity owns the subject; a listing references an account by account id',
  personKind: 'K-01 Identity owns what kind of party a subject is',
  subjectKind: 'K-01 Identity owns what kind of party a subject is',

  // K-02 Authentication owns everything about proving who is calling.
  password: 'K-02 Authentication owns credentials',
  passwordHash: 'K-02 Authentication owns credentials',
  credential: 'K-02 Authentication owns credentials',
  mfa: 'K-02 Authentication owns second factors',
  sessionId: 'K-02 Authentication owns sessions; nothing has authenticated anybody yet',
  session: 'K-02 Authentication owns sessions',
  token: 'K-02 Authentication owns tokens',
  authenticated: 'K-02 Authentication decides that, and does not exist yet',

  // K-03 Accounts owns the universal account; M-04 only references it by id.
  account: 'K-03 Accounts owns the universal account; a listing references one by id',
  origin: 'K-03 Accounts owns the provenance of an account creation, not a listing',

  // K-04 Permissions owns who may do what.
  role: 'K-04 Permissions owns roles and grants',
  roles: 'K-04 Permissions owns roles and grants',
  permissions: 'K-04 Permissions owns permission evaluation',
  grants: 'K-04 Permissions owns grants',

  // K-10 Ledger Foundation owns every amount other than the price this version names.
  balance: 'K-10 Ledger Foundation is the authority on every amount',
  balances: 'K-10 Ledger Foundation is the authority on every amount',
  amount: 'K-10 Ledger Foundation is the authority on every amount',
  ledgerAccountId: 'K-10 Ledger Foundation owns ledger accounts; a listing does not embed one',

  // L3+ order and payment modules are not built yet; name the owner they will have.
  orderId: 'M-11 Orders will own orders; a listing does not embed one',
  paymentId: 'M-12 Payments will own payments; a listing does not embed one',
  quoteId: 'M-10 Quotes will own quotes; a listing does not embed one',

  // Document-content fields: M-04 stores an opaque reference, never the artefact.
  mediaBlob: 'M-04 stores an opaque reference to a media artefact, not the artefact itself',
  imageData: 'M-04 stores an opaque reference to an image, not the image itself',
  documentBody: 'M-04 stores an opaque reference to a document, not the document itself',

  // Profile and contact fields belong elsewhere.
  email: 'email belongs to the account profile core, not to listing ownership',
  phone: 'phone belongs to the account profile core, not to listing ownership',

  // Lifecycle fields M-04 computes rather than accepts.
  status: 'M-04 computes the listing status from its lifecycle operations',
  currentVersion: 'M-04 computes the current version from publish operations',
  publishedAt: 'M-04 sets publishedAt on first publish',
  withdrawnAt: 'M-04 sets withdrawnAt on withdrawal',
});
