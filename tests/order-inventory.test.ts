/**
 * Giving stock back, and consuming it: the other half of the reservation flow.
 *
 * Reserving without resolving is worse than not reserving at all. A hold nothing releases is stock
 * the platform believes is spoken for and nobody can buy, so a shop that collects a hundred
 * abandoned baskets ends up with a full warehouse and an availability of zero — and it fails
 * silently, in the direction of lost revenue, which is the hardest direction to notice.
 *
 * The cases here are weighted towards the ways a *partial* failure could leave stock stranded. An
 * order has many lines against many listings; a handler that stopped at the first refusal would
 * abandon every line after it, which is precisely the failure it exists to prevent.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { InMemoryOrderRepository, OrderService } from '../modules/orders/index.ts';
import {
  InMemoryUniversalListingRepository,
  UniversalListingService,
  type InventoryMode,
} from '../modules/universal-listing/index.ts';
import type { HandlerContext } from '../kernel/event-infrastructure/index.ts';
import {
  InventoryResolutionFailed,
  ORDER_INVENTORY_SUBSCRIPTION,
  ORDER_INVENTORY_SUBSCRIPTION_DEFINITION,
  orderInventoryHandler,
  type InventoryResolution,
} from '../apps/api/consumers/order-inventory.ts';

const BUYER = 'acct_01HR0OIVbuyer01';
const SELLER = 'acct_01HR0OIVsellr01';
const UNIT_TYPE = 'cut_01HR0OIV000001';
const NOW = '2026-07-01T09:00:00.000000Z';

interface Harness {
  readonly orders: OrderService;
  readonly listings: UniversalListingService;
  readonly resolutions: InventoryResolution[];
  readonly handle: (context: HandlerContext) => Promise<void>;
  readonly offer: (mode: InventoryMode) => { listingId: string; versionId: string };
}

async function build(): Promise<Harness> {
  const orders = new OrderService(new InMemoryOrderRepository());
  const listings = new UniversalListingService(new InMemoryUniversalListingRepository());

  const offers: Record<string, { listingId: string; versionId: string }> = {};
  let index = 0;
  for (const mode of ['tracked', 'untracked'] as const) {
    index += 1;
    const tag = String(index).padStart(6, '0');
    const listingId = `lst_01HR0OIV${tag}`;
    const versionId = `ver_01HR0OIV${tag}`;
    await listings.createListing({
      listingId,
      accountId: SELLER,
      commerceUnitTypeId: UNIT_TYPE,
      createdAt: NOW,
      updatedAt: NOW,
      correlationId: 'corr_01HR0OIVsetup1',
      idempotencyKey: `idem_oiv_list_${tag}`,
      recordId: `rec_01HR0OIV${tag}`,
    });
    await listings.publishListing({
      versionId,
      listingId,
      title: `An offer fulfilled as ${mode}`,
      description: 'Published to exercise the resolution path.',
      unitPriceMinor: 250n,
      currency: 'LKR',
      quantityAvailable: 100n,
      inventoryMode: mode,
      attributes: {},
      publishedAt: NOW,
      correlationId: 'corr_01HR0OIVsetup1',
      idempotencyKey: `idem_oiv_ver_${tag}`,
    });
    if (mode === 'tracked') {
      await listings.receiveInventory({
        movementId: `mov_01HR0OIV${tag}`,
        listingId,
        versionId,
        quantity: 20n,
        reason: 'opening stock',
        occurredAt: NOW,
        correlationId: 'corr_01HR0OIVsetup1',
        idempotencyKey: `idem_oiv_stock_${tag}`,
      });
    }
    offers[mode] = { listingId, versionId };
  }

  const resolutions: InventoryResolution[] = [];
  return {
    orders,
    listings,
    resolutions,
    handle: orderInventoryHandler({
      orders,
      listings,
      observe: (resolution) => resolutions.push(resolution),
    }),
    offer: (mode) => {
      const found = offers[mode];
      assert.ok(found !== undefined, `the fixture has no ${mode} offer`);
      return found;
    },
  };
}

/** A draft order with lines, and a reservation held for each tracked line. */
async function anOrderWith(
  harness: Harness,
  tag: string,
  lines: ReadonlyArray<{ readonly mode: InventoryMode; readonly quantity: bigint }>,
): Promise<string> {
  const orderId = `ord_01HR0OIV${tag}`;
  await harness.orders.createOrder({
    orderId,
    buyerAccountId: BUYER,
    sellerAccountId: SELLER,
    currency: 'LKR',
    createdAt: NOW,
    updatedAt: NOW,
    reason: 'a basket with stock behind it',
    correlationId: 'corr_01HR0OIVorder01',
    idempotencyKey: `idem_oiv_ord_${tag}`,
    eventId: `evt_01HR0OIV${tag}`,
  });

  let line = 0;
  for (const spec of lines) {
    line += 1;
    const offer = harness.offer(spec.mode);
    const lineTag = `${tag}${String(line)}`;
    let reservationId: string | null = null;

    if (spec.mode === 'tracked') {
      reservationId = `rsv_01HR0OIV${lineTag}`;
      await harness.listings.reserveInventory({
        movementId: `mov_01HR0OIVr${lineTag}`,
        listingId: offer.listingId,
        versionId: offer.versionId,
        reservationId,
        quantity: spec.quantity,
        reason: 'order-line',
        occurredAt: NOW,
        correlationId: 'corr_01HR0OIVorder01',
        idempotencyKey: `idem_oiv_rsv_${lineTag}`,
      });
    }

    await harness.orders.addItem({
      itemId: `oit_01HR0OIV${lineTag}`,
      orderId,
      listingId: offer.listingId,
      versionId: offer.versionId,
      commerceUnitTypeId: UNIT_TYPE,
      quantity: spec.quantity,
      unitPriceMinor: 250n,
      lineTotalMinor: 250n * spec.quantity,
      currency: 'LKR',
      reservationId,
      addedAt: NOW,
      correlationId: 'corr_01HR0OIVorder01',
      idempotencyKey: `idem_oiv_item_${lineTag}`,
    });
  }

  return orderId;
}

function delivery(orderId: string, type: string, idempotencyKey: string): HandlerContext {
  return {
    envelope: {
      eventId: `evt_${idempotencyKey}`,
      type,
      schemaVersion: 1,
      occurredAt: NOW,
      recordedAt: NOW,
      producer: 'M-11',
      correlationId: 'corr_01HR0OIVresolve',
      causationId: null,
      payload: { order_id: orderId },
      payloadFingerprint: 'a'.repeat(64),
      idempotencyKey: `pub_${idempotencyKey}`,
      origin: 'system',
    },
    subscription: ORDER_INVENTORY_SUBSCRIPTION,
    deliveryId: `del_${idempotencyKey}`,
    attempt: 1,
    idempotencyKey,
  };
}

// ---------------------------------------------------------------------------
// Releasing
// ---------------------------------------------------------------------------

test('a cancelled order gives its stock back', async () => {
  const harness = await build();
  const offer = harness.offer('tracked');
  const orderId = await anOrderWith(harness, '0001', [{ mode: 'tracked', quantity: 5n }]);

  const held = await harness.listings.getAvailability(offer.listingId, offer.versionId);
  assert.equal(held.reserved, 5n);
  assert.equal(held.available, 15n);

  await harness.handle(delivery(orderId, 'order.cancelled', 'idem_oiv_cancel_1'));

  const after = await harness.listings.getAvailability(offer.listingId, offer.versionId);
  assert.equal(after.reserved, 0n, 'the hold is gone');
  assert.equal(after.available, 20n, 'and the stock is buyable again');
  assert.equal(after.onHand, 20n, 'a cancellation returns stock; it does not consume it');

  assert.deepEqual(harness.resolutions, [
    { orderId, action: 'released', resolved: 1, skipped: 0, alreadyResolved: 0 },
  ]);
});

test('a completed order consumes its stock', async () => {
  const harness = await build();
  const offer = harness.offer('tracked');
  const orderId = await anOrderWith(harness, '0002', [{ mode: 'tracked', quantity: 6n }]);

  await harness.handle(delivery(orderId, 'order.completed', 'idem_oiv_commit_1'));

  const after = await harness.listings.getAvailability(offer.listingId, offer.versionId);
  assert.equal(after.onHand, 14n, 'the goods have gone, so on-hand falls');
  assert.equal(
    after.reserved,
    0n,
    'and the hold no longer stands between stock and the next buyer',
  );
  assert.equal(after.available, 14n);

  assert.deepEqual(harness.resolutions, [
    { orderId, action: 'committed', resolved: 1, skipped: 0, alreadyResolved: 0 },
  ]);
});

// ---------------------------------------------------------------------------
// The cases that could strand stock
// ---------------------------------------------------------------------------

test('a redelivered cancellation releases the stock once', async () => {
  // At-least-once delivery makes this the normal case, and it never reaches the error path: every
  // identifier is derived from the delivery's idempotency key, which K-08 holds stable across
  // redeliveries, so M-04 recognises the second attempt as a **replay of the same movement** and
  // returns without moving anything. Exactly-once by idempotency rather than by catching a refusal
  // — which is the stronger of the two, because it does not depend on the refusal keeping its code.
  const harness = await build();
  const offer = harness.offer('tracked');
  const orderId = await anOrderWith(harness, '0003', [{ mode: 'tracked', quantity: 4n }]);

  const context = delivery(orderId, 'order.cancelled', 'idem_oiv_cancel_2');
  await harness.handle(context);
  await harness.handle(context);
  await harness.handle(context);

  const after = await harness.listings.getAvailability(offer.listingId, offer.versionId);
  assert.equal(after.available, 20n, 'released once, not three times');
  assert.equal(after.onHand, 20n);

  assert.deepEqual(
    harness.resolutions.map((one) => [one.resolved, one.alreadyResolved]),
    [
      [1, 0],
      [1, 0],
      [1, 0],
    ],
    'each delivery reports the line as resolved, because it is — but only the first moved stock',
  );
});

test('a second, different delivery against a resolved hold is not an error', async () => {
  // The path the replay above does not take. A cancellation arriving after a completion is a
  // different delivery with its own key, so M-04 sees a genuinely new movement against a hold that
  // has already been committed and refuses `reservation-not-open`. That is the correct answer to
  // the second question and the wrong thing to dead-letter over, so it counts as already resolved.
  const harness = await build();
  const offer = harness.offer('tracked');
  const orderId = await anOrderWith(harness, '0007', [{ mode: 'tracked', quantity: 5n }]);

  await harness.handle(delivery(orderId, 'order.completed', 'idem_oiv_first_01'));
  await assert.doesNotReject(
    harness.handle(delivery(orderId, 'order.cancelled', 'idem_oiv_second_1')),
  );

  const after = await harness.listings.getAvailability(offer.listingId, offer.versionId);
  assert.equal(after.onHand, 15n, 'the completion consumed the stock and the cancellation did not');
  assert.equal(after.reserved, 0n);

  assert.deepEqual(
    harness.resolutions.map((one) => [one.action, one.resolved, one.alreadyResolved]),
    [
      ['committed', 1, 0],
      ['released', 0, 1],
    ],
  );
});

test('a line that never held stock is skipped, not failed', async () => {
  // A service, a made-to-order part, a supplier-direct machine and a digital entitlement never held
  // JAYA stock. Treating that as an error would dead-letter every order containing one.
  const harness = await build();
  const orderId = await anOrderWith(harness, '0004', [
    { mode: 'tracked', quantity: 2n },
    { mode: 'untracked', quantity: 1n },
  ]);

  await harness.handle(delivery(orderId, 'order.cancelled', 'idem_oiv_cancel_3'));

  assert.deepEqual(harness.resolutions, [
    { orderId, action: 'released', resolved: 1, skipped: 1, alreadyResolved: 0 },
  ]);
});

test('an order of only untracked lines resolves cleanly and holds nothing', async () => {
  const harness = await build();
  const orderId = await anOrderWith(harness, '0005', [
    { mode: 'untracked', quantity: 1n },
    { mode: 'untracked', quantity: 3n },
  ]);

  await assert.doesNotReject(
    harness.handle(delivery(orderId, 'order.completed', 'idem_oiv_commit_2')),
  );
  assert.deepEqual(harness.resolutions, [
    { orderId, action: 'committed', resolved: 0, skipped: 2, alreadyResolved: 0 },
  ]);
});

test('one line failing does not abandon the others, and the delivery is still refused', async () => {
  // The case this consumer is shaped around. Stopping at the first refusal would leave every line
  // after it held for ever — the exact failure it exists to prevent — so each is attempted, and the
  // throw comes at the end so K-08 retries a delivery that did real work.
  const harness = await build();
  const offer = harness.offer('tracked');
  const orderId = await anOrderWith(harness, '0006', [
    { mode: 'tracked', quantity: 3n },
    { mode: 'tracked', quantity: 2n },
  ]);

  // Break the first line by releasing its reservation out of band, then breaking it further: the
  // second release will refuse `reservation-not-open`, which the handler treats as done. So instead
  // make one line genuinely unresolvable by pointing it at a listing that has no such reservation.
  const items = await harness.orders.listItems(orderId);
  const broken = items[0];
  assert.ok(broken !== undefined);

  // Commit the first line's reservation out of band. A subsequent *release* of a committed hold is
  // refused as `reservation-not-open`, which the handler treats as already resolved — so to produce
  // a real failure the line is pointed at a version that never held it.
  const failing = orderInventoryHandler({
    orders: {
      listItems: () =>
        Promise.resolve([
          { ...broken, versionId: harness.offer('untracked').versionId },
          ...items.slice(1),
        ]),
    } as unknown as OrderService,
    listings: harness.listings,
    observe: (resolution) => harness.resolutions.push(resolution),
  });

  await assert.rejects(
    failing(delivery(orderId, 'order.cancelled', 'idem_oiv_cancel_4')),
    (error: unknown) => {
      assert.ok(error instanceof InventoryResolutionFailed);
      assert.equal(error.failures.length, 1, 'exactly the one line that could not be resolved');
      assert.match(
        error.message,
        /retried rather than leaving stock held for ever/,
        'the message has to say why it refuses, because the next person will want the dead letter ' +
          'to go away',
      );
      return true;
    },
  );

  // The healthy line was released anyway. That is the whole point of collecting failures rather
  // than throwing at the first one.
  const after = await harness.listings.getAvailability(offer.listingId, offer.versionId);
  assert.equal(after.reserved, 3n, 'the second line came back; only the broken one is still held');
});

test('the subscription covers both ends of an order and is owned by the application', () => {
  assert.deepEqual(
    [...ORDER_INVENTORY_SUBSCRIPTION_DEFINITION.types].sort(),
    ['order.cancelled', 'order.completed'],
    'both endings must resolve the stock. Covering only one is the leak with extra steps',
  );
  assert.equal(
    ORDER_INVENTORY_SUBSCRIPTION_DEFINITION.owner,
    'apps/api',
    'M-04 does not subscribe to order events: it cannot, without knowing M-11 exists',
  );
});
