/**
 * M-10 Quotes — the immutability boundary.
 *
 * An offer binds, so what a caller receives must be what was actually offered. `evidenceReferences`
 * is an array, so a shallow freeze would hand out a frozen wrapper around a mutable list of the
 * certificates a supplier attached — and a dispute is judged against exactly that list.
 *
 * Owned by: M-10 Quotes.
 */

import type { Quote, QuoteEvaluation } from './types.ts';

export function sealQuote(quote: Quote): Quote {
  return Object.freeze({
    ...quote,
    evidenceReferences: Object.freeze([...quote.evidenceReferences]),
  });
}

export function sealQuotes(quotes: readonly Quote[]): readonly Quote[] {
  return Object.freeze(quotes.map(sealQuote));
}

export function sealEvaluation(evaluation: QuoteEvaluation): QuoteEvaluation {
  return Object.freeze({ ...evaluation, factors: Object.freeze({ ...evaluation.factors }) });
}

export function sealEvaluations(
  evaluations: readonly QuoteEvaluation[],
): readonly QuoteEvaluation[] {
  return Object.freeze(evaluations.map(sealEvaluation));
}
