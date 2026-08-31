/**
 * M-11 Orders — constants, identifier rules and foreign-field table.
 *
 * Identifier rules are delegated to K-03 Accounts, because every order references universal accounts
 * by id. Using K-03's rule set means an id that would be refused at account creation is also refused
 * here, in M-11's vocabulary.
 *
 * The foreign-field table is the boundary of M-11. An order record carries only what this module
 * owns; anything else is refused by name.
 *
 * Owned by: M-11 Orders.
 */

import { AccountError, assertAccountIdentifier } from '../../kernel/accounts/index.ts';

import {
  CANCELLATION_REASONS,
  ORDER_EVENT_KINDS,
  ORDER_STATUSES,
  OrderError,
  type CancellationReason,
  type OrderErrorCode,
  type OrderEventKind,
  type OrderStatus,
} from './types.ts';

export type { CancellationReason, OrderErrorCode, OrderEventKind, OrderStatus } from './types.ts';

/**
 * K-03's identifier refusals, in this module's vocabulary.
 *
 * The mapping is total over what `assertAccountIdentifier` can raise.
 */
export const IDENTIFIER_REFUSALS: Readonly<Record<string, OrderErrorCode>> = Object.freeze({
  'malformed-identifier': 'malformed-identifier',
  'natural-identifier': 'natural-identifier',
  'secret-bearing-input': 'secret-bearing-input',
});

/**
 * Refuse an identifier that is malformed, natural, or a credential.
 *
 * M-11 identifiers are opaque handles supplied by the caller. The same rules apply to order ids,
 * item ids, snapshot ids, event ids, account ids, idempotency keys and correlation ids.
 */
export function assertOrderIdentifier(value: unknown, field: string): string {
  try {
    return assertAccountIdentifier(value, field);
  } catch (error) {
    if (!(error instanceof AccountError)) throw error;
    const code = IDENTIFIER_REFUSALS[error.code];
    if (code === undefined) throw error;
    throw new OrderError(code, error.message);
  }
}

/**
 * Refuse an order status that is not one M-11 recognises.
 */
export function assertOrderStatus(value: unknown, field: string): OrderStatus {
  if (typeof value !== 'string' || !(ORDER_STATUSES as readonly string[]).includes(value)) {
    throw new OrderError(
      'unknown-status',
      `${field} is "${String(value)}"; expected one of ${ORDER_STATUSES.join(', ')}`,
    );
  }
  return value as OrderStatus;
}

/**
 * Refuse an order event kind that is not one M-11 recognises.
 */
export function assertOrderEventKind(value: unknown, field: string): OrderEventKind {
  if (typeof value !== 'string' || !(ORDER_EVENT_KINDS as readonly string[]).includes(value)) {
    throw new OrderError(
      'unknown-event-kind',
      `${field} is "${String(value)}"; expected one of ${ORDER_EVENT_KINDS.join(', ')}`,
    );
  }
  return value as OrderEventKind;
}

/**
 * Refuse a cancellation reason that is not one M-11 recognises.
 */
export function assertCancellationReason(value: unknown, field: string): CancellationReason {
  if (typeof value !== 'string' || !(CANCELLATION_REASONS as readonly string[]).includes(value)) {
    throw new OrderError(
      'unknown-cancellation-reason',
      `${field} is "${String(value)}"; expected one of ${CANCELLATION_REASONS.join(', ')}`,
    );
  }
  return value as CancellationReason;
}

/**
 * Fields that belong to another component, with the component named.
 *
 * An order record carries only what M-11 owns. A request carrying a field belonging to another unit
 * is refused by name because it is modelling the thing wrongly, not making a typo.
 */
export const FOREIGN_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  // M-01 Universal Account owns which capabilities an account holds.
  capability: 'M-01 Universal Account owns which capabilities an account holds',
  capabilities: 'M-01 Universal Account owns which capabilities an account holds',

  // M-02 Capability & Verification owns verification levels.
  verificationLevel: 'M-02 Capability & Verification owns verification level',
  verified: 'M-02 Capability & Verification owns verification level',

  // K-01 Identity owns the party.
  subjectId: 'K-01 Identity owns the subject; an order references accounts by account id',
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

  // K-03 Accounts owns the universal account; M-11 only references it by id.
  account: 'K-03 Accounts owns the universal account; an order references accounts by id',
  origin: 'K-03 Accounts owns the provenance of an account creation, not an order',

  // K-04 Permissions owns who may do what.
  role: 'K-04 Permissions owns roles and grants',
  roles: 'K-04 Permissions owns roles and grants',
  permissions: 'K-04 Permissions owns permission evaluation',
  grants: 'K-04 Permissions owns grants',

  // K-10 Ledger Foundation owns ledger accounts and balances.
  balance: 'K-10 Ledger Foundation is the authority on every amount',
  balances: 'K-10 Ledger Foundation is the authority on every amount',
  amount: 'K-10 Ledger Foundation is the authority on every amount',
  ledgerAccountId: 'K-10 Ledger Foundation owns ledger accounts; an order does not embed one',

  // M-12 Payments is the same layer as M-11; these arrive by event, never in a request.
  paymentId:
    'M-12 Payments owns payments; an order does not embed one (same layer: communicate by event)',
  paymentStatus:
    'M-12 Payments owns payment status; an order reacts to payment events (same layer: communicate by event)',
  authorizationCode:
    'M-12 Payments owns authorization codes; they arrive by event (same layer: communicate by event)',
  cardNumber:
    'M-12 Payments owns card data; it never enters an order request (same layer: communicate by event)',
  pan: 'M-12 Payments owns card data; it never enters an order request (same layer: communicate by event)',

  // M-14 Commission Rules is the same layer as M-11; commission arrives by event.
  commissionRate:
    'M-14 Commission Rules owns commission rates; they apply by event (same layer: communicate by event)',
  commissionMinor:
    'M-14 Commission Rules owns commission amounts; they arrive by event (same layer: communicate by event)',

  // M-15 Settlements is above M-11; settlement ids arrive by event.
  settlementId: 'M-15 Settlements owns settlements; an order does not embed one',

  // Profile and contact fields belong elsewhere.
  email: 'email belongs to the account profile core, not to an order',
  phone: 'phone belongs to the account profile core, not to an order',

  // Lifecycle and monetary fields M-11 computes rather than accepts.
  status: 'M-11 computes the order status from its lifecycle operations',
  subtotalMinor: 'M-11 computes the subtotal from the order lines',
  totalMinor: 'M-11 computes the total from the subtotal',
  placedAt: 'M-11 sets placedAt when the order is placed',
  confirmedAt: 'M-11 sets confirmedAt when the order is confirmed',
  completedAt: 'M-11 sets completedAt when the order is completed',
  cancelledAt: 'M-11 sets cancelledAt when the order is cancelled',
});
