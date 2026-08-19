/**
 * K-08 Event Infrastructure — domain types (FND-003b).
 *
 * An event is a statement that something happened, addressed to nobody in particular. That is the
 * whole point of the component: it is how one unit tells the rest of the system about a fact
 * without knowing who cares, which is what makes same-layer modules able to react to each other
 * without importing each other (MODULE_MAP.md §10.3).
 *
 * Two consequences shape every type below:
 *
 *   - **The envelope is a record, not a message.** It is appended, never edited. A consumer that
 *     re-reads an event a year later must see exactly what was published, which means the payload
 *     is frozen and fingerprinted at append and nothing — including replay — may alter it.
 *   - **Delivery is separate from the event.** One event, many subscriptions, each with its own
 *     attempts, backoff and terminal state. Storing delivery state on the event would make a
 *     consumer's retry loop rewrite a historical fact.
 *
 * Provider-neutral by construction: no broker vocabulary appears here. Kafka, SQS, NATS and a
 * PostgreSQL table are all implementations of the port in repository.ts, and choosing one later
 * must not change these types.
 *
 * Owned by: K-08 Event Infrastructure.
 */

/** What a payload field may hold. Deliberately scalar — see `EventPayload`. */
export type JsonScalar = string | number | boolean | null;

/**
 * An event payload: a flat map of scalars.
 *
 * Flat and scalar rather than arbitrary JSON, because a payload is a contract between units that
 * cannot see each other's code. Nested structure invites consumers to depend on shapes the
 * producer never declared, and the registry can only validate what it can describe.
 */
export type EventPayload = Readonly<Record<string, JsonScalar>>;

/** Where an event came from. `ai-suggested` exists so it can be refused explicitly. */
export const EVENT_ORIGINS = ['system', 'human', 'ai-suggested'] as const;
export type EventOrigin = (typeof EVENT_ORIGINS)[number];

/**
 * Origins permitted to append an event.
 *
 * AI may propose that something happened. It may not assert it: an event is trusted evidence that
 * a fact occurred, and a fabricated one is indistinguishable from a real one to every consumer
 * downstream. A human or a deterministic system publishes and owns it.
 */
export const PERMITTED_EVENT_ORIGINS: readonly EventOrigin[] = ['system', 'human'];

/**
 * The published record of something that happened.
 *
 * Every identifier and instant is supplied by the caller so that this component reads no clock and
 * generates no randomness: the same inputs produce the same envelope, which is what makes the
 * concurrency and retry behaviour testable at all.
 */
export interface EventEnvelope {
  /** Caller-supplied. Unique across the log; a duplicate is a refusal, not an overwrite. */
  readonly eventId: string;
  /** Registered type, e.g. `inventory.item_reserved`. */
  readonly type: string;
  /** Which declared version of that type's payload this envelope conforms to. */
  readonly schemaVersion: number;
  /** When the fact happened, according to the producer. */
  readonly occurredAt: string;
  /** When this component durably recorded it. Never earlier than `occurredAt`. */
  readonly recordedAt: string;
  /** Manifest id of the unit that published it, e.g. `K-05`. Checked against the registry. */
  readonly producer: string;
  /** Ties a whole causal chain together, across units. */
  readonly correlationId: string;
  /** The event that caused this one, or null when this starts a chain. */
  readonly causationId: string | null;
  readonly payload: EventPayload;
  /**
   * SHA-256 over the canonical payload, computed once at append.
   *
   * The evidence that a payload was never edited. A consumer, an auditor or a replay can compare
   * it without trusting the row it is comparing.
   */
  readonly payloadFingerprint: string;
  /** Stable across retries of one logical publication. */
  readonly idempotencyKey: string;
  readonly origin: EventOrigin;
}

/**
 * Where a delivery has got to.
 *
 * `delivered` and `dead-lettered` are terminal. A terminal delivery is never reopened — a replay
 * creates a new one — because a worker still holding a lease on the old row must not be able to
 * complete work that has since been superseded.
 */
export const DELIVERY_STATUSES = ['pending', 'in-flight', 'delivered', 'dead-lettered'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export const TERMINAL_DELIVERY_STATUSES: readonly DeliveryStatus[] = ['delivered', 'dead-lettered'];

/** One subscription's attempt to receive one event. */
export interface Delivery {
  readonly deliveryId: string;
  readonly eventId: string;
  /** The consuming subscription, e.g. `audit-writer`. */
  readonly subscription: string;
  /**
   * 1 for the original fan-out; incremented by each replay.
   *
   * A replay does not revive the old row, it appends a new one at the next generation. The old row
   * stays terminal and any worker still holding its lease is refused, which is what stops a
   * long-stalled worker from completing a delivery the operator has already superseded.
   */
  readonly generation: number;
  readonly status: DeliveryStatus;
  /** Incremented when work is claimed, so a worker that dies mid-handler still burns an attempt. */
  readonly attempts: number;
  /** The earliest instant at which this may be claimed. */
  readonly nextAttemptAt: string;
  readonly claimedBy: string | null;
  /**
   * Identifies one claim, not one worker.
   *
   * Completion is conditional on this token, so a worker whose lease expired and whose work was
   * re-claimed cannot acknowledge: it holds the previous token and finds nothing to update.
   */
  readonly claimToken: string | null;
  readonly claimExpiresAt: string | null;
  readonly lastError: string | null;
  readonly completedAt: string | null;
  readonly createdAt: string;
  /** Set by a replay: which operator ordered it, and why. Null on an original delivery. */
  readonly replayOf: string | null;
  readonly replayReason: string | null;
}

/**
 * Proof that a subscription has already processed an event.
 *
 * Delivery is at-least-once, so this is the consumer-side half of exactly-once *effect*. It is
 * written in the same transaction as the acknowledgement, so it exists if and only if the delivery
 * was acknowledged.
 */
export interface ConsumerReceipt {
  readonly subscription: string;
  readonly eventId: string;
  /** The delivery that produced it, for tracing a replayed event back to the attempt that won. */
  readonly deliveryId: string;
  readonly processedAt: string;
}

export type EventErrorCode =
  | 'unknown-event-type'
  | 'unknown-schema-version'
  | 'malformed-envelope'
  | 'invalid-payload'
  | 'secret-bearing-payload'
  | 'origin-not-permitted'
  | 'producer-not-permitted'
  | 'ai-not-permitted'
  | 'duplicate-event-id'
  | 'idempotency-key-reuse'
  | 'no-such-event'
  | 'no-such-delivery'
  | 'stale-claim'
  | 'claim-token-reuse'
  | 'obsolete-delivery'
  | 'delivery-not-terminal'
  | 'replay-not-authorised'
  | 'concurrent-modification'
  | 'nested-transaction'
  | 'immutable-event'
  | 'unknown-subscription';

export class EventError extends Error {
  readonly code: EventErrorCode;

  constructor(code: EventErrorCode, message: string) {
    super(message);
    this.name = 'EventError';
    this.code = code;
  }
}

/**
 * Who is doing something.
 *
 * Carried explicitly rather than inferred, because K-02 Authentication and K-04 Permissions do not
 * exist yet and pretending otherwise would ship an unchecked assumption. `kind` is checked: AI may
 * neither publish nor acknowledge.
 */
export const ACTOR_KINDS = ['system', 'operator', 'ai'] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

export interface Actor {
  readonly id: string;
  readonly kind: ActorKind;
}
