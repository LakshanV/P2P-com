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
  INTERNAL_VALUE_CODES,
  PAYMENT_RAILS,
  PAYMENT_STATUSES,
  PaymentError,
  type AttemptKind,
  type AttemptOutcome,
  type FailureCode,
  type PaymentErrorCode,
  type PaymentRail,
  type PaymentStatus,
} from './types.ts';

export type {
  AttemptKind,
  AttemptOutcome,
  FailureCode,
  PaymentErrorCode,
  PaymentRail,
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

/** Refuse a rail M-12 does not recognise. */
export function assertPaymentRail(value: unknown, field: string): PaymentRail {
  if (typeof value !== 'string' || !(PAYMENT_RAILS as readonly string[]).includes(value)) {
    throw new PaymentError(
      'unknown-rail',
      `${field} is "${String(value)}"; expected one of ${PAYMENT_RAILS.join(', ')}`,
    );
  }
  return value as PaymentRail;
}

/**
 * Refuse a settlement asset that no external counterparty could settle.
 *
 * Two checks, and the second is the architectural one.
 *
 * The shape check is deliberately permissive: uppercase letters and digits, three to twelve
 * characters. It admits `LKR`, `USD`, `BTC` and `USDC` alike, because assuming ISO-4217 here would
 * make this contract fiat-only for ever and every later digital-asset rail would have to break it.
 *
 * The second refuses **JAYA-issued value by name**. Rewards, cashback, merchant credit,
 * promotional credit and community credit are internal liabilities: no bank, card network or
 * custodian has heard of them, and there is no rail down which they could travel. Passing one to a
 * provider adapter would either fail confusingly at the gateway or, far worse, succeed against some
 * fiat balance and quietly turn a restricted credit into cash. M-13's value router allocates those
 * legs against the universal ledger; M-12 orchestrates only the externally settled leg.
 */
export function assertSettlementAsset(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[A-Z0-9]{3,12}$/.test(value)) {
    throw new PaymentError(
      'malformed-asset-code',
      `${field} is "${String(value)}"; expected 3-12 uppercase letters or digits — a settlement ` +
        'asset such as LKR, USD, BTC or USDC, not necessarily an ISO-4217 code',
    );
  }
  if ((INTERNAL_VALUE_CODES as readonly string[]).includes(value)) {
    throw new PaymentError(
      'internal-value-not-settleable',
      `${field} is "${value}", which is value JAYA issues itself. No external provider can settle ` +
        'it, and treating it as cash would convert a restricted credit into money. M-13 allocates ' +
        'internal value against the universal ledger; M-12 settles only external rails',
    );
  }
  return value;
}

/**
 * Refuse an asset scale that is not a plausible power of ten.
 *
 * Zero is legitimate — an indivisible unit — and eighteen covers the largest decimal exponent in
 * common use. Anything outside that is a mistake rather than an exotic asset.
 */
export function assertAssetScale(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 18) {
    throw new PaymentError(
      'malformed-asset-scale',
      `${field} is ${String(value)}; expected an integer from 0 to 18, the power of ten giving ` +
        'minor units per major unit',
    );
  }
  return value;
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

  // Internal JAYA value. M-13 allocates these; no external rail can settle them.
  rewardsMinor: 'M-13 Universal Ledger allocates JAYA rewards; no external provider settles them',
  merchantCreditMinor:
    'M-13 Universal Ledger allocates merchant credit; no external rail carries it',
  cashbackMinor: 'M-13 Universal Ledger allocates cashback',
  promoCreditMinor: 'M-13 Universal Ledger allocates promotional credit',
  communityCreditMinor: 'M-13 Universal Ledger allocates community value',
  currency:
    'M-12 settles an asset rather than a currency; the field is assetCode, and it is not assumed to be fiat',

  // Lifecycle fields M-12 computes from the operation rather than accepting.
  status: 'M-12 owns the payment lifecycle; this field is refused on a request',
  capturedMinor: 'M-12 derives this from the capture attempts',
  refundedMinor: 'M-12 derives this from the refunds',
  authorisedAt: 'M-12 sets this when the provider authorises',
  capturedAt: 'M-12 sets this when the provider captures',
});
