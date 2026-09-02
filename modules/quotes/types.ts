/**
 * M-10 Quotes — what suppliers offered, and how they compare.
 *
 * The other half of a tender. M-09 asks; this is what comes back, and the comparison a customer
 * actually makes their decision on.
 *
 * **A quote is an offer, and an offer binds.** Until it expires, a supplier who quoted 250,000 for
 * twenty tonnes has said they will supply twenty tonnes for 250,000 — so a quote is append-only,
 * carries its own validity, and cannot be edited after it is submitted. A supplier who wants to
 * change their price **withdraws and submits a new one**, which leaves both on the record. A market
 * where offers can be quietly revised is one where the offer you accepted is not the offer you saw.
 *
 * **Not every offer is for the whole thing.** A supplier with twelve tonnes should be able to say
 * so: three of them make a split that a buyer could not have assembled from a market that only
 * accepted all-or-nothing. So `partial` is a first-class kind, and so is `substitute` — a supplier
 * who has something equivalent is more useful than one who says no, provided the difference is
 * declared.
 *
 * **Ranking is not price.** The cheapest offer that arrives three weeks late, from a supplier who
 * failed twice last year, is not the best offer — and a platform that says it is teaches its
 * customers not to trust the ranking. So the score is over several factors, the weights are
 * configurable, and every score carries an explanation. **The customer may always choose a
 * non-recommended offer**: a recommendation is advice, and one that could not be overridden would
 * be a decision taken from them.
 *
 * Deterministic: the caller supplies every identifier and every instant.
 *
 * Owned by: M-10 Quotes.
 */

/**
 * What a supplier is offering, relative to what was asked for.
 *
 * `full` — everything specified, as specified.
 * `partial` — some of the quantity. A buyer may combine several, and a market that refused these
 *   would lose orders no single supplier could fill.
 * `substitute` — something equivalent rather than identical, and the difference must be declared.
 *   Permitted only when the tender's substitution policy allows it.
 */
export const QUOTE_KINDS = ['full', 'partial', 'substitute'] as const;
export type QuoteKind = (typeof QUOTE_KINDS)[number];

/**
 * Where a quote is in its life.
 *
 * `submitted` — offered, and binding until it expires.
 * `withdrawn` — the supplier took it back before it was accepted. Terminal, and the record stays.
 * `expired` — its validity passed. Terminal.
 * `accepted` — the buyer took it. Terminal.
 * `rejected` — the buyer took another. Terminal, and distinct from expired, because a supplier is
 *   owed the difference between "you lost" and "you were too slow".
 */
export const QUOTE_STATUSES = [
  'submitted',
  'withdrawn',
  'expired',
  'accepted',
  'rejected',
] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

export const QUOTE_TRANSITIONS: Readonly<Record<QuoteStatus, readonly QuoteStatus[]>> =
  Object.freeze<Record<QuoteStatus, readonly QuoteStatus[]>>({
    submitted: Object.freeze(['withdrawn', 'expired', 'accepted', 'rejected']),
    withdrawn: Object.freeze([]),
    expired: Object.freeze([]),
    accepted: Object.freeze([]),
    rejected: Object.freeze([]),
  });

/** One supplier's offer against one tender. */
export interface Quote {
  readonly quoteId: string;
  readonly rfqId: string;
  /** The supplier offering. Only an invited supplier may quote. */
  readonly supplierAccountId: string;
  readonly kind: QuoteKind;
  readonly status: QuoteStatus;
  /**
   * How many units this offer covers.
   *
   * Equal to the tender's quantity for a `full` offer, and less for a `partial` one. Never more:
   * offering to sell more than was asked for is not an answer to the question.
   */
  readonly quantity: bigint;
  /** Price per unit, in integer minor units. */
  readonly unitPriceMinor: bigint;
  /**
   * What the buyer actually pays, all in: price, delivery, duties, everything the supplier knows.
   *
   * Carried separately from `unitPriceMinor * quantity` because the difference is where a cheap
   * offer becomes an expensive one, and a comparison that ignored it would rank on the wrong number.
   */
  readonly totalMinor: bigint;
  readonly currency: string;
  /** Days from acceptance to delivery, as the supplier states it. */
  readonly leadTimeDays: number;
  /** Who bears carriage and risk: `delivered`, `ex-works`, `collect`. */
  readonly deliveryTerms: string;
  /** How long the buyer has to accept. After this the offer is not binding. */
  readonly validUntil: string;
  /**
   * What differs from the specification, for a `substitute`.
   *
   * Required for a substitute and refused for the other kinds: an undeclared substitution is how a
   * buyer receives something they did not order and discovers it on delivery day.
   */
  readonly substitutionNote: string | null;
  /** Certifications, test reports, photographs — as opaque references. */
  readonly evidenceReferences: readonly string[];
  readonly submittedAt: string;
  readonly updatedAt: string;
  readonly closedAt: string | null;
  readonly closureReason: string | null;
  readonly correlationId: string;
  readonly idempotencyKey: string;
}

/**
 * How one quote compares, and why.
 *
 * Computed rather than stored on the quote, because a ranking depends on the weights in force and on
 * what else was offered — and both change. Recomputing is cheap; a stale score presented as current
 * is not.
 */
export interface QuoteEvaluation {
  readonly quoteId: string;
  /** 0..1000. An integer per-mille, like every other score in this repository. */
  readonly scorePerMille: number;
  /** 1 is best. Ties are broken by total cost, then by quote id, so the order is stable. */
  readonly rank: number;
  /** True for the single offer the platform would pick. Advice, never a decision. */
  readonly recommended: boolean;
  /** Why it scored what it did, in words a customer could read. */
  readonly explanation: string;
  /** Each factor's contribution, so a customer can see what drove it. */
  readonly factors: Readonly<Record<string, number>>;
  /** Why this offer cannot be accepted, when it cannot. Null when it can. */
  readonly ineligibleReason: string | null;
}

export type QuoteErrorCode =
  | 'malformed-identifier'
  | 'natural-identifier'
  | 'secret-bearing-input'
  | 'malformed-instant'
  | 'foreign-concern'
  | 'malformed-record'
  | 'idempotency-key-reuse'
  | 'duplicate-quote-id'
  | 'quote-not-found'
  | 'unknown-kind'
  | 'unknown-status'
  | 'illegal-transition'
  | 'quote-closed'
  /** The supplier was not invited to this tender. */
  | 'not-invited'
  /** The tender is not accepting offers. */
  | 'rfq-not-open'
  /** A supplier tried to act on somebody else's offer. */
  | 'not-your-quote'
  /** Somebody who did not open the tender tried to choose between its offers. */
  | 'not-your-tender'
  /** The offer is for more than was asked for, or for nothing. */
  | 'malformed-quantity'
  | 'malformed-amount'
  /** A substitute with nothing declared, or a declaration on a non-substitute. */
  | 'undeclared-substitution'
  /** The tender forbids substitutes. */
  | 'substitution-not-permitted'
  | 'malformed-validity';

export class QuoteError extends Error {
  readonly code: QuoteErrorCode;

  constructor(code: QuoteErrorCode, message: string) {
    super(message);
    this.name = 'QuoteError';
    this.code = code;
  }
}
