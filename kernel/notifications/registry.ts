/**
 * K-14 Notifications — constants, identifier rules and foreign-field table.
 *
 * Identifier rules are delegated to K-03 Accounts, because K-14 depends on K-03 and every
 * notification references a universal account by id. Using K-03's rule set means an account id that
 * would be refused at creation is also refused here, in K-14's vocabulary.
 *
 * The foreign-field table is the boundary of K-14. A notification record carries only what this
 * component owns; anything else is refused by name.
 *
 * Owned by: K-14 Notifications.
 */

import { AccountError, assertAccountIdentifier } from '../accounts/index.ts';

import {
  CHANNELS,
  NotificationError,
  PRIORITIES,
  type Channel,
  type NotificationErrorCode,
  type Priority,
} from './types.ts';

export type { Channel, NotificationErrorCode, Priority } from './types.ts';

/**
 * K-03's identifier refusals, in this component's vocabulary.
 *
 * The mapping is total over what `assertAccountIdentifier` can raise, and the notification tests
 * assert that: a new K-03 refusal code must be given a K-14 meaning rather than escaping as an
 * `AccountError` from a call the caller never made.
 */
export const ACCOUNT_REFUSALS: Readonly<Record<string, NotificationErrorCode>> = Object.freeze({
  'malformed-identifier': 'malformed-identifier',
  'natural-identifier': 'natural-identifier',
  'secret-bearing-input': 'secret-bearing-input',
});

/** Refuse an account id that is malformed, natural, or a credential. */
export function assertAccountId(value: unknown, field: string): string {
  try {
    return assertAccountIdentifier(value, field);
  } catch (error) {
    if (!(error instanceof AccountError)) throw error;
    const code = ACCOUNT_REFUSALS[error.code];
    if (code === undefined) throw error;
    throw new NotificationError(code, error.message);
  }
}

/**
 * Refuse a channel that is not one K-14 recognises.
 *
 * Channel ids are not opaque identifiers: they are the platform's shared vocabulary for delivery
 * channels (`in_app`, `email`, `sms`, `push`, `whatsapp`) and must be readable in code and queries.
 */
export function assertChannel(value: unknown, field: string): Channel {
  if (typeof value !== 'string' || !(CHANNELS as readonly string[]).includes(value)) {
    throw new NotificationError(
      'invalid-channel',
      `${field} is "${String(value)}"; expected one of ${CHANNELS.join(', ')}`,
    );
  }
  return value as Channel;
}

/**
 * Refuse a priority that is not one K-14 recognises.
 */
export function assertPriority(value: unknown, field: string): Priority {
  if (typeof value !== 'string' || !(PRIORITIES as readonly string[]).includes(value)) {
    throw new NotificationError(
      'invalid-priority',
      `${field} is "${String(value)}"; expected one of ${PRIORITIES.join(', ')}`,
    );
  }
  return value as Priority;
}

/**
 * Fields that belong to another component, with the component named.
 *
 * A notification record carries only what K-14 owns. A request carrying a business-module field is
 * refused by name because it is modelling the thing wrongly, not making a typo.
 */
export const FOREIGN_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  // K-01 Identity owns the party.
  subjectId: 'K-01 Identity owns the subject; a notification references a recipient by account id',
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

  // K-03 Accounts owns the universal account; we only reference it by id.
  account: 'K-03 Accounts owns the universal account; a notification references one by id',
  origin: 'K-03 Accounts owns the provenance of an account creation, not a notification',

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
  ledgerAccountId: 'K-10 Ledger foundation owns ledger accounts; a notification does not embed one',

  // Business modules own outcomes.
  orderId: 'orders belong to the Orders module, not to notifications',
  paymentId: 'payments belong to the Payments module, not to notifications',
  listingId: 'listings belong to the marketplace modules, not to notifications',
  offerId: 'offers belong to the Offers module, not to notifications',
  quoteId: 'quotes belong to the Quotes module, not to notifications',
  merchantId: 'merchant identity belongs to the Seller modules, not to notifications',
  buyerId: 'buyer identity belongs to the Cockpit modules, not to notifications',
  productId: 'product identity belongs to the Product Catalog module, not to notifications',

  // A template service owns template bodies and rendering; K-14 only stores a template id and the
  // rendered output.
  templateBody: 'a template service owns template bodies; K-14 stores only the rendered result',
  templateContent: 'a template service owns template bodies; K-14 stores only the rendered result',
  templateVariables: 'a template service owns template rendering; K-14 stores the rendered payload',

  // Lifecycle fields this component does not have.
  status: 'K-14 owns the notification lifecycle; this field is refused on creation requests',
  state: 'K-14 owns the notification lifecycle; this field is refused on creation requests',
  updatedAt: 'a notification record is written once, so there is no update timestamp',
  deletedAt: 'a notification record is written once, so there is no deletion timestamp',
});
