/**
 * M-09 RFQ — vocabularies, identifier rules, and the guard that keeps a customer's words out.
 *
 * Owned by: M-09 RFQ.
 */

import { AccountError, assertAccountIdentifier } from '../../kernel/accounts/index.ts';

import {
  RFQ_STATUSES,
  RFQ_VISIBILITIES,
  RfqError,
  SUBSTITUTION_POLICIES,
  type RfqErrorCode,
  type RfqStatus,
  type RfqVisibility,
  type SubstitutionPolicy,
} from './types.ts';

export const IDENTIFIER_REFUSALS: Readonly<Record<string, RfqErrorCode>> = Object.freeze({
  'malformed-identifier': 'malformed-identifier',
  'natural-identifier': 'natural-identifier',
  'secret-bearing-input': 'secret-bearing-input',
});

export function assertRfqIdentifier(value: unknown, field: string): string {
  try {
    return assertAccountIdentifier(value, field);
  } catch (error) {
    if (!(error instanceof AccountError)) throw error;
    const code = IDENTIFIER_REFUSALS[error.code];
    if (code === undefined) throw error;
    throw new RfqError(code, error.message);
  }
}

export function assertRfqStatus(value: unknown, field: string): RfqStatus {
  if (typeof value !== 'string' || !(RFQ_STATUSES as readonly string[]).includes(value)) {
    throw new RfqError(
      'unknown-status',
      `${field} is "${String(value)}"; expected one of ${RFQ_STATUSES.join(', ')}`,
    );
  }
  return value as RfqStatus;
}

export function assertVisibility(value: unknown, field: string): RfqVisibility {
  if (typeof value !== 'string' || !(RFQ_VISIBILITIES as readonly string[]).includes(value)) {
    throw new RfqError(
      'unknown-visibility',
      `${field} is "${String(value)}"; expected one of ${RFQ_VISIBILITIES.join(', ')}`,
    );
  }
  return value as RfqVisibility;
}

export function assertSubstitutionPolicy(value: unknown, field: string): SubstitutionPolicy {
  if (typeof value !== 'string' || !(SUBSTITUTION_POLICIES as readonly string[]).includes(value)) {
    throw new RfqError(
      'unknown-substitution-policy',
      `${field} is "${String(value)}"; expected one of ${SUBSTITUTION_POLICIES.join(', ')}`,
    );
  }
  return value as SubstitutionPolicy;
}

/**
 * The longest a supplier-facing item description may be.
 *
 * Short on purpose. A supplier needs to know what to quote for, and a field long enough to hold a
 * customer's whole message is a field that will eventually hold one — pasted there by somebody in a
 * hurry who thought it would be easier than filling in the attributes.
 */
export const MAXIMUM_ITEM_DESCRIPTION_LENGTH = 500;

/**
 * Shapes that suggest a customer's own words have been pasted into a supplier-facing field.
 *
 * A heuristic, and it is worth being clear about what it can and cannot do. It cannot detect every
 * leak: somebody determined to paste prose into `itemDescription` can write a sentence with no
 * telephone number in it. What it catches is the **accidental** case — the paste that carries a
 * contact detail, an email address or a "call me after six" along with it — which is the case that
 * actually happens.
 *
 * The structural defence is the one that matters: the specification has no free-text field wide
 * enough for a Need, and M-03's raw text is never passed to this module at all. This is the belt to
 * that pair of braces.
 */
const PRIVATE_TEXT_SHAPES: readonly RegExp[] = Object.freeze([
  // A telephone number, in the shapes people actually write them.
  /(?:\+?\d[\d\s-]{8,})/,
  /[^@\s]+@[^@\s]+\.[^@\s]+/,
  /\b(?:call|ring|whatsapp|text)\s+me\b/i,
  /\bmy\s+(?:number|mobile|address|email)\b/i,
]);

/**
 * Refuse a supplier-facing string that looks like it came from the customer's message.
 *
 * Applied to every string a supplier will read.
 */
export function assertNoPrivateText(value: string, field: string): string {
  for (const shape of PRIVATE_TEXT_SHAPES) {
    if (shape.test(value)) {
      throw new RfqError(
        'private-text-in-specification',
        `${field} contains something that looks like the customer's own contact details or ` +
          'message. A supplier receives a specification, never the words a customer wrote: those ' +
          'stay in M-03, where the person who wrote them can see who has read them',
      );
    }
  }
  return value;
}

export const MINIMUM_REASON_LENGTH = 12;

/**
 * Refuse an invitation with no reason.
 *
 * A supplier receiving an irrelevant tender is how a platform trains people to ignore it, so every
 * invitation has to answer "why me" in words the supplier could read.
 */
export function assertReason(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length < MINIMUM_REASON_LENGTH) {
    throw new RfqError(
      'malformed-reason',
      `${field} must be at least ${String(MINIMUM_REASON_LENGTH)} characters. A supplier is ` +
        'entitled to know why they were asked',
    );
  }
  return assertNoPrivateText(value, field);
}

/**
 * Fields belonging to another component.
 *
 * The first entry is the one that matters, and it is the reason this table exists at all.
 */
export const FOREIGN_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  rawText:
    'M-03 Commerce Request owns what the customer said, and a supplier never receives it. An RFQ ' +
    'carries a specification derived from the reading, not the sentence',
  needText: 'M-03 Commerce Request owns what the customer said',
  notes:
    'there is deliberately no free-text field on a specification: it is where a customer message ' +
    'ends up being pasted the first time somebody is in a hurry',
  interpretation:
    'M-03 Commerce Request owns the reading; an RFQ carries what a supplier must meet',

  // `quoteId` is deliberately **not** here. M-10 owns a quotation and M-09 never reads one, but
  // naming the winner is exactly what an award is — the RFQ has to record which offer was chosen or
  // it cannot say a decision was made. What is refused is the collection: an RFQ that carried the
  // quotes themselves would be M-10 with a different name.
  quotes: 'M-10 Quotes owns quotations; an RFQ names only the one that won',
  orderId: 'M-11 Orders owns the order an award becomes',

  candidates: 'M-07 Matching owns candidates; an RFQ has invitations, which are a decision',
  matchScore: 'M-07 Matching owns scoring',

  listingId: 'M-04 Universal Listing owns supply; an RFQ exists because no listing answered',
  reservationId: 'M-04 Universal Listing owns stock reservations',

  price:
    'a supplier states the price in their quote; an RFQ that named one would be an instruction',
  budgetMinor:
    'what a buyer is willing to pay is theirs, and telling suppliers is how a budget becomes a price',
  unitPriceMinor: 'M-10 Quotes owns the price a supplier offers',

  allowed: 'K-04 Permissions decides that',
  role: 'K-04 Permissions owns roles',
  verified: 'M-02 Capability & Verification owns whether a supplier is verified',
  subjectId: 'K-01 Identity owns the subject; an RFQ references an account by account id',
});
