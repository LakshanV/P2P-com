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
  type Order,
  type OrderEvent,
  type OrderEventKind,
  type OrderItem,
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
  readonly listingId: string;
  readonly versionId: string;
  readonly commerceUnitTypeId: string;
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
    assertOrderIdentifier(request.listingId, 'listingId');
    assertOrderIdentifier(request.versionId, 'versionId');
    assertOrderIdentifier(request.commerceUnitTypeId, 'commerceUnitTypeId');
    if (request.reservationId !== null) {
      assertOrderIdentifier(request.reservationId, 'reservationId');
    }
    const addedAt = parseAndCheckInstant(request.addedAt, 'addedAt');

    const item = sealOrderItem(
      validateOrderItem(
        {
          itemId: request.itemId,
          orderId: request.orderId,
          listingId: request.listingId,
          versionId: request.versionId,
          commerceUnitTypeId: request.commerceUnitTypeId,
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
      timestampField: 'completedAt',
      orderTimestampField: 'completedAt',
      makeEvent: makeOrderCompletedEvent,
      makeAction: makeOrderCompletedAction,
    });
  }

  /**
   * Cancel an order.
   *
   * Any non-terminal status → `cancelled`. Terminal.
   */
  async cancelOrder(request: CancelOrderRequest): Promise<CancelOrderResult> {
    assertNoForeignConcerns(request, CANCEL_ORDER_KEYS, 'cancelOrder');
    assertOrderIdentifier(request.orderId, 'orderId');
    assertOrderIdentifier(request.eventId, 'eventId');
    const cancellationReason = assertCancellationReason(
      request.cancellationReason,
      'cancellationReason',
    );
    const cancelledAt = parseAndCheckInstant(request.cancelledAt, 'cancelledAt');
    const updatedAt = parseAndCheckInstant(request.updatedAt, 'updatedAt');

    return this.#repository.withTransaction(async (tx) => {
      const existingEvent = await tx.findEventByIdempotencyKey(request.idempotencyKey);
      if (existingEvent !== null) {
        const expected = buildCancelEventFromRequest(request, existingEvent);
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
        const expected = buildCancelEventFromRequest(request, existingEventId);
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
      if (isTerminal(order.status)) {
        throw new OrderError(
          'order-terminal',
          `order ${request.orderId} is ${order.status} and cannot be cancelled`,
        );
      }
      assertTransitionLegal(order.status, 'cancelled');

      const event = sealOrderEvent(
        validateOrderEvent(
          {
            eventId: request.eventId,
            orderId: order.orderId,
            kind: 'cancelled',
            fromStatus: order.status,
            toStatus: 'cancelled',
            reason: request.reason,
            occurredAt: cancelledAt,
            correlationId: request.correlationId,
            idempotencyKey: request.idempotencyKey,
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
      await tx.insertOutbox(makeOrderCancelledEvent(updated, event, cancellationReason));
      await tx.insertOutbox(makeOrderCancelledAction(updated, event, cancellationReason));
      return { order: updated, replayed: false };
    });
  }

  async #transition<T extends { readonly orderId: string; readonly eventId: string }>(options: {
    readonly request: T;
    readonly permittedKeys: readonly string[];
    readonly operation: string;
    readonly fromStatus: OrderStatus;
    readonly toStatus: OrderStatus;
    readonly timestampField: string;
    readonly orderTimestampField: keyof Order | null;
    readonly makeEvent: (
      order: Order,
      event: OrderEvent,
    ) => import('../../platform/outbox/types.ts').OutboxEntry;
    readonly makeAction: (
      order: Order,
      event: OrderEvent,
    ) => import('../../platform/outbox/types.ts').OutboxEntry;
  }): Promise<{ readonly order: Order; readonly replayed: boolean }> {
    const request = options.request as Record<string, unknown>;
    assertNoForeignConcerns(request, options.permittedKeys, options.operation);
    assertOrderIdentifier(request.orderId as string, 'orderId');
    assertOrderIdentifier(request.eventId as string, 'eventId');
    const occurredAt = parseAndCheckInstant(
      request[options.timestampField] as string,
      options.timestampField,
    );
    const updatedAt = parseAndCheckInstant(request.updatedAt as string, 'updatedAt');

    return this.#repository.withTransaction(async (tx) => {
      const existingEvent = await tx.findEventByIdempotencyKey(request.idempotencyKey as string);
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
        const order = await requireOrder(tx, request.orderId as string);
        return { order: sealOrder(order), replayed: true };
      }

      const existingEventId = await tx.findEventById(request.eventId as string);
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
        const order = await requireOrder(tx, request.orderId as string);
        return { order: sealOrder(order), replayed: true };
      }

      const order = await requireOrder(tx, request.orderId as string);
      if (order.status !== options.fromStatus) {
        throw new OrderError(
          'illegal-transition',
          `order ${order.orderId} is ${order.status}; cannot transition to ${options.toStatus}`,
        );
      }
      assertTransitionLegal(options.fromStatus, options.toStatus);

      const event = sealOrderEvent(
        validateOrderEvent(
          {
            eventId: request.eventId as string,
            orderId: order.orderId,
            kind: options.toStatus as OrderEventKind,
            fromStatus: options.fromStatus,
            toStatus: options.toStatus,
            reason: request.reason as string,
            occurredAt,
            correlationId: request.correlationId as string,
            idempotencyKey: request.idempotencyKey as string,
          },
          'request',
        ),
      );

      const updated = sealOrder({
        ...order,
        status: options.toStatus,
        ...(options.orderTimestampField !== null
          ? { [options.orderTimestampField]: occurredAt }
          : {}),
        updatedAt,
      } as unknown as Order);

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

function orderEquals(a: Order, b: Order): boolean {
  return (
    a.orderId === b.orderId &&
    a.buyerAccountId === b.buyerAccountId &&
    a.sellerAccountId === b.sellerAccountId &&
    a.currency === b.currency &&
    a.createdAt === b.createdAt
  );
}

function itemEquals(a: OrderItem, b: OrderItem): boolean {
  return (
    a.itemId === b.itemId &&
    a.orderId === b.orderId &&
    a.listingId === b.listingId &&
    a.versionId === b.versionId &&
    a.commerceUnitTypeId === b.commerceUnitTypeId &&
    a.quantity === b.quantity &&
    a.unitPriceMinor === b.unitPriceMinor &&
    a.lineTotalMinor === b.lineTotalMinor &&
    a.currency === b.currency &&
    a.reservationId === b.reservationId &&
    a.addedAt === b.addedAt
  );
}

function eventEquals(a: OrderEvent, b: OrderEvent): boolean {
  return (
    a.eventId === b.eventId &&
    a.orderId === b.orderId &&
    a.kind === b.kind &&
    a.fromStatus === b.fromStatus &&
    a.toStatus === b.toStatus &&
    a.reason === b.reason &&
    a.occurredAt === b.occurredAt &&
    a.correlationId === b.correlationId &&
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
  request: Record<string, unknown>,
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
    reason: request.reason as string,
    occurredAt,
    correlationId: request.correlationId as string,
    idempotencyKey: request.idempotencyKey as string,
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
