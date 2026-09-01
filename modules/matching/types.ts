/**
 * M-07 Matching — the sourcing ladder, and what it found.
 *
 * The differentiated middle of the product. A customer says "I need 20 tonnes of cement in Matale by
 * Friday", and the platform's job is to **solve that** — not to publish it and wait.
 *
 * **The ladder stops at the first rung that satisfies.** That is the whole design, and the
 * alternative is what makes most marketplaces tiring to use: broadcasting every request to every
 * supplier. If the cement is already on a shelf forty kilometres away, sending an RFQ to eleven
 * suppliers wastes their time, delays the customer, and teaches everybody to ignore RFQs. So each
 * rung runs only when the one above it did not answer.
 *
 *   1. `catalogue`  — what is already listed and available. The cheapest and fastest answer.
 *   2. `known`      — suppliers this platform has bought from before for this kind of thing.
 *   3. `verified`   — verified suppliers in the right category who have not traded with this buyer.
 *   4. `external`   — discovery beyond the platform, through an adapter, where one is configured.
 *   5. `rfq`        — ask the market. The last resort, not the first move.
 *
 * **Every rung's outcome is recorded, including the ones that found nothing.** "We checked the
 * catalogue and there was none" is the answer to "why did this become an RFQ", and without it an
 * escalation looks arbitrary to the customer and unreviewable to everybody else.
 *
 * **The ladder decides; it does not act.** When no rung satisfies, the outcome is `escalate-to-rfq`
 * — a recommendation. M-09 creates the RFQ, because creating one is M-09's to do and a matching
 * engine that could open tenders would be two modules in one.
 *
 * Deterministic by construction: the caller supplies every identifier and every instant.
 *
 * Owned by: M-07 Matching.
 */

/**
 * The rungs, in the order they are climbed.
 *
 * The order is the product decision. Reordering it changes what the platform is: putting `rfq`
 * first would make JAYA a request board, and putting `external` before `known` would ignore the
 * suppliers who have already served this buyer well.
 */
export const SOURCING_RUNGS = ['catalogue', 'known', 'verified', 'external', 'rfq'] as const;
export type SourcingRung = (typeof SOURCING_RUNGS)[number];

/**
 * What happened on one rung.
 *
 * `satisfied` — candidates good enough to stop here.
 * `insufficient` — candidates were found, but none met the sufficiency threshold. Recorded
 *   separately from `empty`, because "there is some but it is wrong" and "there is none" lead a
 *   human to different next steps.
 * `empty` — nothing at all.
 * `unavailable` — no adapter is wired for this rung. A **configuration** fact: this deployment
 *   was never going to answer here, nobody is paged, and the ladder is working as configured.
 * `lookup-failed` — the adapter was called and it broke. An **operational** fact: somebody should
 *   be paged, and until they are, every Need is escalating for a reason that has nothing to do with
 *   supply.
 *
 *   Both are distinct from `empty`, because neither establishes anything about the world — treating
 *   them as "nothing there" would let a broken supplier directory quietly turn every Need into an
 *   RFQ. And they are distinct from **each other**, because a broken directory that looks like a
 *   deployment choice is an outage nobody is alerted to.
 * `skipped` — the ladder stopped before reaching it. Recorded so the run reads as a sequence rather
 *   than as a set of unexplained gaps.
 */
export const RUNG_OUTCOMES = [
  'satisfied',
  'insufficient',
  'empty',
  'unavailable',
  'lookup-failed',
  'skipped',
] as const;
export type RungOutcome = (typeof RUNG_OUTCOMES)[number];

/** How a whole run ended. */
export const RUN_OUTCOMES = ['matched', 'escalate-to-rfq', 'exhausted'] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];

/**
 * What a candidate is an offer of.
 *
 * `listing` — an existing M-04 listing version. Immediately orderable.
 * `supplier` — a supplier who probably can, but has not yet said so. Needs asking.
 */
export const CANDIDATE_KINDS = ['listing', 'supplier'] as const;
export type CandidateKind = (typeof CANDIDATE_KINDS)[number];

/**
 * One run of the ladder against one Need.
 *
 * Append-only. Re-running the ladder — because the Need was reinterpreted, or because a week has
 * passed and supply has changed — creates a **new** run. Comparing two runs is how anybody answers
 * "why did this find nothing on Tuesday and something on Thursday".
 */
export interface MatchRun {
  /** Caller-supplied opaque and stable identifier. */
  readonly runId: string;
  /** The M-03 Need this ran against. Opaque; M-03 is a lower layer and is read through a port. */
  readonly requestId: string;
  /** The account that asked. Copied so a run can be scoped without reading M-03 back. */
  readonly accountId: string;
  /** The interpretation the ladder ran against, so a re-run after a correction is comparable. */
  readonly interpretationId: string | null;
  readonly outcome: RunOutcome;
  /** The rung that ended it, or null when every rung was climbed without satisfaction. */
  readonly satisfiedBy: SourcingRung | null;
  /** How good a candidate had to be, in per-mille, for this run to stop. */
  readonly sufficiencyPerMille: number;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
}

/** What one rung did, and why the ladder moved on or stopped. */
export interface RungAttempt {
  readonly attemptId: string;
  readonly runId: string;
  readonly rung: SourcingRung;
  /** 1-based, in ladder order, so the sequence reads without joining to the vocabulary. */
  readonly position: number;
  readonly outcome: RungOutcome;
  /** How many candidates this rung produced, before the threshold was applied. */
  readonly candidatesFound: number;
  /** The best score this rung produced, or null when it produced nothing. */
  readonly bestScorePerMille: number | null;
  /**
   * Why the ladder did what it did next, in one line.
   *
   * Required, including for a rung that found nothing. "The catalogue holds no cement in Matale" is
   * what a customer is owed when their Need becomes an RFQ, and "empty" is not that.
   */
  readonly reason: string;
  readonly attemptedAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
}

/**
 * One thing the ladder found.
 *
 * Append-only, and scoped to the run that found it. A candidate is **not** an offer: nobody has
 * committed to anything, and a `supplier` candidate has not even been asked yet.
 */
export interface MatchCandidate {
  readonly candidateId: string;
  readonly runId: string;
  readonly rung: SourcingRung;
  readonly kind: CandidateKind;
  /** The M-04 listing, for a `listing` candidate. Null for a `supplier` one. */
  readonly listingId: string | null;
  /** The pinned version. An order pins terms, so a candidate names the version it was scored on. */
  readonly versionId: string | null;
  /** The supplier's K-03 account. Present for both kinds: a listing has an owner. */
  readonly supplierAccountId: string;
  /**
   * How well it matches, 0 to 1000.
   *
   * An integer per-mille, because no floating-point value exists anywhere in this repository: a
   * score stored as a double compares unequal to itself across a round trip, and a threshold built
   * on one drifts without anybody editing it.
   */
  readonly scorePerMille: number;
  /**
   * Why it scored what it did, in words a customer could read.
   *
   * Required. A candidate a customer cannot understand is a candidate they cannot sensibly accept
   * or reject, and "score: 0.82" explains nothing to the person deciding whether to spend money.
   */
  readonly explanation: string;
  /** What the match was computed from, for review. Open, because a Need can be for anything. */
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly foundAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
}

export type MatchingErrorCode =
  | 'malformed-identifier'
  | 'natural-identifier'
  | 'secret-bearing-input'
  | 'malformed-instant'
  | 'foreign-concern'
  | 'malformed-record'
  | 'idempotency-key-reuse'
  | 'duplicate-run-id'
  | 'duplicate-candidate-id'
  | 'run-not-found'
  | 'unknown-rung'
  | 'unknown-outcome'
  | 'unknown-candidate-kind'
  /** The score or threshold is outside 0..1000, or is not an integer. */
  | 'malformed-score'
  /** A required explanation is missing or too short to be one. */
  | 'malformed-explanation'
  /** A candidate names a listing without a version, or a version without a listing. */
  | 'incoherent-candidate'
  /** A rung port failed in a way the ladder cannot interpret. */
  | 'rung-failed';

export class MatchingError extends Error {
  readonly code: MatchingErrorCode;

  constructor(code: MatchingErrorCode, message: string) {
    super(message);
    this.name = 'MatchingError';
    this.code = code;
  }
}
