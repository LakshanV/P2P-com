/**
 * M-02 Capability & Verification — constants, identifier rules and foreign-field table.
 *
 * Identifier rules are delegated to K-03 Accounts, because every verification case references a
 * universal account by id. Using K-03's rule set means an account id that would be refused at
 * creation is also refused here, in M-02's vocabulary.
 *
 * The foreign-field table is the boundary of M-02. A verification record carries only what this
 * module owns; anything else is refused by name.
 *
 * Owned by: M-02 Capability & Verification.
 */

import { AccountError, assertAccountIdentifier } from '../../kernel/accounts/index.ts';

import {
  CASE_STATUSES,
  EVIDENCE_KINDS,
  EVIDENCE_STATUSES,
  VERIFICATION_LEVELS,
  CapabilityVerificationError,
  type CapabilityVerificationErrorCode,
  type CaseStatus,
  type EvidenceKind,
  type EvidenceStatus,
  type VerificationLevel,
} from './types.ts';

export type {
  CaseStatus,
  EvidenceKind,
  EvidenceStatus,
  VerificationLevel,
  CapabilityVerificationErrorCode,
} from './types.ts';

/**
 * K-03's identifier refusals, in this module's vocabulary.
 *
 * The mapping is total over what `assertAccountIdentifier` can raise, and the M-02 tests assert
 * that: a new K-03 refusal code must be given an M-02 meaning rather than escaping as an
 * `AccountError` from a call the caller never made.
 */
export const IDENTIFIER_REFUSALS: Readonly<Record<string, CapabilityVerificationErrorCode>> =
  Object.freeze({
    'malformed-identifier': 'malformed-identifier',
    'natural-identifier': 'natural-identifier',
    'secret-bearing-input': 'secret-bearing-input',
  });

/**
 * Refuse an identifier that is malformed, natural, or a credential.
 *
 * M-02 identifiers are opaque handles supplied by the caller. The same rules apply to case ids,
 * evidence ids, record ids, account ids, idempotency keys and correlation ids.
 */
export function assertCapabilityVerificationIdentifier(value: unknown, field: string): string {
  try {
    return assertAccountIdentifier(value, field);
  } catch (error) {
    if (!(error instanceof AccountError)) throw error;
    const code = IDENTIFIER_REFUSALS[error.code];
    if (code === undefined) throw error;
    throw new CapabilityVerificationError(code, error.message);
  }
}

/**
 * Refuse a verification level that is not one M-02 recognises.
 */
export function assertVerificationLevel(value: unknown, field: string): VerificationLevel {
  if (typeof value !== 'string' || !(VERIFICATION_LEVELS as readonly string[]).includes(value)) {
    throw new CapabilityVerificationError(
      'unknown-level',
      `${field} is "${String(value)}"; expected one of ${VERIFICATION_LEVELS.join(', ')}`,
    );
  }
  return value as VerificationLevel;
}

/**
 * Refuse a case status that is not one M-02 recognises.
 */
export function assertCaseStatus(value: unknown, field: string): CaseStatus {
  if (typeof value !== 'string' || !(CASE_STATUSES as readonly string[]).includes(value)) {
    throw new CapabilityVerificationError(
      'unknown-status',
      `${field} is "${String(value)}"; expected one of ${CASE_STATUSES.join(', ')}`,
    );
  }
  return value as CaseStatus;
}

/**
 * Refuse an evidence kind that is not one M-02 recognises.
 */
export function assertEvidenceKind(value: unknown, field: string): EvidenceKind {
  if (typeof value !== 'string' || !(EVIDENCE_KINDS as readonly string[]).includes(value)) {
    throw new CapabilityVerificationError(
      'unknown-evidence-kind',
      `${field} is "${String(value)}"; expected one of ${EVIDENCE_KINDS.join(', ')}`,
    );
  }
  return value as EvidenceKind;
}

/**
 * Refuse an evidence status that is not one M-02 recognises.
 */
export function assertEvidenceStatus(value: unknown, field: string): EvidenceStatus {
  if (typeof value !== 'string' || !(EVIDENCE_STATUSES as readonly string[]).includes(value)) {
    throw new CapabilityVerificationError(
      'unknown-evidence-status',
      `${field} is "${String(value)}"; expected one of ${EVIDENCE_STATUSES.join(', ')}`,
    );
  }
  return value as EvidenceStatus;
}

/**
 * Fields that belong to another component, with the component named.
 *
 * A verification record carries only what M-02 owns. A request carrying a field belonging to another
 * unit is refused by name because it is modelling the thing wrongly, not making a typo. M-02 stores
 * no document content, no credential and no monetary field; those refusals are the most important.
 */
export const FOREIGN_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  // M-01 Universal Account owns which roles an account holds.
  capability: 'M-01 Universal Account owns which capabilities an account holds',
  capabilities: 'M-01 Universal Account owns which capabilities an account holds',

  // K-01 Identity owns the party.
  subjectId:
    'K-01 Identity owns the subject; a verification case references an account by account id',
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

  // K-03 Accounts owns the universal account; M-02 only references it by id.
  account: 'K-03 Accounts owns the universal account; a verification case references one by id',
  origin: 'K-03 Accounts owns the provenance of an account creation, not a verification case',

  // K-04 Permissions owns who may do what.
  role: 'K-04 Permissions owns roles and grants',
  roles: 'K-04 Permissions owns roles and grants',
  permissions: 'K-04 Permissions owns permission evaluation',
  grants: 'K-04 Permissions owns grants',

  // K-10 Ledger Foundation owns every amount.
  balance: 'K-10 Ledger Foundation is the authority on every amount',
  balances: 'K-10 Ledger Foundation is the authority on every amount',
  currency: 'K-10 Ledger Foundation owns monetary representation',
  amount: 'K-10 Ledger Foundation is the authority on every amount',
  ledgerAccountId:
    'K-10 Ledger Foundation owns ledger accounts; a verification case does not embed one',

  // Profile and contact fields belong elsewhere.
  email: 'email belongs to the account profile core, not to verification ownership',
  phone: 'phone belongs to the account profile core, not to verification ownership',

  // Document-content fields: M-02 stores an opaque reference, never the artefact.
  taxNumber: 'M-02 stores an opaque reference to a tax identifier, not the number itself',
  nationalId: 'M-02 stores an opaque reference to an identity document, not the number itself',
  passportNumber: 'M-02 stores an opaque reference to a passport, not the number itself',
  bankAccountNumber: 'M-02 stores an opaque reference to a bank account, not the number itself',
  documentImage: 'M-02 stores an opaque reference to a document image, not the image itself',
});
