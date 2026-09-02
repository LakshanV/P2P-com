/**
 * Comparing offers: the part a customer actually makes a decision on.
 *
 * **The cheapest offer is often not the best one.** An offer 8% cheaper that arrives three weeks
 * late, from a supplier who failed twice last year, with no certification and payment up front, is
 * worse than the one next to it — and a platform that ranks it first teaches its customers to
 * ignore the ranking, which is the same as not having one.
 *
 * So the score is over several factors, and three properties matter more than the arithmetic:
 *
 * **The weights are configurable and they are data.** A buyer sourcing cement for Friday weighs lead
 * time differently from one stocking a warehouse. `DEFAULT_WEIGHTS` is a starting point, not a law.
 *
 * **The engine is replaceable.** `rankQuotes` is a function over inputs with no I/O, no clock and no
 * hidden state, so a deployment that wants a learned model swaps it and the rest of the module does
 * not notice. That is why it is a file of its own rather than a method on the service.
 *
 * **Every score explains itself, and the recommendation can be overridden.** A recommendation is
 * *advice*. A customer may accept any eligible offer, and one they could not override would be a
 * decision taken from them rather than a service rendered to them.
 *
 * Owned by: M-10 Quotes.
 */

import { parseInstant } from '../../platform/time/instant.ts';

import type { Quote, QuoteEvaluation } from './types.ts';

/**
 * Microseconds since the epoch.
 *
 * Through the platform parser rather than `Date.parse`, which reads a microsecond instant to
 * millisecond precision and answers NaN for anything it does not recognise — and a comparison
 * against NaN is silently false, which here would mean an expired offer presented as live.
 */
function micros(instant: string): bigint {
  return parseInstant(instant).epochMicros;
}

/**
 * What each factor is worth, out of 1000.
 *
 * Cost is the largest single weight and deliberately not a majority: it is what a customer notices
 * first and what they regret last. Reliability and lead time together outweigh it, because between
 * two offers a few per cent apart the question that actually matters is whether it arrives.
 */
export const DEFAULT_WEIGHTS: Readonly<Record<string, number>> = Object.freeze({
  /** Landed cost, relative to the cheapest eligible offer. */
  cost: 350,
  /** How likely this supplier is to deliver what they promised. */
  reliability: 200,
  /** How soon, against what the buyer asked for. */
  leadTime: 200,
  /** How completely the offer answers the specification. */
  completeness: 150,
  /** Certifications and evidence the buyer asked for. */
  quality: 100,
});

/** What the ranker knows about a set of offers beyond the offers themselves. */
export interface QuoteContext {
  /**
   * Each supplier's delivery record, 0..1000, keyed by account id.
   *
   * A map rather than a single figure because reliability is the one factor that differs per
   * supplier while every other one is judged across the whole set. An absent key means no record,
   * which is not the same as a bad one — see {@link scoreReliability}.
   */
  readonly supplierReliabilityPerMille: Readonly<Record<string, number | null>>;
  /** How many units the tender asked for. */
  readonly quantityRequired: bigint;
  /** When the buyer needs it, or null when they did not say. */
  readonly requiredBy: string | null;
  /** Certifications and standards the tender asked for. */
  readonly qualityRequirements: readonly string[];
  /** "Now", for judging validity and lead time. Injected, like every instant in this repository. */
  readonly now: string;
}

export interface RankingOptions {
  readonly weights?: Readonly<Record<string, number>>;
}

/**
 * Score and order a set of offers.
 *
 * Ineligible offers — withdrawn, expired, already closed — are scored zero and ranked last with the
 * reason stated, rather than dropped. A customer looking at three offers when four suppliers were
 * invited deserves to know that the fourth expired on Tuesday.
 */
export function rankQuotes(
  quotes: readonly Quote[],
  context: QuoteContext,
  options: RankingOptions = {},
): readonly QuoteEvaluation[] {
  const weights = { ...DEFAULT_WEIGHTS, ...(options.weights ?? {}) };

  const eligible = quotes.filter((quote) => eligibility(quote, context) === null);
  // Relative to the best offer actually available, not to an absolute. What matters to a buyer is
  // how this offer compares with the others in front of them.
  const cheapest = eligible.reduce<bigint | null>(
    (best, quote) => (best === null || quote.totalMinor < best ? quote.totalMinor : best),
    null,
  );
  const soonest = eligible.reduce<number | null>(
    (best, quote) => (best === null || quote.leadTimeDays < best ? quote.leadTimeDays : best),
    null,
  );

  const scored = quotes.map((quote) => {
    const ineligible = eligibility(quote, context);
    if (ineligible !== null) {
      return {
        quoteId: quote.quoteId,
        scorePerMille: 0,
        rank: 0,
        recommended: false,
        explanation: `not available: ${ineligible}`,
        factors: Object.freeze({}),
        ineligibleReason: ineligible,
      };
    }

    const factors = {
      cost: scoreCost(quote, cheapest),
      reliability: scoreReliability(reliabilityOf(quote, context)),
      leadTime: scoreLeadTime(quote, context, soonest),
      completeness: scoreCompleteness(quote, context),
      quality: scoreQuality(quote, context),
    };

    let total = 0;
    for (const [name, weight] of Object.entries(weights)) {
      total += (weight * (factors[name as keyof typeof factors] ?? 0)) / 1000;
    }

    return {
      quoteId: quote.quoteId,
      scorePerMille: Math.max(0, Math.min(1000, Math.round(total))),
      rank: 0,
      recommended: false,
      explanation: explain(quote, context, factors, cheapest, soonest),
      factors: Object.freeze(factors as Record<string, number>),
      ineligibleReason: null,
    };
  });

  // Ineligible offers rank last whatever they scored. Ties break on total cost and then on quote id,
  // so two runs over the same offers produce the same order — a ranking that reshuffled on every
  // page load would be one nobody could discuss.
  const byQuote = new Map(quotes.map((quote) => [quote.quoteId, quote]));
  const ordered = [...scored].sort((a, b) => {
    if ((a.ineligibleReason === null) !== (b.ineligibleReason === null)) {
      return a.ineligibleReason === null ? -1 : 1;
    }
    if (a.scorePerMille !== b.scorePerMille) return b.scorePerMille - a.scorePerMille;
    const left = byQuote.get(a.quoteId);
    const right = byQuote.get(b.quoteId);
    if (left !== undefined && right !== undefined && left.totalMinor !== right.totalMinor) {
      return left.totalMinor < right.totalMinor ? -1 : 1;
    }
    return a.quoteId.localeCompare(b.quoteId);
  });

  return Object.freeze(
    ordered.map((evaluation, index) =>
      Object.freeze({
        ...evaluation,
        rank: index + 1,
        // Exactly one recommendation, and only among offers that can actually be accepted.
        recommended: index === 0 && evaluation.ineligibleReason === null,
      }),
    ),
  );
}

/** Why this offer cannot be accepted, or null when it can. */
function eligibility(quote: Quote, context: QuoteContext): string | null {
  if (quote.status === 'withdrawn') return 'the supplier withdrew it';
  if (quote.status === 'expired') return 'it expired before it was accepted';
  if (quote.status === 'rejected') return 'another offer was accepted';
  if (quote.status === 'accepted') return 'it has already been accepted';

  // Validity is checked against the injected instant rather than a stored flag, so an offer that
  // lapsed a minute ago is not presented as live because nobody has run a sweep yet.
  if (micros(quote.validUntil) <= micros(context.now)) return 'its validity has passed';
  return null;
}

/**
 * Cost, relative to the cheapest offer available.
 *
 * A ratio rather than a difference, because 5,000 more matters differently on a 20,000 order and a
 * 2,000,000 one. An offer at twice the cheapest scores zero; the scale between is linear, which is
 * simple enough that a customer can predict it.
 */
function scoreCost(quote: Quote, cheapest: bigint | null): number {
  if (cheapest === null || cheapest <= 0n) return 1000;
  if (quote.totalMinor <= cheapest) return 1000;

  // Integer arithmetic throughout: this repository holds no floating-point value, and a score that
  // did would compare unequal to itself across a round trip.
  const ratioPerMille = Number((quote.totalMinor * 1000n) / cheapest);
  if (ratioPerMille >= 2000) return 0;
  return Math.max(0, Math.round(2000 - ratioPerMille));
}

/**
 * Reliability, where there is a record.
 *
 * Null scores 600, not zero — the same rule the supplier rungs apply, and for the same reason: a new
 * supplier who has never failed is not one who fails half the time, and scoring them identically
 * closes the market to new entrants.
 */
function scoreReliability(reliabilityPerMille: number | null): number {
  return reliabilityPerMille ?? 600;
}

/** This supplier's record, or null where there is none. An absent key is not a zero. */
function reliabilityOf(quote: Quote, context: QuoteContext): number | null {
  return context.supplierReliabilityPerMille[quote.supplierAccountId] ?? null;
}

/**
 * Lead time, against the deadline the buyer actually gave.
 *
 * When they gave one, what matters is whether the offer meets it — an offer arriving the day before
 * is as good as one arriving a week early, and one arriving the day after is not nearly as good
 * however marginal the miss. When they gave none, the comparison is relative to the fastest offer.
 */
function scoreLeadTime(quote: Quote, context: QuoteContext, soonest: number | null): number {
  if (context.requiredBy !== null) {
    const daysAvailable = Number(micros(context.requiredBy) - micros(context.now)) / 86_400_000_000;
    if (quote.leadTimeDays <= daysAvailable) return 1000;
    const overrun = quote.leadTimeDays - daysAvailable;
    // Missing by a day is a real problem and missing by a month is a different one.
    if (overrun <= 1) return 600;
    if (overrun <= 3) return 350;
    if (overrun <= 7) return 150;
    return 0;
  }

  if (soonest === null) return 1000;
  if (quote.leadTimeDays <= soonest) return 1000;
  const extra = quote.leadTimeDays - soonest;
  return Math.max(0, 1000 - extra * 50);
}

/**
 * How completely the offer answers the question.
 *
 * A partial offer is genuinely worth less than a full one — the buyer has to find the rest — but it
 * is worth far more than nothing, because three partials can make a split that no single supplier
 * could fill. Scored proportionally rather than excluded.
 */
function scoreCompleteness(quote: Quote, context: QuoteContext): number {
  if (context.quantityRequired <= 0n) return 1000;
  const covered =
    quote.quantity >= context.quantityRequired
      ? 1000n
      : (quote.quantity * 1000n) / context.quantityRequired;
  const proportion = Number(covered);

  // A substitute answers the quantity but not the specification, so it carries a fixed discount
  // rather than a proportional one: the difference is in kind, not in degree.
  return quote.kind === 'substitute' ? Math.round(proportion * 0.8) : proportion;
}

/** Whether the evidence the buyer asked for was supplied. */
function scoreQuality(quote: Quote, context: QuoteContext): number {
  if (context.qualityRequirements.length === 0) return 1000;
  // The tender asked for certifications and the supplier attached none.
  if (quote.evidenceReferences.length === 0) return 0;
  // Evidence was attached. This module cannot check what a certificate *says* — that is a human or
  // a verification component's job — so what is scored is that it exists to be checked.
  return 1000;
}

function explain(
  quote: Quote,
  context: QuoteContext,
  factors: Readonly<Record<string, number>>,
  cheapest: bigint | null,
  soonest: number | null,
): string {
  const parts: string[] = [];

  if (cheapest !== null && quote.totalMinor === cheapest) {
    parts.push('the lowest total cost offered');
  } else if (cheapest !== null && cheapest > 0n) {
    const overPerMille = Number(((quote.totalMinor - cheapest) * 1000n) / cheapest);
    parts.push(`${String(Math.round(overPerMille / 10))}% above the lowest offer`);
  }

  if (quote.kind === 'partial') {
    parts.push(
      `covers ${String(quote.quantity)} of ${String(context.quantityRequired)}, so the rest needs another supplier`,
    );
  } else if (quote.kind === 'substitute') {
    parts.push(`offers a substitute: ${quote.substitutionNote ?? 'difference not stated'}`);
  }

  if (context.requiredBy !== null) {
    parts.push(
      factors.leadTime === 1000
        ? `meets your date in ${String(quote.leadTimeDays)} days`
        : `${String(quote.leadTimeDays)} days, which misses the date you asked for`,
    );
  } else if (soonest !== null && quote.leadTimeDays === soonest) {
    parts.push(`the fastest offered, at ${String(quote.leadTimeDays)} days`);
  } else {
    parts.push(`${String(quote.leadTimeDays)} days`);
  }

  const reliability = reliabilityOf(quote, context);
  parts.push(
    reliability === null
      ? 'no delivery record with JAYA yet'
      : `delivery record ${String(reliability)} of 1000`,
  );

  if (context.qualityRequirements.length > 0) {
    parts.push(
      factors.quality === 1000
        ? 'evidence attached for the certifications you asked for'
        : 'no evidence attached for the certifications you asked for',
    );
  }

  return parts.join('; ');
}
