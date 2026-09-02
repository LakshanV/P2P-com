/**
 * M-10 Quotes — the public surface.
 *
 * Owned by: M-10 Quotes.
 */

export { QUOTE_KINDS, QUOTE_STATUSES, QUOTE_TRANSITIONS, QuoteError } from './types.ts';
export type { Quote, QuoteErrorCode, QuoteEvaluation, QuoteKind, QuoteStatus } from './types.ts';

export {
  FOREIGN_FIELDS,
  IDENTIFIER_REFUSALS,
  assertAmount,
  assertQuantity,
  assertQuoteIdentifier,
  assertQuoteKind,
  assertQuoteStatus,
} from './registry.ts';

export { STORED_ROW_NOTE, validateQuote } from './validate.ts';
export type { RecordSource } from './validate.ts';

export { sealEvaluation, sealEvaluations, sealQuote, sealQuotes } from './immutable.ts';

export { DEFAULT_WEIGHTS, rankQuotes } from './ranking.ts';
export type { QuoteContext, RankingOptions } from './ranking.ts';

export { QuoteService } from './service.ts';
export type {
  CloseQuoteRequest,
  QuoteResult,
  SubmitQuoteRequest,
  TenderFacts,
  TenderSource,
} from './service.ts';

export { InMemoryQuoteRepository } from './repository.ts';
export type { QuoteRepository, QuoteTransaction } from './repository.ts';

export {
  QUOTE_ACCEPTED_EVENT,
  QUOTE_ACTION,
  QUOTE_EXPIRED_EVENT,
  QUOTE_REJECTED_EVENT,
  QUOTE_SUBMITTED_EVENT,
  QUOTE_WITHDRAWN_EVENT,
} from './outbox.ts';

export {
  EnlistedQuoteRepository,
  OUTBOX_TABLE,
  PostgresQuoteRepository,
  QUOTES_SCHEMA,
  QUOTE_TABLE,
  enlistedClient,
  toQuote,
} from './postgres-repository.ts';
