/**
 * M-11 Orders — split supplier fulfilment behaviour.
 *
 * A buyer orders twenty tonnes and no single supplier holds twenty tonnes, so the order becomes a
 * parent with one child per supplier. The parent completes when every child is terminal; partial
 * fulfilment is a derived quantity, not a status.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  OrderError,
  type InMemoryOrderRepository,
  type OrderService,
} from '../modules/orders/index.ts';

import {
  LISTING,
  UNIT_TYPE,
  VERSION,
  build,
  cancelRequest,
  createRequest,
  entriesOfKind,
  eventTypes,
  itemRequest,
  placeRequest,
} from './helpers/orders-fixtures.ts';

let sequence = 0;

function seq(): string {
  sequence += 1;
  return String(sequence).padStart(4, '0');
}

const SUPPLIER_A = 'acct_01HR0A0supplyA';
const SUPPLIER_B = 'acct_01HR0A0supplyB';
const SUPPLIER_C = 'acct_01HR0A0supplyC';

function splitItem(quantity: bigint) {
  const n = seq();
  return {
    itemId: `oit_split_${n}`,
    listingId: LISTING,
    versionId: VERSION,
    commerceUnitTypeId: UNIT_TYPE,
    quantity,
    unitPriceMinor: 100n,
    lineTotalMinor: quantity * 100n,
    currency: 'LKR',
    reservationId: null,
  };
}

function splitAllocation(orderId: string, sellerAccountId: string, quantities: bigint[]) {
  const n = seq();
  return {
    orderId,
    sellerAccountId,
    idempotencyKey: `idem_split_alloc_${n}`,
    eventId: `oev_split_alloc_${n}`,
    items: quantities.map(splitItem),
  };
}

function splitRequest(
  parentOrderId: string,
  allocations: ReturnType<typeof splitAllocation>[],
  overrides: Record<string, unknown> = {},
) {
  const n = seq();
  return {
    parentOrderId,
    allocations,
    occurredAt: '2026-07-02T10:00:00Z',
    updatedAt: '2026-07-02T10:00:00Z',
    correlationId: `corr_split_${n}`,
    idempotencyKey: `idem_split_${n}`,
    eventId: `oev_split_${n}`,
    reason: 'the order was split across suppliers',
    ...overrides,
  };
}

/**
 * Drive a child order the whole way to completed.
 *
 * A child is a real order, so it walks the same placed -> confirmed -> fulfilling -> completed path
 * as any other. Skipping straight to completed is what the state machine exists to refuse.
 */
async function completeChild(harness: ReturnType<typeof build>, childId: string): Promise<void> {
  const n = seq();
  await harness.service.confirmOrder({
    orderId: childId,
    confirmedAt: '2026-07-03T10:00:00Z',
    updatedAt: '2026-07-03T10:00:00Z',
    correlationId: `corr_cc_${n}`,
    idempotencyKey: `idem_cc_${n}`,
    eventId: `oev_cc_${n}`,
    reason: 'the supplier accepted',
  });
  await harness.service.startFulfilment({
    orderId: childId,
    fulfillingAt: '2026-07-04T10:00:00Z',
    updatedAt: '2026-07-04T10:00:00Z',
    correlationId: `corr_cf_${n}`,
    idempotencyKey: `idem_cf_${n}`,
    eventId: `oev_cf_${n}`,
    reason: 'the supplier began loading',
  });
  await harness.service.completeOrder({
    orderId: childId,
    completedAt: '2026-07-05T10:00:00Z',
    updatedAt: '2026-07-05T10:00:00Z',
    correlationId: `corr_cp_${n}`,
    idempotencyKey: `idem_cp_${n}`,
    eventId: `oev_cp_${n}`,
    reason: 'the supplier delivered',
  });
}

function childCancelRequest(childId: string, reason = 'stock-unavailable') {
  const n = seq();
  return {
    orderId: childId,
    cancellationReason: reason,
    cancelledAt: '2026-07-05T10:00:00Z',
    updatedAt: '2026-07-05T10:00:00Z',
    correlationId: `corr_child_cancel_${n}`,
    idempotencyKey: `idem_child_cancel_${n}`,
    eventId: `oev_child_cancel_${n}`,
    reason: 'the supplier could not deliver',
  };
}

async function placeParent(
  harness: { service: OrderService; repository: InMemoryOrderRepository },
  quantity: bigint,
): Promise<string> {
  const created = createRequest();
  await harness.service.createOrder(created);
  await harness.service.addItem(
    itemRequest(created.orderId, {
      quantity,
      unitPriceMinor: 100n,
      lineTotalMinor: quantity * 100n,
    }),
  );
  await harness.service.placeOrder(
    placeRequest(created.orderId, { expectedTotalMinor: quantity * 100n }),
  );
  return created.orderId;
}

const codeOf = async (body: () => Promise<unknown>): Promise<string> => {
  try {
    await body();
  } catch (error) {
    if (error instanceof OrderError) return error.code;
    throw error;
  }
  throw new Error('expected a refusal, and the call succeeded');
};

// ---------------------------------------------------------------------------
// 1. 20 t → 7 + 5 + 8, all complete → parent completes, fulfilledQuantity = 20.
// ---------------------------------------------------------------------------

test('20 tonnes split 7 + 5 + 8, all children complete, parent completes with fulfilled 20', async () => {
  const harness = build();
  const parentId = await placeParent(harness, 20n);

  const childA = `ord_child_a_${seq()}`;
  const childB = `ord_child_b_${seq()}`;
  const childC = `ord_child_c_${seq()}`;
  const split = await harness.service.splitOrder(
    splitRequest(parentId, [
      splitAllocation(childA, SUPPLIER_A, [7n]),
      splitAllocation(childB, SUPPLIER_B, [5n]),
      splitAllocation(childC, SUPPLIER_C, [8n]),
    ]),
  );

  assert.equal(split.order.status, 'fulfilling');
  assert.equal(split.order.fulfilmentRole, 'parent');
  assert.equal(split.children.length, 3);

  await completeChild(harness, childA);
  await completeChild(harness, childB);
  await completeChild(harness, childC);

  const completed = await harness.service.completeOrder({
    orderId: parentId,
    completedAt: '2026-07-06T10:00:00Z',
    updatedAt: '2026-07-06T10:00:00Z',
    correlationId: `corr_complete_parent_${seq()}`,
    idempotencyKey: `idem_complete_parent_${seq()}`,
    eventId: `oev_complete_parent_${seq()}`,
    reason: 'every child delivered',
  });

  assert.equal(completed.order.status, 'completed');

  const summary = await harness.service.getFulfilmentSummary(parentId);
  assert.equal(summary.orderedQuantity, 20n);
  assert.equal(summary.allocatedQuantity, 20n);
  assert.equal(summary.fulfilledQuantity, 20n);
  assert.equal(summary.cancelledQuantity, 0n);
  assert.equal(summary.pendingQuantity, 0n);
  assert.equal(summary.fullyAllocated, true);
  assert.equal(summary.fullyFulfilled, true);
});

// ---------------------------------------------------------------------------
// 2. Allocation summing to 19 or 21 → allocation-mismatch, nothing written.
// ---------------------------------------------------------------------------

test('allocations that sum to 19 refuse allocation-mismatch and write nothing', async () => {
  const harness = build();
  const parentId = await placeParent(harness, 20n);
  const childA = `ord_child_a_${seq()}`;
  const childB = `ord_child_b_${seq()}`;

  assert.equal(
    await codeOf(() =>
      harness.service.splitOrder(
        splitRequest(parentId, [
          splitAllocation(childA, SUPPLIER_A, [10n]),
          splitAllocation(childB, SUPPLIER_B, [9n]),
        ]),
      ),
    ),
    'allocation-mismatch',
  );

  assert.equal((await harness.service.getOrder(parentId))?.status, 'placed');
  assert.equal(harness.repository.orders().length, 1);
  assert.equal(harness.repository.items().length, 1);
  // Two events from creating and placing the parent, and not a third: a refused split emits
  // nothing at all, so no consumer ever hears about a split that did not happen.
  assert.equal(entriesOfKind(harness.repository, 'event').length, 2);
  assert.ok(!eventTypes(harness.repository).includes('order.split'));
});

test('allocations that sum to 21 refuse allocation-mismatch and write nothing', async () => {
  const harness = build();
  const parentId = await placeParent(harness, 20n);
  const childA = `ord_child_a_${seq()}`;
  const childB = `ord_child_b_${seq()}`;

  assert.equal(
    await codeOf(() =>
      harness.service.splitOrder(
        splitRequest(parentId, [
          splitAllocation(childA, SUPPLIER_A, [12n]),
          splitAllocation(childB, SUPPLIER_B, [9n]),
        ]),
      ),
    ),
    'allocation-mismatch',
  );

  assert.equal((await harness.service.getOrder(parentId))?.status, 'placed');
  assert.equal(harness.repository.orders().length, 1);
});

// ---------------------------------------------------------------------------
// 3. Child B cancelled, A and C complete → parent completes, fulfilled 15, cancelled 5.
// ---------------------------------------------------------------------------

test('one child cancelled and the rest complete, parent completes with fulfilled 15 and cancelled 5', async () => {
  const harness = build();
  const parentId = await placeParent(harness, 20n);
  const childA = `ord_child_a_${seq()}`;
  const childB = `ord_child_b_${seq()}`;
  const childC = `ord_child_c_${seq()}`;

  await harness.service.splitOrder(
    splitRequest(parentId, [
      splitAllocation(childA, SUPPLIER_A, [7n]),
      splitAllocation(childB, SUPPLIER_B, [5n]),
      splitAllocation(childC, SUPPLIER_C, [8n]),
    ]),
  );

  await completeChild(harness, childA);
  await harness.service.cancelOrder(childCancelRequest(childB));
  await completeChild(harness, childC);

  const completed = await harness.service.completeOrder({
    orderId: parentId,
    completedAt: '2026-07-06T10:00:00Z',
    updatedAt: '2026-07-06T10:00:00Z',
    correlationId: `corr_complete_parent_${seq()}`,
    idempotencyKey: `idem_complete_parent_${seq()}`,
    eventId: `oev_complete_parent_${seq()}`,
    reason: 'every remaining child delivered',
  });

  assert.equal(completed.order.status, 'completed');

  const summary = await harness.service.getFulfilmentSummary(parentId);
  assert.equal(summary.fulfilledQuantity, 15n);
  assert.equal(summary.cancelledQuantity, 5n);
  assert.equal(summary.pendingQuantity, 0n);
  assert.equal(summary.fullyFulfilled, false);
});

// ---------------------------------------------------------------------------
// 4. All children cancelled → parent cannot complete (nothing-fulfilled); cancelling works.
// ---------------------------------------------------------------------------

test('all children cancelled, parent cannot complete but can be cancelled', async () => {
  const harness = build();
  const parentId = await placeParent(harness, 20n);
  const childA = `ord_child_a_${seq()}`;
  const childB = `ord_child_b_${seq()}`;

  await harness.service.splitOrder(
    splitRequest(parentId, [
      splitAllocation(childA, SUPPLIER_A, [10n]),
      splitAllocation(childB, SUPPLIER_B, [10n]),
    ]),
  );

  await harness.service.cancelOrder(childCancelRequest(childA));
  await harness.service.cancelOrder(childCancelRequest(childB));

  assert.equal(
    await codeOf(() =>
      harness.service.completeOrder({
        orderId: parentId,
        completedAt: '2026-07-06T10:00:00Z',
        updatedAt: '2026-07-06T10:00:00Z',
        correlationId: `corr_complete_parent_${seq()}`,
        idempotencyKey: `idem_complete_parent_${seq()}`,
        eventId: `oev_complete_parent_${seq()}`,
        reason: 'every child terminal',
      }),
    ),
    'nothing-fulfilled',
  );

  const cancelled = await harness.service.cancelOrder({
    ...cancelRequest(parentId),
    cancellationReason: 'stock-unavailable',
  });
  assert.equal(cancelled.order.status, 'cancelled');

  const summary = await harness.service.getFulfilmentSummary(parentId);
  assert.equal(summary.cancelledQuantity, 20n);
  assert.equal(summary.fulfilledQuantity, 0n);
});

// ---------------------------------------------------------------------------
// 5. Completing a parent with a child still fulfilling → children-outstanding.
// ---------------------------------------------------------------------------

test('completing a parent with a non-terminal child refuses children-outstanding', async () => {
  const harness = build();
  const parentId = await placeParent(harness, 20n);
  const childA = `ord_child_a_${seq()}`;
  const childB = `ord_child_b_${seq()}`;

  await harness.service.splitOrder(
    splitRequest(parentId, [
      splitAllocation(childA, SUPPLIER_A, [10n]),
      splitAllocation(childB, SUPPLIER_B, [10n]),
    ]),
  );

  await completeChild(harness, childA);
  // childB remains placed/non-terminal.

  assert.equal(
    await codeOf(() =>
      harness.service.completeOrder({
        orderId: parentId,
        completedAt: '2026-07-06T10:00:00Z',
        updatedAt: '2026-07-06T10:00:00Z',
        correlationId: `corr_complete_parent_${seq()}`,
        idempotencyKey: `idem_complete_parent_${seq()}`,
        eventId: `oev_complete_parent_${seq()}`,
        reason: 'some children are still in flight',
      }),
    ),
    'children-outstanding',
  );
});

// ---------------------------------------------------------------------------
// 6. Cancelling a parent cascades to non-terminal children only.
// ---------------------------------------------------------------------------

test('cancelling a parent cascades to non-terminal children only', async () => {
  const harness = build();
  const parentId = await placeParent(harness, 20n);
  const childA = `ord_child_a_${seq()}`;
  const childB = `ord_child_b_${seq()}`;

  await harness.service.splitOrder(
    splitRequest(parentId, [
      splitAllocation(childA, SUPPLIER_A, [10n]),
      splitAllocation(childB, SUPPLIER_B, [10n]),
    ]),
  );

  await completeChild(harness, childA);

  await harness.service.cancelOrder({
    ...cancelRequest(parentId),
    cancellationReason: 'buyer-withdrew',
  });

  assert.equal((await harness.service.getOrder(childA))?.status, 'completed');
  assert.equal((await harness.service.getOrder(childB))?.status, 'cancelled');
});

// ---------------------------------------------------------------------------
// 7. Splitting a child → nested-split.
// ---------------------------------------------------------------------------

test('splitting a child order refuses nested-split', async () => {
  const harness = build();
  const parentId = await placeParent(harness, 20n);
  const childA = `ord_child_a_${seq()}`;

  await harness.service.splitOrder(
    splitRequest(parentId, [splitAllocation(childA, SUPPLIER_A, [20n])]),
  );

  assert.equal(
    await codeOf(() =>
      harness.service.splitOrder(
        splitRequest(childA, [splitAllocation(`ord_grandchild_${seq()}`, SUPPLIER_B, [20n])]),
      ),
    ),
    'nested-split',
  );
});

// ---------------------------------------------------------------------------
// 8. Splitting twice → already-split.
// ---------------------------------------------------------------------------

test('splitting the same parent twice refuses already-split', async () => {
  const harness = build();
  const parentId = await placeParent(harness, 20n);
  const childA = `ord_child_a_${seq()}`;

  await harness.service.splitOrder(
    splitRequest(parentId, [splitAllocation(childA, SUPPLIER_A, [20n])]),
  );

  assert.equal(
    await codeOf(() =>
      harness.service.splitOrder(
        splitRequest(parentId, [splitAllocation(`ord_child_b_${seq()}`, SUPPLIER_B, [20n])]),
      ),
    ),
    'already-split',
  );
});

// ---------------------------------------------------------------------------
// 9. Split is idempotent by key; replay writes no second child and emits no second event.
// ---------------------------------------------------------------------------

test('splitOrder is idempotent by key', async () => {
  const harness = build();
  const parentId = await placeParent(harness, 20n);
  const childA = `ord_child_a_${seq()}`;
  const request = splitRequest(parentId, [splitAllocation(childA, SUPPLIER_A, [20n])]);

  const first = await harness.service.splitOrder(request);
  const second = await harness.service.splitOrder(request);

  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.deepEqual(second.order, first.order);
  assert.deepEqual(second.children, first.children);
  assert.equal(harness.repository.orders().length, 2);
  assert.equal(eventTypes(harness.repository).filter((type) => type === 'order.split').length, 1);
});

// ---------------------------------------------------------------------------
// 10. Cancellation reason propagates from parent to every cascaded child.
// ---------------------------------------------------------------------------

test('parent cancellation reason propagates to cascaded children', async () => {
  const harness = build();
  const parentId = await placeParent(harness, 20n);
  const childA = `ord_child_a_${seq()}`;
  const childB = `ord_child_b_${seq()}`;

  await harness.service.splitOrder(
    splitRequest(parentId, [
      splitAllocation(childA, SUPPLIER_A, [10n]),
      splitAllocation(childB, SUPPLIER_B, [10n]),
    ]),
  );

  await harness.service.cancelOrder({
    ...cancelRequest(parentId),
    cancellationReason: 'payment-failed',
  });

  assert.equal((await harness.service.getOrder(childA))?.cancellationReason, 'payment-failed');
  assert.equal((await harness.service.getOrder(childB))?.cancellationReason, 'payment-failed');
});

// ---------------------------------------------------------------------------
// 11. A child's own lifecycle is a normal order lifecycle.
// ---------------------------------------------------------------------------

test('a child order has a normal lifecycle and illegal transitions are refused', async () => {
  const harness = build();
  const parentId = await placeParent(harness, 20n);
  const childA = `ord_child_a_${seq()}`;

  await harness.service.splitOrder(
    splitRequest(parentId, [splitAllocation(childA, SUPPLIER_A, [20n])]),
  );

  // A child is placed, and cannot jump straight to completed. It is an ordinary order and the
  // state machine applies to it in full — being part of a split buys it no shortcuts.
  assert.equal(
    await codeOf(() =>
      harness.service.completeOrder({
        orderId: childA,
        completedAt: '2026-07-05T10:00:00Z',
        updatedAt: '2026-07-05T10:00:00Z',
        correlationId: `corr_skip_${seq()}`,
        idempotencyKey: `idem_skip_${seq()}`,
        eventId: `oev_skip_${seq()}`,
        reason: 'skipping the middle',
      }),
    ),
    'illegal-transition',
  );

  await completeChild(harness, childA);
  assert.equal((await harness.service.getOrder(childA))?.status, 'completed');
});

// ---------------------------------------------------------------------------
// 12. Concurrency: two splitOrder calls racing on the same parent — exactly one wins.
// ---------------------------------------------------------------------------

test('two concurrent splitOrder calls on the same parent leave exactly one winner', async () => {
  const harness = build();
  const parentId = await placeParent(harness, 20n);
  const childA = `ord_child_a_${seq()}`;
  const childB = `ord_child_b_${seq()}`;

  const requestA = splitRequest(parentId, [splitAllocation(childA, SUPPLIER_A, [20n])]);
  const requestB = splitRequest(parentId, [splitAllocation(childB, SUPPLIER_B, [20n])]);

  const [resultA, resultB] = await Promise.allSettled([
    harness.service.splitOrder(requestA),
    harness.service.splitOrder(requestB),
  ]);

  const winners = [resultA, resultB].filter((r) => r.status === 'fulfilled');
  assert.equal(winners.length, 1, 'exactly one split may succeed');

  const parent = await harness.service.getOrder(parentId);
  assert.equal(parent?.fulfilmentRole, 'parent');
  assert.equal(harness.repository.orders().length, 2);
});

// ---------------------------------------------------------------------------
// 13. A standalone order has a fulfilment summary with zero allocation.
// ---------------------------------------------------------------------------

test('a standalone order has zero allocated, fulfilled and cancelled quantities', async () => {
  const harness = build();
  const parentId = await placeParent(harness, 5n);

  const summary = await harness.service.getFulfilmentSummary(parentId);
  assert.equal(summary.orderedQuantity, 5n);
  assert.equal(summary.allocatedQuantity, 0n);
  assert.equal(summary.fulfilledQuantity, 0n);
  assert.equal(summary.cancelledQuantity, 0n);
  assert.equal(summary.pendingQuantity, 0n);
  assert.equal(summary.fullyAllocated, false);
  // Not `true`. A caller checking `fullyFulfilled` before releasing payment must never be told an
  // order that has delivered nothing is fully fulfilled — five tonnes were ordered and none
  // arrived. "No children" means unsplit, not complete.
  assert.equal(summary.fullyFulfilled, false);
  assert.deepEqual(summary.children, []);
});

// ---------------------------------------------------------------------------
// 14. listChildren returns children ordered by orderId.
// ---------------------------------------------------------------------------

test('listChildren returns children ordered by order id', async () => {
  const harness = build();
  const parentId = await placeParent(harness, 20n);
  const childZ = `ord_child_zzz_${seq()}`;
  const childA = `ord_child_aaa_${seq()}`;
  const childM = `ord_child_mmm_${seq()}`;

  await harness.service.splitOrder(
    splitRequest(parentId, [
      splitAllocation(childZ, SUPPLIER_A, [5n]),
      splitAllocation(childA, SUPPLIER_B, [7n]),
      splitAllocation(childM, SUPPLIER_C, [8n]),
    ]),
  );

  const children = await harness.service.listChildren(parentId);
  assert.deepEqual(
    children.map((child) => child.orderId),
    [childA, childM, childZ].sort(),
  );
});

// ---------------------------------------------------------------------------
// 15. Outbox emits order.split and one order.placed per child.
// ---------------------------------------------------------------------------

test('split writes order.split and one order.placed per child to the outbox', async () => {
  const harness = build();
  const parentId = await placeParent(harness, 20n);
  const childA = `ord_child_a_${seq()}`;
  const childB = `ord_child_b_${seq()}`;

  await harness.service.splitOrder(
    splitRequest(parentId, [
      splitAllocation(childA, SUPPLIER_A, [10n]),
      splitAllocation(childB, SUPPLIER_B, [10n]),
    ]),
  );

  const events = eventTypes(harness.repository);
  assert.ok(events.includes('order.split'));
  // The parent's original placement plus one placement per child.
  assert.equal(events.filter((type) => type === 'order.placed').length, 3);
  assert.equal(events.filter((type) => type === 'order.split').length, 1);
});
