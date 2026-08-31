/**
 * M-11 split fulfilment against a live PostgreSQL server — opt-in, and honestly skipped otherwise.
 *
 * Migration 0029 declares three things TypeScript cannot: a child has a parent and only a child has
 * one; no order is its own parent; and the fulfilment role is a closed vocabulary. Each is proved
 * here by issuing the offending statement, not by asserting the service does not.
 *
 * It also proved a defect the in-memory repository could never have caught. A split parent reaches
 * `fulfilling` without ever being `confirmed` — there is no single seller to confirm it — and
 * migration 0028's CHECK assumed the only route to `fulfilling` ran through `confirmed`. The
 * reference repository enforces no CHECKs, so the unit suite passed while every split failed
 * against a real database. 0029 replaces that constraint.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { OrderService, PostgresOrderRepository } from '../../modules/orders/index.ts';
import { migrateUp } from '../../platform/db/runner.ts';
import type { Database } from '../../platform/db/client.ts';

import {
  BUYER,
  LISTING,
  SELLER,
  UNIT_TYPE,
  VERSION,
  cancelRequest,
  createRequest,
  itemRequest,
  placeRequest,
} from '../helpers/orders-fixtures.ts';
import { liveTestOptions, withTestDatabase } from './harness.ts';

let sequence = 0;
const seq = (): string => {
  sequence += 1;
  return String(sequence).padStart(4, '0');
};

async function refuses(database: Database, sql: string): Promise<string | null> {
  const client = await database.connect();
  try {
    await client.query(sql);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  } finally {
    await client.release();
  }
}

async function scalar(database: Database, sql: string): Promise<string> {
  const client = await database.connect();
  try {
    const result = await client.query<{ value: string }>(sql);
    return String(result.rows[0]?.value ?? '');
  } finally {
    await client.release();
  }
}

const HEADER_COLUMNS =
  '(order_id, buyer_account_id, seller_account_id, status, currency, subtotal_minor, total_minor, ' +
  'item_count, placed_at, confirmed_at, completed_at, cancelled_at, cancellation_reason, ' +
  'created_at, updated_at, correlation_id, idempotency_key, parent_order_id, fulfilment_role)';

function draftHeader(
  orderId: string,
  suffix: string,
  parentOrderId: string | null,
  role: string,
): string {
  const parent = parentOrderId === null ? 'NULL' : `'${parentOrderId}'`;
  return (
    `('${orderId}', '${BUYER}', '${SELLER}', 'draft', 'LKR', 0, 0, 0, ` +
    `NULL, NULL, NULL, NULL, NULL, '2026-07-01T09:00:00Z', '2026-07-01T09:00:00Z', ` +
    `'corr_live_${suffix}', 'idem_live_${suffix}', ${parent}, '${role}')`
  );
}

function allocation(orderId: string, sellerAccountId: string, tonnes: bigint) {
  const n = seq();
  return {
    orderId,
    sellerAccountId,
    idempotencyKey: `idem_live_alloc_${n}`,
    eventId: `oev_live_alloc_${n}`,
    items: [
      {
        itemId: `oit_live_alloc_${n}`,
        listingId: LISTING,
        versionId: VERSION,
        commerceUnitTypeId: UNIT_TYPE,
        quantity: tonnes,
        unitPriceMinor: 100n,
        lineTotalMinor: tonnes * 100n,
        currency: 'LKR',
        reservationId: null,
      },
    ],
  };
}

function splitRequest(parentOrderId: string, allocations: ReturnType<typeof allocation>[]) {
  const n = seq();
  return {
    parentOrderId,
    allocations,
    occurredAt: '2026-07-02T09:00:00Z',
    updatedAt: '2026-07-02T09:00:00Z',
    correlationId: `corr_live_split_${n}`,
    idempotencyKey: `idem_live_split_${n}`,
    eventId: `oev_live_split_${n}`,
    reason: 'no single supplier holds the whole quantity',
  };
}

async function placedParent(service: OrderService, tonnes: bigint): Promise<string> {
  const created = createRequest();
  await service.createOrder(created);
  await service.addItem(
    itemRequest(created.orderId, {
      quantity: tonnes,
      unitPriceMinor: 100n,
      lineTotalMinor: tonnes * 100n,
    }),
  );
  await service.placeOrder(placeRequest(created.orderId, { expectedTotalMinor: tonnes * 100n }));
  return created.orderId;
}

async function completeChild(service: OrderService, orderId: string): Promise<void> {
  const n = seq();
  await service.confirmOrder({
    orderId,
    confirmedAt: '2026-07-03T09:00:00Z',
    updatedAt: '2026-07-03T09:00:00Z',
    correlationId: `corr_live_cc_${n}`,
    idempotencyKey: `idem_live_cc_${n}`,
    eventId: `oev_live_cc_${n}`,
    reason: 'accepted',
  });
  await service.startFulfilment({
    orderId,
    fulfillingAt: '2026-07-04T09:00:00Z',
    updatedAt: '2026-07-04T09:00:00Z',
    correlationId: `corr_live_cf_${n}`,
    idempotencyKey: `idem_live_cf_${n}`,
    eventId: `oev_live_cf_${n}`,
    reason: 'loading',
  });
  await service.completeOrder({
    orderId,
    completedAt: '2026-07-05T09:00:00Z',
    updatedAt: '2026-07-05T09:00:00Z',
    correlationId: `corr_live_cp_${n}`,
    idempotencyKey: `idem_live_cp_${n}`,
    eventId: `oev_live_cp_${n}`,
    reason: 'delivered',
  });
}

test('20 tonnes split 7 + 5 + 8 completes end-to-end against the real schema', liveTestOptions, async () => {
  await withTestDatabase(async ({ database, directory }) => {
    await migrateUp(database, { directory });
    const service = new OrderService(new PostgresOrderRepository(database));

    const parentId = await placedParent(service, 20n);
    const split = await service.splitOrder(
      splitRequest(parentId, [
        allocation('ord_live_child_a1', 'acct_live_supplyA1', 7n),
        allocation('ord_live_child_b1', 'acct_live_supplyB1', 5n),
        allocation('ord_live_child_c1', 'acct_live_supplyC1', 8n),
      ]),
    );
    assert.equal(split.children.length, 3);

    assert.equal(
      await scalar(
        database,
        `SELECT count(*)::text AS value FROM module_orders.order_header
          WHERE parent_order_id = '${parentId}' AND fulfilment_role = 'child';`,
      ),
      '3',
    );
    assert.equal(
      await scalar(
        database,
        `SELECT fulfilment_role AS value FROM module_orders.order_header
          WHERE order_id = '${parentId}';`,
      ),
      'parent',
    );

    for (const child of await service.listChildren(parentId)) {
      await completeChild(service, child.orderId);
    }

    const summary = await service.getFulfilmentSummary(parentId);
    assert.equal(summary.fulfilledQuantity, 20n, '7 + 5 + 8 = 20, summed from real rows');
    assert.equal(summary.pendingQuantity, 0n);
    assert.equal(summary.fullyFulfilled, true);

    // The same sum, computed by the database rather than by the service that wrote it. If these two
    // ever disagree, the summary has become a second source of truth rather than a projection.
    assert.equal(
      await scalar(
        database,
        `SELECT COALESCE(SUM(i.quantity), 0)::text AS value
           FROM module_orders.order_item i
           JOIN module_orders.order_header h ON h.order_id = i.order_id
          WHERE h.parent_order_id = '${parentId}' AND h.status = 'completed';`,
      ),
      '20',
    );

    await service.completeOrder({
      orderId: parentId,
      completedAt: '2026-07-06T09:00:00Z',
      updatedAt: '2026-07-06T09:00:00Z',
      correlationId: 'corr_live_pc0001',
      idempotencyKey: 'idem_live_pc0001',
      eventId: 'oev_live_pc0001',
      reason: 'every supplier delivered',
    });
    assert.equal((await service.getOrder(parentId))?.status, 'completed');
  });
});

test('the database refuses a child without a parent, and a non-child with one', liveTestOptions, async () => {
  await withTestDatabase(async ({ database, directory }) => {
    await migrateUp(database, { directory });

    const childNoParent = await refuses(
      database,
      `INSERT INTO module_orders.order_header ${HEADER_COLUMNS}
       VALUES ${draftHeader('ord_live_cnp0001', 'cnp1', null, 'child')};`,
    );
    assert.ok(childNoParent !== null, 'a child with no parent reached the table');
    assert.match(childNoParent, /child_has_parent/);

    const standaloneWithParent = await refuses(
      database,
      `INSERT INTO module_orders.order_header ${HEADER_COLUMNS}
       VALUES ${draftHeader('ord_live_swp0001', 'swp1', 'ord_live_parent001', 'standalone')};`,
    );
    assert.ok(standaloneWithParent !== null, 'a standalone order carrying a parent');
    assert.match(standaloneWithParent, /child_has_parent/);
  });
});

test('the database refuses an order that is its own parent', liveTestOptions, async () => {
  await withTestDatabase(async ({ database, directory }) => {
    await migrateUp(database, { directory });

    const selfParent = await refuses(
      database,
      `INSERT INTO module_orders.order_header ${HEADER_COLUMNS}
       VALUES ${draftHeader('ord_live_self0001', 'self1', 'ord_live_self0001', 'child')};`,
    );
    assert.ok(
      selfParent !== null,
      'an order that is its own parent makes the fulfilment summary infinitely recursive',
    );
    assert.match(selfParent, /no_self_parent/);
  });
});

test('the database refuses a fulfilment role outside the vocabulary', liveTestOptions, async () => {
  await withTestDatabase(async ({ database, directory }) => {
    await migrateUp(database, { directory });

    const unknown = await refuses(
      database,
      `INSERT INTO module_orders.order_header ${HEADER_COLUMNS}
       VALUES ${draftHeader('ord_live_role0001', 'role1', null, 'grandparent')};`,
    );
    assert.ok(unknown !== null, 'an unknown fulfilment role reached the table');
    assert.match(unknown, /fulfilment_role_known/);
  });
});

test('a refused split leaves nothing partial in the database', liveTestOptions, async () => {
  await withTestDatabase(async ({ database, directory }) => {
    await migrateUp(database, { directory });
    const service = new OrderService(new PostgresOrderRepository(database));
    const parentId = await placedParent(service, 20n);

    // 7 + 5 + 7 is 19, not 20.
    await assert.rejects(() =>
      service.splitOrder(
        splitRequest(parentId, [
          allocation('ord_live_bad_a1', 'acct_live_supplyX1', 7n),
          allocation('ord_live_bad_b1', 'acct_live_supplyY1', 5n),
          allocation('ord_live_bad_c1', 'acct_live_supplyZ1', 7n),
        ]),
      ),
    );

    assert.equal(
      await scalar(
        database,
        `SELECT count(*)::text AS value FROM module_orders.order_header
          WHERE parent_order_id = '${parentId}';`,
      ),
      '0',
      'a partially written split would leave the unallocated remainder owned by nobody',
    );
    assert.equal(
      await scalar(
        database,
        `SELECT fulfilment_role AS value FROM module_orders.order_header
          WHERE order_id = '${parentId}';`,
      ),
      'standalone',
      'the parent must be untouched by a refused split',
    );
  });
});

test('cascade cancellation reaches non-terminal children only, in the database', liveTestOptions, async () => {
  await withTestDatabase(async ({ database, directory }) => {
    await migrateUp(database, { directory });
    const service = new OrderService(new PostgresOrderRepository(database));
    const parentId = await placedParent(service, 20n);

    await service.splitOrder(
      splitRequest(parentId, [
        allocation('ord_live_casc_a1', 'acct_live_supplyM1', 7n),
        allocation('ord_live_casc_b1', 'acct_live_supplyN1', 5n),
        allocation('ord_live_casc_c1', 'acct_live_supplyO1', 8n),
      ]),
    );
    await completeChild(service, 'ord_live_casc_a1');

    await service.cancelOrder(cancelRequest(parentId, { cancellationReason: 'buyer-withdrew' }));

    assert.equal(
      await scalar(
        database,
        `SELECT count(*)::text AS value FROM module_orders.order_header
          WHERE parent_order_id = '${parentId}' AND status = 'cancelled'
            AND cancellation_reason = 'buyer-withdrew';`,
      ),
      '2',
      'the two in-flight children are cancelled and carry the parent reason',
    );
    assert.equal(
      await scalar(
        database,
        `SELECT status AS value FROM module_orders.order_header
          WHERE order_id = 'ord_live_casc_a1';`,
      ),
      'completed',
      'an already-delivered child is not unwound by the buyer abandoning the rest',
    );
  });
});
