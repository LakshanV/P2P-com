/**
 * M-11 Orders — service.
 *
 * An order is an agreement. What was agreed cannot change afterwards, which is why the items,
 * snapshot and event log are append-only. The order header carries only mutable administrative
 * state: the current status and the timestamps of each transition.
 *
 * Deterministic by construction: the caller supplies every identifier and every instant. Nothing
 * here reads a clock or generates randomness.
 *
 * Owned by: M-11 Orders.
 */

import type { OutboxEntry } from '../../platform/outbox/types.ts';
import { InvalidInstantError, parseInstant } from '../../platform/time/instant.ts';

import { FOREIGN_FIELDS, assertCancellationReason, assertOrderIdentifier } from './registry.ts';
import type { OrderRepository, OrderTransaction } from './repository.ts';
import {
  sealOrder,
  sealOrderEvent,
  sealOrderEvents,
  sealOrderItem,
  sealOrderItems,
  sealOrderSnapshot,
  sealOrders,
} from './immutable.ts';
import {
  validateOrder,
  validateOrderEvent,
  validateOrderItem,
  validateOrderSnapshot,
} from './validate.ts';
import {
  ORDER_TRANSITIONS,
  OrderError,
  type FulfilmentChild,
  type FulfilmentSummary,
  type Order,
  type OrderEvent,
  type OrderEventKind,
  type OrderItem,
  type OrderLineKind,
  type OrderSnapshot,
  type OrderStatus,
} from './types.ts';
import {
  makeOrderCancelledAction,
  makeOrderCancelledEvent,
  makeOrderCompletedAction,
  makeOrderCompletedEvent,
  makeOrderConfirmedAction,
  makeOrderConfirmedEvent,
  makeOrderCreatedAction,
  makeOrderCreatedEvent,
  makeOrderFulfillingAction,
  makeOrderFulfillingEvent,
  makeOrderPlacedAction,
  makeOrderPlacedEvent,
  makeOrderSplitAction,
  makeOrderSplitEvent,
} from './outbox.ts';

export interface CreateOrderRequest {
  readonly orderId: string;
  readonly buyerAccountId: string;
  readonly sellerAccountId: string;
  readonly currency: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  /** Opaque id for the creation event; the outbox entries are derived from it. */
  readonly eventId: string;
  /** Why the order was created. */
  readonly reason: string;
}

export interface CreateOrderResult {
  readonly order: Order;
  readonly replayed: boolean;
}

export interface AddItemRequest {
  readonly itemId: string;
  readonly orderId: string;
  /**
   * The listing triple, for a line priced from a published offer.
   *
   * Absent — or null — for a line priced from an accepted quote, which supplies {@link quoteId}
   * instead. Exactly one source is accepted.
   */
  readonly listingId?: string | null;
  readonly versionId?: string | null;
  readonly commerceUnitTypeId?: string | null;
  /** The M-10 offer, for a line that came from a tender rather than a listing. */
  readonly quoteId?: string | null;
  /** `goods` or `charges`. Absent means goods, which is what every listing line is. */
  readonly lineKind?: OrderLineKind;
  readonly quantity: bigint;
  readonly unitPriceMinor: bigint;
  readonly lineTotalMinor: bigint;
  readonly currency: string;
  readonly reservationId: string | null;
  readonly addedAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
}

export interface AddItemResult {
  readonly item: OrderItem;
  readonly replayed: boolean;
}

export interface PlaceOrderRequest {
  readonly orderId: string;
  readonly snapshotId: string;
  readonly expectedTotalMinor: bigint;
  /** The K-06 policy version the order is priced under, or null when none is supplied. */
  readonly policyVersionId: string | null;
  readonly placedAt: string;
  readonly updatedAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  /** Opaque id for the placed event; the outbox entries are derived from it. */
  readonly eventId: string;
  readonly reason: string;
}

export interface PlaceOrderResult {
  readonly order: Order;
  readonly snapshot: OrderSnapshot;
  readonly replayed: boolean;
}

export interface ConfirmOrderRequest {
  readonly orderId: string;
  readonly confirmedAt: string;
  readonly updatedAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly eventId: string;
  readonly reason: string;
}

export interface ConfirmOrderResult {
  readonly order: Order;
  readonly replayed: boolean;
}

export interface StartFulfilmentRequest {
  readonly orderId: string;
  readonly fulfillingAt: string;
  readonly updatedAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly eventId: string;
  readonly reason: string;
}

export interface StartFulfilmentResult {
  readonly order: Order;
  readonly replayed: boolean;
}

export interface CompleteOrderRequest {
  readonly orderId: string;
  readonly completedAt: string;
  readonly updatedAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly eventId: string;
  readonly reason: string;
}

export interface CompleteOrderResult {
  readonly order: Order;
  readonly replayed: boolean;
}

export interface CancelOrderRequest {
  readonly orderId: string;
  readonly cancellationReason: string;
  readonly cancelledAt: string;
  readonly updatedAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly eventId: string;
  readonly reason: string;
}

export interface CancelOrderResult {
  readonly order: Order;
  readonly replayed: boolean;
}

/** One line of one supplier's allocation. Mirrors an order item, minus the fields M-11 derives. */
export interface SplitAllocationItem {
  readonly itemId: string;
  /** The M-04 listing, or null when the line was priced from an accepted offer. */
  readonly listingId: string | null;
  /** The pinned version, or null for a quote line. */
  readonly versionId: string | null;
  /** The K-11 type, required for a listing line and null for a quote line. */
  readonly commerceUnitTypeId: string | null;
  /** The M-10 offer this allocation was priced from, or null for a listing line. */
  readonly quoteId?: string | null;
  /** `goods` or `charges`. Absent means goods. */
  readonly lineKind?: OrderLineKind;
  readonly quantity: bigint;
  readonly unitPriceMinor: bigint;
  readonly lineTotalMinor: bigint;
  /**
   * Stated by the caller rather than inherited from the parent, so a mismatch is caught rather than
   * silently absorbed. A child line in a different currency from its parent is a mistake somebody
   * needs to hear about.
   */
  readonly currency: string;
  readonly reservationId: string | null;
}

/** What one supplier will fulfil, and the identifiers for the child order that records it. */
export interface SplitAllocation {
  readonly orderId: string;
  readonly sellerAccountId: string;
  readonly idempotencyKey: string;
  readonly eventId: string;
  readonly items: readonly SplitAllocationItem[];
}

export interface SplitOrderRequest {
  readonly parentOrderId: string;
  readonly allocations: readonly SplitAllocation[];
  readonly occurredAt: string;
  readonly updatedAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  /** Opaque id for the parent's split event; the outbox entries derive from it. */
  readonly eventId: string;
  readonly reason: string;
}

export interface SplitOrderResult {
  /** The parent, now `fulfilling` and marked as a parent. Named `order` for consistency with every other result in this module. */
  readonly order: Order;
  readonly children: readonly Order[];
  readonly replayed: boolean;
}

/**
 * What every status transition supplies, whatever it calls its own timestamp.
 *
 * `confirmOrder`, `startFulfilment` and `completeOrder` share one implementation, and this is the
 * shape that implementation may rely on. Its own instant is passed as a value rather than looked up
 * by name, so the helper never needs to index a request by string — which is what previously forced
 * it to treat the request as a bag of unknowns and cast every field back out.
 */
interface TransitionRequest {
  readonly orderId: string;
  readonly eventId: string;
  readonly updatedAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly reason: string;
}

const SPLIT_ORDER_KEYS: readonly string[] = [
  'parentOrderId',
  'allocations',
  'occurredAt',
  'updatedAt',
  'correlationId',
  'idempotencyKey',
  'eventId',
  'reason',
];

const CREATE_ORDER_KEYS: readonly string[] = [
  'orderId',
  'buyerAccountId',
  'sellerAccountId',
  'currency',
  'createdAt',
  'updatedAt',
  'correlationId',
  'idempotencyKey',
  'eventId',
  'reason',
];

const ADD_ITEM_KEYS: readonly string[] = [
  'itemId',
  'orderId',
  'listingId',
  'versionId',
  'commerceUnitTypeId',
  'quoteId',
  'lineKind',
  'quantity',
  'unitPriceMinor',
  'lineTotalMinor',
  'currency',
  'reservationId',
  'addedAt',
  'correlationId',
  'idempotencyKey',
];

const PLACE_ORDER_KEYS: readonly string[] = [
  'orderId',
  'snapshotId',
  'expectedTotalMinor',
  'policyVersionId',
  'placedAt',
  'updatedAt',
  'correlationId',
  'idempotencyKey',
  'eventId',
  'reason',
];

const CONFIRM_ORDER_KEYS: readonly string[] = [
  'orderId',
  'confirmedAt',
  'updatedAt',
  'correlationId',
  'idempotencyKey',
  'eventId',
  'reason',
];

const START_FULFILMENT_KEYS: readonly string[] = [
  'orderId',
  'fulfillingAt',
  'updatedAt',
  'correlationId',
  'idempotencyKey',
  'eventId',
  'reason',
];

const COMPLETE_ORDER_KEYS: readonly string[] = [
  'orderId',
  'completedAt',
  'updatedAt',
  'correlationId',
  'idempotencyKey',
  'eventId',
  'reason',
];

const CANCEL_ORDER_KEYS: readonly string[] = [
  'orderId',
  'cancellationReason',
  'cancelledAt',
  'updatedAt',
  'correlationId',
  'idempotencyKey',
  'eventId',
  'reason',
];

export class OrderService {
  readonly #repository: OrderRepository;

  constructor(repository: OrderRepository) {
    this.#repository = repository;
  }

  /**
   * Create an order as a draft with no items.
   *
   * Idempotent by key. Refuses `duplicate-order-id` when the order id already exists with different
   * content.
   */
  async createOrder(request: CreateOrderRequest): Promise<CreateOrderResult> {
    assertNoForeignConcerns(request, CREATE_ORDER_KEYS, 'createOrder');
    assertOrderIdentifier(request.orderId, 'orderId');
    assertOrderIdentifier(request.eventId, 'eventId');
    const createdAt = parseAndCheckInstant(request.createdAt, 'createdAt');
    const updatedAt = parseAndCheckInstant(request.updatedAt, 'updatedAt');

    const order = sealOrder(
      validateOrder(
        {
          orderId: request.orderId,
          buyerAccountId: request.buyerAccountId,
          sellerAccountId: request.sellerAccountId,
          status: 'draft',
          parentOrderId: null,
          fulfilmentRole: 'standalone',
          currency: request.currency,
          subtotalMinor: 0n,
          totalMinor: 0n,
          itemCount: 0,
          placedAt: null,
          confirmedAt: null,
          completedAt: null,
          cancelledAt: null,
          cancellationReason: null,
          createdAt,
          updatedAt,
          correlationId: request.correlationId,
          idempotencyKey: request.idempotencyKey,
        },
        'request',
      ),
    );

    const event = sealOrderEvent(
      validateOrderEvent(
        {
          eventId: request.eventId,
          orderId: request.orderId,
          kind: 'created',
          fromStatus: null,
          toStatus: 'draft',
          reason: request.reason,
          occurredAt: createdAt,
          correlationId: request.correlationId,
          idempotencyKey: request.idempotencyKey,
        },
        'request',
      ),
    );

    try {
      return await this.#create(order, event);
    } catch (error) {
      const conflicted =
        error instanceof OrderError &&
        (error.code === 'duplicate-order-id' || error.code === 'idempotency-key-reuse');
      if (!conflicted) throw error;

      const winner = await this.#repository.withTransaction((tx) =>
        tx.findOrderByIdempotencyKey(order.idempotencyKey),
      );
      if (winner === null || !orderEquals(winner, order)) throw error;
      return { order: sealOrder(winner), replayed: true };
    }
  }

  async #create(order: Order, event: OrderEvent): Promise<CreateOrderResult> {
    return this.#repository.withTransaction(async (tx) => {
      const existingKey = await tx.findOrderByIdempotencyKey(order.idempotencyKey);
      if (existingKey !== null) {
        if (!orderEquals(existingKey, order)) {
          throw new OrderError(
            'idempotency-key-reuse',
            `idempotency key "${order.idempotencyKey}" has already been used for a different order`,
          );
        }
        return { order: sealOrder(existingKey), replayed: true };
      }

      const existingId = await tx.findOrderById(order.orderId);
      if (existingId !== null) {
        if (!orderEquals(existingId, order)) {
          throw new OrderError(
            'duplicate-order-id',
            `order ${order.orderId} already exists. An order is created once and its lifecycle ` +
              'is updated through the service',
          );
        }
        return { order: sealOrder(existingId), replayed: true };
      }

      await tx.insertOrder(order);
      await tx.insertEvent(event);
      await this.#emitCreated(order, event, tx);
      return { order, replayed: false };
    });
  }

  /**
   * Add a line to a draft order.
   *
   * The unit price is supplied by the caller and must already equal the pinned version's price;
   * M-11 records it without recomputing it. Refuses `order-not-draft` once the order is placed,
   * `currency-mismatch` when the line's currency differs from the order's, and
   * `line-total-mismatch` when `lineTotalMinor` is not exactly `quantity * unitPriceMinor`.
   */
  async addItem(request: AddItemRequest): Promise<AddItemResult> {
    assertNoForeignConcerns(request, ADD_ITEM_KEYS, 'addItem');
    assertOrderIdentifier(request.itemId, 'itemId');
    assertOrderIdentifier(request.orderId, 'orderId');
    // The source fields are checked by the validator, which is also where the "exactly one source"
    // rule lives — asserting them here as well would refuse a quote line before that rule could
    // explain why a line needs a source at all.
    if (request.reservationId !== null) {
      assertOrderIdentifier(request.reservationId, 'reservationId');
    }
    const addedAt = parseAndCheckInstant(request.addedAt, 'addedAt');

    const item = sealOrderItem(
      validateOrderItem(
        {
          itemId: request.itemId,
          orderId: request.orderId,
          listingId: request.listingId ?? null,
          versionId: request.versionId ?? null,
          commerceUnitTypeId: request.commerceUnitTypeId ?? null,
          quoteId: request.quoteId ?? null,
          lineKind: request.lineKind ?? 'goods',
          quantity: request.quantity,
          unitPriceMinor: request.unitPriceMinor,
          lineTotalMinor: request.lineTotalMinor,
          currency: request.currency,
          reservationId: request.reservationId,
          addedAt,
          correlationId: request.correlationId,
          idempotencyKey: request.idempotencyKey,
        },
        'request',
      ),
    );

    try {
      return await this.#addItem(item);
    } catch (error) {
      const conflicted =
        error instanceof OrderError &&
        (error.code === 'duplicate-item-id' || error.code === 'idempotency-key-reuse');
      if (!conflicted) throw error;

      const winner = await this.#findItem(request.itemId, request.idempotencyKey);
      if (winner === null || !itemEquals(winner, item)) throw error;
      return { item: sealOrderItem(winner), replayed: true };
    }
  }

  async #addItem(item: OrderItem): Promise<AddItemResult> {
    return this.#repository.withTransaction(async (tx) => {
      const existingKey = await tx.findItemByIdempotencyKey(item.idempotencyKey);
      if (existingKey !== null) {
        if (!itemEquals(existingKey, item)) {
          throw new OrderError(
            'idempotency-key-reuse',
            `idempotency key "${item.idempotencyKey}" has already been used for a different item`,
          );
        }
        return { item: sealOrderItem(existingKey), replayed: true };
      }

      const existingId = await tx.findItemById(item.itemId);
      if (existingId !== null) {
        if (!itemEquals(existingId, item)) {
          throw new OrderError(
            'duplicate-item-id',
            `item ${item.itemId} already exists with different content`,
          );
        }
        return { item: sealOrderItem(existingId), replayed: true };
      }

      const order = await requireOrder(tx, item.orderId);
      if (order.status !== 'draft') {
        throw new OrderError(
          'order-not-draft',
          `order ${item.orderId} is ${order.status}; items may only be added to a draft`,
        );
      }
      if (item.currency !== order.currency) {
        throw new OrderError(
          'currency-mismatch',
          `item currency ${item.currency} does not match order currency ${order.currency}`,
        );
      }

      await tx.insertItem(item);
      return { item, replayed: false };
    });
  }

  async #findItem(itemId: string, idempotencyKey: string): Promise<OrderItem | null> {
    const byId = await this.#repository.withTransaction((tx) => tx.findItemById(itemId));
    if (byId !== null) return byId;
    return this.#repository.withTransaction((tx) => tx.findItemByIdempotencyKey(idempotencyKey));
  }

  /**
   * Place the order.
   *
   * Recomputes `subtotalMinor` and `totalMinor` as the exact integer sum of the line totals, refuses
   * `total-mismatch` if the caller's expected total disagrees, writes the immutable snapshot, moves
   * the order to `placed`, appends an event and emits. Refuses `order-empty` when there are no
   * items.
   */
  async placeOrder(request: PlaceOrderRequest): Promise<PlaceOrderResult> {
    assertNoForeignConcerns(request, PLACE_ORDER_KEYS, 'placeOrder');
    assertOrderIdentifier(request.orderId, 'orderId');
    assertOrderIdentifier(request.snapshotId, 'snapshotId');
    assertOrderIdentifier(request.eventId, 'eventId');
    if (request.policyVersionId !== null) {
      assertOrderIdentifier(request.policyVersionId, 'policyVersionId');
    }
    const placedAt = parseAndCheckInstant(request.placedAt, 'placedAt');
    const updatedAt = parseAndCheckInstant(request.updatedAt, 'updatedAt');

    return this.#repository.withTransaction(async (tx) => {
      const existingEvent = await tx.findEventByIdempotencyKey(request.idempotencyKey);
      if (existingEvent !== null) {
        const expected = buildPlacedEventFromRequest(request, existingEvent);
        if (!eventEquals(existingEvent, expected)) {
          throw new OrderError(
            'idempotency-key-reuse',
            `idempotency key "${request.idempotencyKey}" has already been used for a different event`,
          );
        }
        const order = await requireOrder(tx, request.orderId);
        const snapshot = await requireSnapshot(tx, request.orderId);
        return { order: sealOrder(order), snapshot: sealOrderSnapshot(snapshot), replayed: true };
      }

      const existingEventId = await tx.findEventById(request.eventId);
      if (existingEventId !== null) {
        const expected = buildPlacedEventFromRequest(request, existingEventId);
        if (!eventEquals(existingEventId, expected)) {
          throw new OrderError(
            'duplicate-event-id',
            `event ${request.eventId} already exists with different content`,
          );
        }
        const order = await requireOrder(tx, request.orderId);
        const snapshot = await requireSnapshot(tx, request.orderId);
        return { order: sealOrder(order), snapshot: sealOrderSnapshot(snapshot), replayed: true };
      }

      const order = await requireOrder(tx, request.orderId);
      if (order.status !== 'draft') {
        throw new OrderError(
          'order-not-draft',
          `order ${request.orderId} is ${order.status}; only a draft may be placed`,
        );
      }

      const items = await tx.findItemsByOrderId(order.orderId);
      if (items.length === 0) {
        throw new OrderError('order-empty', `order ${request.orderId} has no items`);
      }

      const subtotalMinor = items.reduce((sum, item) => sum + item.lineTotalMinor, 0n);
      const totalMinor = subtotalMinor;
      if (totalMinor !== request.expectedTotalMinor) {
        throw new OrderError(
          'total-mismatch',
          `computed total ${String(totalMinor)} does not match expected total ` +
            `${String(request.expectedTotalMinor)}`,
        );
      }

      const snapshot = sealOrderSnapshot(
        validateOrderSnapshot(
          {
            snapshotId: request.snapshotId,
            orderId: order.orderId,
            buyerAccountId: order.buyerAccountId,
            sellerAccountId: order.sellerAccountId,
            currency: order.currency,
            subtotalMinor,
            totalMinor,
            lines: buildSnapshotLines(items),
            policyVersionId: request.policyVersionId,
            capturedAt: placedAt,
            correlationId: request.correlationId,
            idempotencyKey: request.idempotencyKey,
          },
          'request',
        ),
      );

      const event = sealOrderEvent(
        validateOrderEvent(
          {
            eventId: request.eventId,
            orderId: order.orderId,
            kind: 'placed',
            fromStatus: 'draft',
            toStatus: 'placed',
            reason: request.reason,
            occurredAt: placedAt,
            correlationId: request.correlationId,
            idempotencyKey: request.idempotencyKey,
          },
          'request',
        ),
      );

      const updated = sealOrder({
        ...order,
        status: 'placed',
        subtotalMinor,
        totalMinor,
        itemCount: items.length,
        placedAt,
        updatedAt,
      });

      await tx.insertSnapshot(snapshot);
      await tx.updateOrder(updated);
      await tx.insertEvent(event);
      await this.#emitPlaced(updated, event, tx);
      return { order: updated, snapshot, replayed: false };
    });
  }

  /**
   * Confirm a placed order.
   *
   * `placed` → `confirmed`.
   */
  async confirmOrder(request: ConfirmOrderRequest): Promise<ConfirmOrderResult> {
    return this.#transition({
      request,
      permittedKeys: CONFIRM_ORDER_KEYS,
      operation: 'confirmOrder',
      fromStatus: 'placed',
      toStatus: 'confirmed',
      timestampValue: request.confirmedAt,
      timestampField: 'confirmedAt',
      orderTimestampField: 'confirmedAt',
      makeEvent: makeOrderConfirmedEvent,
      makeAction: makeOrderConfirmedAction,
    });
  }

  /**
   * Start fulfilling a confirmed order.
   *
   * `confirmed` → `fulfilling`.
   */
  async startFulfilment(request: StartFulfilmentRequest): Promise<StartFulfilmentResult> {
    return this.#transition({
      request,
      permittedKeys: START_FULFILMENT_KEYS,
      operation: 'startFulfilment',
      fromStatus: 'confirmed',
      toStatus: 'fulfilling',
      timestampValue: request.fulfillingAt,
      timestampField: 'fulfillingAt',
      orderTimestampField: null,
      makeEvent: makeOrderFulfillingEvent,
      makeAction: makeOrderFulfillingAction,
    });
  }

  /**
   * Complete a fulfilling order.
   *
   * `fulfilling` → `completed`. Terminal.
   */
  async completeOrder(request: CompleteOrderRequest): Promise<CompleteOrderResult> {
    return this.#transition({
      request,
      permittedKeys: COMPLETE_ORDER_KEYS,
      operation: 'completeOrder',
      fromStatus: 'fulfilling',
      toStatus: 'completed',
      timestampValue: request.completedAt,
      timestampField: 'completedAt',
      orderTimestampField: 'completedAt',
      makeEvent: makeOrderCompletedEvent,
      makeAction: makeOrderCompletedAction,
      guard: async (order, tx) => {
        if (order.fulfilmentRole !== 'parent') return;

        const children = await tx.findChildrenByParentId(order.orderId);
        const outstanding = children.filter((child) => !isTerminal(child.status));
        if (outstanding.length > 0) {
          throw new OrderError(
            'children-outstanding',
            `order ${order.orderId} has ${String(outstanding.length)} child order(s) still in ` +
              'flight; a parent completes only once every supplier has finished or failed',
          );
        }

        // Partial delivery completes the parent — the buyer's remedy for a short delivery is a
        // refund, not a permanently open order. But an order where *nothing* arrived was not
        // fulfilled at all, and calling that "completed" would misreport it to every downstream
        // consumer. That case is a cancellation.
        if (!children.some((child) => child.status === 'completed')) {
          throw new OrderError(
            'nothing-fulfilled',
            `every child of order ${order.orderId} was cancelled; an order where nothing was ` +
              'delivered is cancelled, not completed',
          );
        }
      },
    });
  }

  /**
   * Cancel an order.
   *
   * Any non-terminal status → `cancelled`. Terminal.
   */
  async cancelOrder(request: CancelOrderRequest): Promise<CancelOrderResult> {
    assertNoForeignConcerns(request, CANCEL_ORDER_KEYS, 'cancelOrder');
    const typed = request;
    assertOrderIdentifier(typed.orderId, 'orderId');
    assertOrderIdentifier(typed.eventId, 'eventId');
    const cancellationReason = assertCancellationReason(
      typed.cancellationReason,
      'cancellationReason',
    );
    const cancelledAt = parseAndCheckInstant(typed.cancelledAt, 'cancelledAt');
    const updatedAt = parseAndCheckInstant(typed.updatedAt, 'updatedAt');

    return this.#repository.withTransaction(async (tx) => {
      const existingEvent = await tx.findEventByIdempotencyKey(typed.idempotencyKey);
      if (existingEvent !== null) {
        const expected = buildCancelEventFromRequest(typed, existingEvent);
        if (!eventEquals(existingEvent, expected)) {
          throw new OrderError(
            'idempotency-key-reuse',
            `idempotency key "${typed.idempotencyKey}" has already been used for a different event`,
          );
        }
        const order = await requireOrder(tx, typed.orderId);
        return { order: sealOrder(order), replayed: true };
      }

      const existingEventId = await tx.findEventById(typed.eventId);
      if (existingEventId !== null) {
        const expected = buildCancelEventFromRequest(typed, existingEventId);
        if (!eventEquals(existingEventId, expected)) {
          throw new OrderError(
            'duplicate-event-id',
            `event ${typed.eventId} already exists with different content`,
          );
        }
        const order = await requireOrder(tx, typed.orderId);
        return { order: sealOrder(order), replayed: true };
      }

      const order = await requireOrder(tx, typed.orderId);
      if (isTerminal(order.status)) {
        throw new OrderError(
          'order-terminal',
          `order ${typed.orderId} is ${order.status} and cannot be cancelled`,
        );
      }
      assertTransitionLegal(order.status, 'cancelled');

      const event = sealOrderEvent(
        validateOrderEvent(
          {
            eventId: typed.eventId,
            orderId: order.orderId,
            kind: 'cancelled',
            fromStatus: order.status,
            toStatus: 'cancelled',
            reason: typed.reason,
            occurredAt: cancelledAt,
            correlationId: typed.correlationId,
            idempotencyKey: typed.idempotencyKey,
          },
          'request',
        ),
      );

      const updated = sealOrder({
        ...order,
        status: 'cancelled',
        cancelledAt,
        cancellationReason,
        updatedAt,
      });

      await tx.updateOrder(updated);
      await tx.insertEvent(event);
      await tx.insertOutbox(makeOrderCancelledEvent(updated, event));
      await tx.insertOutbox(makeOrderCancelledAction(updated, event));

      // Cancelling a parent cascades to its children, in the same transaction, carrying the
      // parent's reason so every cancelled child can be attributed. Children that already reached
      // a terminal state are left alone: a supplier who already delivered is not un-delivered by
      // the buyer abandoning the rest of the order.
      //
      // The child events are derived from the parent's event id rather than supplied by the
      // caller, because the caller cannot know how many children there are — and an id derived
      // from the child order alone would collide if that child were ever cancelled twice.
      if (updated.fulfilmentRole === 'parent') {
        const children = await tx.findChildrenByParentId(updated.orderId);
        for (const child of children) {
          if (isTerminal(child.status)) continue;

          const childEvent = sealOrderEvent(
            validateOrderEvent(
              {
                eventId: `${typed.eventId}:${child.orderId}`,
                orderId: child.orderId,
                kind: 'cancelled',
                fromStatus: child.status,
                toStatus: 'cancelled',
                reason: typed.reason,
                occurredAt: cancelledAt,
                correlationId: typed.correlationId,
                idempotencyKey: `${typed.idempotencyKey}:${child.orderId}`,
              },
              'request',
            ),
          );

          const cancelledChild = sealOrder({
            ...child,
            status: 'cancelled',
            cancelledAt,
            cancellationReason,
            updatedAt,
          });

          await tx.updateOrder(cancelledChild);
          await tx.insertEvent(childEvent);
          await tx.insertOutbox(makeOrderCancelledEvent(cancelledChild, childEvent));
          await tx.insertOutbox(makeOrderCancelledAction(cancelledChild, childEvent));
        }
      }

      return { order: updated, replayed: false };
    });
  }

  /**
   * Split a placed order across several suppliers.
   *
   * The parent becomes `fulfilling` and each allocation becomes a `placed` child order with its own
   * seller and its own lifecycle. One transaction: a partially written split would leave the
   * unallocated remainder owned by nobody, which is exactly the state this operation exists to make
   * impossible.
   *
   * Refuses `order-not-placed`, `already-split`, `nested-split`, `empty-allocation`,
   * `allocation-currency-mismatch` and — the central rule — `allocation-mismatch` when the summed
   * child quantities do not equal the parent's ordered quantity for every pinned listing version.
   */
  async splitOrder(request: SplitOrderRequest): Promise<SplitOrderResult> {
    assertNoForeignConcerns(request, SPLIT_ORDER_KEYS, 'splitOrder');
    const typed = request;
    assertOrderIdentifier(typed.parentOrderId, 'parentOrderId');
    assertOrderIdentifier(typed.eventId, 'eventId');
    const occurredAt = parseAndCheckInstant(typed.occurredAt, 'occurredAt');
    const updatedAt = parseAndCheckInstant(typed.updatedAt, 'updatedAt');

    if (typed.allocations.length === 0) {
      throw new OrderError('empty-allocation', 'splitOrder needs at least one allocation');
    }
    for (const allocation of typed.allocations) {
      assertOrderIdentifier(allocation.orderId, 'allocations[].orderId');
      assertOrderIdentifier(allocation.eventId, 'allocations[].eventId');
      if (allocation.items.length === 0) {
        throw new OrderError(
          'empty-allocation',
          `allocation ${allocation.orderId} carries no items`,
        );
      }
    }

    const currencies = new Set(
      typed.allocations.flatMap((a) => a.items.map((item) => item.currency)),
    );
    if (currencies.size > 1) {
      throw new OrderError(
        'allocation-currency-mismatch',
        `the allocations name more than one currency (${[...currencies].sort().join(', ')}); ` +
          'every child of one order is priced in the order’s currency',
      );
    }

    return this.#repository.withTransaction(async (tx) => {
      const existingEvent = await tx.findEventByIdempotencyKey(typed.idempotencyKey);
      if (existingEvent !== null) {
        const parent = await requireOrder(tx, typed.parentOrderId);
        return {
          order: sealOrder(parent),
          children: await tx.findChildrenByParentId(parent.orderId),
          replayed: true,
        };
      }

      const parent = await requireOrder(tx, typed.parentOrderId);
      if (parent.fulfilmentRole === 'child') {
        throw new OrderError(
          'nested-split',
          `order ${parent.orderId} is itself a child; split fulfilment is two levels only`,
        );
      }
      if (parent.fulfilmentRole === 'parent') {
        throw new OrderError('already-split', `order ${parent.orderId} has already been split`);
      }
      if (parent.status !== 'placed') {
        throw new OrderError(
          'order-not-placed',
          `order ${parent.orderId} is ${parent.status}; only a placed order may be split`,
        );
      }
      const allocationCurrency = typed.allocations[0]?.items[0]?.currency;
      if (allocationCurrency !== undefined && allocationCurrency !== parent.currency) {
        throw new OrderError(
          'allocation-currency-mismatch',
          `the allocations are priced in ${allocationCurrency} but order ${parent.orderId} is in ` +
            parent.currency,
        );
      }

      // The central rule. Group both sides by the **pinned source** — the listing version, or the
      // accepted quote for a line that came from a tender — and require them to agree exactly:
      // allocating 7 and 5 tonnes of a 20-tonne order and committing it would leave the remaining 8
      // owned by nobody, with no record that anyone was ever meant to supply it.
      const parentItems = await tx.findItemsByOrderId(parent.orderId);
      const ordered = sumBySource(parentItems.map((i) => [lineSource(i), i.quantity] as const));
      const allocated = sumBySource(
        typed.allocations.flatMap((a) => a.items.map((i) => [lineSource(i), i.quantity] as const)),
      );
      for (const [source, quantity] of ordered) {
        const given = allocated.get(source) ?? 0n;
        if (given !== quantity) {
          throw new OrderError(
            'allocation-mismatch',
            `source ${source}: the order is for ${String(quantity)} but ${String(given)} was ` +
              'allocated. Every ordered unit must be allocated to exactly one supplier',
          );
        }
      }
      for (const versionId of allocated.keys()) {
        if (!ordered.has(versionId)) {
          throw new OrderError(
            'allocation-mismatch',
            `version ${versionId} was allocated but is not on the order`,
          );
        }
      }

      const children: Order[] = [];
      for (const allocation of typed.allocations) {
        const child = sealOrder(
          validateOrder(
            {
              orderId: allocation.orderId,
              buyerAccountId: parent.buyerAccountId,
              sellerAccountId: allocation.sellerAccountId,
              status: 'placed',
              parentOrderId: parent.orderId,
              fulfilmentRole: 'child',
              currency: parent.currency,
              subtotalMinor: allocation.items.reduce((sum, i) => sum + i.lineTotalMinor, 0n),
              totalMinor: allocation.items.reduce((sum, i) => sum + i.lineTotalMinor, 0n),
              itemCount: allocation.items.length,
              placedAt: occurredAt,
              confirmedAt: null,
              completedAt: null,
              cancelledAt: null,
              cancellationReason: null,
              createdAt: occurredAt,
              updatedAt,
              correlationId: typed.correlationId,
              idempotencyKey: allocation.idempotencyKey,
            },
            'request',
          ),
        );

        await tx.insertOrder(child);
        for (const item of allocation.items) {
          await tx.insertItem(
            sealOrderItem(
              validateOrderItem(
                {
                  itemId: item.itemId,
                  orderId: child.orderId,
                  listingId: item.listingId,
                  versionId: item.versionId,
                  commerceUnitTypeId: item.commerceUnitTypeId,
                  quoteId: item.quoteId ?? null,
                  lineKind: item.lineKind ?? 'goods',
                  quantity: item.quantity,
                  unitPriceMinor: item.unitPriceMinor,
                  lineTotalMinor: item.lineTotalMinor,
                  currency: item.currency,
                  reservationId: item.reservationId,
                  addedAt: occurredAt,
                  correlationId: typed.correlationId,
                  idempotencyKey: `${allocation.idempotencyKey}:${item.itemId}`,
                },
                'request',
              ),
            ),
          );
        }

        const childEvent = sealOrderEvent(
          validateOrderEvent(
            {
              eventId: allocation.eventId,
              orderId: child.orderId,
              kind: 'placed',
              fromStatus: null,
              toStatus: 'placed',
              reason: typed.reason,
              occurredAt,
              correlationId: typed.correlationId,
              idempotencyKey: allocation.idempotencyKey,
            },
            'request',
          ),
        );
        await tx.insertEvent(childEvent);
        await tx.insertOutbox(makeOrderPlacedEvent(child, childEvent));
        await tx.insertOutbox(makeOrderPlacedAction(child, childEvent));
        children.push(child);
      }

      const updatedParent = sealOrder({
        ...parent,
        status: 'fulfilling',
        fulfilmentRole: 'parent',
        updatedAt,
      });
      const parentEvent = sealOrderEvent(
        validateOrderEvent(
          {
            eventId: typed.eventId,
            orderId: parent.orderId,
            kind: 'fulfilling',
            fromStatus: parent.status,
            toStatus: 'fulfilling',
            reason: typed.reason,
            occurredAt,
            correlationId: typed.correlationId,
            idempotencyKey: typed.idempotencyKey,
          },
          'request',
        ),
      );

      // Guarded: another caller may have split this same parent while this request was being
      // prepared. Both read it as standalone, both built a full set of children, and only one may
      // win — otherwise the same twenty tonnes is promised to two different sets of suppliers, and
      // the loser's children are invisible to the winner.
      const won = await tx.updateOrderIfRole(updatedParent, 'standalone');
      if (!won) {
        throw new OrderError(
          'already-split',
          `order ${parent.orderId} was split by another transaction while this one was open`,
        );
      }
      await tx.insertEvent(parentEvent);
      await tx.insertOutbox(
        makeOrderSplitEvent(
          updatedParent,
          parentEvent,
          children.map((c) => c.orderId),
        ),
      );
      await tx.insertOutbox(
        makeOrderSplitAction(
          updatedParent,
          parentEvent,
          children.map((c) => c.orderId),
        ),
      );

      return { order: updatedParent, children: Object.freeze(children), replayed: false };
    });
  }

  /** Every child of one parent, sealed and ordered by order id. */
  async listChildren(parentOrderId: string): Promise<readonly Order[]> {
    assertOrderIdentifier(parentOrderId, 'parentOrderId');
    const children = await this.#repository.withTransaction((tx) =>
      tx.findChildrenByParentId(parentOrderId),
    );
    return sealOrders(children);
  }

  /**
   * What an order's children add up to.
   *
   * Every number is summed from rows that already exist; nothing here reads a stored ratio, because
   * a stored ratio drifts the first time a child moves and nobody recomputes it.
   */
  async getFulfilmentSummary(orderId: string): Promise<FulfilmentSummary> {
    assertOrderIdentifier(orderId, 'orderId');
    return this.#repository.withTransaction(async (tx) => {
      // Reading the order first means an unknown id is refused rather than silently summarised
      // as a row of zeroes.
      await requireOrder(tx, orderId);
      const ownItems = await tx.findItemsByOrderId(orderId);
      const orderedQuantity = ownItems.reduce((sum, item) => sum + item.quantity, 0n);

      const childOrders = await tx.findChildrenByParentId(orderId);
      const children: FulfilmentChild[] = [];
      let allocated = 0n;
      let fulfilled = 0n;
      let cancelled = 0n;

      for (const child of childOrders) {
        const items = await tx.findItemsByOrderId(child.orderId);
        const quantity = items.reduce((sum, item) => sum + item.quantity, 0n);
        allocated += quantity;
        if (child.status === 'completed') fulfilled += quantity;
        if (child.status === 'cancelled') cancelled += quantity;
        children.push(
          Object.freeze({
            orderId: child.orderId,
            sellerAccountId: child.sellerAccountId,
            quantity,
            status: child.status,
          }),
        );
      }

      return Object.freeze({
        orderedQuantity,
        allocatedQuantity: allocated,
        fulfilledQuantity: fulfilled,
        cancelledQuantity: cancelled,
        pendingQuantity: allocated - fulfilled - cancelled,
        children: Object.freeze(children),
        fullyAllocated: allocated === orderedQuantity,
        fullyFulfilled: orderedQuantity > 0n && fulfilled === orderedQuantity,
      }) satisfies FulfilmentSummary;
    });
  }

  async #transition<T extends TransitionRequest>(options: {
    readonly request: T;
    readonly permittedKeys: readonly string[];
    readonly operation: string;
    readonly fromStatus: OrderStatus;
    readonly toStatus: OrderStatus;
    /**
     * The transition's own instant, taken from the request by the caller.
     *
     * Passed as a value rather than looked up by name, because every operation names its timestamp
     * differently — `confirmedAt`, `fulfillingAt`, `completedAt` — and reading it by string index
     * would mean typing the request as a bag of unknowns, which is how the casts got here.
     */
    readonly timestampValue: string;
    /** The field's name, for the wording of a refusal. */
    readonly timestampField: string;
    readonly orderTimestampField: 'confirmedAt' | 'completedAt' | null;
    readonly makeEvent: (order: Order, event: OrderEvent) => OutboxEntry;
    readonly makeAction: (order: Order, event: OrderEvent) => OutboxEntry;
    /**
     * An extra rule checked inside the transaction, after the order is loaded and before anything
     * is written. A parent order uses it to refuse completion while a child is still in flight;
     * checking that before opening the transaction would be a race against the child finishing.
     */
    readonly guard?: (order: Order, tx: OrderTransaction) => Promise<void>;
  }): Promise<{ readonly order: Order; readonly replayed: boolean }> {
    const request = options.request;
    assertNoForeignConcerns(request, options.permittedKeys, options.operation);
    assertOrderIdentifier(request.orderId, 'orderId');
    assertOrderIdentifier(request.eventId, 'eventId');
    const occurredAt = parseAndCheckInstant(options.timestampValue, options.timestampField);
    const updatedAt = parseAndCheckInstant(request.updatedAt, 'updatedAt');

    return this.#repository.withTransaction(async (tx) => {
      const existingEvent = await tx.findEventByIdempotencyKey(request.idempotencyKey);
      if (existingEvent !== null) {
        const expected = buildTransitionEventFromRequest(
          request,
          existingEvent,
          options.fromStatus,
          options.toStatus,
          occurredAt,
        );
        if (!eventEquals(existingEvent, expected)) {
          throw new OrderError(
            'idempotency-key-reuse',
            `idempotency key "${request.idempotencyKey}" has already been used for a different event`,
          );
        }
        const order = await requireOrder(tx, request.orderId);
        return { order: sealOrder(order), replayed: true };
      }

      const existingEventId = await tx.findEventById(request.eventId);
      if (existingEventId !== null) {
        const expected = buildTransitionEventFromRequest(
          request,
          existingEventId,
          options.fromStatus,
          options.toStatus,
          occurredAt,
        );
        if (!eventEquals(existingEventId, expected)) {
          throw new OrderError(
            'duplicate-event-id',
            `event ${request.eventId} already exists with different content`,
          );
        }
        const order = await requireOrder(tx, request.orderId);
        return { order: sealOrder(order), replayed: true };
      }

      const order = await requireOrder(tx, request.orderId);
      if (order.status !== options.fromStatus) {
        throw new OrderError(
          'illegal-transition',
          `order ${order.orderId} is ${order.status}; cannot transition to ${options.toStatus}`,
        );
      }
      assertTransitionLegal(options.fromStatus, options.toStatus);
      if (options.guard !== undefined) await options.guard(order, tx);

      const event = sealOrderEvent(
        validateOrderEvent(
          {
            eventId: request.eventId,
            orderId: order.orderId,
            kind: options.toStatus as OrderEventKind,
            fromStatus: options.fromStatus,
            toStatus: options.toStatus,
            reason: request.reason,
            occurredAt,
            correlationId: request.correlationId,
            idempotencyKey: request.idempotencyKey,
          },
          'request',
        ),
      );

      // Written out rather than computed from a key, because a computed key widens the record to a
      // string-indexed bag and the only way back is a cast — which is what let a wrong field name
      // through the compiler in the first place. Two statuses stamp a timestamp; both are named.
      const moved: Order = { ...order, status: options.toStatus, updatedAt };
      const updated = sealOrder(
        options.orderTimestampField === 'confirmedAt'
          ? { ...moved, confirmedAt: occurredAt }
          : options.orderTimestampField === 'completedAt'
            ? { ...moved, completedAt: occurredAt }
            : moved,
      );

      await tx.updateOrder(updated);
      await tx.insertEvent(event);
      await tx.insertOutbox(options.makeEvent(updated, event));
      await tx.insertOutbox(options.makeAction(updated, event));
      return { order: updated, replayed: false };
    });
  }

  /** Return one order by id, sealed. */
  async getOrder(orderId: string): Promise<Order | null> {
    assertOrderIdentifier(orderId, 'orderId');
    const order = await this.#repository.withTransaction((tx) => tx.findOrderById(orderId));
    return order === null ? null : sealOrder(order);
  }

  /** Return every item for the order, oldest first. */
  async listItems(orderId: string): Promise<readonly OrderItem[]> {
    assertOrderIdentifier(orderId, 'orderId');
    const items = await this.#repository.withTransaction((tx) => tx.findItemsByOrderId(orderId));
    return sealOrderItems(items);
  }

  /** Return the snapshot for the order, or null if it has not been placed. */
  async getSnapshot(orderId: string): Promise<OrderSnapshot | null> {
    assertOrderIdentifier(orderId, 'orderId');
    const snapshot = await this.#repository.withTransaction((tx) =>
      tx.findSnapshotByOrderId(orderId),
    );
    return snapshot === null ? null : sealOrderSnapshot(snapshot);
  }

  /** Return every event for the order, oldest first. */
  async getHistory(orderId: string): Promise<readonly OrderEvent[]> {
    assertOrderIdentifier(orderId, 'orderId');
    const events = await this.#repository.withTransaction((tx) => tx.findEventsByOrderId(orderId));
    return sealOrderEvents(events);
  }

  /** Every order for the buyer, oldest first. */
  async listOrdersByBuyer(buyerAccountId: string): Promise<readonly Order[]> {
    assertOrderIdentifier(buyerAccountId, 'buyerAccountId');
    const orders = await this.#repository.withTransaction((tx) =>
      tx.findOrdersByBuyerAccountId(buyerAccountId),
    );
    return sealOrders(orders);
  }

  /** Every order for the seller, oldest first. */
  async listOrdersBySeller(sellerAccountId: string): Promise<readonly Order[]> {
    assertOrderIdentifier(sellerAccountId, 'sellerAccountId');
    const orders = await this.#repository.withTransaction((tx) =>
      tx.findOrdersBySellerAccountId(sellerAccountId),
    );
    return sealOrders(orders);
  }

  async #emitCreated(order: Order, event: OrderEvent, tx: OrderTransaction): Promise<void> {
    await tx.insertOutbox(makeOrderCreatedEvent(order, event));
    await tx.insertOutbox(makeOrderCreatedAction(order, event));
  }

  async #emitPlaced(order: Order, event: OrderEvent, tx: OrderTransaction): Promise<void> {
    await tx.insertOutbox(makeOrderPlacedEvent(order, event));
    await tx.insertOutbox(makeOrderPlacedAction(order, event));
  }
}

function assertNoForeignConcerns(
  request: object,
  permitted: readonly string[],
  operation: string,
): void {
  if (request === null || typeof request !== 'object') {
    throw new OrderError(
      'malformed-record',
      `${operation} needs a request object, got ${request === null ? 'null' : typeof request}`,
    );
  }

  for (const key of Object.keys(request)) {
    if (permitted.includes(key)) continue;

    const owner = FOREIGN_FIELDS[key];
    if (owner !== undefined) {
      throw new OrderError(
        'foreign-concern',
        `${operation} carried "${key}", but ${owner}. An order record carries only what M-11 owns`,
      );
    }
    throw new OrderError(
      'foreign-concern',
      `${operation} carried the unrecognised field "${key}". The permitted fields are ` +
        `${permitted.join(', ')}; anything else would be accepted and silently dropped`,
    );
  }
}

function parseAndCheckInstant(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new OrderError(
      'malformed-instant',
      `${field} is ${value === null ? 'null' : typeof value}; expected a UTC instant string`,
    );
  }
  try {
    return parseInstant(value).source;
  } catch (error) {
    if (error instanceof InvalidInstantError) {
      throw new OrderError('malformed-instant', `${field}: ${error.message}`);
    }
    throw error;
  }
}

async function requireOrder(tx: OrderTransaction, orderId: string): Promise<Order> {
  const order = await tx.findOrderById(orderId);
  if (order === null) {
    throw new OrderError('order-not-found', `order ${orderId} does not exist`);
  }
  return order;
}

async function requireSnapshot(tx: OrderTransaction, orderId: string): Promise<OrderSnapshot> {
  const snapshot = await tx.findSnapshotByOrderId(orderId);
  if (snapshot === null) {
    throw new OrderError('malformed-record', `order ${orderId} has no snapshot`);
  }
  return snapshot;
}

function assertTransitionLegal(fromStatus: OrderStatus, toStatus: OrderStatus): void {
  const legal = ORDER_TRANSITIONS[fromStatus];
  if (!legal.includes(toStatus)) {
    throw new OrderError(
      'illegal-transition',
      `cannot transition from ${fromStatus} to ${toStatus}; expected one of ${legal.join(', ')}`,
    );
  }
}

function isTerminal(status: OrderStatus): boolean {
  return status === 'completed' || status === 'cancelled';
}

/**
 * Whether two orders are the same request.
 *
 * **The instant is deliberately not compared.** Idempotency is about what the caller asked for, not
 * about when they asked: a retry arrives later than the original by definition, so comparing
 * `createdAt` would make every real retry a conflict and the whole mechanism useless. It used to,
 * and only a live test with a real clock caught it — the unit suites pin the clock, so both attempts
 * carried the same instant and the two agreed.
 *
 * What is compared is the business content. A retry that changes the buyer, the seller or the
 * currency is not a retry, and `idempotency-key-reuse` is the right answer for it.
 */
function orderEquals(a: Order, b: Order): boolean {
  return (
    a.orderId === b.orderId &&
    a.buyerAccountId === b.buyerAccountId &&
    a.sellerAccountId === b.sellerAccountId &&
    a.currency === b.currency
  );
}

function itemEquals(a: OrderItem, b: OrderItem): boolean {
  return (
    a.itemId === b.itemId &&
    a.orderId === b.orderId &&
    a.listingId === b.listingId &&
    a.versionId === b.versionId &&
    a.commerceUnitTypeId === b.commerceUnitTypeId &&
    a.quoteId === b.quoteId &&
    a.lineKind === b.lineKind &&
    a.quantity === b.quantity &&
    a.unitPriceMinor === b.unitPriceMinor &&
    a.lineTotalMinor === b.lineTotalMinor &&
    a.currency === b.currency &&
    a.reservationId === b.reservationId &&
    a.addedAt === b.addedAt
  );
}

/**
 * Whether two records describe the same request.
 *
 * **Neither the instant nor the correlation id is compared.** Idempotency is about *what* the caller
 * asked for. A retry arrives later than the original by definition, and it carries a fresh
 * correlation id unless the client happened to reuse one — so comparing either would make every real
 * retry a conflict and the whole mechanism useless. Both used to be compared, and only a live test
 * with a real clock caught it: the unit suites pin the clock and the id generator, so the two
 * attempts agreed and the divergence was invisible.
 *
 * What is compared is the business content. A retry that changes an amount, a party or an asset is
 * not a retry, and `idempotency-key-reuse` is the right answer for it.
 */
function eventEquals(a: OrderEvent, b: OrderEvent): boolean {
  return (
    a.eventId === b.eventId &&
    a.orderId === b.orderId &&
    a.kind === b.kind &&
    a.fromStatus === b.fromStatus &&
    a.toStatus === b.toStatus &&
    a.reason === b.reason &&
    a.idempotencyKey === b.idempotencyKey
  );
}

function buildSnapshotLines(items: readonly OrderItem[]): Readonly<Record<string, unknown>> {
  return {
    items: items.map((item) => ({
      item_id: item.itemId,
      listing_id: item.listingId,
      version_id: item.versionId,
      commerce_unit_type_id: item.commerceUnitTypeId,
      quantity: String(item.quantity),
      unit_price_minor: String(item.unitPriceMinor),
      line_total_minor: String(item.lineTotalMinor),
      currency: item.currency,
      reservation_id: item.reservationId,
      added_at: item.addedAt,
    })),
  };
}

function buildPlacedEventFromRequest(request: PlaceOrderRequest, stored: OrderEvent): OrderEvent {
  return {
    eventId: stored.eventId,
    orderId: stored.orderId,
    kind: 'placed',
    fromStatus: 'draft',
    toStatus: 'placed',
    reason: request.reason,
    occurredAt: request.placedAt,
    correlationId: request.correlationId,
    idempotencyKey: request.idempotencyKey,
  };
}

function buildTransitionEventFromRequest(
  request: TransitionRequest,
  stored: OrderEvent,
  fromStatus: OrderStatus,
  toStatus: OrderStatus,
  occurredAt: string,
): OrderEvent {
  return {
    eventId: stored.eventId,
    orderId: stored.orderId,
    kind: toStatus as OrderEventKind,
    fromStatus,
    toStatus,
    reason: request.reason,
    occurredAt,
    correlationId: request.correlationId,
    idempotencyKey: request.idempotencyKey,
  };
}

function buildCancelEventFromRequest(request: CancelOrderRequest, stored: OrderEvent): OrderEvent {
  return {
    eventId: stored.eventId,
    orderId: stored.orderId,
    kind: 'cancelled',
    fromStatus: stored.fromStatus,
    toStatus: 'cancelled',
    reason: request.reason,
    occurredAt: request.cancelledAt,
    correlationId: request.correlationId,
    idempotencyKey: request.idempotencyKey,
  };
}

/** Sum quantities by pinned source, so both sides of a split can be compared exactly. */
function sumBySource(entries: readonly (readonly [string, bigint])[]): Map<string, bigint> {
  const totals = new Map<string, bigint>();
  for (const [source, quantity] of entries) {
    totals.set(source, (totals.get(source) ?? 0n) + quantity);
  }
  return totals;
}

/**
 * The permanent address a line was priced from.
 *
 * A listing line pins a version; a quote line pins the accepted offer, which M-10 holds immutable by
 * trigger. Exactly one is present — the validator and `order_item_names_one_source` both say so —
 * so this always answers, and the fallback exists only because TypeScript cannot see that.
 */
function lineSource(item: {
  readonly versionId: string | null;
  readonly quoteId?: string | null;
}): string {
  return item.versionId ?? item.quoteId ?? '';
}
