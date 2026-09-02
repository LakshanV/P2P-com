/**
 * M-10 Quotes — submitting an offer, withdrawing it, and choosing between them.
 *
 * **A quote binds, so it cannot be edited.** A supplier who quoted 250,000 has said they will supply
 * for 250,000, and a market where that can be quietly revised is one where the offer you accepted is
 * not the offer you saw. Changing a price means **withdrawing and submitting a new offer**, which
 * leaves both on the record and lets a buyer see that the price moved.
 *
 * **A supplier acts only on their own offer.** Checked here, in the service, and not only at the
 * HTTP edge: the edge knows who is calling, but this is where "whose offer is it" is actually known,
 * and a rule enforced only at the edge is a rule a second caller walks around.
 *
 * **Only an invited supplier may quote**, and only while the tender is open. Both are checked
 * against M-09 through a narrow port rather than trusted from the request — a supplier who could
 * assert their own invitation would be a supplier who needs no invitation.
 *
 * Owned by: M-10 Quotes.
 */

import { InvalidInstantError, parseInstant } from '../../platform/time/instant.ts';

import { sealQuote, sealQuotes } from './immutable.ts';
import { makeQuoteEvent, makeQuoteAction } from './outbox.ts';
import { rankQuotes, type QuoteContext, type RankingOptions } from './ranking.ts';
import { FOREIGN_FIELDS, assertQuoteIdentifier } from './registry.ts';
import type { QuoteRepository, QuoteTransaction } from './repository.ts';
import {
  QUOTE_TRANSITIONS,
  QuoteError,
  type Quote,
  type QuoteEvaluation,
  type QuoteStatus,
} from './types.ts';
import { validateQuote } from './validate.ts';

/**
 * What M-10 needs to know about a tender before it accepts an offer against it.
 *
 * A narrow port onto M-09 rather than the service, because M-10 has no business closing tenders or
 * reading somebody else's invitations. It needs three facts, and this is all three.
 */
export interface TenderFacts {
  readonly rfqId: string;
  readonly status: string;
  readonly quantity: bigint;
  readonly substitutionPolicy: string;
  readonly requiredBy: string | null;
  readonly qualityRequirements: readonly string[];
}

export interface TenderSource {
  /** The tender, or null when there is none. */
  findTender(rfqId: string): Promise<TenderFacts | null>;
  /** Whether this supplier was asked. Never taken from the request. */
  isInvited(rfqId: string, supplierAccountId: string): Promise<boolean>;
}

export interface SubmitQuoteRequest {
  readonly quoteId: string;
  readonly rfqId: string;
  readonly supplierAccountId: string;
  readonly kind: string;
  readonly quantity: unknown;
  readonly unitPriceMinor: unknown;
  readonly totalMinor: unknown;
  readonly currency: string;
  readonly leadTimeDays: number;
  readonly deliveryTerms: string;
  readonly validUntil: string;
  readonly substitutionNote?: string | null;
  readonly evidenceReferences?: readonly string[];
  readonly submittedAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
}

export interface QuoteResult {
  readonly quote: Quote;
  readonly replayed: boolean;
}

export interface CloseQuoteRequest {
  readonly quoteId: string;
  /** Who is asking. A supplier withdraws their own; a buyer accepts or rejects. */
  readonly actingAccountId: string;
  readonly reason: string;
  readonly occurredAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
}

const SUBMIT_KEYS: readonly string[] = [
  'quoteId',
  'rfqId',
  'supplierAccountId',
  'kind',
  'quantity',
  'unitPriceMinor',
  'totalMinor',
  'currency',
  'leadTimeDays',
  'deliveryTerms',
  'validUntil',
  'substitutionNote',
  'evidenceReferences',
  'submittedAt',
  'correlationId',
  'idempotencyKey',
];

const CLOSE_KEYS: readonly string[] = [
  'quoteId',
  'actingAccountId',
  'reason',
  'occurredAt',
  'correlationId',
  'idempotencyKey',
];

export class QuoteService {
  readonly #repository: QuoteRepository;
  readonly #tenders: TenderSource;

  constructor(repository: QuoteRepository, tenders: TenderSource) {
    this.#repository = repository;
    this.#tenders = tenders;
  }

  /** Offer against a tender. */
  async submitQuote(request: SubmitQuoteRequest): Promise<QuoteResult> {
    assertNoForeignConcerns(request, SUBMIT_KEYS, 'submitQuote');

    const candidate = validateQuote(
      {
        quoteId: request.quoteId,
        rfqId: request.rfqId,
        supplierAccountId: request.supplierAccountId,
        kind: request.kind,
        status: 'submitted' as QuoteStatus,
        quantity: request.quantity,
        unitPriceMinor: request.unitPriceMinor,
        totalMinor: request.totalMinor,
        currency: request.currency,
        leadTimeDays: request.leadTimeDays,
        deliveryTerms: request.deliveryTerms,
        validUntil: request.validUntil,
        substitutionNote: request.substitutionNote ?? null,
        evidenceReferences: [...(request.evidenceReferences ?? [])],
        submittedAt: request.submittedAt,
        updatedAt: request.submittedAt,
        closedAt: null,
        closureReason: null,
        correlationId: request.correlationId,
        idempotencyKey: request.idempotencyKey,
      },
      'request',
    );

    // An offer that is not binding for any length of time is not an offer.
    if (
      parseInstant(candidate.validUntil).epochMicros <=
      parseInstant(candidate.submittedAt).epochMicros
    ) {
      throw new QuoteError(
        'malformed-validity',
        'an offer must be valid for some period after it is made. One that expires as it arrives ' +
          'cannot be accepted, so it is not an offer',
      );
    }

    const tender = await this.#tenders.findTender(candidate.rfqId);
    if (tender === null) {
      throw new QuoteError('quote-not-found', `no tender with id ${candidate.rfqId}`);
    }
    if (tender.status !== 'open') {
      throw new QuoteError(
        'rfq-not-open',
        `tender ${tender.rfqId} is ${tender.status}. An offer arriving after closing cannot be ` +
          'accepted, and taking it would let a late supplier undercut everybody who was on time',
      );
    }

    // Checked against M-09 rather than taken from the request. A supplier who could assert their own
    // invitation would be a supplier who needs no invitation.
    if (!(await this.#tenders.isInvited(candidate.rfqId, candidate.supplierAccountId))) {
      throw new QuoteError(
        'not-invited',
        `supplier ${candidate.supplierAccountId} was not invited to ${candidate.rfqId}. A private ` +
          'tender is private, and quoting for one you were not asked about is reading it',
      );
    }

    if (candidate.quantity > tender.quantity) {
      throw new QuoteError(
        'malformed-quantity',
        `the offer covers ${String(candidate.quantity)} and the tender asked for ` +
          `${String(tender.quantity)}. Offering more than was asked for is not an answer to the ` +
          'question, and a buyer cannot accept a quantity they did not want',
      );
    }
    if (candidate.kind === 'full' && candidate.quantity !== tender.quantity) {
      throw new QuoteError(
        'malformed-quantity',
        `a full offer covers the whole quantity. This covers ${String(candidate.quantity)} of ` +
          `${String(tender.quantity)}, which is a partial offer and should say so`,
      );
    }
    if (candidate.kind === 'substitute' && tender.substitutionPolicy === 'none') {
      throw new QuoteError(
        'substitution-not-permitted',
        'this tender asks for exactly what it specified, so a substitute is not an answer to it',
      );
    }

    return this.#converge(
      async (tx) => {
        const byKey = await tx.findQuoteByIdempotencyKey(candidate.idempotencyKey);
        if (byKey !== null) return { quote: sealQuote(byKey), replayed: true };

        await tx.insertQuote(candidate);
        await tx.insertOutbox(makeQuoteEvent(candidate));
        await tx.insertOutbox(makeQuoteAction(candidate));
        return { quote: sealQuote(candidate), replayed: false };
      },
      async (tx) => {
        const byKey = await tx.findQuoteByIdempotencyKey(candidate.idempotencyKey);
        return byKey === null ? null : { quote: sealQuote(byKey), replayed: true };
      },
    );
  }

  /**
   * Take an offer back.
   *
   * The supplier's own, and only theirs. This is how a price is changed: withdraw, then submit a
   * new offer — so both stay on the record and a buyer can see that the price moved.
   */
  withdrawQuote(request: CloseQuoteRequest): Promise<QuoteResult> {
    return this.#transition(request, 'withdrawn', 'supplier', 'withdrawQuote');
  }

  /** The buyer takes this offer. */
  acceptQuote(request: CloseQuoteRequest): Promise<QuoteResult> {
    return this.#transition(request, 'accepted', 'buyer', 'acceptQuote');
  }

  /**
   * The buyer took another.
   *
   * Distinct from expiry, because a supplier is owed the difference between "you lost" and "you
   * were too slow": only one of those is worth changing anything about next time.
   */
  rejectQuote(request: CloseQuoteRequest): Promise<QuoteResult> {
    return this.#transition(request, 'rejected', 'buyer', 'rejectQuote');
  }

  async getQuote(quoteId: string): Promise<Quote | null> {
    const held = await this.#repository.withTransaction((tx) => tx.findQuoteById(quoteId));
    return held === null ? null : sealQuote(held);
  }

  async listQuotesForRfq(rfqId: string): Promise<readonly Quote[]> {
    return sealQuotes(await this.#repository.withTransaction((tx) => tx.findQuotesByRfqId(rfqId)));
  }

  async listQuotesForSupplier(supplierAccountId: string): Promise<readonly Quote[]> {
    return sealQuotes(
      await this.#repository.withTransaction((tx) => tx.findQuotesBySupplier(supplierAccountId)),
    );
  }

  /**
   * Score and order the offers against one tender.
   *
   * Computed on demand rather than stored: a ranking depends on the weights in force and on what
   * else was offered, and both change. A stale score presented as current is worse than none.
   */
  async evaluateQuotes(options: {
    readonly rfqId: string;
    readonly now: string;
    /** 0..1000 per supplier account, or absent where there is no record. Null is not zero. */
    readonly reliability?: Readonly<Record<string, number | null>>;
    readonly ranking?: RankingOptions;
  }): Promise<readonly QuoteEvaluation[]> {
    const tender = await this.#tenders.findTender(options.rfqId);
    if (tender === null) {
      throw new QuoteError('quote-not-found', `no tender with id ${options.rfqId}`);
    }

    const quotes = await this.listQuotesForRfq(options.rfqId);

    // One pass over the whole set: a rank is relative to the other offers, so ranking each supplier
    // separately would compare every offer against itself and produce nothing worth reading.
    const context: QuoteContext = {
      supplierReliabilityPerMille: options.reliability ?? {},
      quantityRequired: tender.quantity,
      requiredBy: tender.requiredBy,
      qualityRequirements: tender.qualityRequirements,
      now: options.now,
    };

    return rankQuotes(quotes, context, options.ranking ?? {});
  }

  async #transition(
    request: CloseQuoteRequest,
    to: QuoteStatus,
    actor: 'supplier' | 'buyer',
    operation: string,
  ): Promise<QuoteResult> {
    assertNoForeignConcerns(request, CLOSE_KEYS, operation);
    assertQuoteIdentifier(request.actingAccountId, 'actingAccountId');
    assertInstant(request.occurredAt, 'occurredAt');

    return this.#converge(
      async (tx) => {
        const before = await tx.findQuoteById(request.quoteId);
        if (before === null) {
          throw new QuoteError('quote-not-found', `no quote with id ${request.quoteId}`);
        }

        // Checked here rather than only at the HTTP edge. The edge knows who is calling; this is
        // where whose offer it is is actually known, and a rule enforced only at the edge is a rule
        // a second caller walks around.
        if (actor === 'supplier' && before.supplierAccountId !== request.actingAccountId) {
          throw new QuoteError(
            'not-your-quote',
            'a supplier may withdraw only their own offer. Withdrawing somebody else’s would let ' +
              'one supplier remove a competitor from a tender',
          );
        }

        if (before.status === to) return { quote: sealQuote(before), replayed: true };

        const allowed = QUOTE_TRANSITIONS[before.status];
        if (!allowed.includes(to)) {
          throw new QuoteError(
            allowed.length === 0 ? 'quote-closed' : 'illegal-transition',
            `an offer that is ${before.status} cannot become ${to}` +
              (allowed.length === 0
                ? '. It has ended, and an offer is binding precisely because it cannot be revised ' +
                  'after the fact'
                : `; from ${before.status} it may become ${allowed.join(', ')}`),
          );
        }

        const after = validateQuote(
          {
            ...before,
            status: to,
            updatedAt: request.occurredAt,
            closedAt: request.occurredAt,
            closureReason: request.reason,
          },
          'request',
        );

        await tx.updateQuote(after);
        await tx.insertOutbox(makeQuoteEvent(after));
        await tx.insertOutbox(makeQuoteAction(after));
        return { quote: sealQuote(after), replayed: false };
      },
      async (tx) => {
        const held = await tx.findQuoteById(request.quoteId);
        if (held === null || held.status !== to) return null;
        return { quote: sealQuote(held), replayed: true };
      },
    );
  }

  async #converge<T>(
    operation: (tx: QuoteTransaction) => Promise<T>,
    recover: (tx: QuoteTransaction) => Promise<T | null>,
  ): Promise<T> {
    try {
      return await this.#repository.withTransaction(operation);
    } catch (error) {
      const conflicted =
        error instanceof QuoteError &&
        (error.code === 'idempotency-key-reuse' || error.code === 'duplicate-quote-id');
      if (!conflicted) throw error;

      const recovered = await this.#repository.withTransaction(recover);
      if (recovered === null) throw error;
      return recovered;
    }
  }
}

function assertNoForeignConcerns(
  request: object,
  permitted: readonly string[],
  operation: string,
): void {
  for (const key of Object.keys(request)) {
    const owner = FOREIGN_FIELDS[key];
    if (owner !== undefined) {
      throw new QuoteError('foreign-concern', `${operation} refuses "${key}": ${owner}`);
    }
    if (!permitted.includes(key)) {
      throw new QuoteError(
        'foreign-concern',
        `${operation} refuses "${key}"; the permitted fields are ${permitted.join(', ')}`,
      );
    }
  }
}

function assertInstant(value: string, field: string): string {
  try {
    return parseInstant(value).source;
  } catch (error) {
    if (error instanceof InvalidInstantError) {
      throw new QuoteError('malformed-instant', `${field}: ${error.message}`);
    }
    throw error;
  }
}
