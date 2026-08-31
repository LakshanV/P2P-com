/**
 * M-11 Orders — service behaviour.
 *
 * An order is an agreement, and the module's whole job is that **what was agreed cannot change
 * afterwards**. Three things carry that: an order item pins `(listingId, versionId)` — the permanent
 * address M-04 exists to provide — the `OrderSnapshot` captures the agreed commercial terms at the
 * instant of agreement, and both are append-only.
 *
 * The second theme is the state machine. It is a declared table rather than scattered conditionals,
 * so the legal transitions can be asserted directly and an illegal one is refused by name.
 *
 * The third is the financial-zone discipline: every amount is an exact `bigint` in minor units,
 * `lineTotal` must equal `quantity × unitPrice`, and the subtotal must equal the exact sum of lines.
 *
 * Live-PostgreSQL properties are in `tests/integration/orders.integration.ts`.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CANCELLATION_REASONS,
  ORDER_STATUSES,
  ORDER_TRANSITIONS,
  OrderError,
  FOREIGN_FIELDS,
} from '../modules/orders/index.ts';

import {
  BUYER,
  SELLER,
  VERSION,
  build,
  cancelRequest,
  confirmRequest,
  createRequest,
  entriesOfKind,
  eventTypes,
  itemRequest,
  lastEventPayload,
  placeRequest,
} from './helpers/orders-fixtures.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODULE_DIR = path.join(REPO_ROOT, 'modules', 'orders');

/** The refusal code, or a rethrow when it is not one of M-11's. */
const codeOf = async (body: () => Promise<unknown>): Promise<string> => {
  try {
    await body();
  } catch (error) {
    if (error instanceof OrderError) return error.code;
    throw error;
  }
  throw new Error('expected a refusal, and the call succeeded');
};

/** A draft order with one line, ready to place. */
async function drafted(
  harness: ReturnType<typeof build>,
): Promise<{ orderId: string; itemId: string }> {
  const created = createRequest();
  await harness.service.createOrder(created);
  const item = itemRequest(created.orderId);
  await harness.service.addItem(item);
  return { orderId: created.orderId, itemId: item.itemId };
}

/** A placed order. */
async function placed(harness: ReturnType<typeof build>): Promise<string> {
  const { orderId } = await drafted(harness);
  await harness.service.placeOrder(placeRequest(orderId));
  return orderId;
}

// ---------------------------------------------------------------------------
// The state machine
// ---------------------------------------------------------------------------

test('the transition table is the state machine, and both terminal states are terminal', () => {
  assert.deepEqual(
    Object.keys(ORDER_TRANSITIONS).sort(),
    [...ORDER_STATUSES].sort(),
    'every status must appear in the transition table, or a status exists with no declared rules',
  );
  assert.deepEqual(ORDER_TRANSITIONS.completed, [], 'completed is terminal');
  assert.deepEqual(ORDER_TRANSITIONS.cancelled, [], 'cancelled is terminal');

  // Cancellation is reachable from every non-terminal state. An order you cannot abandon is a trap.
  for (const status of ORDER_STATUSES) {
    if (status === 'completed' || status === 'cancelled') continue;
    assert.ok(
      ORDER_TRANSITIONS[status].includes('cancelled'),
      `${status} cannot reach cancelled, so an order in that state can never be abandoned`,
    );
  }
});

test('the happy path walks draft to completed and records every transition', async () => {
  const harness = build();
  const { orderId } = await drafted(harness);

  await harness.service.placeOrder(placeRequest(orderId));
  await harness.service.confirmOrder(confirmRequest(orderId));
  await harness.service.startFulfilment({
    orderId,
    fulfillingAt: '2026-07-02T12:00:00Z',
    updatedAt: '2026-07-02T12:00:00Z',
    correlationId: 'corr_ff_0001',
    idempotencyKey: 'idem_ff_0001',
    eventId: 'oev_ff_0001',
    reason: 'the seller began packing',
  });
  const done = await harness.service.completeOrder({
    orderId,
    completedAt: '2026-07-04T12:00:00Z',
    updatedAt: '2026-07-04T12:00:00Z',
    correlationId: 'corr_cp_0001',
    idempotencyKey: 'idem_cp_0001',
    eventId: 'oev_cp_0001',
    reason: 'the buyer confirmed receipt',
  });

  assert.equal(done.order.status, 'completed');
  assert.equal(done.order.completedAt, '2026-07-04T12:00:00Z');

  const history = await harness.service.getHistory(orderId);
  assert.deepEqual(
    history.map((event) => [event.fromStatus, event.toStatus]),
    [
      [null, 'draft'],
      ['draft', 'placed'],
      ['placed', 'confirmed'],
      ['confirmed', 'fulfilling'],
      ['fulfilling', 'completed'],
    ],
    'the history is the whole life of the order, oldest first',
  );

  assert.deepEqual(eventTypes(harness.repository), [
    'order.created',
    'order.placed',
    'order.confirmed',
    'order.fulfilling',
    'order.completed',
  ]);
});

test('an illegal transition is refused by name, and changes nothing', async () => {
  const harness = build();
  const { orderId } = await drafted(harness);

  // draft cannot jump straight to confirmed.
  assert.equal(
    await codeOf(() => harness.service.confirmOrder(confirmRequest(orderId))),
    'illegal-transition',
  );

  const order = await harness.service.getOrder(orderId);
  assert.equal(order?.status, 'draft');
  assert.equal((await harness.service.getHistory(orderId)).length, 1);
});

test('a completed order is terminal — nothing moves it, including cancellation', async () => {
  const harness = build();
  const orderId = await placed(harness);
  await harness.service.confirmOrder(confirmRequest(orderId));
  await harness.service.startFulfilment({
    orderId,
    fulfillingAt: '2026-07-02T12:00:00Z',
    updatedAt: '2026-07-02T12:00:00Z',
    correlationId: 'corr_ff_0002',
    idempotencyKey: 'idem_ff_0002',
    eventId: 'oev_ff_0002',
    reason: 'packing',
  });
  await harness.service.completeOrder({
    orderId,
    completedAt: '2026-07-04T12:00:00Z',
    updatedAt: '2026-07-04T12:00:00Z',
    correlationId: 'corr_cp_0002',
    idempotencyKey: 'idem_cp_0002',
    eventId: 'oev_cp_0002',
    reason: 'received',
  });

  const code = await codeOf(() => harness.service.cancelOrder(cancelRequest(orderId)));
  assert.match(
    code,
    /order-terminal|illegal-transition/,
    'a completed order that can still be cancelled would let a settled sale be unwound silently',
  );
});

test('cancellation records a vocabulary reason and is terminal', async () => {
  const harness = build();
  const orderId = await placed(harness);
  const request = cancelRequest(orderId, { cancellationReason: 'stock-unavailable' });

  const result = await harness.service.cancelOrder(request);

  assert.equal(result.order.status, 'cancelled');
  assert.equal(result.order.cancelledAt, request.cancelledAt);
  assert.equal(result.order.cancellationReason, 'stock-unavailable');

  // The reason must reach the event — a cancellation nobody can attribute is a support ticket.
  assert.equal(lastEventPayload(harness.repository).cancellation_reason, 'stock-unavailable');

  assert.equal(
    await codeOf(() => harness.service.confirmOrder(confirmRequest(orderId))),
    'illegal-transition',
  );
});

test('every cancellation reason in the vocabulary is accepted, and nothing else is', async () => {
  for (const cancellationReason of CANCELLATION_REASONS) {
    const harness = build();
    const orderId = await placed(harness);
    const result = await harness.service.cancelOrder(
      cancelRequest(orderId, { cancellationReason }),
    );
    assert.equal(result.order.cancellationReason, cancellationReason);
  }

  const harness = build();
  const orderId = await placed(harness);
  assert.equal(
    await codeOf(() =>
      harness.service.cancelOrder(
        cancelRequest(orderId, { cancellationReason: 'changed-my-mind' as never }),
      ),
    ),
    'unknown-cancellation-reason',
  );
});

// ---------------------------------------------------------------------------
// Items, and the pinned listing version
// ---------------------------------------------------------------------------

test('an item pins the listing version, which is what makes the agreement stable', async () => {
  const harness = build();
  const created = createRequest();
  await harness.service.createOrder(created);
  const item = itemRequest(created.orderId);
  const result = await harness.service.addItem(item);

  assert.equal(result.item.versionId, VERSION);
  assert.equal(
    result.item.unitPriceMinor,
    249_500n,
    'the price is copied from the pinned version, never recomputed later',
  );

  const items = await harness.service.listItems(created.orderId);
  assert.equal(items.length, 1);
  assert.equal(items[0]?.listingId, item.listingId);
});

test('items may not be added once the order is placed', async () => {
  const harness = build();
  const orderId = await placed(harness);
  assert.equal(
    await codeOf(() => harness.service.addItem(itemRequest(orderId))),
    'order-not-draft',
  );
});

test('a line whose total does not equal quantity times unit price is refused', async () => {
  const harness = build();
  const created = createRequest();
  await harness.service.createOrder(created);

  assert.equal(
    await codeOf(() =>
      harness.service.addItem(
        itemRequest(created.orderId, {
          quantity: 3n,
          unitPriceMinor: 100n,
          lineTotalMinor: 299n, // should be 300
        }),
      ),
    ),
    'line-total-mismatch',
    'a line total the caller computed wrongly is a price nobody can defend later',
  );
});

test('a line in a different currency from the order is refused', async () => {
  const harness = build();
  const created = createRequest({ currency: 'LKR' });
  await harness.service.createOrder(created);

  assert.equal(
    await codeOf(() => harness.service.addItem(itemRequest(created.orderId, { currency: 'USD' }))),
    'currency-mismatch',
  );
});

test('a negative quantity or amount is refused', async () => {
  const harness = build();
  const created = createRequest();
  await harness.service.createOrder(created);

  assert.equal(
    await codeOf(() =>
      harness.service.addItem(
        itemRequest(created.orderId, { quantity: -1n, lineTotalMinor: -249_500n }),
      ),
    ),
    'negative-quantity',
  );
  assert.equal(
    await codeOf(() =>
      harness.service.addItem(
        itemRequest(created.orderId, { unitPriceMinor: -1n, lineTotalMinor: -3n }),
      ),
    ),
    'negative-amount',
  );
});

// ---------------------------------------------------------------------------
// Placing, and the immutable snapshot
// ---------------------------------------------------------------------------

test('placing computes the subtotal exactly and writes the immutable snapshot', async () => {
  const harness = build();
  const created = createRequest();
  await harness.service.createOrder(created);
  await harness.service.addItem(
    itemRequest(created.orderId, { quantity: 2n, unitPriceMinor: 100n, lineTotalMinor: 200n }),
  );
  await harness.service.addItem(
    itemRequest(created.orderId, { quantity: 3n, unitPriceMinor: 50n, lineTotalMinor: 150n }),
  );

  const result = await harness.service.placeOrder(
    placeRequest(created.orderId, { expectedTotalMinor: 350n }),
  );

  assert.equal(result.order.status, 'placed');
  assert.equal(result.order.subtotalMinor, 350n);
  assert.equal(result.order.totalMinor, 350n);
  assert.equal(result.order.itemCount, 2);

  const snapshot = await harness.service.getSnapshot(created.orderId);
  assert.notEqual(snapshot, null);
  assert.equal(snapshot?.totalMinor, 350n);
  assert.equal(snapshot?.buyerAccountId, BUYER);
  assert.equal(snapshot?.sellerAccountId, SELLER);
});

test('a total the caller did not expect is refused rather than silently accepted', async () => {
  const harness = build();
  const { orderId } = await drafted(harness);

  assert.equal(
    await codeOf(() =>
      harness.service.placeOrder(placeRequest(orderId, { expectedTotalMinor: 1n })),
    ),
    'total-mismatch',
    'the buyer agreed to a number; if the server computes a different one, nobody may proceed',
  );

  const order = await harness.service.getOrder(orderId);
  assert.equal(order?.status, 'draft', 'a refused placement leaves the order where it was');
});

test('an order with no items cannot be placed', async () => {
  const harness = build();
  const created = createRequest();
  await harness.service.createOrder(created);
  assert.equal(
    await codeOf(() => harness.service.placeOrder(placeRequest(created.orderId))),
    'order-empty',
  );
});

test('the snapshot is written once and never rewritten', async () => {
  const harness = build();
  const orderId = await placed(harness);
  const first = await harness.service.getSnapshot(orderId);

  // Confirming and cancelling both move the order on; the snapshot must not follow.
  await harness.service.confirmOrder(confirmRequest(orderId));
  const after = await harness.service.getSnapshot(orderId);

  assert.deepEqual(after, first, 'the snapshot is the agreement, and the agreement does not move');
});

test('a snapshot is sealed', async () => {
  const harness = build();
  const orderId = await placed(harness);
  const snapshot = await harness.service.getSnapshot(orderId);

  assert.throws(() => {
    (snapshot as unknown as { totalMinor: bigint }).totalMinor = 1n;
  }, TypeError);
});

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

test('a subtotal above Number.MAX_SAFE_INTEGER stays exact', async () => {
  const harness = build();
  const created = createRequest();
  await harness.service.createOrder(created);
  const huge = 9_007_199_254_740_993n;
  await harness.service.addItem(
    itemRequest(created.orderId, {
      quantity: 1n,
      unitPriceMinor: huge,
      lineTotalMinor: huge,
    }),
  );

  const result = await harness.service.placeOrder(
    placeRequest(created.orderId, { expectedTotalMinor: huge }),
  );

  assert.equal(result.order.totalMinor, huge);
  assert.equal(
    lastEventPayload(harness.repository).total_minor,
    '9007199254740993',
    'the event carries the amount as text; a number would have rounded it',
  );
});

test('a currency that is not ISO-4217 is refused', async () => {
  const harness = build();
  for (const currency of ['', 'lkr', 'LKRR', '123']) {
    assert.equal(
      await codeOf(() => harness.service.createOrder(createRequest({ currency }))),
      'malformed-currency',
      `"${currency}" should be refused as a currency`,
    );
  }
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

test('creation is idempotent by key, and a differing replay is refused', async () => {
  const harness = build();
  const request = createRequest();

  const first = await harness.service.createOrder(request);
  const second = await harness.service.createOrder(request);

  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.deepEqual(second.order, first.order);
  assert.equal(entriesOfKind(harness.repository, 'event').length, 1);

  assert.equal(
    await codeOf(() =>
      harness.service.createOrder({
        ...request,
        orderId: 'ord_other_00001',
        buyerAccountId: 'acct_01HR0Aother1',
      }),
    ),
    'idempotency-key-reuse',
  );
});

test('every transition is idempotent and emits exactly once', async () => {
  const harness = build();
  const orderId = await placed(harness);
  const confirm = confirmRequest(orderId);

  const first = await harness.service.confirmOrder(confirm);
  const second = await harness.service.confirmOrder(confirm);

  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.equal(
    eventTypes(harness.repository).filter((type) => type === 'order.confirmed').length,
    1,
    'a replayed confirmation that emitted twice would look like two agreements',
  );
});

// ---------------------------------------------------------------------------
// Layer discipline — payments and inventory reach M-11 only by contract
// ---------------------------------------------------------------------------

test('every field belonging to another unit is refused, by name, with its owner', async () => {
  const harness = build();

  for (const [field, owner] of Object.entries(FOREIGN_FIELDS)) {
    const request = { ...createRequest(), [field]: 'anything' };
    const code = await codeOf(() => harness.service.createOrder(request));
    assert.equal(code, 'foreign-concern', `${field} was not refused as a foreign concern`);
    assert.match(
      owner,
      /K-\d\d|M-\d\d|profile core|provider/,
      `FOREIGN_FIELDS["${field}"] must name the unit that owns it, and says "${owner}"`,
    );
  }
});

test('payment fields are refused by name — M-12 is the same layer and reaches M-11 by event', async () => {
  const harness = build();
  for (const field of ['paymentId', 'paymentStatus', 'authorizationCode', 'cardNumber', 'pan']) {
    assert.equal(
      await codeOf(() => harness.service.createOrder({ ...createRequest(), [field]: 'x' })),
      'foreign-concern',
      `${field} must be refused: M-12 Payments is L5 like M-11, so it communicates by event only`,
    );
  }
});

test('M-11 imports no same-layer module and never the AI gateway', () => {
  const forbidden = [
    'modules/payments',
    'modules/financial-ledger',
    'modules/commission-rules',
    'modules/settlements',
    'kernel/ai-gateway',
  ];
  for (const file of readdirSync(MODULE_DIR).filter((name) => name.endsWith('.ts'))) {
    const source = readFileSync(path.join(MODULE_DIR, file), 'utf8');
    for (const target of forbidden) {
      assert.ok(
        !source.includes(target),
        `${file} references ${target}. Same-layer modules communicate by event (MODULE_MAP §10.3), ` +
          'and an order module that could reach the AI gateway would put AI in the financial ' +
          'authority path (MODULE_MAP §11, rule F-1) — a P0 defect',
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Atomicity and determinism
// ---------------------------------------------------------------------------

test('a refused operation leaves no row and no outbox entry', async () => {
  const harness = build();

  await assert.rejects(() => harness.service.createOrder(createRequest({ currency: 'nope' })));

  assert.deepEqual(harness.repository.orders(), []);
  assert.deepEqual(harness.repository.outbox().entries(), []);
});

test('outbox ids are unique per fact across a full order lifecycle', async () => {
  const harness = build();
  const orderId = await placed(harness);
  await harness.service.confirmOrder(confirmRequest(orderId));
  await harness.service.cancelOrder(cancelRequest(orderId));

  const ids = harness.repository
    .outbox()
    .entries()
    .map((entry) => entry.outboxId);
  assert.equal(
    new Set(ids).size,
    ids.length,
    'two outbox entries share an id, so the second would be refused by outbox_pkey. Ids derive ' +
      'from the order event, never from the order id alone',
  );
});

test('the module reads no clock and generates no randomness', () => {
  const offenders: string[] = [];
  for (const file of readdirSync(MODULE_DIR).filter((name) => name.endsWith('.ts'))) {
    const source = readFileSync(path.join(MODULE_DIR, file), 'utf8');
    if (/\bDate\.now\b|\bnew Date\b|\bMath\.random\b|\bcrypto\.randomUUID\b/.test(source)) {
      offenders.push(file);
    }
  }
  assert.deepEqual(offenders, [], 'the caller supplies every identifier and every instant');
});
