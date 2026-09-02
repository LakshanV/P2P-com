/**
 * Stock reservations: establishing one, and refusing to believe a client about one.
 *
 * The defect this suite exists to keep closed: `POST /v1/orders/{id}/items` read `reservationId`
 * **out of the request body**. Any client could send any string and M-11 recorded it, so an order
 * line could claim stock that nothing was holding — and the order would then be placed, paid for
 * and fulfilled against inventory that had never been set aside. Nobody would notice until delivery
 * day, when two orders wanted the same thing.
 *
 * It is the same shape as the webhook that read `signatureVerified` from its caller. Both are the
 * layer above letting the attacker answer the question, and both are closed the same way: the
 * server computes the answer, and a body that still asserts it is refused by name.
 *
 * Two halves.
 *
 * **The normal purchase flow** creates the reservation server-side, from an identifier derived from
 * the request context, so a retry converges on the same hold rather than taking the stock twice.
 * Whether a line needs one at all comes from the pinned version's `inventoryMode` — a service, a
 * made-to-order part, a supplier-direct machine and a digital entitlement hold no JAYA stock, and
 * demanding a reservation for them would make the platform unable to sell them.
 *
 * **Presenting an existing reservation** is verified rather than trusted. Each of the seven checks
 * below is a distinct way somebody else's hold, or a stale one, or one for a different thing
 * entirely, could otherwise be attached to an order. Missing any one turns "present your
 * reservation" into "name any reservation".
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FinancialLedgerService,
  InMemoryFinancialLedgerRepository,
  K10LedgerPort,
} from '../modules/financial-ledger/index.ts';
import { InMemoryLedgerRepository, LedgerService } from '../kernel/ledger-foundation/index.ts';
import { InMemoryOrderRepository, OrderService } from '../modules/orders/index.ts';
import {
  InMemoryPaymentRepository,
  PaymentService,
  resolveMockProvider,
} from '../modules/payments/index.ts';
import {
  INVENTORY_MODES,
  InMemoryUniversalListingRepository,
  UniversalListingService,
  requiresReservation,
  type InventoryMode,
} from '../modules/universal-listing/index.ts';
import {
  CommerceRequestService,
  InMemoryCommerceRequestRepository,
} from '../modules/commerce-request/index.ts';
import { UserCockpitService } from '../modules/user-cockpit/index.ts';
import { buildApi } from '../apps/api/app.ts';
import { verifyPresentedReservation } from '../apps/api/reservation.ts';
import { ApiError } from '../apps/api/errors.ts';
import { handleRequest } from '../platform/http/pipeline.ts';
import type { HttpResponse } from '../platform/http/types.ts';

import { identityStack, type SignedIn } from './helpers/api-identity.ts';
import { inMemoryTendering } from './helpers/tendering-services.ts';

const NOW = '2026-07-01T09:00:00.000000Z';
const UNIT_TYPE = 'cut_01HR0RSV000001';

interface Harness {
  readonly call: (
    method: string,
    target: string,
    body?: unknown,
    options?: { readonly as?: SignedIn; readonly key?: string },
  ) => Promise<HttpResponse>;
  readonly listings: UniversalListingService;
  readonly orders: OrderService;
  readonly buyer: SignedIn;
  readonly seller: SignedIn;
  /** listingId and versionId for each mode, all published and all with stock where it applies. */
  readonly offers: Readonly<Record<InventoryMode, { listingId: string; versionId: string }>>;
}

const codeOf = (response: HttpResponse): string =>
  (response.body as { code?: string }).code ?? '(no code)';

async function build(): Promise<Harness> {
  const orders = new OrderService(new InMemoryOrderRepository());
  const payments = new PaymentService(new InMemoryPaymentRepository(), resolveMockProvider);
  const journal = new LedgerService(new InMemoryLedgerRepository());
  const ledger = new FinancialLedgerService(
    new InMemoryFinancialLedgerRepository(),
    new K10LedgerPort(journal),
  );
  const listings = new UniversalListingService(new InMemoryUniversalListingRepository());

  const identity = await identityStack(NOW);
  const buyer = await identity.register({ handle: 'rsv-buyer', roles: ['CUSTOMER'] });
  const seller = await identity.register({ handle: 'rsv-seller', roles: ['SUPPLIER'] });

  // One published offer per mode, so every branch is exercised against a real M-04 rather than a
  // stub that agrees with whatever the test expects.
  const offers: Record<string, { listingId: string; versionId: string }> = {};
  let index = 0;
  for (const mode of INVENTORY_MODES) {
    index += 1;
    const tag = String(index).padStart(6, '0');
    const listingId = `lst_01HR0RSV${tag}`;
    const versionId = `ver_01HR0RSV${tag}`;

    await listings.createListing({
      listingId,
      accountId: seller.accountId,
      commerceUnitTypeId: UNIT_TYPE,
      createdAt: NOW,
      updatedAt: NOW,
      correlationId: 'corr_01HR0RSVsetup1',
      idempotencyKey: `idem_rsv_list_${tag}`,
      recordId: `rec_01HR0RSV${tag}`,
    });
    await listings.publishListing({
      versionId,
      listingId,
      title: `An offer fulfilled as ${mode}`,
      description: `Published to exercise the ${mode} path.`,
      unitPriceMinor: 250n,
      currency: 'LKR',
      quantityAvailable: 100n,
      inventoryMode: mode,
      attributes: {},
      publishedAt: NOW,
      correlationId: 'corr_01HR0RSVsetup1',
      idempotencyKey: `idem_rsv_ver_${tag}`,
    });
    // Stock only where stock is a thing. Receiving inventory for a service would be the very
    // confusion this model exists to prevent.
    if (requiresReservation(mode)) {
      await listings.receiveInventory({
        movementId: `mov_01HR0RSV${tag}`,
        listingId,
        versionId,
        quantity: 10n,
        reason: 'opening stock',
        occurredAt: NOW,
        correlationId: 'corr_01HR0RSVsetup1',
        idempotencyKey: `idem_rsv_stock_${tag}`,
      });
    }
    offers[mode] = { listingId, versionId };
  }

  const api = buildApi({
    services: {
      orders,
      payments,
      ledger,
      listings,
      needs: new CommerceRequestService(new InMemoryCommerceRequestRepository()),
      ...inMemoryTendering(),
      cockpit: new UserCockpitService({ orders, payments, ledger, journal }),
    },
    access: identity,
    clock: () => NOW,
  });

  let sequence = 0;
  const call: Harness['call'] = (method, target, body, options = {}) => {
    sequence += 1;
    const principal = options.as ?? buyer;
    return handleRequest(api, {
      method,
      target,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        authorization: `Bearer ${principal.token}`,
        'idempotency-key': options.key ?? `idem_rsv_${String(sequence).padStart(5, '0')}`,
        'x-correlation-id': `corr_01HR0RSV${String(sequence).padStart(6, '0')}`,
      },
      body: body === undefined ? null : JSON.stringify(body),
    });
  };

  return {
    call,
    listings,
    orders,
    buyer,
    seller,
    offers: offers as Harness['offers'],
  };
}

/** A draft order, so there is somewhere to add a line. */
async function anOrder(harness: Harness, key: string): Promise<string> {
  const created = await harness.call(
    'POST',
    '/v1/orders',
    {
      buyerAccountId: harness.buyer.accountId,
      sellerAccountId: harness.seller.accountId,
      currency: 'LKR',
      reason: 'a basket to add lines to',
    },
    { key },
  );
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return (created.body as { order: { orderId: string } }).order.orderId;
}

function line(
  harness: Harness,
  mode: InventoryMode,
  quantity = '2',
): Readonly<Record<string, unknown>> {
  const offer = harness.offers[mode];
  return {
    listingId: offer.listingId,
    versionId: offer.versionId,
    commerceUnitTypeId: UNIT_TYPE,
    quantity,
    unitPriceMinor: '250',
    lineTotalMinor: String(250 * Number(quantity)),
    currency: 'LKR',
  };
}

// ---------------------------------------------------------------------------
// The client cannot assert a reservation
// ---------------------------------------------------------------------------

test('a body carrying reservationId is refused by name, and nothing is added', async () => {
  // The defect itself. Before this, `reservationId: 'anything-at-all'` was written straight onto the
  // order line, and the line then looked exactly like one that held real stock.
  const harness = await build();
  const orderId = await anOrder(harness, 'idem_rsv_order_001');

  const response = await harness.call(
    'POST',
    `/v1/orders/${orderId}/items`,
    { ...line(harness, 'tracked'), reservationId: 'rsv_01HR0RSVforged1' },
    { key: 'idem_rsv_forge_001' },
  );

  assert.equal(response.status, 400);
  assert.equal(codeOf(response), 'caller-asserted-reservation');
  assert.match(
    (response.body as { detail: string }).detail,
    /nothing was holding|not a field a caller may send/,
  );

  const items = await harness.orders.listItems(orderId);
  assert.equal(items.length, 0, 'the line must not exist: it was never legitimately reservable');
});

test('the other shapes somebody reaches for next are refused too', async () => {
  // Refusing exactly one field name is refusing exactly one attempt. These are the spellings a
  // client tries when the first is rejected, and each would have been read as a claim about stock.
  const harness = await build();
  const orderId = await anOrder(harness, 'idem_rsv_order_002');

  for (const field of ['reservation_id', 'reserved', 'stockReserved', 'inventoryReserved']) {
    const response = await harness.call(
      'POST',
      `/v1/orders/${orderId}/items`,
      { ...line(harness, 'tracked'), [field]: true },
      { key: `idem_rsv_alt_${field.slice(0, 8)}` },
    );
    assert.equal(response.status, 400, `"${field}" was accepted`);
    assert.equal(codeOf(response), 'caller-asserted-reservation');
  }
});

// ---------------------------------------------------------------------------
// The server establishes it
// ---------------------------------------------------------------------------

test('adding a tracked line reserves real stock, and the reservation is the server’s', async () => {
  const harness = await build();
  const orderId = await anOrder(harness, 'idem_rsv_order_003');
  const offer = harness.offers.tracked;

  const before = await harness.listings.getAvailability(offer.listingId, offer.versionId);
  assert.equal(before.available, 10n);

  const added = await harness.call(
    'POST',
    `/v1/orders/${orderId}/items`,
    line(harness, 'tracked', '3'),
    { key: 'idem_rsv_add_003' },
  );
  assert.equal(added.status, 201, JSON.stringify(added.body));

  const after = await harness.listings.getAvailability(offer.listingId, offer.versionId);
  assert.equal(after.reserved, 3n, 'the stock is actually held, not merely claimed');
  assert.equal(after.available, 7n);

  const items = await harness.orders.listItems(orderId);
  const reservationId = items[0]?.reservationId;
  assert.ok(
    reservationId !== null && reservationId !== undefined,
    'a tracked line carries the reservation that holds its stock',
  );
  assert.match(
    reservationId,
    /^rsv_/,
    'and it was minted here, from the request context, rather than sent by the client',
  );
});

test('a retry of the same line holds the stock once, not twice', async () => {
  // The identifiers are derived from the idempotency key, so the second attempt converges on the
  // reservation the first made. Without that, every retry of a flaky request would eat more stock.
  const harness = await build();
  const orderId = await anOrder(harness, 'idem_rsv_order_004');
  const offer = harness.offers.tracked;

  const first = await harness.call(
    'POST',
    `/v1/orders/${orderId}/items`,
    line(harness, 'tracked', '4'),
    { key: 'idem_rsv_retry_004' },
  );
  const second = await harness.call(
    'POST',
    `/v1/orders/${orderId}/items`,
    line(harness, 'tracked', '4'),
    { key: 'idem_rsv_retry_004' },
  );

  assert.equal(first.status, 201);
  assert.equal(second.status, 200, 'a retry converges rather than creating a second line');

  const after = await harness.listings.getAvailability(offer.listingId, offer.versionId);
  assert.equal(after.reserved, 4n, 'four units held, not eight');
});

test('a line for more than the available stock is refused, and holds nothing', async () => {
  const harness = await build();
  const orderId = await anOrder(harness, 'idem_rsv_order_005');
  const offer = harness.offers.tracked;

  const response = await harness.call(
    'POST',
    `/v1/orders/${orderId}/items`,
    line(harness, 'tracked', '99'),
    { key: 'idem_rsv_short_005' },
  );

  assert.equal(response.status, 409, 'a conflict with the world, not a malformed request');
  assert.equal(codeOf(response), 'insufficient-stock');

  const after = await harness.listings.getAvailability(offer.listingId, offer.versionId);
  assert.equal(after.reserved, 0n);
  assert.equal((await harness.orders.listItems(orderId)).length, 0);
});

// ---------------------------------------------------------------------------
// The mode decides, not the client
// ---------------------------------------------------------------------------

test('only a tracked offer reserves; the other four modes hold no JAYA stock', async () => {
  // The reason this is a policy and not a Boolean. A service, a made-to-order part, a
  // supplier-direct machine and a digital entitlement are four different fulfilment stories, and
  // none of them holds stock JAYA can set aside — but they are not the same as each other, and
  // collapsing them would have to be undone the first time one needed its own behaviour.
  const harness = await build();

  for (const mode of INVENTORY_MODES) {
    const orderId = await anOrder(harness, `idem_rsv_ord_${mode.slice(0, 8)}`);
    const added = await harness.call('POST', `/v1/orders/${orderId}/items`, line(harness, mode), {
      key: `idem_rsv_mode_${mode.slice(0, 8)}`,
    });

    assert.equal(added.status, 201, `${mode}: ${JSON.stringify(added.body)}`);
    assert.equal(
      (added.body as { inventoryMode: string }).inventoryMode,
      mode,
      'the response says which mode applied, because "no reservation" and "reservation forgotten" ' +
        'look identical to a client otherwise',
    );

    const items = await harness.orders.listItems(orderId);
    const held = items[0]?.reservationId ?? null;
    assert.equal(
      held !== null,
      requiresReservation(mode),
      `${mode} ${requiresReservation(mode) ? 'must' : 'must not'} hold a reservation`,
    );
  }
});

test('a version that belongs to another listing is refused rather than reserved against', async () => {
  const harness = await build();
  const orderId = await anOrder(harness, 'idem_rsv_order_006');

  const response = await harness.call(
    'POST',
    `/v1/orders/${orderId}/items`,
    {
      ...line(harness, 'tracked'),
      // A real version id — of a different listing. Reserving against this would hold stock of one
      // thing while the line said another.
      versionId: harness.offers.digital.versionId,
    },
    { key: 'idem_rsv_cross_006' },
  );

  assert.equal(response.status, 404);
  assert.equal(codeOf(response), 'no-such-version');
});

// ---------------------------------------------------------------------------
// Presenting an existing reservation: the seven checks
// ---------------------------------------------------------------------------

const HELD = Object.freeze({
  reservationId: 'rsv_01HR0RSVheld001',
  accountId: 'acct_01HR0RSVowner1',
  listingId: 'lst_01HR0RSV000001',
  versionId: 'ver_01HR0RSV000001',
  quantity: 5n,
});

/** Everything valid, for a test to spoil exactly one thing at a time. */
function presentation(
  overrides: Record<string, unknown> = {},
): Parameters<typeof verifyPresentedReservation>[0] {
  return {
    held: HELD,
    accountId: HELD.accountId,
    listingId: HELD.listingId,
    versionId: HELD.versionId,
    quantity: 2n,
    status: 'open',
    expiresAt: '2026-07-01T10:00:00.000000Z',
    now: NOW,
    alreadyUsed: false,
    ...overrides,
  };
}

test('a presented reservation that satisfies every check is accepted', async () => {
  await assert.doesNotReject(verifyPresentedReservation(presentation()));
});

test('each of the seven ways a presented reservation can be wrong is refused, with its own code', async () => {
  const cases: ReadonlyArray<readonly [string, Record<string, unknown>, string]> = [
    ['it does not exist', { held: null }, 'no-such-reservation'],
    ['it belongs to somebody else', { accountId: 'acct_01HR0RSVother1' }, 'reservation-not-yours'],
    [
      'it is for a different listing',
      { listingId: 'lst_01HR0RSV000002' },
      'reservation-wrong-item',
    ],
    [
      'it is for a different version of the same listing',
      { versionId: 'ver_01HR0RSV000002' },
      'reservation-wrong-item',
    ],
    ['it holds less than the line needs', { quantity: 9n }, 'reservation-too-small'],
    ['it has already been released', { status: 'released' }, 'reservation-not-open'],
    ['it has already been committed', { status: 'committed' }, 'reservation-not-open'],
    ['it has expired', { expiresAt: '2026-07-01T08:00:00.000000Z' }, 'reservation-expired'],
    ['another line has already used it', { alreadyUsed: true }, 'reservation-already-used'],
  ];

  for (const [why, overrides, expected] of cases) {
    await assert.rejects(
      verifyPresentedReservation(presentation(overrides)),
      (error: unknown) => {
        assert.ok(error instanceof ApiError, `${why}: not an ApiError`);
        assert.equal(error.code, expected, why);
        assert.equal(
          error.status,
          409,
          'every refusal shares a status on purpose: a different one for "not yours" than for ' +
            '"no such reservation" is a way to discover which identifiers exist',
        );
        return true;
      },
      `presenting a reservation when ${why} must be refused`,
    );
  }
});

test('a refusal never says whose the reservation is', async () => {
  // The detail a stranger sees must not confirm that the reservation exists, or who holds it.
  await assert.rejects(
    verifyPresentedReservation(presentation({ accountId: 'acct_01HR0RSVother1' })),
    (error: unknown) => {
      const message = (error as Error).message;
      assert.ok(!message.includes(HELD.accountId), 'the owner must not appear in the refusal');
      assert.ok(!message.includes(HELD.reservationId), 'nor the reservation identifier');
      return true;
    },
  );
});

test('every mode is either reservable or not, and the question has exactly one answer', () => {
  // A guard against a sixth mode being added without deciding this. `requiresReservation` is the
  // only question the order path asks, so a mode nobody classified would silently take the
  // no-reservation path — which for a physical good is stock sold twice.
  for (const mode of INVENTORY_MODES) {
    assert.equal(typeof requiresReservation(mode), 'boolean', `${mode} has no answer`);
  }
  assert.deepEqual(
    INVENTORY_MODES.filter((mode) => requiresReservation(mode)),
    ['tracked'],
    'only TRACKED holds JAYA stock today. EXTERNAL joins it when a supplier reservation adapter ' +
      'exists, and that change belongs here rather than at each call site',
  );
});

test('M-04 answers a retry that arrives later, under a fresh correlation id', async () => {
  // The defect the API retry above uncovered, gone at directly. `inventoryMovementEquals` compared
  // `correlationId` and `occurredAt`, so the same reservation attempted a second later — which is
  // what every retry is — came back as `idempotency-key-reuse`. A client following that advice would
  // have sent a *new* idempotency key, and reserved the stock twice.
  //
  // Deliberately not pinned: the two calls differ in exactly the two fields a real retry differs in.
  const harness = await build();
  const offer = harness.offers.tracked;

  const reserve = (occurredAt: string, correlationId: string): Promise<unknown> =>
    harness.listings.reserveInventory({
      movementId: 'mov_01HR0RSVretry01',
      listingId: offer.listingId,
      versionId: offer.versionId,
      reservationId: 'rsv_01HR0RSVretry01',
      quantity: 2n,
      reason: 'order-line',
      occurredAt,
      correlationId,
      idempotencyKey: 'idem_rsv_m04_retry',
    });

  await reserve(NOW, 'corr_01HR0RSVfirst01');
  await assert.doesNotReject(
    reserve('2026-07-01T09:00:01.000000Z', 'corr_01HR0RSVsecond1'),
    'a retry a second later, with a fresh correlation id, is the same request',
  );

  const availability = await harness.listings.getAvailability(offer.listingId, offer.versionId);
  assert.equal(availability.reserved, 2n, 'two units held, not four');
});
