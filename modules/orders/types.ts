/**
 * M-11 Orders — domain types.
 *
 * An order is an agreement. Its defining property is that what was agreed cannot change afterwards,
 * which is why M-04 versions its listings: an order item pins `(listingId, versionId)`, and that pair
 * is a permanent address for one set of terms.
 *
 * Deterministic by construction: the caller supplies every identifier and every instant. Nothing here
 * reads a clock or generates randomness.
 *
 * Owned by: M-11 Orders.
 */

/** Lifecycle of an order. */
export const ORDER_STATUSES = [
  'draft',
  'placed',
  'confirmed',
  'fulfilling',
  'completed',
  'cancelled',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** Kinds of order event. Each successful state transition appends one event of the matching kind. */
export const ORDER_EVENT_KINDS = [
  'created',
  'placed',
  'confirmed',
  'fulfilling',
  'completed',
  'cancelled',
] as const;
export type OrderEventKind = (typeof ORDER_EVENT_KINDS)[number];

/** Reasons an order may be cancelled. */
export const CANCELLATION_REASONS = [
  'buyer-withdrew',
  'seller-declined',
  'payment-failed',
  'stock-unavailable',
  'expired',
] as const;
export type CancellationReason = (typeof CANCELLATION_REASONS)[number];

/**
 * The legal state transitions. The state machine is a table, not scattered `if`s.
 *
 * `completed` and `cancelled` are terminal — both map to an empty array.
 */
export const ORDER_TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> =
  Object.freeze({
    draft: ['placed', 'cancelled'],
    placed: ['confirmed', 'cancelled'],
    confirmed: ['fulfilling', 'cancelled'],
    fulfilling: ['completed', 'cancelled'],
    completed: [],
    cancelled: [],
  });

/**
 * The order header. What both parties agreed, in mutable administrative state only: the items,
 * snapshot and event log are append-only.
 */
export interface Order {
  /** Caller-supplied opaque and stable identifier. */
  readonly orderId: string;
  /** The K-03 account buying. Not a foreign key. */
  readonly buyerAccountId: string;
  /** The K-03 account selling. Not a foreign key. */
  readonly sellerAccountId: string;
  /** Current lifecycle status. */
  readonly status: OrderStatus;
  /** ISO-4217 currency code, three uppercase letters. */
  readonly currency: string;
  /** Sum of the line totals in integer minor units. */
  readonly subtotalMinor: bigint;
  /** The amount owed in integer minor units. Equal to subtotalMinor in this slice. */
  readonly totalMinor: bigint;
  /** Number of items on the order. ≥ 1 once placed. */
  readonly itemCount: number;
  /** When the order moved to placed, or null. */
  readonly placedAt: string | null;
  /** When the order moved to confirmed, or null. */
  readonly confirmedAt: string | null;
  /** When the order moved to completed, or null. */
  readonly completedAt: string | null;
  /** When the order was cancelled, or null. */
  readonly cancelledAt: string | null;
  /** One of CANCELLATION_REASONS when cancelled, otherwise null. */
  readonly cancellationReason: CancellationReason | null;
  /** When the order was created. */
  readonly createdAt: string;
  /** When the order was last changed. */
  readonly updatedAt: string;
  /** Correlates with the caller request trace. */
  readonly correlationId: string;
  /** Stable across retries of one logical request. */
  readonly idempotencyKey: string;
}

/**
 * One line of an order. Append-only: once a line is added it is never edited, because the order is
 * an agreement and an agreement that changes after the fact is not a record of what was agreed.
 */
export interface OrderItem {
  /** Caller-supplied opaque and stable identifier. */
  readonly itemId: string;
  /** The order this line belongs to. */
  readonly orderId: string;
  /** The M-04 listing. */
  readonly listingId: string;
  /** The pinned version — the permanent address of the agreed terms. */
  readonly versionId: string;
  /** The commerce unit type copied from the listing at pin time. */
  readonly commerceUnitTypeId: string;
  /** How many units. */
  readonly quantity: bigint;
  /** The unit price in integer minor units, copied from the pinned version. Never recomputed. */
  readonly unitPriceMinor: bigint;
  /** `quantity * unitPriceMinor`, exact integer arithmetic. */
  readonly lineTotalMinor: bigint;
  /** Must equal the order's currency. */
  readonly currency: string;
  /** The M-04 inventory reservation held for this line, or null. */
  readonly reservationId: string | null;
  /** When the line was added. */
  readonly addedAt: string;
  /** Correlates with the caller request trace. */
  readonly correlationId: string;
  /** Stable across retries of one logical request. */
  readonly idempotencyKey: string;
}

/**
 * The immutable commercial snapshot. One row per order, written at placeOrder. This is the record a
 * later dispute is judged against.
 */
export interface OrderSnapshot {
  /** Caller-supplied opaque and stable identifier. */
  readonly snapshotId: string;
  /** The order this snapshot belongs to. */
  readonly orderId: string;
  readonly buyerAccountId: string;
  readonly sellerAccountId: string;
  readonly currency: string;
  /** Sum of line totals in integer minor units. */
  readonly subtotalMinor: bigint;
  /** Amount owed in integer minor units. */
  readonly totalMinor: bigint;
  /** The full agreed line detail as JSON. */
  readonly lines: Readonly<Record<string, unknown>>;
  /** The K-06 policy version in force, or null when none was pinned in this slice. */
  readonly policyVersionId: string | null;
  /** When the snapshot was captured. */
  readonly capturedAt: string;
  /** Correlates with the caller request trace. */
  readonly correlationId: string;
  /** Stable across retries of one logical request. */
  readonly idempotencyKey: string;
}

/**
 * One append-only order event. The event id is unique per transition and is used to derive the
 * outbox ids, so a second transition on the same order does not collide.
 */
export interface OrderEvent {
  /** Caller-supplied opaque and stable identifier. */
  readonly eventId: string;
  /** The order this event belongs to. */
  readonly orderId: string;
  /** The kind of transition that happened. */
  readonly kind: OrderEventKind;
  /** The status before the transition, or null for the first event. */
  readonly fromStatus: OrderStatus | null;
  /** The status after the transition. */
  readonly toStatus: OrderStatus;
  /** Why the transition happened, 1-500 characters. */
  readonly reason: string;
  /** When the transition happened. */
  readonly occurredAt: string;
  /** Correlates with the caller request trace. */
  readonly correlationId: string;
  /** Stable across retries of one logical request. */
  readonly idempotencyKey: string;
}

export type OrderErrorCode =
  /** An identifier is not well formed. */
  | 'malformed-identifier'
  /** An identifier looks like a natural key. */
  | 'natural-identifier'
  /** An identifier names or looks like a credential. */
  | 'secret-bearing-input'
  /** The instant is not a real UTC instant. */
  | 'malformed-instant'
  /** A request carried a field belonging to another component. */
  | 'foreign-concern'
  /** A stored row, or a candidate record, is not what this component writes. */
  | 'malformed-record'
  /** The idempotency key was already used for a different record. */
  | 'idempotency-key-reuse'
  /** An enlisted write tried to issue transaction control. */
  | 'nested-transaction'
  /** An order id already exists with different content. */
  | 'duplicate-order-id'
  /** An item id already exists with different content. */
  | 'duplicate-item-id'
  /** An event id already exists with different content. */
  | 'duplicate-event-id'
  /** A snapshot id already exists with different content. */
  | 'duplicate-snapshot-id'
  /** The status is not one M-11 recognises. */
  | 'unknown-status'
  /** The cancellation reason is not one M-11 recognises. */
  | 'unknown-cancellation-reason'
  /** The event kind is not one M-11 recognises. */
  | 'unknown-event-kind'
  /** The currency is not a valid ISO-4217 code. */
  | 'malformed-currency'
  /** The reason text is malformed. */
  | 'malformed-reason'
  /** An amount is negative. */
  | 'negative-amount'
  /** A quantity is negative. */
  | 'negative-quantity'
  /** The order id is unknown. */
  | 'order-not-found'
  /** The order is no longer draft and refuses item addition. */
  | 'order-not-draft'
  /** The order has no items and cannot be placed. */
  | 'order-empty'
  /** The order is in a terminal state and refuses further transition. */
  | 'order-terminal'
  /** The requested transition is not in the state machine. */
  | 'illegal-transition'
  /** A line's currency does not match the order's currency. */
  | 'currency-mismatch'
  /** The caller's expected total disagrees with the computed total. */
  | 'total-mismatch'
  /** A line's lineTotalMinor does not equal quantity * unitPriceMinor. */
  | 'line-total-mismatch'
  /** A snapshot already exists for this order. */
  | 'snapshot-exists';

/** A refusal the caller must act on. */
export class OrderError extends Error {
  readonly code: OrderErrorCode;

  constructor(code: OrderErrorCode, message: string) {
    super(message);
    this.name = 'OrderError';
    this.code = code;
  }
}
