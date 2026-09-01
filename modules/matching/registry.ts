/**
 * M-07 Matching — vocabularies, identifier rules and the foreign-field table.
 *
 * Owned by: M-07 Matching.
 */

import { AccountError, assertAccountIdentifier } from '../../kernel/accounts/index.ts';

import {
  CANDIDATE_KINDS,
  MatchingError,
  RUNG_OUTCOMES,
  RUN_OUTCOMES,
  SOURCING_RUNGS,
  type CandidateKind,
  type MatchingErrorCode,
  type RunOutcome,
  type RungOutcome,
  type SourcingRung,
} from './types.ts';

export const IDENTIFIER_REFUSALS: Readonly<Record<string, MatchingErrorCode>> = Object.freeze({
  'malformed-identifier': 'malformed-identifier',
  'natural-identifier': 'natural-identifier',
  'secret-bearing-input': 'secret-bearing-input',
});

export function assertMatchingIdentifier(value: unknown, field: string): string {
  try {
    return assertAccountIdentifier(value, field);
  } catch (error) {
    if (!(error instanceof AccountError)) throw error;
    const code = IDENTIFIER_REFUSALS[error.code];
    if (code === undefined) throw error;
    throw new MatchingError(code, error.message);
  }
}

export function assertSourcingRung(value: unknown, field: string): SourcingRung {
  if (typeof value !== 'string' || !(SOURCING_RUNGS as readonly string[]).includes(value)) {
    throw new MatchingError(
      'unknown-rung',
      `${field} is "${String(value)}"; the ladder is ${SOURCING_RUNGS.join(' → ')}`,
    );
  }
  return value as SourcingRung;
}

export function assertRungOutcome(value: unknown, field: string): RungOutcome {
  if (typeof value !== 'string' || !(RUNG_OUTCOMES as readonly string[]).includes(value)) {
    throw new MatchingError(
      'unknown-outcome',
      `${field} is "${String(value)}"; expected one of ${RUNG_OUTCOMES.join(', ')}`,
    );
  }
  return value as RungOutcome;
}

export function assertRunOutcome(value: unknown, field: string): RunOutcome {
  if (typeof value !== 'string' || !(RUN_OUTCOMES as readonly string[]).includes(value)) {
    throw new MatchingError(
      'unknown-outcome',
      `${field} is "${String(value)}"; expected one of ${RUN_OUTCOMES.join(', ')}`,
    );
  }
  return value as RunOutcome;
}

export function assertCandidateKind(value: unknown, field: string): CandidateKind {
  if (typeof value !== 'string' || !(CANDIDATE_KINDS as readonly string[]).includes(value)) {
    throw new MatchingError(
      'unknown-candidate-kind',
      `${field} is "${String(value)}"; expected one of ${CANDIDATE_KINDS.join(', ')}`,
    );
  }
  return value as CandidateKind;
}

/**
 * Refuse a score that is not a whole per-mille from 0 to 1000.
 *
 * The same rule M-03 applies to confidence, for the same reason: this repository holds no
 * floating-point value anywhere, because a score stored as a double compares unequal to itself
 * across a round trip and a sufficiency threshold built on one moves without anybody editing it.
 */
export function assertScore(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 1000) {
    throw new MatchingError(
      'malformed-score',
      `${field} is ${String(value)}; expected a whole number of per-mille from 0 to 1000`,
    );
  }
  return value;
}

export const MINIMUM_EXPLANATION_LENGTH = 12;

/**
 * Refuse an explanation that is not one.
 *
 * Required on every candidate and every rung attempt. A candidate a customer cannot understand is
 * one they cannot sensibly accept or reject — "score: 0.82" explains nothing to the person deciding
 * whether to spend money — and a rung outcome nobody explained makes an escalation to RFQ look
 * arbitrary.
 */
export function assertExplanation(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length < MINIMUM_EXPLANATION_LENGTH) {
    throw new MatchingError(
      'malformed-explanation',
      `${field} must be at least ${String(MINIMUM_EXPLANATION_LENGTH)} characters. A customer ` +
        'deciding whether to spend money is owed a reason they can read',
    );
  }
  return value;
}

/**
 * Fields belonging to another component.
 *
 * M-07 sits between demand and supply, so a caller most naturally reaches for the Need's words on
 * one side and an order or a price on the other. Neither is M-07's: the ladder scores supply against
 * an interpretation, and what a thing costs is a term of an offer.
 */
export const FOREIGN_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  // The words, and only the words. A rung may talk to an external supplier, and handing it a
  // sentence a customer wrote -- deliberately exempt from the identifier rules, and possibly holding
  // a telephone number -- would send that sentence outside the platform.
  rawText: 'M-03 Commerce Request owns what the customer said; a match names the Need by id',
  // The whole interpretation record. M-07 is *given* the structured reading to search with, and
  // stores none of it: a run names the interpretation by id, so the reading has exactly one home.
  interpretation: 'M-03 Commerce Request owns the reading; a run names the interpretation by id',

  orderId: 'M-11 Orders owns the order a match may become',
  order: 'M-11 Orders owns the order',
  quoteId: 'M-10 Quotes owns a quotation',
  rfqId: 'M-09 RFQ owns the tender an escalation leads to; M-07 recommends and does not create one',
  offerId: 'M-08 Offers owns an offer; a candidate is not one, because nobody has committed yet',

  unitPriceMinor: 'M-04 Universal Listing owns the price a version was published at',
  totalMinor: 'M-11 Orders owns an order total',
  price: 'M-04 and M-10 own price; a match is about fit, and fit is scored rather than costed',

  reservationId: 'M-04 Universal Listing owns stock reservations; a candidate holds nothing',
  quantityAvailable: 'M-04 Universal Listing owns availability',

  allowed: 'K-04 Permissions decides that',
  role: 'K-04 Permissions owns roles',
  subjectId: 'K-01 Identity owns the subject; a run references an account by account id',
  sessionId: 'K-02 Authentication owns sessions',

  verified: 'M-02 Capability & Verification owns whether a supplier is verified',
  verificationLevel: 'M-02 Capability & Verification owns verification level',
});
