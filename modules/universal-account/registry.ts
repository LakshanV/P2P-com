/**
 * M-01 Universal Account — constants, identifier rules and foreign-field table.
 *
 * Identifier rules are delegated to K-03 Accounts, because every capability references a universal
 * account by id. Using K-03's rule set means an account id that would be refused at creation is also
 * refused here, in M-01's vocabulary.
 *
 * The foreign-field table is the boundary of M-01. A capability record carries only what this
 * module owns; anything else is refused by name.
 *
 * Owned by: M-01 Universal Account.
 */

import { AccountError, assertAccountIdentifier } from '../../kernel/accounts/index.ts';

import {
  CAPABILITIES,
  CAPABILITY_STATUSES,
  UniversalAccountError,
  type Capability,
  type CapabilityStatus,
  type UniversalAccountErrorCode,
} from './types.ts';

export type { Capability, CapabilityStatus, UniversalAccountErrorCode } from './types.ts';

/**
 * K-03's identifier refusals, in this module's vocabulary.
 *
 * The mapping is total over what `assertAccountIdentifier` can raise, and the M-01 tests assert
 * that: a new K-03 refusal code must be given an M-01 meaning rather than escaping as an
 * `AccountError` from a call the caller never made.
 */
export const IDENTIFIER_REFUSALS: Readonly<Record<string, UniversalAccountErrorCode>> =
  Object.freeze({
    'malformed-identifier': 'malformed-identifier',
    'natural-identifier': 'natural-identifier',
    'secret-bearing-input': 'secret-bearing-input',
  });

/**
 * Refuse an identifier that is malformed, natural, or a credential.
 *
 * M-01 identifiers are opaque handles supplied by the caller. The same rules apply to capability
 * ids, state ids, account ids and idempotency keys.
 */
export function assertUniversalAccountIdentifier(value: unknown, field: string): string {
  try {
    return assertAccountIdentifier(value, field);
  } catch (error) {
    if (!(error instanceof AccountError)) throw error;
    const code = IDENTIFIER_REFUSALS[error.code];
    if (code === undefined) throw error;
    throw new UniversalAccountError(code, error.message);
  }
}

/**
 * Refuse a capability that is not one M-01 recognises.
 *
 * Capability names are the module's shared vocabulary for roles; they must be readable in code and
 * queries and are not opaque identifiers.
 */
export function assertCapability(value: unknown, field: string): Capability {
  if (typeof value !== 'string' || !(CAPABILITIES as readonly string[]).includes(value)) {
    throw new UniversalAccountError(
      'unknown-capability',
      `${field} is "${String(value)}"; expected one of ${CAPABILITIES.join(', ')}`,
    );
  }
  return value as Capability;
}

/**
 * Refuse a status that is not one M-01 recognises.
 */
export function assertStatus(value: unknown, field: string): CapabilityStatus {
  if (typeof value !== 'string' || !(CAPABILITY_STATUSES as readonly string[]).includes(value)) {
    throw new UniversalAccountError(
      'unknown-status',
      `${field} is "${String(value)}"; expected one of ${CAPABILITY_STATUSES.join(', ')}`,
    );
  }
  return value as CapabilityStatus;
}

/**
 * Fields that belong to another component, with the component named.
 *
 * A capability record carries only what M-01 owns. A request carrying a field belonging to another
 * unit is refused by name because it is modelling the thing wrongly, not making a typo.
 */
export const FOREIGN_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  // K-01 Identity owns the party.
  subjectId: 'K-01 Identity owns the subject; a capability references an account by account id',
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

  // K-03 Accounts owns the universal account; M-01 only references it by id.
  account: 'K-03 Accounts owns the universal account; a capability references one by id',
  origin: 'K-03 Accounts owns the provenance of an account creation, not a capability',

  // K-04 Permissions owns who may do what.
  roles: 'K-04 Permissions owns roles and grants',
  role: 'K-04 Permissions owns roles and grants',
  permissions: 'K-04 Permissions owns permission evaluation',
  grants: 'K-04 Permissions owns grants',

  // K-10 Ledger Foundation owns every amount.
  balance: 'K-10 Ledger foundation is the authority on every amount',
  balances: 'K-10 Ledger foundation is the authority on every amount',
  currency: 'K-10 Ledger foundation owns monetary representation',
  amount: 'K-10 Ledger foundation is the authority on every amount',
  ledgerAccountId: 'K-10 Ledger foundation owns ledger accounts; a capability does not embed one',

  // M-02 Capability & Verification owns verification levels.
  verificationLevel: 'M-02 Capability & Verification owns verification levels, not M-01',

  // Profile and contact fields belong elsewhere.
  email: 'email belongs to the account profile core, not to capability ownership',
  phone: 'phone belongs to the account profile core, not to capability ownership',

  // Lifecycle fields this module computes from the operation, not from the request.
  status: 'M-01 owns the capability lifecycle; this field is refused on activation requests',
  state: 'M-01 owns the capability lifecycle; this field is refused on activation requests',
  deactivatedAt: 'M-01 sets this when a capability is deactivated',
});
