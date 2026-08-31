/**
 * M-11 Orders — immutability boundary.
 *
 * Every record that crosses a service or repository boundary is deep-frozen and cloned, so a caller
 * cannot edit what was stored. Items, snapshots and events are append-only; the order header is
 * updated only through the service's operations. The only defence against silent mutation at the
 * boundary is to make mutation throw.
 *
 * Owned by: M-11 Orders.
 */

import type { Order, OrderEvent, OrderItem, OrderSnapshot } from './types.ts';

function sealRecord(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return Object.freeze(value.map(sealRecord));
  }
  const copy: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    copy[key] = sealRecord(entry);
  }
  return Object.freeze(copy);
}

/** A deep, frozen copy of an order. */
export function sealOrder(order: Order): Order {
  return Object.freeze({ ...order });
}

/** A deep, frozen copy of an order item. */
export function sealOrderItem(item: OrderItem): OrderItem {
  return Object.freeze({ ...item });
}

/** A deep, frozen copy of an order snapshot. */
export function sealOrderSnapshot(snapshot: OrderSnapshot): OrderSnapshot {
  return Object.freeze({
    snapshotId: snapshot.snapshotId,
    orderId: snapshot.orderId,
    buyerAccountId: snapshot.buyerAccountId,
    sellerAccountId: snapshot.sellerAccountId,
    currency: snapshot.currency,
    subtotalMinor: snapshot.subtotalMinor,
    totalMinor: snapshot.totalMinor,
    lines: sealRecord(snapshot.lines) as Readonly<Record<string, unknown>>,
    policyVersionId: snapshot.policyVersionId,
    capturedAt: snapshot.capturedAt,
    correlationId: snapshot.correlationId,
    idempotencyKey: snapshot.idempotencyKey,
  });
}

/** A deep, frozen copy of an order event. */
export function sealOrderEvent(event: OrderEvent): OrderEvent {
  return Object.freeze({ ...event });
}

/** Frozen copies of a list of orders. */
export function sealOrders(orders: readonly Order[]): readonly Order[] {
  return Object.freeze(orders.map(sealOrder));
}

/** Frozen copies of a list of order items. */
export function sealOrderItems(items: readonly OrderItem[]): readonly OrderItem[] {
  return Object.freeze(items.map(sealOrderItem));
}

/** Frozen copies of a list of order snapshots. */
export function sealOrderSnapshots(snapshots: readonly OrderSnapshot[]): readonly OrderSnapshot[] {
  return Object.freeze(snapshots.map(sealOrderSnapshot));
}

/** Frozen copies of a list of order events. */
export function sealOrderEvents(events: readonly OrderEvent[]): readonly OrderEvent[] {
  return Object.freeze(events.map(sealOrderEvent));
}

/** Is this order sealed? */
export function isOrderSealed(order: Order): boolean {
  return Object.isFrozen(order);
}

/** Is this order item sealed? */
export function isOrderItemSealed(item: OrderItem): boolean {
  return Object.isFrozen(item);
}

/** Is this order snapshot sealed? */
export function isOrderSnapshotSealed(snapshot: OrderSnapshot): boolean {
  return Object.isFrozen(snapshot) && Object.isFrozen(snapshot.lines);
}

/** Is this order event sealed? */
export function isOrderEventSealed(event: OrderEvent): boolean {
  return Object.isFrozen(event);
}
