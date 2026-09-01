/**
 * M-03 Commerce Request — vocabularies, identifier rules and the foreign-field table.
 *
 * Identifier rules are delegated to K-03 Accounts, because every Need references a universal account
 * by id. Using K-03's rule set means an id refused at account creation is refused here too, in M-03's
 * own vocabulary.
 *
 * The foreign-field table is the boundary of M-03. It is longer than most modules' because M-03 sits
 * at the front of the platform, where a caller most naturally reaches for things that belong further
 * down: a matched supplier, a price, an order id, a decision about whether the Need is any good.
 * Every one of those is somebody else's fact, and a Need that carried it would be the place two
 * modules disagree.
 *
 * Owned by: M-03 Commerce Request.
 */

import { AccountError, assertAccountIdentifier } from '../../kernel/accounts/index.ts';

import {
  CAPTURE_CHANNELS,
  CommerceRequestError,
  INTERPRETATION_ORIGINS,
  MEDIA_KINDS,
  REQUEST_STATUSES,
  type CaptureChannel,
  type CommerceRequestErrorCode,
  type InterpretationOrigin,
  type MediaKind,
  type RequestStatus,
} from './types.ts';

export type {
  CaptureChannel,
  CommerceRequestErrorCode,
  InterpretationOrigin,
  MediaKind,
  RequestStatus,
} from './types.ts';

/** K-03's identifier refusals, in this module's vocabulary. Total over what K-03 can raise. */
export const IDENTIFIER_REFUSALS: Readonly<Record<string, CommerceRequestErrorCode>> =
  Object.freeze({
    'malformed-identifier': 'malformed-identifier',
    'natural-identifier': 'natural-identifier',
    'secret-bearing-input': 'secret-bearing-input',
  });

/**
 * Refuse an identifier that is malformed, natural, or a credential.
 *
 * Applies to request ids, interpretation ids, media ids, account ids, conversation ids, AI run ids,
 * idempotency keys and correlation ids — **and not to `rawText`**, which is the one field in this
 * module that is deliberately outside the rule. See `CommerceRequest.rawText`.
 */
export function assertCommerceRequestIdentifier(value: unknown, field: string): string {
  try {
    return assertAccountIdentifier(value, field);
  } catch (error) {
    if (!(error instanceof AccountError)) throw error;
    const code = IDENTIFIER_REFUSALS[error.code];
    if (code === undefined) throw error;
    throw new CommerceRequestError(code, error.message);
  }
}

export function assertCaptureChannel(value: unknown, field: string): CaptureChannel {
  if (typeof value !== 'string' || !(CAPTURE_CHANNELS as readonly string[]).includes(value)) {
    throw new CommerceRequestError(
      'unknown-channel',
      `${field} is "${String(value)}"; expected one of ${CAPTURE_CHANNELS.join(', ')}`,
    );
  }
  return value as CaptureChannel;
}

export function assertRequestStatus(value: unknown, field: string): RequestStatus {
  if (typeof value !== 'string' || !(REQUEST_STATUSES as readonly string[]).includes(value)) {
    throw new CommerceRequestError(
      'unknown-status',
      `${field} is "${String(value)}"; expected one of ${REQUEST_STATUSES.join(', ')}`,
    );
  }
  return value as RequestStatus;
}

export function assertInterpretationOrigin(value: unknown, field: string): InterpretationOrigin {
  if (typeof value !== 'string' || !(INTERPRETATION_ORIGINS as readonly string[]).includes(value)) {
    throw new CommerceRequestError(
      'unknown-origin',
      `${field} is "${String(value)}"; expected one of ${INTERPRETATION_ORIGINS.join(', ')}`,
    );
  }
  return value as InterpretationOrigin;
}

export function assertMediaKind(value: unknown, field: string): MediaKind {
  if (typeof value !== 'string' || !(MEDIA_KINDS as readonly string[]).includes(value)) {
    throw new CommerceRequestError(
      'unknown-media-kind',
      `${field} is "${String(value)}"; expected one of ${MEDIA_KINDS.join(', ')}`,
    );
  }
  return value as MediaKind;
}

/** The longest raw Need M-03 will store. */
export const MAXIMUM_RAW_TEXT_LENGTH = 20_000;

/**
 * Refuse raw text that is empty or unbounded.
 *
 * The **only** two rules applied to it, and both are about storage rather than content. It is not
 * trimmed, not normalised, not spell-corrected and not checked against the opacity rule: it is what
 * a person said, and the whole value of keeping it is that it is unaltered.
 *
 * Leading and trailing whitespace is preserved for the same reason. A Need is compared against what
 * the customer typed, and "helpfully" trimming it means the stored evidence differs from what they
 * would swear they sent.
 */
export function assertRawText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new CommerceRequestError(
      'malformed-raw-text',
      `${field} must be a non-empty string. A Need with nothing in it is not a Need`,
    );
  }
  // Counted in code points, not UTF-16 units: a Need written in Sinhala or with emoji must not be
  // held to a shorter limit than one written in English.
  if ([...value].length > MAXIMUM_RAW_TEXT_LENGTH) {
    throw new CommerceRequestError(
      'malformed-raw-text',
      `${field} is longer than ${String(MAXIMUM_RAW_TEXT_LENGTH)} characters. The bound exists ` +
        'because an unbounded field is a way to fill the database, not because anybody has ever ' +
        'needed more',
    );
  }
  return value;
}

/**
 * Refuse a confidence that is not a whole per-mille between 0 and 1000.
 *
 * Per-mille integers rather than a fraction, because this repository holds no floating-point value
 * anywhere: a confidence stored as a double compares unequal to itself across a round trip, and a
 * threshold built on one drifts without anybody changing it.
 */
export function assertConfidence(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 1000) {
    throw new CommerceRequestError(
      'malformed-confidence',
      `${field} is ${String(value)}; expected a whole number of per-mille from 0 to 1000. It is ` +
        'an integer because a floating-point confidence does not survive a round trip intact, and ' +
        'a threshold built on one moves without anybody editing it',
    );
  }
  return value;
}

/** The shortest explanation M-03 will accept as one. */
export const MINIMUM_RATIONALE_LENGTH = 8;

/**
 * Refuse a rationale that is absent or is not an explanation.
 *
 * Required on every interpretation, including a model's. "The customer said 6mm, not 6cm" and
 * "re-interpreted after the catalogue was extended" are the difference between a history somebody
 * can read and a list of timestamps — and the person who most needs to read it is whoever is
 * looking at a wrong answer months later.
 */
export function assertRationale(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length < MINIMUM_RATIONALE_LENGTH) {
    throw new CommerceRequestError(
      'malformed-rationale',
      `${field} must be at least ${String(MINIMUM_RATIONALE_LENGTH)} characters. An ` +
        'interpretation without a reason is one nobody can argue with later',
    );
  }
  return value;
}

export function assertStructured(value: unknown, field: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CommerceRequestError(
      'malformed-structured',
      `${field} must be a JSON object. An array or a scalar cannot say what was understood`,
    );
  }
  return value as Readonly<Record<string, unknown>>;
}

/**
 * Fields that belong to another component, with the component named.
 *
 * M-03 sits at the front of the platform, so this table is longer than most: a caller reaching for
 * "the matched supplier" or "the price" or "whether this is any good" is reaching past the Need into
 * something downstream that has not happened yet. Refusing by name says which module owns it.
 */
export const FOREIGN_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  // M-07 Matching decides what a Need matches. A Need that carried its own match would be a Need
  // that answered the question the ladder exists to ask.
  matchedListingId: 'M-07 Matching owns what a Need matches',
  matches: 'M-07 Matching owns what a Need matches',
  matchScore: 'M-07 Matching owns match quality',
  candidates: 'M-07 Matching owns candidate supply',

  // M-09 RFQ owns quotations and awards.
  rfqId: 'M-09 RFQ owns the request for quotation a Need may lead to',
  quoteId: 'M-10 Quotes owns the quotation',
  offers: 'M-08 Offers owns supplier offers against a Need',
  awardedTo: 'M-09 RFQ owns the award',

  // M-11 Orders owns the order. A Need becomes an order; it does not contain one.
  orderId: 'M-11 Orders owns the order a Need may become',
  order: 'M-11 Orders owns the order',

  // Money is never on a Need. What somebody is willing to pay is a term of an offer or an order,
  // priced by M-14 against a policy version — not a number a Need carries around.
  price: 'M-14 Commission Rules and M-10 Quotes own price; a Need states what, not what it costs',
  unitPriceMinor: 'M-10 Quotes owns price',
  totalMinor: 'M-11 Orders owns an order total',
  currency: 'M-11 Orders owns the currency an order is denominated in',
  budgetMinor: 'A budget belongs in the structured interpretation, not on the Need record itself',

  // M-04 owns supply. A Need is demand.
  listingId: 'M-04 Universal Listing owns supply; a Need is demand and names no listing',
  inventoryMode: 'M-04 Universal Listing owns how a listing is fulfilled',
  quantityAvailable: 'M-04 Universal Listing owns availability',

  // K-13 decides nothing on its own, and M-03 records what it produced rather than its authority.
  aiAuthority: 'K-13 AI Gateway owns what a task is permitted to do',
  authorityLevel: 'K-13 AI Gateway owns the level a run executed under',
  modelId: 'K-13 AI Gateway owns which model ran; M-03 keeps the run id it returned',
  prompt: 'K-13 AI Gateway owns prompts; a Need is not one',

  // K-01/K-02/K-03: identity, credentials and the account itself.
  subjectId: 'K-01 Identity owns the subject; a Need references an account by account id',
  password: 'K-02 Authentication owns credentials',
  credential: 'K-02 Authentication owns credentials',
  sessionId: 'K-02 Authentication owns sessions',
  token: 'K-02 Authentication owns tokens',
  account: 'K-03 Accounts owns the universal account; a Need references one by id',

  // K-04 decides authorisation. A Need that said it was allowed would be formatting its caller's
  // opinion, which is exactly what K-04 refuses.
  allowed: 'K-04 Permissions decides that',
  permitted: 'K-04 Permissions decides that',
  role: 'K-04 Permissions owns roles',

  // The platform's own opinion of a Need is not a field on it.
  valid: 'Whether a Need is actionable is a status, reached by a transition somebody recorded',
  score: 'M-07 Matching owns scoring',
  priority: 'M-38 Operations owns triage',
});
