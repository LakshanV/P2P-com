/**
 * M-12 Payments — constants, identifier rules and foreign-field table.
 *
 * Identifier rules are delegated to K-03 Accounts, so an id refused at account creation is refused
 * here too, in M-12's vocabulary.
 *
 * The foreign-field table is the boundary of M-12, and it carries more weight here than in any
 * other module: it is what stops a card number reaching a stored row.
 *
 * Owned by: M-12 Payments.
 */

import { AccountError, assertAccountIdentifier } from '../../kernel/accounts/index.ts';

import {
  ATTEMPT_KINDS,
  ATTEMPT_OUTCOMES,
  FAILURE_CODES,
  PAYMENT_STATUSES,
  PaymentError,
  type AttemptKind,
  type AttemptOutcome,
  type FailureCode,
  type PaymentErrorCode,
  type PaymentStatus,
} from './types.ts';

export type {
  AttemptKind,
  AttemptOutcome,
  FailureCode,
  PaymentErrorCode,
  PaymentStatus,
} from './types.ts';

/** K-03's identifier refusals, in this module's vocabulary. Total over what K-03 can raise. */
export const IDENTIFIER_REFUSALS: Readonly<Record<string, PaymentErrorCode>> = Object.freeze({
  'malformed-identifier': 'malformed-identifier',
  'natural-identifier': 'natural-identifier',
  'secret-bearing-input': 'secret-bearing-input',
});

/**
 * Refuse an identifier that is malformed, natural, or a credential.
 *
 * The same rules apply to payment ids, attempt ids, refund ids, receipt ids, account ids,
 * idempotency keys and correlation ids — and to the **instrument token**, which is the point: a
 * token that looks like a card number, an email or an IBAN is not a token, and refusing it here is
 * what keeps the instrument on the provider's side of the boundary.
 */
export function assertPaymentIdentifier(value: unknown, field: string): string {
  try {
    return assertAccountIdentifier(value, field);
  } catch (error) {
    if (!(error instanceof AccountError)) throw error;
    const code = IDENTIFIER_REFUSALS[error.code];
    if (code === undefined) throw error;
    throw new PaymentError(code, error.message);
  }
}

/** Refuse a payment status M-12 does not recognise. */
export function assertPaymentStatus(value: unknown, field: string): PaymentStatus {
  if (typeof value !== 'string' || !(PAYMENT_STATUSES as readonly string[]).includes(value)) {
    throw new PaymentError(
      'unknown-status',
      `${field} is "${String(value)}"; expected one of ${PAYMENT_STATUSES.join(', ')}`,
    );
  }
  return value as PaymentStatus;
}

/** Refuse an attempt kind M-12 does not recognise. */
export function assertAttemptKind(value: unknown, field: string): AttemptKind {
  if (typeof value !== 'string' || !(ATTEMPT_KINDS as readonly string[]).includes(value)) {
    throw new PaymentError(
      'unknown-attempt-kind',
      `${field} is "${String(value)}"; expected one of ${ATTEMPT_KINDS.join(', ')}`,
    );
  }
  return value as AttemptKind;
}

/** Refuse an attempt outcome M-12 does not recognise. */
export function assertAttemptOutcome(value: unknown, field: string): AttemptOutcome {
  if (typeof value !== 'string' || !(ATTEMPT_OUTCOMES as readonly string[]).includes(value)) {
    throw new PaymentError(
      'malformed-record',
      `${field} is "${String(value)}"; expected one of ${ATTEMPT_OUTCOMES.join(', ')}`,
    );
  }
  return value as AttemptOutcome;
}

/** Refuse a failure code M-12 does not recognise. Null passes through. */
export function assertOptionalFailureCode(value: unknown, field: string): FailureCode | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !(FAILURE_CODES as readonly string[]).includes(value)) {
    throw new PaymentError(
      'unknown-failure-code',
      `${field} is "${String(value)}"; expected one of ${FAILURE_CODES.join(', ')}`,
    );
  }
  return value as FailureCode;
}

/**
 * Fields that belong to another unit, with the unit named.
 *
 * The first block is the one that matters. **A payment record must never carry an instrument.** It
 * outlives the transaction and is copied into every projection built from it, so a PAN written here
 * is disclosed for as long as the platform exists and no later deletion policy can recall it. These
 * are refused by name rather than ignored, because a caller sending a card number has misunderstood
 * the boundary and needs to be told, not silently accommodated.
 */
export const FOREIGN_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  // The instrument itself. The payment provider holds these; M-12 holds a token.
  cardNumber: 'the payment provider holds the instrument; M-12 stores only an opaque token',
  pan: 'the payment provider holds the instrument; M-12 stores only an opaque token',
  cvv: 'the payment provider holds the instrument; a CVV may never be stored by anyone',
  cvc: 'the payment provider holds the instrument; a CVV may never be stored by anyone',
  expiryMonth: 'the payment provider holds the instrument; M-12 stores only an opaque token',
  expiryYear: 'the payment provider holds the instrument; M-12 stores only an opaque token',
  cardholderName: 'the payment provider holds the instrument, and the name is personal data',
  iban: 'the payment provider holds the instrument; M-12 stores only an opaque token',
  accountNumber: 'the payment provider holds the instrument; M-12 stores only an opaque token',
  sortCode: 'the payment provider holds the instrument; M-12 stores only an opaque token',
  routingNumber: 'the payment provider holds the instrument; M-12 stores only an opaque token',
  billingAddress: 'the payment provider holds billing details, and an address is personal data',

  // M-11 Orders is the same layer, so it reaches M-12 by event.
  orderStatus:
    'M-11 Orders owns the order lifecycle; M-11 is the same layer and reaches M-12 by event',
  orderTotal: 'M-11 Orders owns the order total; M-12 is told an amount, not an order',
  orderItems: 'M-11 Orders owns the lines',

  // K-10 and the other L5 financial modules.
  ledgerAccountId: 'K-10 Ledger foundation owns ledger accounts',
  balance: 'K-10 Ledger foundation is the authority on every balance',
  commissionMinor: 'M-14 Commission Rules owns commission, and is the same layer',
  settlementId: 'M-15 Settlements owns settlement, and is the same layer',

  // Identity, authentication and authority.
  subjectId: 'K-01 Identity owns the subject; a payment references an account by id',
  sessionId: 'K-02 Authentication owns sessions',
  password: 'K-02 Authentication owns credentials',
  token: 'ambiguous by name; the provider token is `instrumentToken`, and K-02 owns auth tokens',
  role: 'K-04 Permissions owns roles and grants',
  permissions: 'K-04 Permissions owns permission evaluation',

  // Profile and contact.
  email: 'email belongs to the account profile core, not to a payment record',
  phone: 'phone belongs to the account profile core, not to a payment record',

  // Lifecycle fields M-12 computes from the operation rather than accepting.
  status: 'M-12 owns the payment lifecycle; this field is refused on a request',
  capturedMinor: 'M-12 derives this from the capture attempts',
  refundedMinor: 'M-12 derives this from the refunds',
  authorisedAt: 'M-12 sets this when the provider authorises',
  capturedAt: 'M-12 sets this when the provider captures',
});
