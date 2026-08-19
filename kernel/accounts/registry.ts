/**
 * K-03 Accounts — the foreign-field table and the identifier rules (FND-004b).
 *
 * **Identifier rules are K-01's, not a copy of them.** An account id is written into every order,
 * payment, ledger entry and audit record that ever references the account, exactly as a subject id
 * is, so the rule about what an identifier may be is the same rule — and a fourth copy of it would
 * be a fourth thing to keep in step. `assertOpaqueIdentifier` is imported from K-01 and its refusal
 * is re-raised in this component's vocabulary, so a caller who passes an email as an `accountId`
 * gets an `AccountError` naming `accountId` rather than an `IdentityError` from a component it
 * never called.
 *
 * K-03 depends on K-01 by declaration (MODULE_MAP §3), so this is the dependency being used rather
 * than a new one being introduced.
 *
 * **The foreign-field table is the "one universal account" rule made executable.** Every entry is
 * something a reasonable person would try to put on an account, with the component that actually
 * owns it. The refusal names the owner, because a caller passing `capabilities` is not making a
 * typo — it is modelling the thing wrongly, and silently dropping the field would leave it
 * believing a seller capability had been activated.
 *
 * Owned by: K-03 Accounts.
 */

import { IdentityError, assertOpaqueIdentifier } from '../identity/index.ts';

import { AccountError, type AccountErrorCode } from './types.ts';

/**
 * K-01's identifier refusals, in this component's vocabulary.
 *
 * The mapping is total over what `assertOpaqueIdentifier` can raise, and `tests/accounts.test.ts`
 * asserts that: a new K-01 refusal code must be given a K-03 meaning rather than escaping as an
 * `IdentityError` from a call the caller never made.
 */
export const IDENTITY_REFUSALS: Readonly<Record<string, AccountErrorCode>> = Object.freeze({
  'malformed-identifier': 'malformed-identifier',
  'natural-identifier': 'natural-identifier',
  'secret-bearing-input': 'secret-bearing-input',
});

/**
 * Refuse an identifier that is malformed, natural, or a credential.
 *
 * One rule set, K-01's, applied to K-03's identifiers. An `IdentityError` this cannot translate is
 * rethrown unchanged rather than mislabelled — an error that lies about its own cause is worse than
 * one that names an unexpected component.
 */
export function assertAccountIdentifier(value: unknown, field: string): string {
  try {
    return assertOpaqueIdentifier(value, field);
  } catch (error) {
    if (!(error instanceof IdentityError)) throw error;
    const code = IDENTITY_REFUSALS[error.code];
    if (code === undefined) throw error;
    throw new AccountError(code, error.message);
  }
}

/**
 * Fields that belong to another component, with the component named.
 *
 * Grouped by why they are absent, because the reasons differ and a reader deciding where to put a
 * new field needs the reason rather than the list.
 */
export const FOREIGN_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  // K-01 owns the party. The account references a subject; it does not describe one.
  subjectKind: 'K-01 Identity owns what kind of party a subject is',
  personKind: 'K-01 Identity owns what kind of party a subject is',
  subject: 'K-01 Identity owns the subject; an account links to one by id and does not embed it',

  // K-02 owns everything about proving who is calling.
  password: 'K-02 Authentication owns credentials',
  passwordHash: 'K-02 Authentication owns credentials',
  credential: 'K-02 Authentication owns credentials',
  mfa: 'K-02 Authentication owns second factors',
  sessionId: 'K-02 Authentication owns sessions; nothing has authenticated anybody yet',
  session: 'K-02 Authentication owns sessions',
  token: 'K-02 Authentication owns tokens',
  lastLoginAt: 'K-02 Authentication owns sessions, and this component records no activity',

  // K-04 owns who may do what.
  roles: 'K-04 Permissions owns roles and grants',
  role: 'K-04 Permissions owns roles and grants',
  permissions: 'K-04 Permissions owns permission evaluation',
  grants: 'K-04 Permissions owns grants',

  // Capabilities are the whole point of the one-account rule, and they are not stored here.
  capabilities: 'the Capability & Verification module owns capability activation',
  capability: 'the Capability & Verification module owns capability activation',
  persona: 'a persona is a capability of an account, activated when the party needs it',
  isSeller: 'selling is a capability, not a property of the account (guide §4)',
  isBuyer: 'buying is a capability, not a property of the account (guide §4)',
  isHost: 'hosting is a capability, not a property of the account (guide §4)',
  accountType: 'an account has no type; capabilities are what differ between parties',
  sellerProfile: 'the Seller modules own seller state',
  buyerProfile: 'the Cockpit modules own buyer state',

  // Verification is a level a capability requires, decided elsewhere.
  verified: 'the Capability & Verification module owns verification level',
  verificationLevel: 'the Capability & Verification module owns verification level',
  kyc: 'the Capability & Verification module owns identity verification',
  kycStatus: 'the Capability & Verification module owns identity verification',
  taxId: 'the Capability & Verification module owns tax identity',

  // Profile data is personal data. This component stores none, which is what lets it say so.
  email: 'a profile field, and personal data. The account profile core is separate work',
  phone: 'a profile field, and personal data',
  name: 'a profile field, and personal data',
  displayName: 'a profile field, and often a real name — the account profile core is separate work',
  address: 'a profile field, and personal data',
  dateOfBirth: 'a profile field, and personal data',
  locale: 'a preference, not an account property',
  preferences: 'preferences are separate work and are not identity or account structure',

  // Money never lives on an account record. K-10 Ledger is the authority, and an account
  // carrying a balance is a balance two systems can disagree about.
  balance: 'K-10 Ledger foundation is the authority on every amount',
  balances: 'K-10 Ledger foundation is the authority on every amount',
  currency: 'K-10 Ledger foundation owns monetary representation',
  credit: 'K-10 Ledger foundation is the authority on every amount',
  creditLimit: 'K-10 Ledger foundation is the authority on every amount',
  wallet: 'K-10 Ledger foundation is the authority on every amount',
  points: 'the Rewards module owns points, and K-10 records the movements',
  payoutAccount: 'the Seller Payouts module owns payout destinations',
  paymentMethods: 'the Payments module owns payment instruments',

  // A lifecycle this component does not have.
  status: 'an account is created and never changes; there is no state machine here',
  state: 'an account is created and never changes; there is no state machine here',
  suspended: 'suspension is a permission decision (K-04), not an account column',
  closedAt: 'closure is deferred and deliberately unimplemented',
  deletedAt: 'an account is written once; deletion is deferred and deliberately unimplemented',
  mergedInto: 'account merge is deferred and deliberately unimplemented',
  updatedAt: 'an account is written once, so there is nothing to timestamp',
});
