/**
 * The join that makes the differentiated path a purchase: an accepted offer opens an order.
 *
 * Until this handler existed the tendering path stopped at the moment of choosing — the customer
 * picked a supplier, `quote.accepted` was published, and nobody listened. Everything upstream of it
 * was a very careful way of buying nothing.
 *
 * The cases here are weighted towards the three ways the join could quietly get the money wrong:
 *
 *   * **the landed total**, which is not `quantity × unitPrice` and must not be forced to be;
 *   * **the buyer**, which comes from the tender and never from anything a caller can influence;
 *   * **redelivery**, because K-08 delivers at least once and opening an order twice is a customer
 *     charged twice.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type { HandlerContext } from '../kernel/event-infrastructure/index.ts';
import { InMemoryOrderRepository, OrderService } from '../modules/orders/index.ts';
import {
  InMemoryQuoteRepository,
  QuoteService,
  type TenderFacts,
  type TenderSource,
} from '../modules/quotes/index.ts';
import {
  QUOTE_ORDER_SUBSCRIPTION,
  QUOTE_ORDER_SUBSCRIPTION_DEFINITION,
  QuoteOrderFailed,
  quoteOrderHandler,
  type QuoteOrderOutcome,
  type TenderBuyerSource,
} from '../apps/api/consumers/quote-order.ts';

const RFQ = 'rfq_01HR0QORDER0001';
const BUYER = 'acct_01HR0QORbuyer1';
const SUPPLIER = 'acct_01HR0QORsuppl1';

const NOW = '2026-07-01T09:00:00.000000Z';
const LATER = '2026-07-01T11:30:00.000000Z';
const VALID_UNTIL = '2026-07-08T09:00:00.000000Z';

/** 20 tonnes at 1,250,000 minor units, landing for 25,600,000: 600,000 of delivery. */
const QUANTITY = 20n;
const UNIT_PRICE = 1_250_000n;
const GOODS_TOTAL = QUANTITY * UNIT_PRICE;
const DELIVERY = 600_000n;
const LANDED_TOTAL = GOODS_TOTAL + DELIVERY;

class StubTenders implements TenderSource, TenderBuyerSource {
  buyer: string | null = BUYER;

  findTender(rfqId: string): Promise<TenderFacts | null> {
    return Promise.resolve(
      rfqId === RFQ
        ? {
            rfqId: RFQ,
            buyerAccountId: BUYER,
            status: 'open',
            quantity: QUANTITY,
            substitutionPolicy: 'equivalent-with-disclosure',
            requiredBy: null,
            qualityRequirements: [],
          }
        : null,
    );
  }

  isInvited(): Promise<boolean> {
    return Promise.resolve(true);
  }

  findBuyer(rfqId: string): Promise<string | null> {
    return Promise.resolve(rfqId === RFQ ? this.buyer : null);
  }
}

interface Harness {
  readonly orders: OrderService;
  readonly quotes: QuoteService;
  readonly tenders: StubTenders;
  readonly outcomes: QuoteOrderOutcome[];
  readonly handle: (context: HandlerContext) => Promise<void>;
}

function build(): Harness {
  const orders = new OrderService(new InMemoryOrderRepository());
  const tenders = new StubTenders();
  const quotes = new QuoteService(new InMemoryQuoteRepository(), tenders);
  const outcomes: QuoteOrderOutcome[] = [];

  return {
    orders,
    quotes,
    tenders,
    outcomes,
    handle: quoteOrderHandler({
      orders,
      quotes,
      tenders,
      observe: (outcome) => outcomes.push(outcome),
    }),
  };
}

/** An offer, accepted, ready for the handler to act on. */
async function acceptedOffer(
  harness: Harness,
  options: { readonly tag?: string; readonly totalMinor?: bigint } = {},
): Promise<string> {
  const tag = options.tag ?? '0001';
  const quoteId = `quo_01HR0QORDER${tag}`;

  await harness.quotes.submitQuote({
    quoteId,
    rfqId: RFQ,
    supplierAccountId: SUPPLIER,
    kind: 'full',
    quantity: QUANTITY,
    unitPriceMinor: UNIT_PRICE,
    totalMinor: options.totalMinor ?? LANDED_TOTAL,
    currency: 'LKR',
    leadTimeDays: 5,
    deliveryTerms: 'delivered',
    validUntil: VALID_UNTIL,
    evidenceReferences: [],
    submittedAt: NOW,
    correlationId: `corr_01HR0QOR${tag}`,
    idempotencyKey: `idem_01HR0QOR${tag}`,
  });

  await harness.quotes.acceptQuote({
    quoteId,
    actingAccountId: BUYER,
    reason: 'the best available offer on the date we need it',
    occurredAt: LATER,
    correlationId: `corr_01HR0QORac${tag}`,
    idempotencyKey: `idem_01HR0QORac${tag}`,
  });

  return quoteId;
}

function delivery(quoteId: string, idempotencyKey: string): HandlerContext {
  return {
    envelope: {
      eventId: `evt_${idempotencyKey}`,
      type: 'quote.accepted',
      schemaVersion: 1,
      occurredAt: LATER,
      recordedAt: LATER,
      producer: 'M-10',
      correlationId: 'corr_01HR0QORdeliver',
      causationId: null,
      // Exactly what M-10 publishes: no price, because the log is read by every subscriber.
      payload: { quote_id: quoteId, rfq_id: RFQ, supplier_account_id: SUPPLIER },
      payloadFingerprint: 'a'.repeat(64),
      idempotencyKey: `pub_${idempotencyKey}`,
      origin: 'system',
    },
    subscription: QUOTE_ORDER_SUBSCRIPTION,
    deliveryId: `del_${idempotencyKey}`,
    attempt: 1,
    idempotencyKey,
  };
}

// ---------------------------------------------------------------------------
// The purchase
// ---------------------------------------------------------------------------

test('an accepted offer becomes a placed, confirmed order', async () => {
  const harness = build();
  const quoteId = await acceptedOffer(harness);

  await harness.handle(delivery(quoteId, 'dlv_01HR0QORDER0001'));

  const outcome = harness.outcomes[0];
  assert.ok(outcome !== undefined);
  assert.equal(outcome.buyerAccountId, BUYER);
  assert.equal(outcome.sellerAccountId, SUPPLIER);
  assert.equal(outcome.totalMinor, LANDED_TOTAL);

  const order = await harness.orders.getOrder(outcome.orderId);
  assert.ok(order !== null);
  assert.equal(
    order.status,
    'confirmed',
    'a quote binds, so leaving it at placed would give the supplier a second chance to decline ' +
      'what they were bound to',
  );
  assert.equal(order.buyerAccountId, BUYER);
  assert.equal(order.sellerAccountId, SUPPLIER);
  assert.equal(order.currency, 'LKR');
  assert.equal(order.totalMinor, LANDED_TOTAL);
});

test('the landed total becomes two lines, not one inflated unit price', async () => {
  // A buyer who cannot see what the delivery cost cannot tell a cheap offer with expensive carriage
  // from an expensive one that includes it. And M-11's line arithmetic is a database rule that must
  // keep holding.
  const harness = build();
  const quoteId = await acceptedOffer(harness, { tag: '0002' });

  await harness.handle(delivery(quoteId, 'dlv_01HR0QORDER0002'));

  const orderId = harness.outcomes[0]?.orderId ?? '';
  const items = await harness.orders.listItems(orderId);

  assert.equal(items.length, 2);
  const goods = items.find((one) => one.lineKind === 'goods');
  const charges = items.find((one) => one.lineKind === 'charges');
  assert.ok(goods !== undefined && charges !== undefined);

  assert.equal(goods.quantity, QUANTITY);
  assert.equal(goods.unitPriceMinor, UNIT_PRICE);
  assert.equal(goods.lineTotalMinor, GOODS_TOTAL);
  assert.equal(charges.quantity, 1n, 'delivery is not sold by the tonne');
  assert.equal(charges.lineTotalMinor, DELIVERY);
  assert.equal(
    goods.lineTotalMinor + charges.lineTotalMinor,
    LANDED_TOTAL,
    'the two lines add up to what the supplier said the buyer would pay',
  );
  assert.equal(harness.outcomes[0]?.carriesCharges, true);
});

test('an ex-works offer opens a single line', async () => {
  const harness = build();
  const quoteId = await acceptedOffer(harness, { tag: '0003', totalMinor: GOODS_TOTAL });

  await harness.handle(delivery(quoteId, 'dlv_01HR0QORDER0003'));

  const items = await harness.orders.listItems(harness.outcomes[0]?.orderId ?? '');
  assert.equal(items.length, 1);
  assert.equal(items[0]?.lineKind, 'goods');
  assert.equal(harness.outcomes[0]?.carriesCharges, false);
});

test('the order line pins the quote and no listing version', async () => {
  // A tender exists because no listing answered, so there is no version to pin. Faking one would
  // put a row in M-04 that nobody published and no supplier maintains.
  const harness = build();
  const quoteId = await acceptedOffer(harness, { tag: '0004' });

  await harness.handle(delivery(quoteId, 'dlv_01HR0QORDER0004'));

  const items = await harness.orders.listItems(harness.outcomes[0]?.orderId ?? '');
  for (const item of items) {
    assert.equal(item.quoteId, quoteId);
    assert.equal(item.listingId, null);
    assert.equal(item.versionId, null);
    assert.equal(item.commerceUnitTypeId, null);
    assert.equal(item.reservationId, null, 'there is no JAYA stock behind a tendered supply');
  }
});

test('the snapshot records what was agreed, at the offer’s terms', async () => {
  const harness = build();
  const quoteId = await acceptedOffer(harness, { tag: '0005' });

  await harness.handle(delivery(quoteId, 'dlv_01HR0QORDER0005'));

  const snapshot = await harness.orders.getSnapshot(harness.outcomes[0]?.orderId ?? '');
  assert.ok(snapshot !== null);
  assert.equal(snapshot.totalMinor, LANDED_TOTAL);
  assert.equal(snapshot.buyerAccountId, BUYER);
  assert.equal(snapshot.sellerAccountId, SUPPLIER);
});

// ---------------------------------------------------------------------------
// Where it must not act
// ---------------------------------------------------------------------------

test('a redelivery opens no second order', async () => {
  // K-08 delivers at least once. Two orders from one acceptance is a customer charged twice, so
  // every identifier derives from the delivery key and M-11's idempotency does the rest.
  const harness = build();
  const quoteId = await acceptedOffer(harness, { tag: '0006' });

  await harness.handle(delivery(quoteId, 'dlv_01HR0QORDER0006'));
  await harness.handle(delivery(quoteId, 'dlv_01HR0QORDER0006'));

  assert.equal(harness.outcomes.length, 2, 'both deliveries were handled');
  assert.equal(harness.outcomes[0]?.orderId, harness.outcomes[1]?.orderId);
  assert.equal(harness.outcomes[1]?.replayed, true, 'and the second found the work already done');

  const orders = await harness.orders.listOrdersByBuyer(BUYER);
  assert.equal(orders.length, 1);
  assert.equal((await harness.orders.listItems(orders[0]?.orderId ?? '')).length, 2);
});

test('a quote that cannot be read refuses the delivery rather than dropping the purchase', async () => {
  const harness = build();

  await assert.rejects(
    harness.handle(delivery('quo_01HR0QORDERgone', 'dlv_01HR0QORDER0007')),
    (error: unknown) => error instanceof QuoteOrderFailed && error.code === 'quote-not-found',
  );
});

test('an offer that is no longer accepted opens nothing, and is not an error', async () => {
  // A redelivery of a superseded fact is not a failure. Recorded and left alone rather than
  // dead-lettered.
  const harness = build();
  const quoteId = `quo_01HR0QORDER0008`;

  await harness.quotes.submitQuote({
    quoteId,
    rfqId: RFQ,
    supplierAccountId: SUPPLIER,
    kind: 'full',
    quantity: QUANTITY,
    unitPriceMinor: UNIT_PRICE,
    totalMinor: LANDED_TOTAL,
    currency: 'LKR',
    leadTimeDays: 5,
    deliveryTerms: 'delivered',
    validUntil: VALID_UNTIL,
    evidenceReferences: [],
    submittedAt: NOW,
    correlationId: 'corr_01HR0QOR0008',
    idempotencyKey: 'idem_01HR0QOR0008',
  });

  await harness.handle(delivery(quoteId, 'dlv_01HR0QORDER0008'));

  assert.equal(harness.outcomes[0]?.orderId, '');
  assert.equal((await harness.orders.listOrdersByBuyer(BUYER)).length, 0);
});

test('a tender whose buyer cannot be read opens no order in the wrong name', async () => {
  // Taking the buyer from anywhere a caller could influence would let somebody open an order in
  // another person's name. Refusing is the correct answer to not knowing.
  const harness = build();
  const quoteId = await acceptedOffer(harness, { tag: '0009' });
  harness.tenders.buyer = null;

  await assert.rejects(
    harness.handle(delivery(quoteId, 'dlv_01HR0QORDER0009')),
    (error: unknown) => error instanceof QuoteOrderFailed && error.code === 'tender-not-found',
  );
  assert.equal((await harness.orders.listOrdersByBuyer(BUYER)).length, 0);
});

test('a payload missing its quote id is refused by name', async () => {
  const harness = build();
  const context = delivery('quo_01HR0QORDER0010', 'dlv_01HR0QORDER0010');
  const broken = {
    ...context,
    envelope: { ...context.envelope, payload: { rfq_id: RFQ } },
  };

  await assert.rejects(
    harness.handle(broken),
    (error: unknown) => error instanceof QuoteOrderFailed && error.code === 'malformed-payload',
  );
});

test('the subscription declares itself, and only for the fact it acts on', () => {
  assert.equal(QUOTE_ORDER_SUBSCRIPTION_DEFINITION.subscription, QUOTE_ORDER_SUBSCRIPTION);
  assert.equal(QUOTE_ORDER_SUBSCRIPTION_DEFINITION.owner, 'apps/api');
  assert.deepEqual(QUOTE_ORDER_SUBSCRIPTION_DEFINITION.types, ['quote.accepted']);
});
