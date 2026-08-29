/**
 * K-15 Search Foundation — the persistence port.
 *
 * The service is written against this interface. The port exposes document indexing, querying,
 * removal and query-log storage, plus the outbox insert every producing module must support.
 *
 * Documents are replaced whole by `documentId` in this slice. Query logs and outbox entries are
 * append-only.
 *
 * Owned by: K-15 Search Foundation.
 */

import { InMemoryOutboxStore } from '../../platform/outbox/repository.ts';
import type { OutboxEntry, OutboxTransaction } from '../../platform/outbox/types.ts';

import {
  sealSearchDocument,
  sealSearchDocuments,
  sealSearchQueryLog,
  sealSearchQueryLogs,
} from './immutable.ts';
import { SearchError, type SearchDocument, type SearchQueryLog } from './types.ts';

export interface SearchFilters {
  readonly ownerType?: string;
  readonly scope?: string;
  readonly language?: string;
  readonly attributes?: Readonly<Record<string, unknown>>;
}

export interface SearchOptions {
  readonly limit: number;
  readonly offset: number;
}

export interface SearchResult {
  readonly documents: readonly SearchDocument[];
  readonly total: number;
}

export interface SearchTransaction extends OutboxTransaction {
  /** Document lookup and indexing. */
  findDocumentById(documentId: string): Promise<SearchDocument | null>;
  findDocumentByIdempotencyKey(idempotencyKey: string): Promise<SearchDocument | null>;
  insertDocument(document: SearchDocument): Promise<void>;
  deleteDocument(documentId: string): Promise<void>;

  /** Query execution. */
  searchDocuments(
    queryText: string,
    filters: SearchFilters,
    options: SearchOptions,
  ): Promise<SearchResult>;

  /** Query log storage. */
  findQueryLogById(queryId: string): Promise<SearchQueryLog | null>;
  findQueryLogByIdempotencyKey(idempotencyKey: string): Promise<SearchQueryLog | null>;
  insertQueryLog(log: SearchQueryLog): Promise<void>;
}

export interface SearchRepository {
  /**
   * Run `body` in one transaction. An exception must roll everything back — a caller that sees a
   * failure must be able to assume nothing was written.
   */
  withTransaction<T>(body: (tx: SearchTransaction) => Promise<T>): Promise<T>;
}

/**
 * An in-memory repository.
 *
 * The reference implementation of the port's contract. It enforces the same uniqueness rules the
 * database does, and checks them **at commit against the store as it stands** rather than against the
 * snapshot the transaction read. Two callers that both read "no such document" must not both win.
 */
export class InMemorySearchRepository implements SearchRepository {
  #documents: SearchDocument[] = [];
  #queryLogs: SearchQueryLog[] = [];
  readonly #outbox = new InMemoryOutboxStore('K-15', 'kernel_search_foundation');
  transactionsCommitted = 0;
  transactionsRolledBack = 0;

  documents(): readonly SearchDocument[] {
    return sealSearchDocuments(this.#documents);
  }

  queryLogs(): readonly SearchQueryLog[] {
    return sealSearchQueryLogs(this.#queryLogs);
  }

  outbox(): InMemoryOutboxStore {
    return this.#outbox;
  }

  /** Seed state directly, for tests that need a starting point without going through the service. */
  seed(state: {
    readonly documents?: readonly SearchDocument[];
    readonly queryLogs?: readonly SearchQueryLog[];
    readonly outbox?: readonly OutboxEntry[];
  }): void {
    this.#documents = (state.documents ?? []).map(sealSearchDocument);
    this.#queryLogs = (state.queryLogs ?? []).map(sealSearchQueryLog);
    this.#outbox.seed(state.outbox ?? []);
  }

  async withTransaction<T>(body: (tx: SearchTransaction) => Promise<T>): Promise<T> {
    const working = {
      documents: this.#documents.map(sealSearchDocument),
      queryLogs: this.#queryLogs.map(sealSearchQueryLog),
    };
    const outboxWorking = new InMemoryOutboxStore(this.#outbox.name, this.#outbox.schema);
    outboxWorking.seed(this.#outbox.entries());

    const touched = new Touched();
    const tx = new InMemorySearchTransaction(working, outboxWorking, touched);

    try {
      const result = await body(tx);
      this.#commit(working, touched);
      this.#outbox.seed(outboxWorking.entries());
      this.transactionsCommitted += 1;
      return result;
    } catch (error) {
      this.transactionsRolledBack += 1;
      throw error;
    }
  }

  #commit(working: WorkingSet, touched: Touched): void {
    // Documents: idempotency-key conflicts come first, then replace by documentId.
    for (const document of working.documents) {
      if (touched.documentKeys.has(document.idempotencyKey)) {
        const holder = this.#documents.find(
          (held) => held.idempotencyKey === document.idempotencyKey,
        );
        if (holder !== undefined && holder.documentId !== document.documentId) {
          throw new SearchError(
            'idempotency-key-reuse',
            `idempotency key "${document.idempotencyKey}" was used by document ${holder.documentId}, ` +
              'created by another transaction while this one was open',
          );
        }
      }
    }

    // Apply document replacements and deletions.
    if (touched.documents.size > 0 || touched.deletedDocuments.size > 0) {
      this.#documents = this.#documents
        .filter((held) => !touched.deletedDocuments.has(held.documentId))
        .map((held) => {
          const replacement = working.documents.find(
            (candidate) =>
              candidate.documentId === held.documentId &&
              touched.documents.has(candidate.documentId),
          );
          return replacement === undefined ? held : sealSearchDocument(replacement);
        });

      const appended = working.documents.filter(
        (candidate) =>
          touched.documents.has(candidate.documentId) &&
          !this.#documents.some((held) => held.documentId === candidate.documentId),
      );
      this.#documents = [...this.#documents, ...appended.map(sealSearchDocument)];
    }

    // Query logs are append-only.
    for (const log of working.queryLogs) {
      if (touched.queryLogs.has(log.queryId)) {
        if (this.#queryLogs.some((held) => held.queryId === log.queryId)) {
          throw new SearchError(
            'duplicate-query-id',
            `query ${log.queryId} was created by another transaction while this one was open`,
          );
        }
      }
      if (touched.queryLogKeys.has(log.idempotencyKey)) {
        const holder = this.#queryLogs.find((held) => held.idempotencyKey === log.idempotencyKey);
        if (holder !== undefined) {
          throw new SearchError(
            'idempotency-key-reuse',
            `idempotency key "${log.idempotencyKey}" was used by query ${holder.queryId}, ` +
              'created by another transaction while this one was open',
          );
        }
      }
    }

    this.#queryLogs = [
      ...this.#queryLogs,
      ...working.queryLogs
        .filter((log) => touched.queryLogs.has(log.queryId))
        .map(sealSearchQueryLog),
    ];
  }
}

class WorkingSet {
  documents: SearchDocument[];
  queryLogs: SearchQueryLog[];

  constructor(snapshot: { documents: SearchDocument[]; queryLogs: SearchQueryLog[] }) {
    this.documents = snapshot.documents;
    this.queryLogs = snapshot.queryLogs;
  }
}

class Touched {
  readonly documents = new Set<string>();
  readonly documentKeys = new Set<string>();
  readonly deletedDocuments = new Set<string>();
  readonly queryLogs = new Set<string>();
  readonly queryLogKeys = new Set<string>();
}

class InMemorySearchTransaction implements SearchTransaction {
  readonly #state: WorkingSet;
  readonly #outbox: InMemoryOutboxStore;
  readonly #touched: Touched;

  constructor(state: WorkingSet, outbox: InMemoryOutboxStore, touched: Touched) {
    this.#state = state;
    this.#outbox = outbox;
    this.#touched = touched;
  }

  insertOutbox(entry: OutboxEntry): Promise<void> {
    this.#outbox.insert(entry);
    return Promise.resolve();
  }

  findDocumentById(documentId: string): Promise<SearchDocument | null> {
    const found = this.#state.documents.find((d) => d.documentId === documentId);
    return Promise.resolve(found === undefined ? null : sealSearchDocument(found));
  }

  findDocumentByIdempotencyKey(idempotencyKey: string): Promise<SearchDocument | null> {
    const found = this.#state.documents.find((d) => d.idempotencyKey === idempotencyKey);
    return Promise.resolve(found === undefined ? null : sealSearchDocument(found));
  }

  insertDocument(document: SearchDocument): Promise<void> {
    if (this.#state.documents.some((held) => held.idempotencyKey === document.idempotencyKey)) {
      return Promise.reject(
        new SearchError(
          'idempotency-key-reuse',
          `idempotency key "${document.idempotencyKey}" has already been used`,
        ),
      );
    }
    const index = this.#state.documents.findIndex(
      (held) => held.documentId === document.documentId,
    );
    if (index === -1) {
      this.#state.documents.push(sealSearchDocument(document));
    } else {
      this.#state.documents[index] = sealSearchDocument(document);
    }
    this.#touched.documents.add(document.documentId);
    this.#touched.documentKeys.add(document.idempotencyKey);
    return Promise.resolve();
  }

  deleteDocument(documentId: string): Promise<void> {
    const index = this.#state.documents.findIndex((held) => held.documentId === documentId);
    if (index !== -1) {
      this.#state.documents.splice(index, 1);
      this.#touched.deletedDocuments.add(documentId);
    }
    return Promise.resolve();
  }

  searchDocuments(
    queryText: string,
    filters: SearchFilters,
    options: SearchOptions,
  ): Promise<SearchResult> {
    const terms = queryText
      .toLowerCase()
      .split(/\s+/)
      .filter((term) => term.length > 0);

    const matches = this.#state.documents.filter((document) => {
      if (filters.ownerType !== undefined && document.ownerType !== filters.ownerType) return false;
      if (filters.scope !== undefined && document.scope !== filters.scope) return false;
      if (filters.language !== undefined && document.language !== filters.language) return false;
      if (filters.attributes !== undefined) {
        for (const [key, value] of Object.entries(filters.attributes)) {
          if (JSON.stringify(document.attributes[key]) !== JSON.stringify(value)) return false;
        }
      }
      return true;
    });

    const scored = matches
      .map((document) => {
        let score = 0;
        if (terms.length > 0) {
          const words = `${document.title} ${document.description} ${document.keywords.join(' ')}`
            .toLowerCase()
            .split(/\s+/)
            .filter((word) => word.length > 0);
          for (const term of terms) {
            for (const word of words) {
              if (word === term) score += 1;
            }
          }
        }
        return { document, score };
      })
      .filter((entry) => terms.length === 0 || entry.score > 0);

    scored.sort((a, b) => {
      const byScore = b.score - a.score;
      if (byScore !== 0) return byScore;
      const byTime = b.document.updatedAt.localeCompare(a.document.updatedAt);
      if (byTime !== 0) return byTime;
      return b.document.documentId.localeCompare(a.document.documentId);
    });

    const total = scored.length;
    const paged = scored
      .slice(options.offset, options.offset + options.limit)
      .map((entry) => entry.document);
    return Promise.resolve({
      documents: Object.freeze(paged.map(sealSearchDocument)),
      total,
    });
  }

  findQueryLogById(queryId: string): Promise<SearchQueryLog | null> {
    const found = this.#state.queryLogs.find((log) => log.queryId === queryId);
    return Promise.resolve(found === undefined ? null : sealSearchQueryLog(found));
  }

  findQueryLogByIdempotencyKey(idempotencyKey: string): Promise<SearchQueryLog | null> {
    const found = this.#state.queryLogs.find((log) => log.idempotencyKey === idempotencyKey);
    return Promise.resolve(found === undefined ? null : sealSearchQueryLog(found));
  }

  insertQueryLog(log: SearchQueryLog): Promise<void> {
    if (this.#state.queryLogs.some((held) => held.queryId === log.queryId)) {
      return Promise.reject(
        new SearchError(
          'duplicate-query-id',
          `query ${log.queryId} already exists. A query log is created once and never rewritten`,
        ),
      );
    }
    if (this.#state.queryLogs.some((held) => held.idempotencyKey === log.idempotencyKey)) {
      return Promise.reject(
        new SearchError(
          'idempotency-key-reuse',
          `idempotency key "${log.idempotencyKey}" has already been used`,
        ),
      );
    }
    this.#state.queryLogs.push(sealSearchQueryLog(log));
    this.#touched.queryLogs.add(log.queryId);
    this.#touched.queryLogKeys.add(log.idempotencyKey);
    return Promise.resolve();
  }
}
