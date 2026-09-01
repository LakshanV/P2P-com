/**
 * M-07 Matching — the rungs, as ports.
 *
 * Each rung is a way of finding supply, and none of them is M-07's to implement. The catalogue rung
 * reads M-04; the known-supplier rung reads trading history; the external rung talks to somebody
 * else's API entirely. What M-07 owns is the **order they are tried in and when to stop**, which is
 * the part that decides what the product feels like.
 *
 * That split is why they are ports. A deployment with no external discovery adapter simply does not
 * wire one, and the ladder records `unavailable` for that rung rather than pretending it looked.
 *
 * **A rung returns candidates; it never decides.** Sufficiency is applied by the ladder, in one
 * place, against one threshold — so "how good is good enough" is a single reviewable policy rather
 * than five implementations that drift apart.
 *
 * Owned by: M-07 Matching.
 */

import type { CandidateKind } from './types.ts';

/**
 * What the ladder gives a rung to search with.
 *
 * The **interpretation**, not the words. A rung searching raw text would be reimplementing M-03's
 * job badly, and — more to the point — a rung that talks to an external supplier must not be handed
 * a sentence that may contain the customer's telephone number.
 */
export interface SourcingQuery {
  readonly requestId: string;
  /** The account that asked. A rung may legitimately weight suppliers this buyer has used before. */
  readonly accountId: string;
  /** M-03's structured reading: commodity, quantity, unit, place, deadline, whatever it found. */
  readonly structured: Readonly<Record<string, unknown>>;
  /** How sure M-03 was, in per-mille. A rung may reasonably search more broadly for a vague Need. */
  readonly confidencePerMille: number;
  /** When the ladder is running. Supplied, because a rung must not read a clock either. */
  readonly now: string;
  readonly correlationId: string;
}

/**
 * One thing a rung found, before the ladder scores it against the threshold.
 *
 * A rung supplies its own score and explanation, because only the rung knows why its answer is a
 * good one: "this listing is the same grade, in the same district, in stock" and "this supplier has
 * filled four similar orders for you" are not comparable by any rule the ladder could apply from
 * outside.
 */
export interface RungCandidate {
  readonly kind: CandidateKind;
  readonly listingId: string | null;
  readonly versionId: string | null;
  readonly supplierAccountId: string;
  /** 0..1000. The ladder refuses anything outside, rather than clamping a rung's arithmetic error. */
  readonly scorePerMille: number;
  /** In words a customer could read. The ladder refuses a candidate without one. */
  readonly explanation: string;
  readonly evidence: Readonly<Record<string, unknown>>;
}

/**
 * A rung.
 *
 * Returning an empty array means "I looked and there is nothing", which is a real answer. **Throwing
 * means "I could not look"**, which is a different one: the ladder records `unavailable` and says so,
 * rather than treating a broken supplier directory as proof that no supplier exists. Getting that
 * distinction wrong is how a platform quietly turns every Need into an RFQ the week its search index
 * breaks.
 */
export interface SourcingRungPort {
  find(query: SourcingQuery): Promise<readonly RungCandidate[]>;
}

/**
 * A rung that is not wired.
 *
 * Distinct from a rung that finds nothing, and deliberately so: this one has not established
 * anything about the world. The ladder records `unavailable`.
 */
export const NOT_CONFIGURED: SourcingRungPort = Object.freeze({
  find(): Promise<readonly RungCandidate[]> {
    return Promise.reject(
      new Error('no adapter is configured for this rung, so nothing was searched'),
    );
  },
});
