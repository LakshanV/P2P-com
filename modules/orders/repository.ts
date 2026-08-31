/**
 * M-11 Orders — persistence port.
 *
 * The service is written against this interface. The port exposes order lookup, creation and
 * lifecycle updates, append-only item storage, append-only snapshot storage, append-only event
 * storage, and the outbox insert every producing module must support.
 *
 * Owned by: M-11 Orders.
 */

import { InMemoryOutboxStore } from '../../platform/outbox/repository.ts';
import type { OutboxEntry, OutboxTransaction } from '../../platform/outbox/types.ts';

import {
  sealOrder,
  sealOrderEvent,
  sealOrderEvents,
  sealOrderItem,
  sealOrderItems,
  sealOrderSnapshot,
  sealOrderSnapshots,
  sealOrders,
} from './immutable.ts';
import {
  OrderError,
  type FulfilmentRole,
  type Order,
  type OrderEvent,
  type OrderItem,
  type OrderSnapshot,
} from './types.ts';

export interface OrderTransaction extends OutboxTransaction {
  /** Order lookup and creation. */
  findOrderById(orderId: string): Promise<Order | null>;
  findOrderByIdempotencyKey(idempotencyKey: string): Promise<Order | null>;
  findOrdersByBuyerAccountId(buyerAccountId: string): Promise<readonly Order[]>;
  findOrdersBySellerAccountId(sellerAccountId: string): Promise<readonly Order[]>;
  /**
   * Every child of one parent, ordered by order id.
   *
   * The order is fixed rather than incidental because a fulfilment summary is computed from this
   * list, and a summary whose row order depends on insertion order is one two readers can disagree
   * about.
   */
  findChildrenByParentId(parentOrderId: string): Promise<readonly Order[]>;
  insertOrder(order: Order): Promise<void>;
  updateOrder(order: Order): Promise<void>;
  /**
   * Update an order only while its stored fulfilment role is still `expectedRole`.
   *
   * Optimistic locking for the one transition that cannot be allowed to happen twice. Two callers
   * splitting the same parent both read it as `standalone`, both build a full set of children, and
   * without this both would commit — promising the same twenty tonnes to two different sets of
   * suppliers, with the second set of children invisible to the first caller.
   *
   * Returns false when the stored role has already moved, so the caller can refuse rather than
   * overwrite. `updateOrder` stays unguarded because every other transition is a status change that
   * the state machine already serialises.
   */
  updateOrderIfRole(order: Order, expectedRole: FulfilmentRole): Promise<boolean>;

  /** Item lookup and creation. */
  findItemById(itemId: string): Promise<OrderItem | null>;
  findItemByIdempotencyKey(idempotencyKey: string): Promise<OrderItem | null>;
  findItemsByOrderId(orderId: string): Promise<readonly OrderItem[]>;
  insertItem(item: OrderItem): Promise<void>;

  /** Snapshot lookup and creation. */
  findSnapshotById(snapshotId: string): Promise<OrderSnapshot | null>;
  findSnapshotByOrderId(orderId: string): Promise<OrderSnapshot | null>;
  insertSnapshot(snapshot: OrderSnapshot): Promise<void>;

  /** Event lookup and creation. */
  findEventById(eventId: string): Promise<OrderEvent | null>;
  findEventByIdempotencyKey(idempotencyKey: string): Promise<OrderEvent | null>;
  findEventsByOrderId(orderId: string): Promise<readonly OrderEvent[]>;
  insertEvent(event: OrderEvent): Promise<void>;
}

export interface OrderRepository {
  /**
   * Run `body` in one transaction. An exception must roll everything back — a caller that sees a
   * failure must be able to assume nothing was written, including a half-written order, item,
   * snapshot or event.
   */
  withTransaction<T>(body: (tx: OrderTransaction) => Promise<T>): Promise<T>;
}

/**
 * An in-memory repository.
 *
 * The reference implementation of the port's contract. It enforces the same uniqueness rules the
 * database does, and checks them **at commit against the store as it stands** rather than against
 * the snapshot the transaction read.
 */
export class InMemoryOrderRepository implements OrderRepository {
  #orders: Order[] = [];
  #items: OrderItem[] = [];
  #snapshots: OrderSnapshot[] = [];
  #events: OrderEvent[] = [];
  readonly #outbox = new InMemoryOutboxStore('M-11', 'module_orders');
  transactionsCommitted = 0;
  transactionsRolledBack = 0;

  orders(): readonly Order[] {
    return sealOrders(this.#orders);
  }

  items(): readonly OrderItem[] {
    return sealOrderItems(this.#items);
  }

  snapshots(): readonly OrderSnapshot[] {
    return sealOrderSnapshots(this.#snapshots);
  }

  events(): readonly OrderEvent[] {
    return sealOrderEvents(this.#events);
  }

  outbox(): InMemoryOutboxStore {
    return this.#outbox;
  }

  /** Seed state directly, for tests that need a starting point without going through the service. */
  seed(state: {
    readonly orders?: readonly Order[];
    readonly items?: readonly OrderItem[];
    readonly snapshots?: readonly OrderSnapshot[];
    readonly events?: readonly OrderEvent[];
    readonly outbox?: readonly OutboxEntry[];
  }): void {
    this.#orders = (state.orders ?? []).map(sealOrder);
    this.#items = (state.items ?? []).map(sealOrderItem);
    this.#snapshots = (state.snapshots ?? []).map(sealOrderSnapshot);
    this.#events = (state.events ?? []).map(sealOrderEvent);
    this.#outbox.seed(state.outbox ?? []);
  }

  async withTransaction<T>(body: (tx: OrderTransaction) => Promise<T>): Promise<T> {
    const working = new WorkingSet({
      orders: this.#orders.map(sealOrder),
      items: this.#items.map(sealOrderItem),
      snapshots: this.#snapshots.map(sealOrderSnapshot),
      events: this.#events.map(sealOrderEvent),
    });
    const outboxWorking = new InMemoryOutboxStore(this.#outbox.name, this.#outbox.schema);
    outboxWorking.seed(this.#outbox.entries());

    const touched = new Touched();
    const tx = new InMemoryOrderTransaction(working, outboxWorking, touched, () => this.#orders);

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
    // Orders: idempotency-key conflicts come first, then order-id conflicts.
    for (const order of working.orders) {
      if (touched.orderKeys.has(order.idempotencyKey)) {
        const holder = this.#orders.find((held) => held.idempotencyKey === order.idempotencyKey);
        if (holder !== undefined && holder.orderId !== order.orderId) {
          throw new OrderError(
            'idempotency-key-reuse',
            `idempotency key "${order.idempotencyKey}" was used by order ${holder.orderId}, ` +
              'created by another transaction while this one was open',
          );
        }
      }
      if (touched.orders.has(order.orderId)) {
        if (this.#orders.some((held) => held.orderId === order.orderId)) {
          throw new OrderError(
            'duplicate-order-id',
            `order ${order.orderId} was created by another transaction while this one was open`,
          );
        }
      }
    }

    // Guarded updates: the role must still be what the transaction saw when it decided to write.
    // Two concurrent splits both pass the check inside their own bodies, because neither has
    // committed yet; this is the point at which exactly one of them loses.
    for (const [orderId, expectedRole] of touched.roleGuards) {
      const held = this.#orders.find((candidate) => candidate.orderId === orderId);
      if (held !== undefined && held.fulfilmentRole !== expectedRole) {
        throw new OrderError(
          'already-split',
          `order ${orderId} was changed from ${expectedRole} to ${held.fulfilmentRole} by another ` +
            'transaction while this one was open',
        );
      }
    }

    // Order updates: a touched order id may already exist in the store.
    for (const order of working.orders) {
      if (touched.orderUpdates.has(order.orderId)) {
        this.#orders = this.#orders.map((held) =>
          held.orderId === order.orderId ? sealOrder(order) : held,
        );
      }
    }

    this.#orders = [
      ...this.#orders,
      ...working.orders.filter((o) => touched.orders.has(o.orderId)).map(sealOrder),
    ];

    // Items are append-only.
    for (const item of working.items) {
      if (touched.items.has(item.itemId)) {
        if (this.#items.some((held) => held.itemId === item.itemId)) {
          throw new OrderError(
            'duplicate-item-id',
            `item ${item.itemId} was created by another transaction while this one was open`,
          );
        }
      }
      if (touched.itemKeys.has(item.idempotencyKey)) {
        const holder = this.#items.find((held) => held.idempotencyKey === item.idempotencyKey);
        if (holder !== undefined) {
          throw new OrderError(
            'idempotency-key-reuse',
            `idempotency key "${item.idempotencyKey}" was used by item ${holder.itemId}, ` +
              'created by another transaction while this one was open',
          );
        }
      }
    }

    this.#items = [
      ...this.#items,
      ...working.items.filter((i) => touched.items.has(i.itemId)).map(sealOrderItem),
    ];

    // Snapshots are append-only: one per order.
    for (const snapshot of working.snapshots) {
      if (touched.snapshots.has(snapshot.snapshotId)) {
        if (this.#snapshots.some((held) => held.snapshotId === snapshot.snapshotId)) {
          throw new OrderError(
            'duplicate-snapshot-id',
            `snapshot ${snapshot.snapshotId} was created by another transaction while this one was open`,
          );
        }
      }
      if (touched.snapshotKeys.has(snapshot.idempotencyKey)) {
        const holder = this.#snapshots.find(
          (held) => held.idempotencyKey === snapshot.idempotencyKey,
        );
        if (holder !== undefined) {
          throw new OrderError(
            'idempotency-key-reuse',
            `idempotency key "${snapshot.idempotencyKey}" was used by snapshot ${holder.snapshotId}, ` +
              'created by another transaction while this one was open',
          );
        }
      }
      if (touched.snapshotOrders.has(snapshot.orderId)) {
        const holder = this.#snapshots.find((held) => held.orderId === snapshot.orderId);
        if (holder !== undefined) {
          throw new OrderError(
            'snapshot-exists',
            `order ${snapshot.orderId} already has a snapshot ${holder.snapshotId}`,
          );
        }
      }
    }

    this.#snapshots = [
      ...this.#snapshots,
      ...working.snapshots
        .filter((s) => touched.snapshots.has(s.snapshotId))
        .map(sealOrderSnapshot),
    ];

    // Events are append-only.
    for (const event of working.events) {
      if (touched.events.has(event.eventId)) {
        if (this.#events.some((held) => held.eventId === event.eventId)) {
          throw new OrderError(
            'duplicate-event-id',
            `event ${event.eventId} was created by another transaction while this one was open`,
          );
        }
      }
      if (touched.eventKeys.has(event.idempotencyKey)) {
        const holder = this.#events.find((held) => held.idempotencyKey === event.idempotencyKey);
        if (holder !== undefined) {
          throw new OrderError(
            'idempotency-key-reuse',
            `idempotency key "${event.idempotencyKey}" was used by event ${holder.eventId}, ` +
              'created by another transaction while this one was open',
          );
        }
      }
    }

    this.#events = [
      ...this.#events,
      ...working.events.filter((e) => touched.events.has(e.eventId)).map(sealOrderEvent),
    ];
  }
}

class WorkingSet {
  orders: Order[];
  items: OrderItem[];
  snapshots: OrderSnapshot[];
  events: OrderEvent[];

  constructor(snapshot: {
    orders: Order[];
    items: OrderItem[];
    snapshots: OrderSnapshot[];
    events: OrderEvent[];
  }) {
    this.orders = snapshot.orders;
    this.items = snapshot.items;
    this.snapshots = snapshot.snapshots;
    this.events = snapshot.events;
  }
}

class Touched {
  readonly orders = new Set<string>();
  readonly orderKeys = new Set<string>();
  readonly orderUpdates = new Set<string>();
  /** orderId to the fulfilment role the transaction expects to still be there at commit. */
  readonly roleGuards = new Map<string, FulfilmentRole>();
  readonly items = new Set<string>();
  readonly itemKeys = new Set<string>();
  readonly snapshots = new Set<string>();
  readonly snapshotKeys = new Set<string>();
  readonly snapshotOrders = new Set<string>();
  readonly events = new Set<string>();
  readonly eventKeys = new Set<string>();
}

class InMemoryOrderTransaction implements OrderTransaction {
  readonly #state: WorkingSet;
  readonly #outbox: InMemoryOutboxStore;
  readonly #touched: Touched;
  /** The committed store, so a guarded update can see what other transactions have already done. */
  readonly #committed: () => readonly Order[];

  constructor(
    state: WorkingSet,
    outbox: InMemoryOutboxStore,
    touched: Touched,
    committed: () => readonly Order[],
  ) {
    this.#state = state;
    this.#outbox = outbox;
    this.#touched = touched;
    this.#committed = committed;
  }

  insertOutbox(entry: OutboxEntry): Promise<void> {
    this.#outbox.insert(entry);
    return Promise.resolve();
  }

  findOrderById(orderId: string): Promise<Order | null> {
    const found = this.#state.orders.find((o) => o.orderId === orderId);
    return Promise.resolve(found === undefined ? null : sealOrder(found));
  }

  findOrderByIdempotencyKey(idempotencyKey: string): Promise<Order | null> {
    const found = this.#state.orders.find((o) => o.idempotencyKey === idempotencyKey);
    return Promise.resolve(found === undefined ? null : sealOrder(found));
  }

  findOrdersByBuyerAccountId(buyerAccountId: string): Promise<readonly Order[]> {
    const found = this.#state.orders
      .filter((o) => o.buyerAccountId === buyerAccountId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.orderId.localeCompare(b.orderId));
    return Promise.resolve(sealOrders(found));
  }

  findOrdersBySellerAccountId(sellerAccountId: string): Promise<readonly Order[]> {
    const found = this.#state.orders
      .filter((o) => o.sellerAccountId === sellerAccountId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.orderId.localeCompare(b.orderId));
    return Promise.resolve(sealOrders(found));
  }

  findChildrenByParentId(parentOrderId: string): Promise<readonly Order[]> {
    const found = this.#state.orders
      .filter((o) => o.parentOrderId === parentOrderId)
      .sort((a, b) => a.orderId.localeCompare(b.orderId));
    return Promise.resolve(sealOrders(found));
  }

  insertOrder(order: Order): Promise<void> {
    if (this.#state.orders.some((held) => held.orderId === order.orderId)) {
      return Promise.reject(
        new OrderError(
          'duplicate-order-id',
          `order ${order.orderId} already exists. An order is created once and its lifecycle ` +
            'is updated through the service',
        ),
      );
    }
    if (this.#state.orders.some((held) => held.idempotencyKey === order.idempotencyKey)) {
      return Promise.reject(
        new OrderError(
          'idempotency-key-reuse',
          `idempotency key "${order.idempotencyKey}" has already been used`,
        ),
      );
    }
    this.#state.orders.push(sealOrder(order));
    this.#touched.orders.add(order.orderId);
    this.#touched.orderKeys.add(order.idempotencyKey);
    return Promise.resolve();
  }

  updateOrder(order: Order): Promise<void> {
    const index = this.#state.orders.findIndex((held) => held.orderId === order.orderId);
    if (index === -1) {
      return Promise.reject(
        new OrderError('order-not-found', `order ${order.orderId} does not exist`),
      );
    }
    this.#state.orders[index] = sealOrder(order);
    this.#touched.orderUpdates.add(order.orderId);
    return Promise.resolve();
  }

  updateOrderIfRole(order: Order, expectedRole: FulfilmentRole): Promise<boolean> {
    // Checked against the committed store rather than this transaction's working copy: the whole
    // point is to notice a change another transaction has already made.
    const committed = this.#committed().find((held) => held.orderId === order.orderId);
    if (committed === undefined) {
      return Promise.reject(
        new OrderError('order-not-found', `order ${order.orderId} does not exist`),
      );
    }
    if (committed.fulfilmentRole !== expectedRole) return Promise.resolve(false);

    const index = this.#state.orders.findIndex((held) => held.orderId === order.orderId);
    if (index !== -1) this.#state.orders[index] = sealOrder(order);
    this.#touched.orderUpdates.add(order.orderId);
    // Re-checked at commit as well. Two transactions running concurrently both reach this line
    // before either commits, so the read above cannot be the only guard.
    this.#touched.roleGuards.set(order.orderId, expectedRole);
    return Promise.resolve(true);
  }

  findItemById(itemId: string): Promise<OrderItem | null> {
    const found = this.#state.items.find((i) => i.itemId === itemId);
    return Promise.resolve(found === undefined ? null : sealOrderItem(found));
  }

  findItemByIdempotencyKey(idempotencyKey: string): Promise<OrderItem | null> {
    const found = this.#state.items.find((i) => i.idempotencyKey === idempotencyKey);
    return Promise.resolve(found === undefined ? null : sealOrderItem(found));
  }

  findItemsByOrderId(orderId: string): Promise<readonly OrderItem[]> {
    const found = this.#state.items
      .filter((i) => i.orderId === orderId)
      .sort((a, b) => a.addedAt.localeCompare(b.addedAt) || a.itemId.localeCompare(b.itemId));
    return Promise.resolve(sealOrderItems(found));
  }

  insertItem(item: OrderItem): Promise<void> {
    if (this.#state.items.some((held) => held.itemId === item.itemId)) {
      return Promise.reject(
        new OrderError(
          'duplicate-item-id',
          `item ${item.itemId} already exists. An item is created once and never rewritten`,
        ),
      );
    }
    if (this.#state.items.some((held) => held.idempotencyKey === item.idempotencyKey)) {
      return Promise.reject(
        new OrderError(
          'idempotency-key-reuse',
          `idempotency key "${item.idempotencyKey}" has already been used`,
        ),
      );
    }
    this.#state.items.push(sealOrderItem(item));
    this.#touched.items.add(item.itemId);
    this.#touched.itemKeys.add(item.idempotencyKey);
    return Promise.resolve();
  }

  findSnapshotById(snapshotId: string): Promise<OrderSnapshot | null> {
    const found = this.#state.snapshots.find((s) => s.snapshotId === snapshotId);
    return Promise.resolve(found === undefined ? null : sealOrderSnapshot(found));
  }

  findSnapshotByOrderId(orderId: string): Promise<OrderSnapshot | null> {
    const found = this.#state.snapshots.find((s) => s.orderId === orderId);
    return Promise.resolve(found === undefined ? null : sealOrderSnapshot(found));
  }

  insertSnapshot(snapshot: OrderSnapshot): Promise<void> {
    if (this.#state.snapshots.some((held) => held.snapshotId === snapshot.snapshotId)) {
      return Promise.reject(
        new OrderError(
          'duplicate-snapshot-id',
          `snapshot ${snapshot.snapshotId} already exists. A snapshot is created once and never rewritten`,
        ),
      );
    }
    if (this.#state.snapshots.some((held) => held.idempotencyKey === snapshot.idempotencyKey)) {
      return Promise.reject(
        new OrderError(
          'idempotency-key-reuse',
          `idempotency key "${snapshot.idempotencyKey}" has already been used`,
        ),
      );
    }
    if (this.#state.snapshots.some((held) => held.orderId === snapshot.orderId)) {
      return Promise.reject(
        new OrderError(
          'snapshot-exists',
          `order ${snapshot.orderId} already has a snapshot. An order is agreed once`,
        ),
      );
    }
    this.#state.snapshots.push(sealOrderSnapshot(snapshot));
    this.#touched.snapshots.add(snapshot.snapshotId);
    this.#touched.snapshotKeys.add(snapshot.idempotencyKey);
    this.#touched.snapshotOrders.add(snapshot.orderId);
    return Promise.resolve();
  }

  findEventById(eventId: string): Promise<OrderEvent | null> {
    const found = this.#state.events.find((e) => e.eventId === eventId);
    return Promise.resolve(found === undefined ? null : sealOrderEvent(found));
  }

  findEventByIdempotencyKey(idempotencyKey: string): Promise<OrderEvent | null> {
    const found = this.#state.events.find((e) => e.idempotencyKey === idempotencyKey);
    return Promise.resolve(found === undefined ? null : sealOrderEvent(found));
  }

  findEventsByOrderId(orderId: string): Promise<readonly OrderEvent[]> {
    const found = this.#state.events
      .filter((e) => e.orderId === orderId)
      .sort(
        (a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.eventId.localeCompare(b.eventId),
      );
    return Promise.resolve(sealOrderEvents(found));
  }

  insertEvent(event: OrderEvent): Promise<void> {
    if (this.#state.events.some((held) => held.eventId === event.eventId)) {
      return Promise.reject(
        new OrderError(
          'duplicate-event-id',
          `event ${event.eventId} already exists. An event is created once and never rewritten`,
        ),
      );
    }
    if (this.#state.events.some((held) => held.idempotencyKey === event.idempotencyKey)) {
      return Promise.reject(
        new OrderError(
          'idempotency-key-reuse',
          `idempotency key "${event.idempotencyKey}" has already been used`,
        ),
      );
    }
    this.#state.events.push(sealOrderEvent(event));
    this.#touched.events.add(event.eventId);
    this.#touched.eventKeys.add(event.idempotencyKey);
    return Promise.resolve();
  }
}
