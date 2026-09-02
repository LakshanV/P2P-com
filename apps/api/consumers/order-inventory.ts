/**
 * Closing out the stock a line reserved: committed when the order completes, released when it does
 * not.
 *
 * The half of the reservation flow that is easy to leave for later and expensive to. A hold that is
 * never resolved is stock the platform believes is spoken for and nobody can buy — so a shop that
 * takes a hundred abandoned baskets ends up unable to sell anything, with a warehouse full of goods
 * and an availability of zero. Reserving without releasing is worse than not reserving at all,
 * because it fails silently and in the direction of lost revenue.
 *
 * **Two events, two directions:**
 *
 *   * `order.cancelled` — give the stock back. The order will not happen.
 *   * `order.completed` — consume the hold. The goods have gone; `onHand` falls and the reservation
 *     stops standing between the remaining stock and the next buyer.
 *
 * **It lives in `apps/` for the same reason the settlement consumer does.** M-11 and M-04 are the
 * same layer and neither may import the other, so the join is made from above both.
 *
 * Three judgements worth reading.
 *
 * **Every line is attempted, and one failure does not abandon the rest.** An order has many lines
 * against many listings. Stopping at the first refusal would leave the lines after it held for ever
 * — the exact failure this consumer exists to prevent — so each is attempted and the failures are
 * collected. If any failed, the handler throws at the end, so K-08 retries the whole delivery; the
 * lines that already succeeded are idempotent and do nothing the second time.
 *
 * **A line with no reservation is skipped, not failed.** A service, a made-to-order part, a
 * supplier-direct machine and a digital entitlement never held JAYA stock. There is nothing to give
 * back, and treating that as an error would dead-letter every order that contained one.
 *
 * **A reservation already resolved is not an error.** Two different things arrive here looking
 * similar. A **redelivery** of the same event never reaches this at all: every identifier is derived
 * from the delivery key that K-08 holds stable, so M-04 recognises a replay of the same movement and
 * moves nothing — exactly-once by idempotency, which is stronger than catching a refusal because it
 * does not depend on the refusal keeping its code. A genuinely **different** delivery against a
 * resolved hold — a cancellation arriving after a completion — does refuse `reservation-not-open`,
 * and that is the right answer to the second question rather than something to dead-letter over.
 *
 * Owned by: apps/api.
 */

import type { HandlerContext } from '../../../kernel/event-infrastructure/index.ts';
import type { OrderItem, OrderService } from '../../../modules/orders/index.ts';
import type { UniversalListingService } from '../../../modules/universal-listing/index.ts';
import { deriveId } from '../../../platform/http/context.ts';

export const ORDER_INVENTORY_SUBSCRIPTION = 'universal-listing-resolves-order-reservations';

/**
 * The subscription K-08 must know about before a delivery can be created.
 *
 * `owner` is the application. M-04 does not subscribe to order events — it cannot, without knowing
 * M-11 exists — so the application subscribes on its behalf.
 */
export const ORDER_INVENTORY_SUBSCRIPTION_DEFINITION = Object.freeze({
  subscription: ORDER_INVENTORY_SUBSCRIPTION,
  owner: 'apps/api',
  types: Object.freeze(['order.cancelled', 'order.completed']),
  description:
    'Releases reserved stock when an order is cancelled and commits it when the order completes. ' +
    'Without it every reservation is held for ever, and a shop with a hundred abandoned baskets ' +
    'has a full warehouse and nothing available to sell.',
});

/** What the handler did to one order. */
export interface InventoryResolution {
  readonly orderId: string;
  readonly action: 'released' | 'committed';
  /** Lines whose stock was resolved by this delivery. */
  readonly resolved: number;
  /** Lines that held no reservation, because their offer holds no JAYA stock. */
  readonly skipped: number;
  /** Lines whose reservation had already been resolved. Normal under at-least-once delivery. */
  readonly alreadyResolved: number;
}

export interface OrderInventoryOptions {
  readonly orders: OrderService;
  readonly listings: UniversalListingService;
  readonly observe?: (resolution: InventoryResolution) => void;
}

export class InventoryResolutionFailed extends Error {
  readonly code = 'inventory-resolution-failed';
  /** One entry per line that could not be resolved, so a dead letter says which. */
  readonly failures: readonly string[];

  constructor(orderId: string, failures: readonly string[]) {
    super(
      `${String(failures.length)} line(s) of order ${orderId} could not have their stock ` +
        `resolved: ${failures.join('; ')}. The delivery is refused so it is retried rather than ` +
        'leaving stock held for ever.',
    );
    this.name = 'InventoryResolutionFailed';
    this.failures = failures;
  }
}

export function orderInventoryHandler(
  options: OrderInventoryOptions,
): (context: HandlerContext) => Promise<void> {
  return async (context: HandlerContext): Promise<void> => {
    const orderId = readString(context.envelope.payload, 'order_id');
    const action = context.envelope.type === 'order.completed' ? 'committed' : 'released';

    const items = await options.orders.listItems(orderId);
    const failures: string[] = [];
    let resolved = 0;
    let skipped = 0;
    let alreadyResolved = 0;

    for (const item of items) {
      // No JAYA stock was ever held for this line. A service, a made-to-order part, a
      // supplier-direct machine and a digital entitlement never held any; nor did a line priced
      // from an accepted quote, which exists precisely because no listing answered and so has no
      // listing version to move stock against.
      if (item.reservationId === null || item.listingId === null || item.versionId === null) {
        skipped += 1;
        continue;
      }

      try {
        await resolveLine(
          options,
          item,
          item.listingId,
          item.versionId,
          item.reservationId,
          action,
          context,
        );
        resolved += 1;
      } catch (error) {
        if ((error as { code?: unknown }).code === 'reservation-not-open') {
          // Already released or committed. Under at-least-once delivery this is what a redelivery
          // looks like, and it is the right answer rather than something to dead-letter over.
          alreadyResolved += 1;
          continue;
        }
        // Collected rather than thrown: the lines after this one still need resolving, and
        // abandoning them would hold their stock for ever — which is the failure this exists to
        // prevent.
        failures.push(`${item.itemId}: ${String((error as { code?: unknown }).code ?? error)}`);
      }
    }

    options.observe?.({ orderId, action, resolved, skipped, alreadyResolved });

    if (failures.length > 0) {
      // Thrown only after every line has been attempted. K-08 retries the whole delivery and the
      // lines that already succeeded do nothing the second time.
      throw new InventoryResolutionFailed(orderId, failures);
    }
  };
}

async function resolveLine(
  options: OrderInventoryOptions,
  item: OrderItem,
  listingId: string,
  versionId: string,
  reservationId: string,
  action: 'released' | 'committed',
  context: HandlerContext,
): Promise<void> {
  // Derived from the delivery's idempotency key and the line, so a redelivery produces the same
  // movement id and M-04's own idempotency turns at-least-once delivery into exactly-once effect.
  const key = `${context.idempotencyKey}:${item.itemId}`;
  const request = {
    movementId: deriveId('mov', `order-${action}`, key),
    listingId,
    versionId,
    reservationId,
    quantity: item.quantity,
    reason: action === 'committed' ? 'order-completed' : 'order-cancelled',
    occurredAt: context.envelope.occurredAt,
    correlationId: context.envelope.correlationId,
    idempotencyKey: deriveId('idem', `order-${action}`, key),
  };

  if (action === 'committed') {
    await options.listings.commitInventory(request);
    return;
  }
  await options.listings.releaseInventory(request);
}

function readString(payload: unknown, field: string): string {
  const value = (payload as Record<string, unknown>)[field];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`"${field}" is missing from the order event payload, or is not a string`);
  }
  return value;
}
