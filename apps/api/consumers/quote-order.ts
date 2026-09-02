/**
 * The moment a tender becomes a purchase: an accepted offer opens an order.
 *
 * This is the join the differentiated path has been building towards. A customer said what they
 * needed, the sourcing ladder failed to find it, a tender went out, suppliers offered, the customer
 * chose — and until now that chose nothing. `quote.accepted` was published and nobody listened.
 *
 * **It lives in `apps/` because M-10 and M-11 must not know about each other.** M-11 is above M-10
 * and could import it, but then Orders would depend on Quotes existing, and an order opened from a
 * catalogue purchase would drag a tendering module in behind it. The join is made from above both.
 *
 * Four judgements worth reading.
 *
 * **The price is read from M-10, not from the event.** No price travels in a quote event, and
 * deliberately: the log is read by every subscriber and kept indefinitely. So the handler fetches
 * the offer, which is also the safer source — the stored row is the one the immutability trigger
 * protects, and an event payload is a copy that could disagree with it.
 *
 * **The buyer comes from the tender, not from the request.** An accepted offer names the supplier;
 * who is buying is a fact M-09 holds. Taking it from anywhere a caller could influence would let
 * somebody open an order in another person's name.
 *
 * **A landed total becomes two lines, not one inflated unit price.** A quote's total is what the
 * buyer pays all in, and it is deliberately not `quantity × unitPrice` — the difference is delivery,
 * duties and handling. M-11's `order_item_line_total_is_product` is a database rule that the line
 * arithmetic must hold, and it should stay one. So the order gets a `goods` line at the exact
 * product and a `charges` line for the remainder. A buyer who cannot see what the delivery cost
 * cannot tell a cheap offer with expensive carriage from an expensive one that includes it.
 *
 * **The order is placed and confirmed here.** A quote binds: the supplier offered to supply at that
 * price and the buyer accepted. Both sides have already agreed, so leaving the order at `placed` for
 * the supplier to confirm would give them a second chance to decline what they were bound to —
 * which is the thing M-10 exists to prevent.
 *
 * Owned by: apps/api.
 */

import type { HandlerContext } from '../../../kernel/event-infrastructure/index.ts';
import type { OrderService } from '../../../modules/orders/index.ts';
import type { QuoteService } from '../../../modules/quotes/index.ts';
import { deriveId } from '../../../platform/http/context.ts';

export const QUOTE_ORDER_SUBSCRIPTION = 'orders-opens-from-accepted-quotes';

/**
 * The subscription K-08 must know about before a delivery can be created.
 *
 * `owner` is the application. M-11 does not subscribe to quote events — it cannot, without knowing
 * M-10 exists — so the application subscribes on its behalf.
 */
export const QUOTE_ORDER_SUBSCRIPTION_DEFINITION = Object.freeze({
  subscription: QUOTE_ORDER_SUBSCRIPTION,
  owner: 'apps/api',
  types: Object.freeze(['quote.accepted']),
  description:
    'Opens an order from the offer a buyer accepted. Without it the differentiated path stops at ' +
    'the moment of choosing: the customer picks a supplier and nothing is bought.',
});

/**
 * Who is buying, for one tender.
 *
 * A one-method port onto M-09 rather than its service, because that is the only fact this handler
 * needs from it — and taking the buyer from anywhere a caller could influence would let somebody
 * open an order in another person's name.
 */
export interface TenderBuyerSource {
  findBuyer(rfqId: string): Promise<string | null>;
}

/** What the handler did with one accepted offer. */
export interface QuoteOrderOutcome {
  readonly quoteId: string;
  readonly rfqId: string;
  readonly orderId: string;
  readonly buyerAccountId: string;
  readonly sellerAccountId: string;
  /** The landed total the order was placed for. */
  readonly totalMinor: bigint;
  /** True when the charges line was needed — the offer landed for more than the goods. */
  readonly carriesCharges: boolean;
  /** True when this delivery found the work already done. Normal under at-least-once delivery. */
  readonly replayed: boolean;
}

export interface QuoteOrderOptions {
  readonly orders: OrderService;
  readonly quotes: QuoteService;
  readonly tenders: TenderBuyerSource;
  readonly observe?: (outcome: QuoteOrderOutcome) => void;
}

export class QuoteOrderFailed extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'QuoteOrderFailed';
    this.code = code;
  }
}

export function quoteOrderHandler(
  options: QuoteOrderOptions,
): (context: HandlerContext) => Promise<void> {
  return async (context: HandlerContext): Promise<void> => {
    const quoteId = readString(context.envelope.payload, 'quote_id');
    const rfqId = readString(context.envelope.payload, 'rfq_id');

    // From the store rather than the event. The stored row is the one the immutability trigger
    // protects; a payload is a copy that could disagree with it — and it carries no price anyway.
    const quote = await options.quotes.getQuote(quoteId);
    if (quote === null) {
      throw new QuoteOrderFailed(
        'quote-not-found',
        `quote ${quoteId} was accepted but cannot be read. Refusing the delivery so it is retried ` +
          'rather than dropping a purchase the customer has already agreed to',
      );
    }
    if (quote.status !== 'accepted') {
      // Not an error worth retrying: the offer moved on. Recorded and left alone rather than
      // dead-lettered, because a redelivery of a superseded fact is not a failure.
      options.observe?.({
        quoteId,
        rfqId,
        orderId: '',
        buyerAccountId: '',
        sellerAccountId: quote.supplierAccountId,
        totalMinor: quote.totalMinor,
        carriesCharges: false,
        replayed: true,
      });
      return;
    }

    const buyerAccountId = await options.tenders.findBuyer(rfqId);
    if (buyerAccountId === null) {
      throw new QuoteOrderFailed(
        'tender-not-found',
        `tender ${rfqId} cannot be read, so who is buying is unknown. An order opened without it ` +
          'would name the wrong buyer, which is worse than opening none',
      );
    }

    // Derived from the delivery key K-08 holds stable, so a redelivery produces the same identifiers
    // and M-11's own idempotency turns at-least-once delivery into exactly-once effect.
    const key = context.idempotencyKey;
    const orderId = deriveId('ord', 'quote-accepted', key);

    const goodsTotal = quote.quantity * quote.unitPriceMinor;
    const charges = quote.totalMinor - goodsTotal;

    const created = await options.orders.createOrder({
      orderId,
      buyerAccountId,
      sellerAccountId: quote.supplierAccountId,
      currency: quote.currency,
      createdAt: context.envelope.occurredAt,
      updatedAt: context.envelope.occurredAt,
      correlationId: context.envelope.correlationId,
      idempotencyKey: deriveId('idem', 'quote-order-create', key),
      eventId: deriveId('evt', 'quote-order-create', key),
      reason: `opened from accepted offer ${quoteId} against tender ${rfqId}`,
    });

    await options.orders.addItem({
      itemId: deriveId('oit', 'quote-order-goods', key),
      orderId,
      // No listing and no version: a tender exists because no listing answered. The accepted offer
      // is the permanent address this line pins, and M-10 holds it immutable by trigger.
      quoteId,
      lineKind: 'goods',
      quantity: quote.quantity,
      unitPriceMinor: quote.unitPriceMinor,
      lineTotalMinor: goodsTotal,
      currency: quote.currency,
      // Nothing was reserved. There is no JAYA stock behind a tendered supply, which is why there
      // was a tender.
      reservationId: null,
      addedAt: context.envelope.occurredAt,
      correlationId: context.envelope.correlationId,
      idempotencyKey: deriveId('idem', 'quote-order-goods', key),
    });

    if (charges > 0n) {
      await options.orders.addItem({
        itemId: deriveId('oit', 'quote-order-charges', key),
        orderId,
        quoteId,
        lineKind: 'charges',
        // One of, priced at the whole remainder. Delivery is not sold by the tonne.
        quantity: 1n,
        unitPriceMinor: charges,
        lineTotalMinor: charges,
        currency: quote.currency,
        reservationId: null,
        addedAt: context.envelope.occurredAt,
        correlationId: context.envelope.correlationId,
        idempotencyKey: deriveId('idem', 'quote-order-charges', key),
      });
    }

    const placed = await options.orders.placeOrder({
      orderId,
      snapshotId: deriveId('osn', 'quote-order', key),
      // The offer's landed total, stated rather than trusted: M-11 recomputes the lines and refuses
      // `total-mismatch` if they disagree, which is the check that catches an arithmetic slip here
      // before a customer is billed for it.
      expectedTotalMinor: quote.totalMinor,
      policyVersionId: null,
      placedAt: context.envelope.occurredAt,
      updatedAt: context.envelope.occurredAt,
      correlationId: context.envelope.correlationId,
      idempotencyKey: deriveId('idem', 'quote-order-place', key),
      eventId: deriveId('evt', 'quote-order-place', key),
      reason: `placed on the terms of accepted offer ${quoteId}`,
    });

    // Confirmed here rather than left for the supplier. A quote binds: they offered to supply at
    // that price and the buyer accepted, so both sides have already agreed. Asking the supplier to
    // confirm again would give them a second chance to decline what they were bound to.
    await options.orders.confirmOrder({
      orderId,
      confirmedAt: context.envelope.occurredAt,
      updatedAt: context.envelope.occurredAt,
      correlationId: context.envelope.correlationId,
      idempotencyKey: deriveId('idem', 'quote-order-confirm', key),
      eventId: deriveId('evt', 'quote-order-confirm', key),
      reason: `the supplier's offer ${quoteId} was binding and the buyer accepted it`,
    });

    options.observe?.({
      quoteId,
      rfqId,
      orderId,
      buyerAccountId,
      sellerAccountId: quote.supplierAccountId,
      totalMinor: placed.snapshot.totalMinor,
      carriesCharges: charges > 0n,
      replayed: created.replayed,
    });
  };
}

function readString(payload: unknown, field: string): string {
  const value = (payload as Record<string, unknown>)[field];
  if (typeof value !== 'string' || value === '') {
    throw new QuoteOrderFailed(
      'malformed-payload',
      `"${field}" is missing from the quote event payload, or is not a string`,
    );
  }
  return value;
}
