/**
 * K-08 Event Infrastructure — publication, delivery and replay (FND-003b).
 *
 * Three operations, and the interesting part of each is what it refuses.
 *
 * **Publish.** Validate against the registry, fingerprint the payload, append the event and fan out
 * one delivery per subscribed consumer — all in one transaction. Either the event and every
 * delivery exist, or neither does. An event appended without its deliveries is a fact nobody will
 * ever hear; deliveries without their event are work with nothing to do.
 *
 * **Deliver.** Claim due work under a lease, check whether this subscription has already processed
 * this event, run the handler, and acknowledge *only* if it returned. Delivery is at-least-once by
 * design, because the alternative — acknowledging before the handler runs — is at-most-once, and
 * silently losing an event is worse than processing one twice. Exactly-once *effect* is the
 * consumer's, achieved with the receipt this component maintains and the idempotency key it hands
 * to every handler.
 *
 * **Replay.** Operator-explicit, and appends a new delivery generation rather than reopening a
 * terminal one. Two things it will not do quietly: it will not bypass the consumer's deduplication
 * (a replayed event whose receipt still exists is acknowledged without reaching the handler unless
 * the operator explicitly discards that receipt and says why), and it will not revive an obsolete
 * delivery (the old row stays terminal, so a worker still holding its lease is refused).
 *
 * Deterministic throughout: `now`, every identifier and every claim token come from the caller.
 * This component reads no clock, generates no randomness, and adds no jitter to a backoff — jitter
 * would make retry timing unassertable, and a scheduler whose behaviour cannot be asserted is a
 * scheduler nobody can reason about during an incident.
 *
 * Owned by: K-08 Event Infrastructure. No broker SDK, no API, no UI — see CONTRACT.md.
 */

import { createHash } from 'node:crypto';

import {
  InvalidInstantError,
  addSeconds,
  compareInstants,
  parseInstant,
} from '../../platform/time/instant.ts';

import {
  assertValidPayload,
  type EventTypeRegistry,
  type SubscriptionRegistry,
} from './registry.ts';
import type { EventRepository, EventTransaction } from './repository.ts';
import {
  EventError,
  PERMITTED_EVENT_ORIGINS,
  TERMINAL_DELIVERY_STATUSES,
  type Actor,
  type ConsumerReceipt,
  type Delivery,
  type EventEnvelope,
  type EventOrigin,
  type EventPayload,
} from './types.ts';

/** Everything that identifies one logical publication. */
export interface PublishRequest {
  readonly eventId: string;
  readonly type: string;
  readonly schemaVersion: number;
  readonly occurredAt: string;
  readonly producer: string;
  readonly correlationId: string;
  readonly causationId?: string | null;
  readonly payload: EventPayload;
  readonly idempotencyKey: string;
  readonly origin: EventOrigin;
  readonly actor: Actor;
  readonly now: string;
}

export interface PublishResult {
  readonly event: EventEnvelope;
  readonly deliveries: readonly Delivery[];
  /** True when this idempotency key had already produced this exact event. */
  readonly deduplicated: boolean;
}

export interface RetryPolicy {
  /** Attempts before a delivery is dead-lettered. */
  readonly maxAttempts: number;
  readonly baseBackoffSeconds: number;
  /** The cap. Without one, exponential backoff schedules a retry after the heat death. */
  readonly maxBackoffSeconds: number;
  /** How long a claim is valid before another worker may take the delivery. */
  readonly leaseSeconds: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 5,
  baseBackoffSeconds: 30,
  maxBackoffSeconds: 3_600,
  leaseSeconds: 300,
};

/** What a handler is given. Everything it needs to be idempotent, and nothing it could forge. */
export interface HandlerContext {
  readonly envelope: EventEnvelope;
  readonly subscription: string;
  readonly deliveryId: string;
  readonly attempt: number;
  /**
   * Stable across every redelivery and every replay generation of this event.
   *
   * A handler that writes this alongside its own effect, in its own transaction, gets
   * exactly-once effect out of at-least-once delivery. See CONTRACT.md §5.
   */
  readonly idempotencyKey: string;
}

export type EventHandler = (context: HandlerContext) => Promise<void>;

export type DeliveryOutcomeKind =
  'delivered' | 'deduplicated' | 'retry-scheduled' | 'dead-lettered' | 'lost-claim';

export interface DeliveryOutcome {
  readonly deliveryId: string;
  readonly eventId: string;
  readonly subscription: string;
  readonly kind: DeliveryOutcomeKind;
  readonly attempt: number;
  /** Set when a retry was scheduled. */
  readonly nextAttemptAt: string | null;
  readonly error: string | null;
}

export interface DeliverRequest {
  readonly subscription: string;
  readonly worker: Actor;
  /** Unique per call. Supplied so the component stays deterministic. */
  readonly claimToken: string;
  readonly now: string;
  readonly limit?: number;
}

export interface ReplayRequest {
  readonly eventId: string;
  readonly subscription: string;
  /** Caller-supplied id for the delivery this replay appends. */
  readonly deliveryId: string;
  readonly operator: Actor;
  readonly reason: string;
  readonly now: string;
  /**
   * Discard the consumer's receipt so the handler runs again.
   *
   * Off by default and never implicit. A replay usually means "this consumer's effect was lost";
   * occasionally it means "redeliver the notification". Only the operator knows which, and getting
   * it wrong silently re-applies an effect that was already applied.
   */
  readonly discardReceipt?: boolean;
}

export interface ReplayResult {
  readonly delivery: Delivery;
  readonly supersededDeliveryId: string;
  readonly receiptDiscarded: boolean;
}

/**
 * Deterministic bounded exponential backoff.
 *
 * `base * 2^(attempt-1)`, capped. No jitter: this component has no randomness source by design,
 * and a caller that needs to spread load can stagger its workers' `now`. Exported because the
 * schedule is part of the contract — an operator reading a `nextAttemptAt` should be able to
 * compute it rather than infer it.
 */
export function backoffSeconds(attempt: number, policy: RetryPolicy): number {
  if (attempt < 1) return policy.baseBackoffSeconds;
  const exponent = Math.min(attempt - 1, 30); // 2^31 overflows the useful range long before this
  const raw = policy.baseBackoffSeconds * 2 ** exponent;
  return Math.min(raw, policy.maxBackoffSeconds);
}

/** SHA-256 over the payload in a canonical form, so key order cannot change the fingerprint. */
export function fingerprintPayload(payload: EventPayload): string {
  const canonical = Object.keys(payload)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${JSON.stringify(payload[key] ?? null)}`)
    .join(',');
  return createHash('sha256').update(`{${canonical}}`).digest('hex');
}

export class EventService {
  readonly #types: EventTypeRegistry;
  readonly #subscriptions: SubscriptionRegistry;
  readonly #repository: EventRepository;
  readonly #policy: RetryPolicy;
  readonly #handlers = new Map<string, EventHandler>();

  constructor(
    types: EventTypeRegistry,
    subscriptions: SubscriptionRegistry,
    repository: EventRepository,
    policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  ) {
    this.#types = types;
    this.#subscriptions = subscriptions;
    this.#repository = repository;
    this.#policy = policy;
  }

  get policy(): RetryPolicy {
    return this.#policy;
  }

  /** Register the handler for a subscription. Refuses an unregistered subscription. */
  register(subscription: string, handler: EventHandler): void {
    this.#subscriptions.require(subscription);
    this.#handlers.set(subscription, handler);
  }

  /**
   * Append an event and fan it out, in one transaction.
   *
   * Validation happens before the transaction opens, so a malformed envelope never occupies a
   * transaction; everything that touches state happens inside one.
   */
  async publish(request: PublishRequest): Promise<PublishResult> {
    const definition = this.#types.require(request.type, request.schemaVersion);

    assertActorMayPublish(request.actor, request.origin);
    if (!PERMITTED_EVENT_ORIGINS.includes(request.origin)) {
      throw new EventError(
        'origin-not-permitted',
        `origin "${request.origin}" may not publish an event. AI may propose that something ` +
          'happened; it may not assert it, because a fabricated event is indistinguishable from a ' +
          'real one to every consumer downstream',
      );
    }
    if (request.producer !== definition.owner) {
      throw new EventError(
        'producer-not-permitted',
        `${request.producer} may not publish ${request.type}, which is owned by ` +
          `${definition.owner}. A unit that could publish another's events could fabricate its ` +
          'history',
      );
    }

    assertIdentifier(request.eventId, 'eventId');
    assertIdentifier(request.correlationId, 'correlationId');
    assertIdentifier(request.idempotencyKey, 'idempotencyKey');
    if (request.causationId !== undefined && request.causationId !== null) {
      assertIdentifier(request.causationId, 'causationId');
    }
    const occurredAt = assertEnvelopeInstant(request.occurredAt, 'occurredAt');
    const recordedAt = assertEnvelopeInstant(request.now, 'now');
    if (compareInstants(occurredAt, recordedAt) > 0) {
      throw new EventError(
        'malformed-envelope',
        `occurredAt ${occurredAt} is after now (${recordedAt}). An event cannot be recorded ` +
          'before it happened; a producer whose clock runs fast must not be able to publish into ' +
          'the future of this log',
      );
    }

    assertValidPayload(definition, request.payload);

    const envelope: EventEnvelope = {
      eventId: request.eventId,
      type: request.type,
      schemaVersion: request.schemaVersion,
      occurredAt,
      recordedAt,
      producer: request.producer,
      correlationId: request.correlationId,
      causationId: request.causationId ?? null,
      payload: Object.freeze({ ...request.payload }),
      payloadFingerprint: fingerprintPayload(request.payload),
      idempotencyKey: request.idempotencyKey,
      origin: request.origin,
    };

    const subscribers = this.#subscriptions.subscribersOf(request.type);

    try {
      return await this.#append(envelope, subscribers, recordedAt);
    } catch (error) {
      // Two retries of one publication that overlap in time each read a store with no such
      // idempotency key, so both try to append and one loses — at the INSERT against PostgreSQL,
      // at commit against the reference implementation. The loser has not failed: the publication
      // it was retrying succeeded, and it should be told what happened rather than handed a
      // conflict it cannot act on.
      //
      // So the loser re-reads and converges on the winner's event. Convergence is not blind: the
      // same content check as the sequential path runs, so a key genuinely reused for a *different*
      // event still fails closed rather than being answered with somebody else's event.
      //
      // One re-read, not a loop. If the key is still absent the conflict was something else — a
      // duplicate event id under a different key, say — and it is rethrown untouched.
      const conflicted =
        error instanceof EventError &&
        (error.code === 'idempotency-key-reuse' || error.code === 'duplicate-event-id');
      if (!conflicted) throw error;

      const winner = await this.#repository.withTransaction((tx) =>
        tx.findEventByIdempotencyKey(request.idempotencyKey),
      );
      if (winner === null) throw error;

      assertSameLogicalEvent(winner, envelope);
      return {
        event: winner,
        deliveries: await this.#repository.withTransaction((tx) =>
          tx.findDeliveriesForEvent(winner.eventId),
        ),
        deduplicated: true,
      };
    }
  }

  /** The append itself: one transaction holding the event and every delivery it fans out to. */
  async #append(
    envelope: EventEnvelope,
    subscribers: readonly { readonly subscription: string }[],
    recordedAt: string,
  ): Promise<PublishResult> {
    return this.#repository.withTransaction(async (tx) => {
      const existing = await tx.findEventByIdempotencyKey(envelope.idempotencyKey);
      if (existing !== null) {
        assertSameLogicalEvent(existing, envelope);
        return {
          event: existing,
          deliveries: await tx.findDeliveriesForEvent(existing.eventId),
          deduplicated: true,
        };
      }

      await tx.insertEvent(envelope);

      const deliveries: Delivery[] = [];
      for (const subscriber of subscribers) {
        const delivery: Delivery = {
          deliveryId: `${envelope.eventId}:${subscriber.subscription}:1`,
          eventId: envelope.eventId,
          subscription: subscriber.subscription,
          generation: 1,
          status: 'pending',
          attempts: 0,
          nextAttemptAt: recordedAt,
          claimedBy: null,
          claimToken: null,
          claimExpiresAt: null,
          lastError: null,
          completedAt: null,
          createdAt: recordedAt,
          replayOf: null,
          replayReason: null,
        };
        await tx.insertDelivery(delivery);
        deliveries.push(delivery);
      }

      return { event: envelope, deliveries, deduplicated: false };
    });
  }

  /**
   * Claim due work for a subscription and run its handler over each delivery.
   *
   * The claim is one transaction; each delivery's outcome is another. Deliberately not one big
   * transaction: a handler is arbitrary consumer code that may take seconds, and holding a
   * database transaction open across it would make one slow consumer everybody's problem.
   */
  async deliver(request: DeliverRequest): Promise<readonly DeliveryOutcome[]> {
    this.#subscriptions.require(request.subscription);
    assertActorMayAcknowledge(request.worker);

    const handler = this.#handlers.get(request.subscription);
    if (handler === undefined) {
      throw new EventError(
        'unknown-subscription',
        `no handler is registered for "${request.subscription}". Claiming work with nothing to ` +
          'run it would burn attempts and dead-letter events that were never actually delivered',
      );
    }

    const now = assertEnvelopeInstant(request.now, 'now');
    const claimExpiresAt = addSeconds(now, this.#policy.leaseSeconds);

    let claimed: readonly Delivery[];
    try {
      claimed = await this.#repository.withTransaction((tx) =>
        tx.claimDueDeliveries({
          subscription: request.subscription,
          now,
          limit: request.limit ?? 10,
          worker: request.worker.id,
          claimToken: request.claimToken,
          claimExpiresAt,
        }),
      );
    } catch (error) {
      // Losing a claim race is not an error, it is Tuesday. Against PostgreSQL the loser's
      // `FOR UPDATE SKIP LOCKED` simply returns no rows; the in-memory repository detects the same
      // race as a conflicting commit. Both mean "somebody else took this work", so both yield an
      // empty batch rather than a failure a caller would have to special-case.
      //
      // Narrow on purpose: `claim-token-reuse` is a caller bug — a token identifies one claim —
      // and every other failure is rethrown, because a claim that fails for an unknown reason must
      // not look like an idle poll.
      if (error instanceof EventError && error.code === 'concurrent-modification') return [];
      throw error;
    }

    const outcomes: DeliveryOutcome[] = [];
    for (const delivery of claimed) {
      outcomes.push(await this.#runOne(delivery, handler, request, now));
    }
    return outcomes;
  }

  async #runOne(
    delivery: Delivery,
    handler: EventHandler,
    request: DeliverRequest,
    now: string,
  ): Promise<DeliveryOutcome> {
    const envelope = await this.#repository.withTransaction((tx) =>
      tx.findEventById(delivery.eventId),
    );
    if (envelope === null) {
      throw new EventError(
        'no-such-event',
        `delivery ${delivery.deliveryId} refers to event ${delivery.eventId}, which does not ` +
          'exist. Publication is transactional, so this cannot happen through this component',
      );
    }

    // Consumer-side deduplication, checked before the handler runs rather than after. A replayed
    // or redelivered event whose receipt already exists must not reach consumer code at all.
    const receipt = await this.#repository.withTransaction((tx) =>
      tx.findReceipt(delivery.subscription, delivery.eventId),
    );
    if (receipt !== null) {
      return this.#settle(delivery, request, now, 'deduplicated', null, null);
    }

    try {
      await handler({
        envelope,
        subscription: delivery.subscription,
        deliveryId: delivery.deliveryId,
        attempt: delivery.attempts,
        idempotencyKey: `${delivery.subscription}:${delivery.eventId}`,
      });
    } catch (error) {
      // A handler that threw has not processed the event, whatever it may have written. It is
      // never acknowledged: the failure path is the only path from here.
      const message = error instanceof Error ? error.message : String(error);
      return this.#fail(delivery, request, now, message);
    }

    return this.#settle(delivery, request, now, 'delivered', null, null);
  }

  /**
   * Record success: the receipt and the acknowledgement, in one transaction.
   *
   * Together or not at all. A receipt without an acknowledgement would suppress a redelivery of
   * work that is still pending; an acknowledgement without a receipt would let a later replay run
   * a handler that has already had its effect.
   */
  async #settle(
    delivery: Delivery,
    request: DeliverRequest,
    now: string,
    kind: 'delivered' | 'deduplicated',
    nextAttemptAt: string | null,
    error: string | null,
  ): Promise<DeliveryOutcome> {
    try {
      await this.#repository.withTransaction(async (tx) => {
        // Ownership first, receipt second. Both are in one transaction so the order cannot change
        // what is written — but it does change what a *stale* worker is told. Inserting first, it
        // collides with the winner's receipt and is told a receipt exists, which is true and
        // useless; checking the claim first tells it the thing it needs to know, which is that it
        // no longer owns this delivery.
        await tx.completeDelivery(delivery.deliveryId, request.claimToken, now);
        if (kind === 'delivered') {
          const receipt: ConsumerReceipt = {
            subscription: delivery.subscription,
            eventId: delivery.eventId,
            deliveryId: delivery.deliveryId,
            processedAt: now,
          };
          await tx.insertReceipt(receipt);
        }
      });
    } catch (failure) {
      return this.#lostClaim(delivery, failure, delivery.attempts);
    }

    return {
      deliveryId: delivery.deliveryId,
      eventId: delivery.eventId,
      subscription: delivery.subscription,
      kind,
      attempt: delivery.attempts,
      nextAttemptAt,
      error,
    };
  }

  /** Schedule a bounded retry, or dead-letter once the attempts are spent. */
  async #fail(
    delivery: Delivery,
    request: DeliverRequest,
    now: string,
    message: string,
  ): Promise<DeliveryOutcome> {
    const exhausted = delivery.attempts >= this.#policy.maxAttempts;
    const nextAttemptAt = exhausted
      ? null
      : addSeconds(now, backoffSeconds(delivery.attempts, this.#policy));

    try {
      await this.#repository.withTransaction(async (tx) => {
        if (exhausted) {
          await tx.deadLetterDelivery(delivery.deliveryId, request.claimToken, now, message);
        } else {
          await tx.rescheduleDelivery(
            delivery.deliveryId,
            request.claimToken,
            nextAttemptAt as string,
            message,
          );
        }
      });
    } catch (failure) {
      return this.#lostClaim(delivery, failure, delivery.attempts);
    }

    return {
      deliveryId: delivery.deliveryId,
      eventId: delivery.eventId,
      subscription: delivery.subscription,
      kind: exhausted ? 'dead-lettered' : 'retry-scheduled',
      attempt: delivery.attempts,
      nextAttemptAt,
      error: message,
    };
  }

  /**
   * This worker no longer owns the delivery.
   *
   * Reported rather than thrown: losing a lease is a normal outcome in a system with more than one
   * worker, and the batch's remaining deliveries are unaffected. Anything that is *not* a lost
   * claim is rethrown, because dressing an unknown failure as a lost claim would hide it.
   */
  #lostClaim(delivery: Delivery, failure: unknown, attempt: number): DeliveryOutcome {
    const lost =
      failure instanceof EventError &&
      (failure.code === 'stale-claim' ||
        failure.code === 'obsolete-delivery' ||
        failure.code === 'concurrent-modification');
    if (!lost) throw failure;

    return {
      deliveryId: delivery.deliveryId,
      eventId: delivery.eventId,
      subscription: delivery.subscription,
      kind: 'lost-claim',
      attempt,
      nextAttemptAt: null,
      error: failure.message,
    };
  }

  /**
   * Redeliver an event to one subscription, on an operator's explicit instruction.
   *
   * Appends the next generation rather than reopening the terminal delivery, so a worker still
   * holding the old row's lease is refused by the repository's own guard rather than by a check
   * that could be forgotten here.
   */
  async replay(request: ReplayRequest): Promise<ReplayResult> {
    assertActorMayReplay(request.operator);
    this.#subscriptions.require(request.subscription);
    if (request.reason.trim() === '') {
      throw new EventError(
        'replay-not-authorised',
        'a replay must carry a reason. It re-runs consumer code against a historical fact, and ' +
          'the next person to read this delivery needs to know why it exists',
      );
    }
    const now = assertEnvelopeInstant(request.now, 'now');

    return this.#repository.withTransaction(async (tx) => {
      const event = await tx.findEventById(request.eventId);
      if (event === null) {
        throw new EventError('no-such-event', `no event ${request.eventId} to replay`);
      }

      const latest = await tx.findLatestDelivery(request.eventId, request.subscription);
      if (latest === null) {
        throw new EventError(
          'no-such-delivery',
          `${request.subscription} has no delivery for ${request.eventId}. Replay redelivers an ` +
            'existing subscription; it does not create one that was never subscribed',
        );
      }
      if (!TERMINAL_DELIVERY_STATUSES.includes(latest.status)) {
        throw new EventError(
          'delivery-not-terminal',
          `delivery ${latest.deliveryId} is ${latest.status}. Replaying work that is still ` +
            'pending or in flight would put two live deliveries of one event in front of one ' +
            'consumer; wait for it to finish or let its lease expire',
        );
      }

      const receiptDiscarded =
        request.discardReceipt === true
          ? await tx.deleteReceipt(request.subscription, request.eventId)
          : false;

      const delivery: Delivery = {
        deliveryId: request.deliveryId,
        eventId: request.eventId,
        subscription: request.subscription,
        generation: latest.generation + 1,
        status: 'pending',
        attempts: 0,
        nextAttemptAt: now,
        claimedBy: null,
        claimToken: null,
        claimExpiresAt: null,
        lastError: null,
        completedAt: null,
        createdAt: now,
        replayOf: latest.deliveryId,
        replayReason: `${request.operator.id}: ${request.reason}`,
      };
      await tx.insertDelivery(delivery);

      return { delivery, supersededDeliveryId: latest.deliveryId, receiptDiscarded };
    });
  }

  /** Read an event back. The only way to see one; there is no operation that changes one. */
  async eventById(eventId: string): Promise<EventEnvelope> {
    const event = await this.#repository.withTransaction((tx: EventTransaction) =>
      tx.findEventById(eventId),
    );
    if (event === null) throw new EventError('no-such-event', `no event ${eventId}`);
    return event;
  }

  deliveriesForEvent(eventId: string): Promise<readonly Delivery[]> {
    return this.#repository.withTransaction((tx) => tx.findDeliveriesForEvent(eventId));
  }
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function assertIdentifier(value: string, field: string): void {
  if (!IDENTIFIER.test(value)) {
    throw new EventError(
      'malformed-envelope',
      `${field} "${value}" is not a valid identifier. Expected 1-128 characters of ` +
        '[A-Za-z0-9._:-] starting alphanumeric',
    );
  }
}

/** Instants are validated in this component's own vocabulary, not the platform utility's. */
function assertEnvelopeInstant(value: string, field: string): string {
  try {
    return parseInstant(value).source;
  } catch (error) {
    if (error instanceof InvalidInstantError) {
      throw new EventError('malformed-envelope', `${field}: ${error.message}`);
    }
    throw error;
  }
}

function assertActorMayPublish(actor: Actor, origin: EventOrigin): void {
  if (actor.kind === 'ai') {
    throw new EventError(
      'ai-not-permitted',
      `actor "${actor.id}" is AI and may not publish an event. AI may propose a fact to a human ` +
        'or to a deterministic system, which publishes it and owns it',
    );
  }
  if (actor.kind === 'system' && origin === 'human') {
    throw new EventError(
      'origin-not-permitted',
      `a system actor may not publish with origin "human"; the origin must describe who actually ` +
        'decided, or it records nothing worth having',
    );
  }
}

function assertActorMayAcknowledge(actor: Actor): void {
  if (actor.kind === 'ai') {
    throw new EventError(
      'ai-not-permitted',
      `worker "${actor.id}" is AI and may not claim or acknowledge deliveries. Marking an event ` +
        'delivered asserts that a consumer really processed it, which AI cannot know',
    );
  }
}

function assertActorMayReplay(actor: Actor): void {
  if (actor.kind !== 'operator') {
    throw new EventError(
      'replay-not-authorised',
      `replay requires an operator; "${actor.id}" is ${actor.kind}. Automatic replay is how one ` +
        'incident becomes two, and AI in particular may not order consumer code to re-run',
    );
  }
}

/** A retry must be a retry of *this* publication. */
function assertSameLogicalEvent(existing: EventEnvelope, incoming: EventEnvelope): void {
  const differences: string[] = [];
  const compare = (field: string, was: unknown, now: unknown): void => {
    if (was !== now)
      differences.push(`${field} was ${JSON.stringify(was)}, now ${JSON.stringify(now)}`);
  };

  compare('eventId', existing.eventId, incoming.eventId);
  compare('type', existing.type, incoming.type);
  compare('schemaVersion', existing.schemaVersion, incoming.schemaVersion);
  compare('producer', existing.producer, incoming.producer);
  compare('correlationId', existing.correlationId, incoming.correlationId);
  compare('causationId', existing.causationId, incoming.causationId);
  compare('origin', existing.origin, incoming.origin);
  compare('payloadFingerprint', existing.payloadFingerprint, incoming.payloadFingerprint);
  if (compareInstants(existing.occurredAt, incoming.occurredAt) !== 0) {
    differences.push(`occurredAt was ${existing.occurredAt}, now ${incoming.occurredAt}`);
  }

  if (differences.length > 0) {
    throw new EventError(
      'idempotency-key-reuse',
      `idempotency key "${incoming.idempotencyKey}" was already used for a different event ` +
        `(${differences.join('; ')}). Returning the earlier event would report success for ` +
        'something that was never published',
    );
  }
}
