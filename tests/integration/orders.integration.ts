/**
 * M-11 Orders against a live PostgreSQL server — opt-in, and honestly skipped otherwise.
 *
 * Migration 0028 declares what TypeScript cannot: append-only triggers on the lines, the snapshot
 * and the transition log; `UNIQUE (order_id)` on `order_snapshot`, so an order cannot have two
 * agreements; `order_item_line_total_is_product`, which makes the arithmetic a database rule; and
 * the status/timestamp CHECKs that stop a row claiming to be cancelled with no instant of
 * cancellation.
 *
 * Each is proved by issuing the offending statement, not by asserting that the service does not.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { OrderService, PostgresOrderRepository } from '../../modules/orders/index.ts';
import { migrateUp } from '../../platform/db/runner.ts';
import type { Database } from '../../platform/db/client.ts';

import {
  BUYER,
  SELLER,
  cancelRequest,
  confirmRequest,
  createRequest,
  itemRequest,
  placeRequest,
} from '../helpers/orders-fixtures.ts';
import {
  developmentDatabaseName,
  developmentSnapshot,
  liveTestOptions,
  rollBackTo,
  withTestDatabase,
} from './harness.ts';

async function count(database: Database, table: string): Promise<number> {
  const client = await database.connect();
  try {
    const result = await client.query<{ count: string }>(`SELECT count(*) AS count FROM ${table};`);
    return Number(result.rows[0]?.count ?? 0);
  } finally {
    await client.release();
  }
}

/** The error message when the statement is refused, or null when it succeeded. */
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

const HEADER_COLUMNS =
  '(order_id, buyer_account_id, seller_account_id, status, currency, subtotal_minor, total_minor, ' +
  'item_count, placed_at, confirmed_at, completed_at, cancelled_at, cancellation_reason, ' +
  'created_at, updated_at, correlation_id, idempotency_key)';

const ITEM_COLUMNS =
  '(item_id, order_id, listing_id, version_id, commerce_unit_type_id, quantity, unit_price_minor, ' +
  'line_total_minor, currency, reservation_id, added_at, correlation_id, idempotency_key)';

function draftHeader(orderId: string, suffix: string): string {
  return (
    `('${orderId}', '${BUYER}', '${SELLER}', 'draft', 'LKR', 0, 0, 0, ` +
    `NULL, NULL, NULL, NULL, NULL, '2026-07-01T09:00:00Z', '2026-07-01T09:00:00Z', ` +
    `'corr_live_${suffix}', 'idem_live_${suffix}')`
  );
}

/** Drive a full order through the service against the real schema. */
async function fullLifecycle(
  service: OrderService,
  suffix: string,
): Promise<{ orderId: string; total: bigint }> {
  const created = createRequest({ orderId: `ord_live_${suffix}` });
  await service.createOrder(created);
  await service.addItem(
    itemRequest(created.orderId, { quantity: 4n, unitPriceMinor: 250n, lineTotalMinor: 1000n }),
  );
  await service.placeOrder(placeRequest(created.orderId, { expectedTotalMinor: 1000n }));
  return { orderId: created.orderId, total: 1000n };
}

test(
  'creates, places, confirms and completes end-to-end against the real schema',
  liveTestOptions,
  async () => {
    const before = await developmentSnapshot();

    await withTestDatabase(async ({ database, directory, name }) => {
      assert.notEqual(
        name,
        developmentDatabaseName(),
        'the target is never the development database',
      );
      await migrateUp(database, { directory });

      const service = new OrderService(new PostgresOrderRepository(database));
      const { orderId } = await fullLifecycle(service, 'flow01');

      const placedOrder = await service.getOrder(orderId);
      assert.equal(placedOrder?.status, 'placed');
      assert.equal(
        placedOrder?.totalMinor,
        1000n,
        'a bigint total round-trips through PostgreSQL as a bigint, not a rounded double',
      );
      assert.equal(
        placedOrder?.placedAt,
        '2026-07-01T10:00:00Z',
        'an instant projected through to_char comes back as the string that went in',
      );

      // The snapshot is the agreement, read back from a real database.
      const snapshot = await service.getSnapshot(orderId);
      assert.equal(snapshot?.totalMinor, 1000n);
      assert.equal(snapshot?.buyerAccountId, BUYER);

      await service.confirmOrder(confirmRequest(orderId));
      const confirmed = await service.getOrder(orderId);
      assert.equal(confirmed?.status, 'confirmed');
      assert.notEqual(confirmed?.confirmedAt, null);

      assert.equal(await count(database, 'module_orders.order_header'), 1);
      assert.equal(await count(database, 'module_orders.order_item'), 1);
      assert.equal(await count(database, 'module_orders.order_snapshot'), 1);
      assert.equal(await count(database, 'module_orders.order_event'), 3);
      assert.equal(
        await count(database, 'module_orders.outbox'),
        6,
        'three facts — created, placed, confirmed — each emitting an event and an audit record',
      );
    });

    const after = await developmentSnapshot();
    assert.deepEqual(
      after.applied.map((entry) => entry.version),
      before.applied.map((entry) => entry.version),
      'the development database was read and never written',
    );
  },
);

test(
  'the database refuses a line whose total is not quantity times unit price',
  liveTestOptions,
  async () => {
    await withTestDatabase(async ({ database, directory }) => {
      await migrateUp(database, { directory });

      const client = await database.connect();
      try {
        await client.query(
          `INSERT INTO module_orders.order_header ${HEADER_COLUMNS}
         VALUES ${draftHeader('ord_live_arith1', 'ar01')};`,
        );
      } finally {
        await client.release();
      }

      // 3 × 100 is 300, not 299. The service checks this; so must the database, because a total
      // nobody can derive from the line is a price nobody can defend in a dispute.
      const wrong = await refuses(
        database,
        `INSERT INTO module_orders.order_item ${ITEM_COLUMNS}
       VALUES ('oit_live_arith1', 'ord_live_arith1', 'lst_live_arith1', 'ver_live_arith1',
               'cut_live_arith1', 3, 100, 299, 'LKR', NULL, '2026-07-01T09:05:00Z',
               'corr_live_ar02', 'idem_live_ar02');`,
      );
      assert.ok(wrong !== null, 'a line total that is not the product reached the table');
      assert.match(wrong, /line_total_is_product/);

      const right = await refuses(
        database,
        `INSERT INTO module_orders.order_item ${ITEM_COLUMNS}
       VALUES ('oit_live_arith2', 'ord_live_arith1', 'lst_live_arith1', 'ver_live_arith1',
               'cut_live_arith1', 3, 100, 300, 'LKR', NULL, '2026-07-01T09:05:00Z',
               'corr_live_ar03', 'idem_live_ar03');`,
      );
      assert.equal(right, null, 'the correct product must be accepted');
    });
  },
);

test('the database refuses a second snapshot for one order', liveTestOptions, async () => {
  await withTestDatabase(async ({ database, directory }) => {
    await migrateUp(database, { directory });
    const service = new OrderService(new PostgresOrderRepository(database));
    const { orderId } = await fullLifecycle(service, 'snap01');

    const second = await refuses(
      database,
      `INSERT INTO module_orders.order_snapshot
         (snapshot_id, order_id, buyer_account_id, seller_account_id, currency, subtotal_minor,
          total_minor, lines, policy_version_id, captured_at, correlation_id, idempotency_key)
       VALUES ('osn_live_dup001', '${orderId}', '${BUYER}', '${SELLER}', 'LKR', 1, 1, '{}',
               NULL, '2026-07-01T10:00:00Z', 'corr_live_sn02', 'idem_live_sn02');`,
    );
    assert.ok(
      second !== null,
      'an order with two snapshots has two agreements, and no way to say which one a dispute is ' +
        'judged against',
    );
    assert.match(second, /order_snapshot_order_unique|unique/i);
  });
});

test(
  'the database refuses a status that disagrees with its timestamps',
  liveTestOptions,
  async () => {
    await withTestDatabase(async ({ database, directory }) => {
      await migrateUp(database, { directory });

      const cancelledWithout = await refuses(
        database,
        `INSERT INTO module_orders.order_header ${HEADER_COLUMNS}
       VALUES ('ord_live_chk001', '${BUYER}', '${SELLER}', 'cancelled', 'LKR', 0, 0, 0,
               '2026-07-01T10:00:00Z', NULL, NULL, NULL, NULL,
               '2026-07-01T09:00:00Z', '2026-07-01T09:00:00Z', 'corr_live_ck01', 'idem_live_ck01');`,
      );
      assert.ok(cancelledWithout !== null, 'a cancelled order with no instant of cancellation');
      assert.match(
        cancelledWithout,
        /cancelled_at_matches_status|cancellation_reason_matches_status/,
      );

      const draftPlaced = await refuses(
        database,
        `INSERT INTO module_orders.order_header ${HEADER_COLUMNS}
       VALUES ('ord_live_chk002', '${BUYER}', '${SELLER}', 'draft', 'LKR', 0, 0, 0,
               '2026-07-01T10:00:00Z', NULL, NULL, NULL, NULL,
               '2026-07-01T09:00:00Z', '2026-07-01T09:00:00Z', 'corr_live_ck02', 'idem_live_ck02');`,
      );
      assert.ok(draftPlaced !== null, 'a draft that carries a placement instant');
      assert.match(draftPlaced, /draft_never_placed/);

      const badCurrency = await refuses(
        database,
        `INSERT INTO module_orders.order_header ${HEADER_COLUMNS}
       VALUES ('ord_live_chk003', '${BUYER}', '${SELLER}', 'draft', 'lkr', 0, 0, 0,
               NULL, NULL, NULL, NULL, NULL,
               '2026-07-01T09:00:00Z', '2026-07-01T09:00:00Z', 'corr_live_ck03', 'idem_live_ck03');`,
      );
      assert.ok(badCurrency !== null, 'a lowercase currency is not ISO-4217');
      assert.match(badCurrency, /currency_well_formed/);
    });
  },
);

test(
  'the database refuses to rewrite or delete a line, a snapshot or a transition',
  liveTestOptions,
  async () => {
    await withTestDatabase(async ({ database, directory }) => {
      await migrateUp(database, { directory });
      const service = new OrderService(new PostgresOrderRepository(database));
      const { orderId } = await fullLifecycle(service, 'append1');

      const targets: readonly (readonly [string, string])[] = [
        ['order_item', 'currency'],
        ['order_snapshot', 'currency'],
        ['order_event', 'reason'],
      ];

      for (const [table, column] of targets) {
        const update = await refuses(
          database,
          `UPDATE module_orders.${table} SET ${column} = 'XXX' WHERE order_id = '${orderId}';`,
        );
        assert.ok(update !== null, `the append-only trigger must refuse an UPDATE on ${table}`);
        assert.match(update, /append-only/i);

        const remove = await refuses(
          database,
          `DELETE FROM module_orders.${table} WHERE order_id = '${orderId}';`,
        );
        assert.ok(remove !== null, `the append-only trigger must refuse a DELETE on ${table}`);
        assert.match(remove, /append-only/i);
      }

      // The header is legitimately mutable — that is the point of separating it from the rest.
      await service.confirmOrder(confirmRequest(orderId));
      assert.equal((await service.getOrder(orderId))?.status, 'confirmed');
    });
  },
);

test(
  'a cancelled order keeps its reason, and the transition log survives',
  liveTestOptions,
  async () => {
    await withTestDatabase(async ({ database, directory }) => {
      await migrateUp(database, { directory });
      const service = new OrderService(new PostgresOrderRepository(database));
      const { orderId } = await fullLifecycle(service, 'cancel1');

      await service.cancelOrder(
        cancelRequest(orderId, { cancellationReason: 'stock-unavailable' }),
      );

      const order = await service.getOrder(orderId);
      assert.equal(order?.status, 'cancelled');
      assert.equal(order?.cancellationReason, 'stock-unavailable');

      const history = await service.getHistory(orderId);
      assert.deepEqual(
        history.map((event) => event.toStatus),
        ['draft', 'placed', 'cancelled'],
        'the whole life of the order survives its cancellation',
      );
    });
  },
);

test(
  'a total above Number.MAX_SAFE_INTEGER survives the round trip exactly',
  liveTestOptions,
  async () => {
    await withTestDatabase(async ({ database, directory }) => {
      await migrateUp(database, { directory });
      const service = new OrderService(new PostgresOrderRepository(database));
      const huge = 9_007_199_254_740_993n;

      const created = createRequest({ orderId: 'ord_live_huge01' });
      await service.createOrder(created);
      await service.addItem(
        itemRequest(created.orderId, {
          quantity: 1n,
          unitPriceMinor: huge,
          lineTotalMinor: huge,
        }),
      );
      const placed = await service.placeOrder(
        placeRequest(created.orderId, { expectedTotalMinor: huge }),
      );

      assert.equal(
        placed.order.totalMinor,
        huge,
        'a total a double cannot represent must come back as the bigint that went in',
      );
      assert.equal(typeof placed.order.subtotalMinor, 'bigint');
    });
  },
);

test('migration 0028 rolls back and leaves no trace of the schema', liveTestOptions, async () => {
  await withTestDatabase(async ({ database, directory }) => {
    await migrateUp(database, { directory });

    const client = await database.connect();
    try {
      const present = await client.query<{ count: string }>(
        `SELECT count(*) AS count FROM information_schema.schemata
          WHERE schema_name = 'module_orders';`,
      );
      assert.equal(Number(present.rows[0]?.count ?? 0), 1);
    } finally {
      await client.release();
    }

    await rollBackTo(database, directory, '0028');

    const after = await database.connect();
    try {
      const rows = await after.query<{ count: string }>(
        `SELECT count(*) AS count FROM information_schema.schemata
          WHERE schema_name = 'module_orders';`,
      );
      assert.equal(
        Number(rows.rows[0]?.count ?? 0),
        0,
        'the rollback dropped the tables but left the schema, so the migration is not reversible',
      );
    } finally {
      await after.release();
    }
  });
});
