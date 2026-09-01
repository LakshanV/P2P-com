/**
 * M-03 Commerce Request — the persistence port, and the in-memory reference implementation.
 *
 * The service is written against the interface. The in-memory implementation is the reference for
 * what the port promises, and it checks its uniqueness rules **at commit, against the store as it
 * stands** rather than against the snapshot the transaction read — because that is what a database
 * does, and an in-memory repository that only checked the snapshot would let two concurrent
 * transactions both succeed where PostgreSQL would refuse one. A test suite that passes against a
 * more forgiving fake is a test suite that proves the wrong thing.
 *
 * Owned by: M-03 Commerce Request.
 */

import { InMemoryOutboxStore } from '../../platform/outbox/repository.ts';
import type { OutboxEntry, OutboxTransaction } from '../../platform/outbox/types.ts';

import {
  sealCommerceRequest,
  sealCommerceRequests,
  sealInterpretation,
  sealInterpretations,
  sealRequestEvent,
  sealRequestEvents,
  sealRequestMedia,
  sealRequestMedias,
} from './immutable.ts';
import {
  CommerceRequestError,
  type CommerceRequest,
  type RequestEvent,
  type RequestInterpretation,
  type RequestMedia,
} from './types.ts';

export interface CommerceRequestTransaction extends OutboxTransaction {
  findRequestById(requestId: string): Promise<CommerceRequest | null>;
  findRequestByIdempotencyKey(idempotencyKey: string): Promise<CommerceRequest | null>;
  findRequestsByAccountId(accountId: string): Promise<readonly CommerceRequest[]>;
  insertRequest(request: CommerceRequest): Promise<void>;
  updateRequest(request: CommerceRequest): Promise<void>;

  findInterpretationById(interpretationId: string): Promise<RequestInterpretation | null>;
  findInterpretationByIdempotencyKey(idempotencyKey: string): Promise<RequestInterpretation | null>;
  findInterpretationsByRequestId(requestId: string): Promise<readonly RequestInterpretation[]>;
  insertInterpretation(interpretation: RequestInterpretation): Promise<void>;

  findMediaById(mediaId: string): Promise<RequestMedia | null>;
  findMediaByIdempotencyKey(idempotencyKey: string): Promise<RequestMedia | null>;
  findMediaByRequestId(requestId: string): Promise<readonly RequestMedia[]>;
  insertMedia(media: RequestMedia): Promise<void>;

  findEventsByRequestId(requestId: string): Promise<readonly RequestEvent[]>;
  insertEvent(event: RequestEvent): Promise<void>;
}

export interface CommerceRequestRepository {
  withTransaction<T>(body: (tx: CommerceRequestTransaction) => Promise<T>): Promise<T>;
}

interface Store {
  requests: CommerceRequest[];
  interpretations: RequestInterpretation[];
  medias: RequestMedia[];
  events: RequestEvent[];
}

/** What one transaction created or changed, so commit knows what to check. */
class Touched {
  readonly requests = new Set<string>();
  readonly requestUpdates = new Set<string>();
  readonly requestKeys = new Set<string>();
  readonly interpretations = new Set<string>();
  readonly interpretationKeys = new Set<string>();
  readonly medias = new Set<string>();
  readonly mediaKeys = new Set<string>();
  readonly events = new Set<string>();
}

export class InMemoryCommerceRequestRepository implements CommerceRequestRepository {
  #store: Store = { requests: [], interpretations: [], medias: [], events: [] };
  readonly #outbox = new InMemoryOutboxStore('M-03', 'module_commerce_request');
  transactionsCommitted = 0;
  transactionsRolledBack = 0;

  requests(): readonly CommerceRequest[] {
    return sealCommerceRequests(this.#store.requests);
  }

  interpretations(): readonly RequestInterpretation[] {
    return sealInterpretations(this.#store.interpretations);
  }

  medias(): readonly RequestMedia[] {
    return sealRequestMedias(this.#store.medias);
  }

  events(): readonly RequestEvent[] {
    return sealRequestEvents(this.#store.events);
  }

  outbox(): InMemoryOutboxStore {
    return this.#outbox;
  }

  /** Seed state directly, for a test that needs a starting point without going through the service. */
  seed(state: {
    readonly requests?: readonly CommerceRequest[];
    readonly interpretations?: readonly RequestInterpretation[];
    readonly medias?: readonly RequestMedia[];
    readonly events?: readonly RequestEvent[];
    readonly outbox?: readonly OutboxEntry[];
  }): void {
    this.#store = {
      requests: (state.requests ?? []).map(sealCommerceRequest),
      interpretations: (state.interpretations ?? []).map(sealInterpretation),
      medias: (state.medias ?? []).map(sealRequestMedia),
      events: (state.events ?? []).map(sealRequestEvent),
    };
    this.#outbox.seed(state.outbox ?? []);
  }

  async withTransaction<T>(body: (tx: CommerceRequestTransaction) => Promise<T>): Promise<T> {
    const working: Store = {
      requests: this.#store.requests.map(sealCommerceRequest),
      interpretations: this.#store.interpretations.map(sealInterpretation),
      medias: this.#store.medias.map(sealRequestMedia),
      events: this.#store.events.map(sealRequestEvent),
    };
    const outboxWorking = new InMemoryOutboxStore(this.#outbox.name, this.#outbox.schema);
    outboxWorking.seed(this.#outbox.entries());

    const touched = new Touched();
    const tx = new InMemoryCommerceRequestTransaction(working, outboxWorking, touched);

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

  /**
   * Apply the transaction, refusing anything another transaction has done in the meantime.
   *
   * Every check is against `this.#store` — the committed state — and not against the working copy,
   * because the working copy is exactly what a concurrent transaction would not have been in.
   */
  #commit(working: Store, touched: Touched): void {
    for (const request of working.requests) {
      if (touched.requestKeys.has(request.idempotencyKey)) {
        const holder = this.#store.requests.find(
          (held) => held.idempotencyKey === request.idempotencyKey,
        );
        if (holder !== undefined && holder.requestId !== request.requestId) {
          throw new CommerceRequestError(
            'idempotency-key-reuse',
            `idempotency key "${request.idempotencyKey}" was used by request ${holder.requestId}, ` +
              'created by another transaction while this one was open',
          );
        }
      }
      if (
        touched.requests.has(request.requestId) &&
        this.#store.requests.some((held) => held.requestId === request.requestId)
      ) {
        throw new CommerceRequestError(
          'duplicate-request-id',
          `request ${request.requestId} was created by another transaction while this one was open`,
        );
      }
    }

    for (const request of working.requests) {
      if (touched.requestUpdates.has(request.requestId)) {
        this.#store.requests = this.#store.requests.map((held) =>
          held.requestId === request.requestId ? sealCommerceRequest(request) : held,
        );
      }
    }
    this.#store.requests = [
      ...this.#store.requests,
      ...working.requests
        .filter((request) => touched.requests.has(request.requestId))
        .map(sealCommerceRequest),
    ];

    this.#appendUnique(
      working.interpretations,
      touched.interpretations,
      touched.interpretationKeys,
      (one) => one.interpretationId,
      this.#store.interpretations,
      'duplicate-interpretation-id',
      'interpretation',
      sealInterpretation,
    );
    this.#store.interpretations = [
      ...this.#store.interpretations,
      ...working.interpretations
        .filter((one) => touched.interpretations.has(one.interpretationId))
        .map(sealInterpretation),
    ];

    this.#appendUnique(
      working.medias,
      touched.medias,
      touched.mediaKeys,
      (one) => one.mediaId,
      this.#store.medias,
      'duplicate-media-id',
      'media',
      sealRequestMedia,
    );
    this.#store.medias = [
      ...this.#store.medias,
      ...working.medias.filter((one) => touched.medias.has(one.mediaId)).map(sealRequestMedia),
    ];

    this.#store.events = [
      ...this.#store.events,
      ...working.events.filter((one) => touched.events.has(one.eventId)).map(sealRequestEvent),
    ];
  }

  /** The shared half of the append-only checks: same id, or same idempotency key, already stored. */
  #appendUnique<T extends { readonly idempotencyKey: string }>(
    working: readonly T[],
    touchedIds: ReadonlySet<string>,
    touchedKeys: ReadonlySet<string>,
    idOf: (one: T) => string,
    stored: readonly T[],
    duplicateCode: 'duplicate-interpretation-id' | 'duplicate-media-id',
    what: string,
    _seal: (one: T) => T,
  ): void {
    for (const one of working) {
      if (touchedIds.has(idOf(one)) && stored.some((held) => idOf(held) === idOf(one))) {
        throw new CommerceRequestError(
          duplicateCode,
          `${what} ${idOf(one)} was created by another transaction while this one was open`,
        );
      }
      if (
        touchedKeys.has(one.idempotencyKey) &&
        stored.some((held) => held.idempotencyKey === one.idempotencyKey)
      ) {
        throw new CommerceRequestError(
          'idempotency-key-reuse',
          `idempotency key "${one.idempotencyKey}" was used by another ${what} created while this ` +
            'transaction was open',
        );
      }
    }
  }
}

class InMemoryCommerceRequestTransaction implements CommerceRequestTransaction {
  readonly #store: Store;
  readonly #outbox: InMemoryOutboxStore;
  readonly #touched: Touched;

  constructor(store: Store, outbox: InMemoryOutboxStore, touched: Touched) {
    this.#store = store;
    this.#outbox = outbox;
    this.#touched = touched;
  }

  insertOutbox(entry: OutboxEntry): Promise<void> {
    this.#outbox.insert(entry);
    return Promise.resolve();
  }

  findRequestById(requestId: string): Promise<CommerceRequest | null> {
    return Promise.resolve(this.#store.requests.find((one) => one.requestId === requestId) ?? null);
  }

  findRequestByIdempotencyKey(idempotencyKey: string): Promise<CommerceRequest | null> {
    return Promise.resolve(
      this.#store.requests.find((one) => one.idempotencyKey === idempotencyKey) ?? null,
    );
  }

  findRequestsByAccountId(accountId: string): Promise<readonly CommerceRequest[]> {
    return Promise.resolve(
      sealCommerceRequests(
        this.#store.requests
          .filter((one) => one.accountId === accountId)
          // Newest first: a cockpit shows what somebody asked for most recently, and ordering here
          // means every adapter agrees rather than each choosing.
          .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt)),
      ),
    );
  }

  insertRequest(request: CommerceRequest): Promise<void> {
    if (this.#store.requests.some((one) => one.requestId === request.requestId)) {
      return Promise.reject(
        new CommerceRequestError(
          'duplicate-request-id',
          `request ${request.requestId} already exists`,
        ),
      );
    }
    if (this.#store.requests.some((one) => one.idempotencyKey === request.idempotencyKey)) {
      return Promise.reject(
        new CommerceRequestError(
          'idempotency-key-reuse',
          `idempotency key "${request.idempotencyKey}" already belongs to another request`,
        ),
      );
    }
    this.#store.requests.push(sealCommerceRequest(request));
    this.#touched.requests.add(request.requestId);
    this.#touched.requestKeys.add(request.idempotencyKey);
    return Promise.resolve();
  }

  updateRequest(request: CommerceRequest): Promise<void> {
    const index = this.#store.requests.findIndex((one) => one.requestId === request.requestId);
    if (index < 0) {
      return Promise.reject(
        new CommerceRequestError(
          'request-not-found',
          `request ${request.requestId} does not exist`,
        ),
      );
    }
    this.#store.requests[index] = sealCommerceRequest(request);
    this.#touched.requestUpdates.add(request.requestId);
    return Promise.resolve();
  }

  findInterpretationById(interpretationId: string): Promise<RequestInterpretation | null> {
    return Promise.resolve(
      this.#store.interpretations.find((one) => one.interpretationId === interpretationId) ?? null,
    );
  }

  findInterpretationByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<RequestInterpretation | null> {
    return Promise.resolve(
      this.#store.interpretations.find((one) => one.idempotencyKey === idempotencyKey) ?? null,
    );
  }

  findInterpretationsByRequestId(requestId: string): Promise<readonly RequestInterpretation[]> {
    return Promise.resolve(
      sealInterpretations(
        this.#store.interpretations
          .filter((one) => one.requestId === requestId)
          .sort((a, b) => a.version - b.version),
      ),
    );
  }

  insertInterpretation(interpretation: RequestInterpretation): Promise<void> {
    if (
      this.#store.interpretations.some(
        (one) => one.interpretationId === interpretation.interpretationId,
      )
    ) {
      return Promise.reject(
        new CommerceRequestError(
          'duplicate-interpretation-id',
          `interpretation ${interpretation.interpretationId} already exists`,
        ),
      );
    }
    if (
      this.#store.interpretations.some(
        (one) => one.idempotencyKey === interpretation.idempotencyKey,
      )
    ) {
      return Promise.reject(
        new CommerceRequestError(
          'idempotency-key-reuse',
          `idempotency key "${interpretation.idempotencyKey}" already belongs to another ` +
            'interpretation',
        ),
      );
    }
    if (
      this.#store.interpretations.some(
        (one) =>
          one.requestId === interpretation.requestId && one.version === interpretation.version,
      )
    ) {
      return Promise.reject(
        new CommerceRequestError(
          'duplicate-interpretation-id',
          `request ${interpretation.requestId} already has an interpretation at version ` +
            `${String(interpretation.version)}. Versions are how the history is ordered, so two ` +
            'readings claiming the same one would make the sequence unreadable',
        ),
      );
    }
    this.#store.interpretations.push(sealInterpretation(interpretation));
    this.#touched.interpretations.add(interpretation.interpretationId);
    this.#touched.interpretationKeys.add(interpretation.idempotencyKey);
    return Promise.resolve();
  }

  findMediaById(mediaId: string): Promise<RequestMedia | null> {
    return Promise.resolve(this.#store.medias.find((one) => one.mediaId === mediaId) ?? null);
  }

  findMediaByIdempotencyKey(idempotencyKey: string): Promise<RequestMedia | null> {
    return Promise.resolve(
      this.#store.medias.find((one) => one.idempotencyKey === idempotencyKey) ?? null,
    );
  }

  findMediaByRequestId(requestId: string): Promise<readonly RequestMedia[]> {
    return Promise.resolve(
      sealRequestMedias(
        this.#store.medias
          .filter((one) => one.requestId === requestId)
          .sort((a, b) => a.position - b.position),
      ),
    );
  }

  insertMedia(media: RequestMedia): Promise<void> {
    if (this.#store.medias.some((one) => one.mediaId === media.mediaId)) {
      return Promise.reject(
        new CommerceRequestError('duplicate-media-id', `media ${media.mediaId} already exists`),
      );
    }
    if (this.#store.medias.some((one) => one.idempotencyKey === media.idempotencyKey)) {
      return Promise.reject(
        new CommerceRequestError(
          'idempotency-key-reuse',
          `idempotency key "${media.idempotencyKey}" already belongs to other media`,
        ),
      );
    }
    this.#store.medias.push(sealRequestMedia(media));
    this.#touched.medias.add(media.mediaId);
    this.#touched.mediaKeys.add(media.idempotencyKey);
    return Promise.resolve();
  }

  findEventsByRequestId(requestId: string): Promise<readonly RequestEvent[]> {
    return Promise.resolve(
      sealRequestEvents(
        this.#store.events
          .filter((one) => one.requestId === requestId)
          .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt)),
      ),
    );
  }

  insertEvent(event: RequestEvent): Promise<void> {
    if (this.#store.events.some((one) => one.eventId === event.eventId)) {
      // Not an error: a replayed transition writes the same event, and the transition log is the
      // record of what happened rather than of how many times somebody asked.
      return Promise.resolve();
    }
    this.#store.events.push(sealRequestEvent(event));
    this.#touched.events.add(event.eventId);
    return Promise.resolve();
  }
}
