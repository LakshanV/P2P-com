/**
 * M-10 Quotes — the persistence port and its in-memory reference implementation.
 *
 * Owned by: M-10 Quotes.
 */

import { InMemoryOutboxStore } from '../../platform/outbox/repository.ts';
import type { OutboxEntry, OutboxTransaction } from '../../platform/outbox/types.ts';

import { sealQuote, sealQuotes } from './immutable.ts';
import { QuoteError, type Quote } from './types.ts';

export interface QuoteTransaction extends OutboxTransaction {
  findQuoteById(quoteId: string): Promise<Quote | null>;
  findQuoteByIdempotencyKey(idempotencyKey: string): Promise<Quote | null>;
  /** Every offer against one tender, whatever its status. A buyer sees the withdrawn ones too. */
  findQuotesByRfqId(rfqId: string): Promise<readonly Quote[]>;
  /** One supplier's offers, so they can see what they have quoted for. */
  findQuotesBySupplier(supplierAccountId: string): Promise<readonly Quote[]>;
  insertQuote(quote: Quote): Promise<void>;
  updateQuote(quote: Quote): Promise<void>;
}

export interface QuoteRepository {
  withTransaction<T>(body: (tx: QuoteTransaction) => Promise<T>): Promise<T>;
}

export class InMemoryQuoteRepository implements QuoteRepository {
  #quotes: Quote[] = [];
  readonly #outbox = new InMemoryOutboxStore('M-10', 'module_quotes');
  transactionsCommitted = 0;
  transactionsRolledBack = 0;

  quotes(): readonly Quote[] {
    return sealQuotes(this.#quotes);
  }

  outbox(): InMemoryOutboxStore {
    return this.#outbox;
  }

  seed(state: {
    readonly quotes?: readonly Quote[];
    readonly outbox?: readonly OutboxEntry[];
  }): void {
    this.#quotes = (state.quotes ?? []).map(sealQuote);
    this.#outbox.seed(state.outbox ?? []);
  }

  async withTransaction<T>(body: (tx: QuoteTransaction) => Promise<T>): Promise<T> {
    const working = this.#quotes.map(sealQuote);
    const outboxWorking = new InMemoryOutboxStore(this.#outbox.name, this.#outbox.schema);
    outboxWorking.seed(this.#outbox.entries());

    const created = new Set<string>();
    const tx = new InMemoryQuoteTransaction(working, outboxWorking, created);

    try {
      const result = await body(tx);
      // Against the committed store, because that is what a concurrent transaction would have
      // written into — the snapshot this one read is precisely what it would not have been in.
      for (const quote of working) {
        if (!created.has(quote.quoteId)) continue;
        if (this.#quotes.some((held) => held.quoteId === quote.quoteId)) {
          throw new QuoteError(
            'duplicate-quote-id',
            `quote ${quote.quoteId} was created by another transaction while this one was open`,
          );
        }
        if (this.#quotes.some((held) => held.idempotencyKey === quote.idempotencyKey)) {
          throw new QuoteError(
            'idempotency-key-reuse',
            `idempotency key "${quote.idempotencyKey}" was used by a quote created while this ` +
              'transaction was open',
          );
        }
      }
      this.#quotes = working;
      this.#outbox.seed(outboxWorking.entries());
      this.transactionsCommitted += 1;
      return result;
    } catch (error) {
      this.transactionsRolledBack += 1;
      throw error;
    }
  }
}

class InMemoryQuoteTransaction implements QuoteTransaction {
  readonly #quotes: Quote[];
  readonly #outbox: InMemoryOutboxStore;
  readonly #created: Set<string>;

  constructor(quotes: Quote[], outbox: InMemoryOutboxStore, created: Set<string>) {
    this.#quotes = quotes;
    this.#outbox = outbox;
    this.#created = created;
  }

  insertOutbox(entry: OutboxEntry): Promise<void> {
    this.#outbox.insert(entry);
    return Promise.resolve();
  }

  findQuoteById(quoteId: string): Promise<Quote | null> {
    return Promise.resolve(this.#quotes.find((one) => one.quoteId === quoteId) ?? null);
  }

  findQuoteByIdempotencyKey(idempotencyKey: string): Promise<Quote | null> {
    return Promise.resolve(
      this.#quotes.find((one) => one.idempotencyKey === idempotencyKey) ?? null,
    );
  }

  findQuotesByRfqId(rfqId: string): Promise<readonly Quote[]> {
    return Promise.resolve(
      sealQuotes(
        this.#quotes
          .filter((one) => one.rfqId === rfqId)
          .sort(
            (a, b) =>
              a.submittedAt.localeCompare(b.submittedAt) || a.quoteId.localeCompare(b.quoteId),
          ),
      ),
    );
  }

  findQuotesBySupplier(supplierAccountId: string): Promise<readonly Quote[]> {
    return Promise.resolve(
      sealQuotes(
        this.#quotes
          .filter((one) => one.supplierAccountId === supplierAccountId)
          .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt)),
      ),
    );
  }

  insertQuote(quote: Quote): Promise<void> {
    if (this.#quotes.some((one) => one.quoteId === quote.quoteId)) {
      return Promise.reject(
        new QuoteError('duplicate-quote-id', `quote ${quote.quoteId} already exists`),
      );
    }
    if (this.#quotes.some((one) => one.idempotencyKey === quote.idempotencyKey)) {
      return Promise.reject(
        new QuoteError(
          'idempotency-key-reuse',
          `idempotency key "${quote.idempotencyKey}" already belongs to another quote`,
        ),
      );
    }
    this.#quotes.push(sealQuote(quote));
    this.#created.add(quote.quoteId);
    return Promise.resolve();
  }

  updateQuote(quote: Quote): Promise<void> {
    const index = this.#quotes.findIndex((one) => one.quoteId === quote.quoteId);
    if (index < 0) {
      return Promise.reject(
        new QuoteError('quote-not-found', `quote ${quote.quoteId} does not exist`),
      );
    }
    this.#quotes[index] = sealQuote(quote);
    return Promise.resolve();
  }
}
