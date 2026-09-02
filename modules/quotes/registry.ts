/**
 * M-10 Quotes — vocabularies, identifier rules and the foreign-field table.
 *
 * Owned by: M-10 Quotes.
 */

import { AccountError, assertAccountIdentifier } from '../../kernel/accounts/index.ts';

import {
  QUOTE_KINDS,
  QUOTE_STATUSES,
  QuoteError,
  type QuoteErrorCode,
  type QuoteKind,
  type QuoteStatus,
} from './types.ts';

export const IDENTIFIER_REFUSALS: Readonly<Record<string, QuoteErrorCode>> = Object.freeze({
  'malformed-identifier': 'malformed-identifier',
  'natural-identifier': 'natural-identifier',
  'secret-bearing-input': 'secret-bearing-input',
});

export function assertQuoteIdentifier(value: unknown, field: string): string {
  try {
    return assertAccountIdentifier(value, field);
  } catch (error) {
    if (!(error instanceof AccountError)) throw error;
    const code = IDENTIFIER_REFUSALS[error.code];
    if (code === undefined) throw error;
    throw new QuoteError(code, error.message);
  }
}

export function assertQuoteKind(value: unknown, field: string): QuoteKind {
  if (typeof value !== 'string' || !(QUOTE_KINDS as readonly string[]).includes(value)) {
    throw new QuoteError(
      'unknown-kind',
      `${field} is "${String(value)}"; expected one of ${QUOTE_KINDS.join(', ')}`,
    );
  }
  return value as QuoteKind;
}

export function assertQuoteStatus(value: unknown, field: string): QuoteStatus {
  if (typeof value !== 'string' || !(QUOTE_STATUSES as readonly string[]).includes(value)) {
    throw new QuoteError(
      'unknown-status',
      `${field} is "${String(value)}"; expected one of ${QUOTE_STATUSES.join(', ')}`,
    );
  }
  return value as QuoteStatus;
}

/**
 * Money, as integer minor units.
 *
 * Accepts a bigint, a non-negative safe integer or a digits-only string — the three forms every
 * amount in this repository accepts. A JSON number that is not a safe integer is refused rather than
 * rounded: a double cannot hold 9007199254740993 minor units, and a price silently rounded is a
 * price somebody is going to be charged.
 */
export function assertAmount(value: unknown, field: string): bigint {
  if (typeof value === 'bigint') {
    if (value < 0n) {
      throw new QuoteError('malformed-amount', `${field} is negative; a price is not a discount`);
    }
    return value;
  }
  if (typeof value === 'string') {
    if (!/^\d+$/.test(value)) {
      throw new QuoteError(
        'malformed-amount',
        `${field} is "${value}"; an amount is a non-negative integer of minor units`,
      );
    }
    return BigInt(value);
  }
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  throw new QuoteError(
    'malformed-amount',
    `${field} is ${String(value)}; send an amount as a string or a safe integer of minor units. ` +
      'A double cannot hold every amount this platform can express, and a price rounded on the way ' +
      'in is a price somebody is charged',
  );
}

export function assertQuantity(value: unknown, field: string): bigint {
  if (typeof value === 'bigint') {
    if (value <= 0n) {
      throw new QuoteError('malformed-quantity', `${field} must be greater than zero`);
    }
    return value;
  }
  if (typeof value === 'string' && /^\d+$/.test(value) && BigInt(value) > 0n) return BigInt(value);
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return BigInt(value);
  throw new QuoteError(
    'malformed-quantity',
    `${field} is ${String(value)}; an offer for nothing is not an offer`,
  );
}

/** Fields belonging to another component. */
export const FOREIGN_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  rawText: 'M-03 Commerce Request owns what the customer said; a supplier never receives it',
  specification:
    'M-09 RFQ owns the specification; a quote answers one and does not carry a copy that could ' +
    'disagree with it',
  needText: 'M-03 Commerce Request owns what the customer said',

  orderId: 'M-11 Orders owns the order an accepted quote becomes',
  order: 'M-11 Orders owns the order',
  paymentId: 'M-12 Payments owns the payment',

  listingId: 'M-04 Universal Listing owns supply; a quote exists because no listing answered',
  reservationId: 'M-04 Universal Listing owns stock reservations; a quote holds nothing',

  score: 'a score is computed from the offers in front of a buyer, not stated by the supplier',
  rank: 'a rank is relative to the other offers, so a supplier cannot carry one',
  recommended: 'the platform recommends; a supplier claiming to be recommended is advertising',

  allowed: 'K-04 Permissions decides that',
  verified: 'M-02 Capability & Verification owns whether a supplier is verified',
  subjectId: 'K-01 Identity owns the subject; a quote references an account by account id',
});
