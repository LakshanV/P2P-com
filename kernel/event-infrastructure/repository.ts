/**
 * K-08 Event Infrastructure — the persistence port (FND-003b).
 *
 * The service is written against this interface and never against a driver or a broker, because
 * the behaviour that matters here is precisely the behaviour that is miserable to provoke against
 * a real one: two workers claiming the same delivery, a worker dying between a handler succeeding
 * and its acknowledgement, a lease expiring mid-flight, a replay racing a redelivery. All of those
 * are three lines against an injected fake and a flaky afternoon against a server.
 *
 * **The operations are shaped by the guarantees, not by convenience.** Every mutation that decides
 * who owns a piece of work is conditional on the state the caller believed it was acting on:
 *
 *   - `claimDueDeliveries` moves rows to `in-flight` and stamps a fresh claim token. The token
 *     identifies *one claim*, not one worker.
 *   - `completeDelivery`, `rescheduleDelivery` and `deadLetterDelivery` are all conditional on that
 *     token still being current. A worker whose lease expired holds a stale token, finds nothing to
 *     update, and is refused — which is the only thing standing between at-least-once delivery and
 *     two workers both declaring the same delivery authoritatively finished.
 *
 * That conditionality is the concurrency control. It is not an optimisation and it is not advisory:
 * remove it and the component silently loses the guarantee it exists to provide.
 *
 * Owned by: K-08 Event Infrastructure.
 */

import { compareInstants } from '../../platform/time/instant.ts';

import {
  EventError,
  TERMINAL_DELIVERY_STATUSES,
  type ConsumerReceipt,
  type Delivery,
  type EventEnvelope,
} from './types.ts';

/** What a claim needs to say about itself. */
export interface ClaimRequest {
  readonly subscription: string;
  /** Only deliveries due at or before this instant are claimable. */
  readonly now: string;
  readonly limit: number;
  readonly worker: string;
  /**
   * Caller-supplied, unique per claim.
   *
   * Supplied rather than generated so the component stays deterministic; a caller that reuses one
   * has defeated its own lease, which is why the in-memory implementation refuses a token already
   * in flight.
   */
  readonly claimToken: string;
  /** After this instant the claim is void and the delivery may be re-claimed by anyone. */
  readonly claimExpiresAt: string;
}

export interface EventTransaction {
  /** The exact envelope, or null. Historical reads and replay both go through this. */
  findEventById(eventId: string): Promise<EventEnvelope | null>;

  /** A previous publication with this idempotency key, if one exists. */
  findEventByIdempotencyKey(idempotencyKey: string): Promise<EventEnvelope | null>;

  /**
   * Append an event. Must refuse a duplicate id and a reused idempotency key.
   *
   * There is deliberately no update operation for an event anywhere in this port. An envelope is
   * evidence; a port that could rewrite one would make every consumer's record of the past
   * conditional on nobody having done so.
   */
  insertEvent(envelope: EventEnvelope): Promise<void>;

  findDeliveryById(deliveryId: string): Promise<Delivery | null>;

  /** Every delivery for one event, oldest generation first. */
  findDeliveriesForEvent(eventId: string): Promise<readonly Delivery[]>;

  /** The delivery for a subscription at the newest generation, or null. */
  findLatestDelivery(eventId: string, subscription: string): Promise<Delivery | null>;

  insertDelivery(delivery: Delivery): Promise<void>;

  /**
   * Claim up to `limit` due deliveries, oldest first.
   *
   * "Due" means `pending` with `nextAttemptAt <= now`, or `in-flight` with an expired lease — the
   * second case is how a crashed worker's work returns to the pool without an operator.
   */
  claimDueDeliveries(request: ClaimRequest): Promise<readonly Delivery[]>;

  /**
   * Mark a delivery `delivered`, conditional on `claimToken` still being the current claim.
   *
   * Must refuse otherwise: this is what stops a worker that has lost its lease from reporting
   * success for work another worker now owns.
   */
  completeDelivery(deliveryId: string, claimToken: string, completedAt: string): Promise<void>;

  /** Return a delivery to `pending` with a new due time, conditional on the claim token. */
  rescheduleDelivery(
    deliveryId: string,
    claimToken: string,
    nextAttemptAt: string,
    lastError: string,
  ): Promise<void>;

  /** Terminal failure, conditional on the claim token. */
  deadLetterDelivery(
    deliveryId: string,
    claimToken: string,
    at: string,
    lastError: string,
  ): Promise<void>;

  findReceipt(subscription: string, eventId: string): Promise<ConsumerReceipt | null>;

  /** Written in the same transaction as the acknowledgement, never separately. */
  insertReceipt(receipt: ConsumerReceipt): Promise<void>;

  /** Operator-explicit, and recorded: which receipt was discarded, by whom, and why. */
  deleteReceipt(subscription: string, eventId: string): Promise<boolean>;
}

export interface EventRepository {
  /**
   * Run `body` in one transaction. An exception rolls everything back — a caller that sees a
   * failure must be able to assume nothing was written, including a receipt written next to an
   * acknowledgement that never happened.
   */
  withTransaction<T>(body: (tx: EventTransaction) => Promise<T>): Promise<T>;
}

/**
 * An in-memory repository.
 *
 * The reference implementation of the port's contract, not a convenience double: it enforces the
 * same invariants the database does — unique event ids, unique idempotency keys, one delivery per
 * (event, subscription, generation), one receipt per (subscription, event), and claim-token
 * conditionality on every completion path.
 *
 * Transactions read a snapshot on entry and, on commit, apply only the rows they wrote onto the
 * current store, refusing if those rows moved underneath them. Two workers that overlap therefore
 * behave here as they would against a server: one wins and the other is told it lost, rather than
 * the later commit quietly overwriting the earlier.
 */
export class InMemoryEventRepository implements EventRepository {
  #events: EventEnvelope[] = [];
  #deliveries: Delivery[] = [];
  #receipts: ConsumerReceipt[] = [];
  transactionsCommitted = 0;
  transactionsRolledBack = 0;

  events(): readonly EventEnvelope[] {
    return this.#events.map((event) => ({ ...event, payload: { ...event.payload } }));
  }

  deliveries(): readonly Delivery[] {
    return this.#deliveries.map((delivery) => ({ ...delivery }));
  }

  receipts(): readonly ConsumerReceipt[] {
    return this.#receipts.map((receipt) => ({ ...receipt }));
  }

  /** Seed state directly, for tests that need a starting point without going through the service. */
  seed(state: {
    events?: readonly EventEnvelope[];
    deliveries?: readonly Delivery[];
    receipts?: readonly ConsumerReceipt[];
  }): void {
    if (state.events !== undefined) this.#events = state.events.map((event) => ({ ...event }));
    if (state.deliveries !== undefined)
      this.#deliveries = state.deliveries.map((delivery) => ({ ...delivery }));
    if (state.receipts !== undefined)
      this.#receipts = state.receipts.map((receipt) => ({ ...receipt }));
  }

  async withTransaction<T>(body: (tx: EventTransaction) => Promise<T>): Promise<T> {
    const base = {
      events: this.#events.map((event) => ({ ...event })),
      deliveries: this.#deliveries.map((delivery) => ({ ...delivery })),
      receipts: this.#receipts.map((receipt) => ({ ...receipt })),
    };
    const working = {
      events: base.events.map((event) => ({ ...event })),
      deliveries: base.deliveries.map((delivery) => ({ ...delivery })),
      receipts: base.receipts.map((receipt) => ({ ...receipt })),
    };
    const tx = new InMemoryEventTransaction(working);

    try {
      const result = await body(tx);
      this.#commit(base, working, tx.touchedDeliveries);
      this.transactionsCommitted += 1;
      return result;
    } catch (error) {
      this.transactionsRolledBack += 1;
      throw error;
    }
  }

  /**
   * Apply this transaction's writes onto the store as it stands now.
   *
   * Deliveries are merged row by row and refused if the row moved since the snapshot, because that
   * is exactly the race this component exists to survive: two workers that both read a pending
   * delivery must not both succeed at claiming it. Events and receipts are append-only, so a
   * conflicting append is refused rather than merged.
   */
  #commit(
    base: { events: EventEnvelope[]; deliveries: Delivery[]; receipts: ConsumerReceipt[] },
    working: { events: EventEnvelope[]; deliveries: Delivery[]; receipts: ConsumerReceipt[] },
    touchedDeliveries: ReadonlySet<string>,
  ): void {
    const baseDeliveries = new Map(base.deliveries.map((row) => [row.deliveryId, row]));
    const currentDeliveries = new Map(this.#deliveries.map((row) => [row.deliveryId, row]));
    const merged = this.#deliveries.map((row) => ({ ...row }));
    const indexById = new Map(merged.map((row, index) => [row.deliveryId, index]));

    for (const deliveryId of touchedDeliveries) {
      const written = working.deliveries.find((row) => row.deliveryId === deliveryId);
      if (written === undefined) continue;

      const before = baseDeliveries.get(deliveryId);
      const now = currentDeliveries.get(deliveryId);

      if (before === undefined) {
        if (now !== undefined) {
          throw new EventError(
            'concurrent-modification',
            `delivery ${deliveryId} was inserted by another transaction while this one was open`,
          );
        }
        indexById.set(deliveryId, merged.length);
        merged.push({ ...written });
        continue;
      }

      if (now === undefined || !sameDeliveryState(before, now)) {
        throw new EventError(
          'concurrent-modification',
          `delivery ${deliveryId} changed underneath this transaction — it was ${before.status} ` +
            `holding ${before.claimToken ?? 'no claim'} when read, and is ${now?.status ?? 'gone'} ` +
            `holding ${now?.claimToken ?? 'no claim'} now`,
        );
      }
      merged[indexById.get(deliveryId) as number] = { ...written };
    }

    const currentEventIds = new Set(this.#events.map((event) => event.eventId));
    const appendedEvents = working.events.filter((event) => !baseEventIds(base).has(event.eventId));
    for (const event of appendedEvents) {
      if (currentEventIds.has(event.eventId)) {
        throw new EventError(
          'duplicate-event-id',
          `event ${event.eventId} was appended by another transaction while this one was open`,
        );
      }
    }

    const currentReceiptKeys = new Set(this.#receipts.map(receiptKey));
    const baseReceiptKeys = new Set(base.receipts.map(receiptKey));
    const appendedReceipts = working.receipts.filter(
      (receipt) => !baseReceiptKeys.has(receiptKey(receipt)),
    );
    for (const receipt of appendedReceipts) {
      if (currentReceiptKeys.has(receiptKey(receipt))) {
        throw new EventError(
          'concurrent-modification',
          `${receipt.subscription} already recorded a receipt for ${receipt.eventId}; another ` +
            'transaction acknowledged it first',
        );
      }
    }
    const removedReceipts = new Set(
      base.receipts
        .map(receiptKey)
        .filter((key) => !working.receipts.some((receipt) => receiptKey(receipt) === key)),
    );

    this.#deliveries = merged;
    this.#events = [...this.#events, ...appendedEvents.map((event) => ({ ...event }))];
    this.#receipts = [
      ...this.#receipts.filter((receipt) => !removedReceipts.has(receiptKey(receipt))),
      ...appendedReceipts.map((receipt) => ({ ...receipt })),
    ];
  }
}

const baseEventIds = (base: { events: EventEnvelope[] }): ReadonlySet<string> =>
  new Set(base.events.map((event) => event.eventId));

const receiptKey = (receipt: ConsumerReceipt): string =>
  `${receipt.subscription}|${receipt.eventId}`;

/** Only the fields a competing worker can move. Content is immutable and cannot be raced on. */
function sameDeliveryState(a: Delivery, b: Delivery): boolean {
  return (
    a.status === b.status &&
    a.attempts === b.attempts &&
    a.claimToken === b.claimToken &&
    a.claimedBy === b.claimedBy &&
    a.claimExpiresAt === b.claimExpiresAt &&
    a.nextAttemptAt === b.nextAttemptAt &&
    a.completedAt === b.completedAt
  );
}

class InMemoryEventTransaction implements EventTransaction {
  readonly #state: {
    events: EventEnvelope[];
    deliveries: Delivery[];
    receipts: ConsumerReceipt[];
  };

  /** Every delivery this transaction wrote, so the commit applies those rows and only those. */
  readonly touchedDeliveries = new Set<string>();

  constructor(state: {
    events: EventEnvelope[];
    deliveries: Delivery[];
    receipts: ConsumerReceipt[];
  }) {
    this.#state = state;
  }

  findEventById(eventId: string): Promise<EventEnvelope | null> {
    return Promise.resolve(this.#state.events.find((event) => event.eventId === eventId) ?? null);
  }

  findEventByIdempotencyKey(idempotencyKey: string): Promise<EventEnvelope | null> {
    return Promise.resolve(
      this.#state.events.find((event) => event.idempotencyKey === idempotencyKey) ?? null,
    );
  }

  insertEvent(envelope: EventEnvelope): Promise<void> {
    if (this.#state.events.some((event) => event.eventId === envelope.eventId)) {
      return Promise.reject(
        new EventError(
          'duplicate-event-id',
          `event ${envelope.eventId} already exists. An event is evidence and is never rewritten`,
        ),
      );
    }
    if (this.#state.events.some((event) => event.idempotencyKey === envelope.idempotencyKey)) {
      return Promise.reject(
        new EventError(
          'idempotency-key-reuse',
          `idempotency key "${envelope.idempotencyKey}" has already been used`,
        ),
      );
    }
    this.#state.events.push({ ...envelope, payload: { ...envelope.payload } });
    return Promise.resolve();
  }

  findDeliveryById(deliveryId: string): Promise<Delivery | null> {
    return Promise.resolve(
      this.#state.deliveries.find((delivery) => delivery.deliveryId === deliveryId) ?? null,
    );
  }

  findDeliveriesForEvent(eventId: string): Promise<readonly Delivery[]> {
    return Promise.resolve(
      this.#state.deliveries
        .filter((delivery) => delivery.eventId === eventId)
        .sort(
          (a, b) =>
            a.generation - b.generation ||
            a.subscription.localeCompare(b.subscription) ||
            a.deliveryId.localeCompare(b.deliveryId),
        ),
    );
  }

  findLatestDelivery(eventId: string, subscription: string): Promise<Delivery | null> {
    const matching = this.#state.deliveries
      .filter((delivery) => delivery.eventId === eventId && delivery.subscription === subscription)
      .sort((a, b) => b.generation - a.generation);
    return Promise.resolve(matching[0] ?? null);
  }

  insertDelivery(delivery: Delivery): Promise<void> {
    if (this.#state.deliveries.some((row) => row.deliveryId === delivery.deliveryId)) {
      return Promise.reject(
        new EventError('concurrent-modification', `delivery ${delivery.deliveryId} already exists`),
      );
    }
    const clash = this.#state.deliveries.some(
      (row) =>
        row.eventId === delivery.eventId &&
        row.subscription === delivery.subscription &&
        row.generation === delivery.generation,
    );
    if (clash) {
      return Promise.reject(
        new EventError(
          'concurrent-modification',
          `${delivery.subscription} already has a generation-${delivery.generation} delivery for ` +
            `${delivery.eventId}. A replay appends the next generation rather than reusing one`,
        ),
      );
    }
    this.#state.deliveries.push({ ...delivery });
    this.touchedDeliveries.add(delivery.deliveryId);
    return Promise.resolve();
  }

  claimDueDeliveries(request: ClaimRequest): Promise<readonly Delivery[]> {
    if (request.limit < 1) return Promise.resolve([]);
    if (compareInstants(request.claimExpiresAt, request.now) <= 0) {
      return Promise.reject(
        new EventError(
          'malformed-envelope',
          `claim lease expires at ${request.claimExpiresAt}, which is not after ${request.now}; a ` +
            'lease that has already expired protects nothing',
        ),
      );
    }
    if (this.#state.deliveries.some((row) => row.claimToken === request.claimToken)) {
      return Promise.reject(
        new EventError(
          'claim-token-reuse',
          `claim token "${request.claimToken}" is already held by a delivery. A token identifies ` +
            'one claim, not one worker; reusing one means two claims cannot be told apart, and ' +
            'the guard that stops a stale worker acknowledging depends on telling them apart',
        ),
      );
    }

    const due = this.#state.deliveries
      .filter((delivery) => delivery.subscription === request.subscription)
      .filter((delivery) => isClaimable(delivery, request.now))
      .sort(
        (a, b) =>
          compareInstants(a.nextAttemptAt, b.nextAttemptAt) ||
          a.deliveryId.localeCompare(b.deliveryId),
      )
      .slice(0, request.limit);

    const claimed: Delivery[] = [];
    for (const delivery of due) {
      const index = this.#state.deliveries.findIndex(
        (row) => row.deliveryId === delivery.deliveryId,
      );
      const updated: Delivery = {
        ...delivery,
        status: 'in-flight',
        // Incremented at claim, not at failure: a worker that dies mid-handler must still burn an
        // attempt, or a payload that reliably kills its consumer is retried for ever.
        attempts: delivery.attempts + 1,
        claimedBy: request.worker,
        claimToken: request.claimToken,
        claimExpiresAt: request.claimExpiresAt,
      };
      this.#state.deliveries[index] = updated;
      this.touchedDeliveries.add(delivery.deliveryId);
      claimed.push(updated);
    }
    return Promise.resolve(claimed);
  }

  completeDelivery(deliveryId: string, claimToken: string, completedAt: string): Promise<void> {
    return this.#transition(deliveryId, claimToken, (delivery) => ({
      ...delivery,
      status: 'delivered',
      completedAt,
      claimedBy: null,
      claimToken: null,
      claimExpiresAt: null,
    }));
  }

  rescheduleDelivery(
    deliveryId: string,
    claimToken: string,
    nextAttemptAt: string,
    lastError: string,
  ): Promise<void> {
    return this.#transition(deliveryId, claimToken, (delivery) => ({
      ...delivery,
      status: 'pending',
      nextAttemptAt,
      lastError,
      claimedBy: null,
      claimToken: null,
      claimExpiresAt: null,
    }));
  }

  deadLetterDelivery(
    deliveryId: string,
    claimToken: string,
    at: string,
    lastError: string,
  ): Promise<void> {
    return this.#transition(deliveryId, claimToken, (delivery) => ({
      ...delivery,
      status: 'dead-lettered',
      completedAt: at,
      lastError,
      claimedBy: null,
      claimToken: null,
      claimExpiresAt: null,
    }));
  }

  /**
   * Every terminal transition, guarded identically.
   *
   * The guard is the whole mechanism: `in-flight` **and** holding this exact claim token. A worker
   * whose lease expired fails the second half even though the delivery may look in-flight again,
   * because the new claim replaced the token.
   */
  #transition(
    deliveryId: string,
    claimToken: string,
    change: (delivery: Delivery) => Delivery,
  ): Promise<void> {
    const index = this.#state.deliveries.findIndex((row) => row.deliveryId === deliveryId);
    const existing = index === -1 ? undefined : this.#state.deliveries[index];
    if (existing === undefined) {
      return Promise.reject(
        new EventError('no-such-delivery', `no delivery ${deliveryId} to complete`),
      );
    }
    if (TERMINAL_DELIVERY_STATUSES.includes(existing.status)) {
      return Promise.reject(
        new EventError(
          'obsolete-delivery',
          `delivery ${deliveryId} is already ${existing.status}. A terminal delivery is never ` +
            'reopened; a replay appends a new generation instead',
        ),
      );
    }
    if (existing.status !== 'in-flight' || existing.claimToken !== claimToken) {
      return Promise.reject(
        new EventError(
          'stale-claim',
          `delivery ${deliveryId} is ${existing.status} holding ` +
            `${existing.claimToken ?? 'no claim'}, not claim "${claimToken}". The lease was lost ` +
            'and another worker owns this delivery — this one may not report on it',
        ),
      );
    }
    this.#state.deliveries[index] = change(existing);
    this.touchedDeliveries.add(deliveryId);
    return Promise.resolve();
  }

  findReceipt(subscription: string, eventId: string): Promise<ConsumerReceipt | null> {
    return Promise.resolve(
      this.#state.receipts.find(
        (receipt) => receipt.subscription === subscription && receipt.eventId === eventId,
      ) ?? null,
    );
  }

  insertReceipt(receipt: ConsumerReceipt): Promise<void> {
    const exists = this.#state.receipts.some(
      (existing) =>
        existing.subscription === receipt.subscription && existing.eventId === receipt.eventId,
    );
    if (exists) {
      return Promise.reject(
        new EventError(
          'concurrent-modification',
          `${receipt.subscription} has already recorded a receipt for ${receipt.eventId}`,
        ),
      );
    }
    this.#state.receipts.push({ ...receipt });
    return Promise.resolve();
  }

  deleteReceipt(subscription: string, eventId: string): Promise<boolean> {
    const index = this.#state.receipts.findIndex(
      (receipt) => receipt.subscription === subscription && receipt.eventId === eventId,
    );
    if (index === -1) return Promise.resolve(false);
    this.#state.receipts.splice(index, 1);
    return Promise.resolve(true);
  }
}

/** Due now, or abandoned by a worker whose lease has run out. */
function isClaimable(delivery: Delivery, now: string): boolean {
  if (delivery.status === 'pending') return compareInstants(delivery.nextAttemptAt, now) <= 0;
  if (delivery.status === 'in-flight') {
    return delivery.claimExpiresAt !== null && compareInstants(delivery.claimExpiresAt, now) <= 0;
  }
  return false;
}
