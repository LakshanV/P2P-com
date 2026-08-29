/**
 * M-04's inventory interface against a live PostgreSQL server — opt-in, and honestly skipped
 * otherwise.
 *
 * The unit suites and the contract test prove that the *service* refuses to over-reserve. This file
 * proves the database does too. That distinction is the whole point of the design: availability is
 * derived from an append-only movement log precisely so the invariant can be a constraint rather
 * than a convention, and a constraint that has never refused anything is not evidence of anything.
 *
 * Migration 0027 declares four things TypeScript cannot: `CHECK (reserved <= on_hand)` — you cannot
 * hold stock you do not have — the three non-negativity CHECKs beneath it, an append-only trigger on
 * `inventory_movement`, and `CHECK (quantity > 0)` with the direction carried by `kind` rather than
 * by a sign.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PostgresUniversalListingRepository,
  UniversalListingService,
} from '../../modules/universal-listing/index.ts';
import { migrateUp } from '../../platform/db/runner.ts';
import type { Database } from '../../platform/db/client.ts';

import { createRequest, publishRequest } from '../helpers/universal-listing-fixtures.ts';
import { liveTestOptions, rollBackTo, withTestDatabase } from './harness.ts';

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

async function scalar(database: Database, sql: string): Promise<string> {
  const client = await database.connect();
  try {
    const result = await client.query<{ value: string }>(sql);
    return String(result.rows[0]?.value ?? '');
  } finally {
    await client.release();
  }
}

const SNAPSHOT_COLUMNS =
  '(listing_id, version_id, on_hand, reserved, committed, updated_at, correlation_id)';

const MOVEMENT_COLUMNS =
  '(movement_id, listing_id, version_id, kind, quantity, reservation_id, reason, occurred_at, ' +
  'correlation_id, idempotency_key)';

/** Create a listing and publish one version, returning both ids. */
async function seedListing(
  service: UniversalListingService,
  suffix: string,
): Promise<{ listingId: string; versionId: string }> {
  const created = createRequest({ listingId: `lst_live_inv_${suffix}` });
  await service.createListing(created);
  const version = publishRequest(created.listingId, { versionId: `ver_live_inv_${suffix}` });
  await service.publishListing(version);
  return { listingId: created.listingId, versionId: version.versionId };
}

test(
  'receives, reserves, releases and commits end-to-end against the real schema',
  liveTestOptions,
  async () => {
    await withTestDatabase(async ({ database, directory }) => {
      await migrateUp(database, { directory });
      const service = new UniversalListingService(new PostgresUniversalListingRepository(database));
      const { listingId, versionId } = await seedListing(service, 'flow');

      await service.receiveInventory({
        movementId: 'mov_live_inv_recv1',
        listingId,
        versionId,
        quantity: 100n,
        reason: 'first delivery from the estate',
        occurredAt: '2026-06-03T09:00:00Z',
        correlationId: 'corr_live_inv_r1',
        idempotencyKey: 'idem_live_inv_r1',
      });

      await service.reserveInventory({
        movementId: 'mov_live_inv_res1',
        listingId,
        versionId,
        reservationId: 'rsv_live_inv_0001',
        quantity: 30n,
        reason: 'held for a pending order',
        occurredAt: '2026-06-04T09:00:00Z',
        correlationId: 'corr_live_inv_s1',
        idempotencyKey: 'idem_live_inv_s1',
      });

      const held = await service.getAvailability(listingId, versionId);
      assert.deepEqual(held, { onHand: 100n, reserved: 30n, committed: 0n, available: 70n });

      await service.commitInventory({
        movementId: 'mov_live_inv_com1',
        listingId,
        versionId,
        reservationId: 'rsv_live_inv_0001',
        quantity: 30n,
        reason: 'the order was paid',
        occurredAt: '2026-06-05T09:00:00Z',
        correlationId: 'corr_live_inv_c1',
        idempotencyKey: 'idem_live_inv_c1',
      });

      const sold = await service.getAvailability(listingId, versionId);
      assert.deepEqual(
        sold,
        { onHand: 70n, reserved: 0n, committed: 30n, available: 70n },
        'committing takes the stock out of hand and out of the reservation at the same time',
      );

      // The property the movement log exists for: the cached snapshot equals the log, read back from
      // the database rather than from the service that wrote it.
      const derivedOnHand = await scalar(
        database,
        `SELECT COALESCE(SUM(
                CASE kind
                  WHEN 'receive' THEN quantity
                  WHEN 'adjust-up' THEN quantity
                  WHEN 'adjust-down' THEN -quantity
                  WHEN 'commit' THEN -quantity
                  ELSE 0
                END), 0) AS value
         FROM module_universal_listing.inventory_movement
        WHERE listing_id = '${listingId}' AND version_id = '${versionId}';`,
      );
      const storedOnHand = await scalar(
        database,
        `SELECT on_hand AS value FROM module_universal_listing.inventory_snapshot
        WHERE listing_id = '${listingId}' AND version_id = '${versionId}';`,
      );
      assert.equal(
        storedOnHand,
        derivedOnHand,
        'the snapshot is a cache of the movement sum, and a cache that can disagree with its source ' +
          'is a second source',
      );
    });
  },
);

test('the database refuses to hold stock that is not there', liveTestOptions, async () => {
  await withTestDatabase(async ({ database, directory }) => {
    await migrateUp(database, { directory });

    // Written directly, bypassing the service entirely. This is the case the CHECK exists for: a
    // future caller, a repair script, or a replacement implementation that forgets the rule.
    const overReserved = await refuses(
      database,
      `INSERT INTO module_universal_listing.inventory_snapshot ${SNAPSHOT_COLUMNS}
       VALUES ('lst_live_chk_inv1', 'ver_live_chk_inv1', 10, 11, 0, '2026-06-04T09:00:00Z',
               'corr_live_chk_i1');`,
    );
    assert.ok(
      overReserved !== null,
      'reserved 11 against on_hand 10 reached the table; the invariant is a convention, not a rule',
    );
    assert.match(overReserved, /reserved.*on_hand|inventory_snapshot/i);

    for (const [column, values] of [
      ['on_hand', '-1, 0, 0'],
      ['reserved', '5, -1, 0'],
      ['committed', '5, 0, -1'],
    ] as const) {
      const negative = await refuses(
        database,
        `INSERT INTO module_universal_listing.inventory_snapshot ${SNAPSHOT_COLUMNS}
         VALUES ('lst_live_neg_${column}', 'ver_live_neg_${column}', ${values},
                 '2026-06-04T09:00:00Z', 'corr_live_neg_1');`,
      );
      assert.ok(negative !== null, `a negative ${column} reached the table`);
    }
  });
});

test(
  'the database refuses a movement with a zero or negative quantity',
  liveTestOptions,
  async () => {
    await withTestDatabase(async ({ database, directory }) => {
      await migrateUp(database, { directory });

      // Direction is carried by `kind`, the way K-10 carries it by debit/credit. A signed quantity
      // would make a data error indistinguishable from a legitimate movement.
      for (const quantity of ['0', '-5']) {
        const result = await refuses(
          database,
          `INSERT INTO module_universal_listing.inventory_movement ${MOVEMENT_COLUMNS}
         VALUES ('mov_live_qty_${quantity.replace('-', 'n')}', 'lst_live_qty_0001',
                 'ver_live_qty_0001', 'receive', ${quantity}, NULL, 'a reason',
                 '2026-06-03T09:00:00Z', 'corr_live_qty_1', 'idem_live_qty_${quantity.replace('-', 'n')}');`,
        );
        assert.ok(result !== null, `a movement of quantity ${quantity} reached the table`);
      }
    });
  },
);

test('the database refuses to rewrite or delete a movement', liveTestOptions, async () => {
  await withTestDatabase(async ({ database, directory }) => {
    await migrateUp(database, { directory });
    const service = new UniversalListingService(new PostgresUniversalListingRepository(database));
    const { listingId, versionId } = await seedListing(service, 'appd');

    await service.receiveInventory({
      movementId: 'mov_live_app_recv',
      listingId,
      versionId,
      quantity: 25n,
      reason: 'a delivery',
      occurredAt: '2026-06-03T09:00:00Z',
      correlationId: 'corr_live_app_1',
      idempotencyKey: 'idem_live_app_1',
    });

    const update = await refuses(
      database,
      `UPDATE module_universal_listing.inventory_movement SET quantity = 9999
        WHERE movement_id = 'mov_live_app_recv';`,
    );
    assert.ok(update !== null, 'the append-only trigger must refuse an UPDATE');
    assert.match(update, /append-only/i);

    const remove = await refuses(
      database,
      `DELETE FROM module_universal_listing.inventory_movement
        WHERE movement_id = 'mov_live_app_recv';`,
    );
    assert.ok(remove !== null, 'the append-only trigger must refuse a DELETE');
    assert.match(remove, /append-only/i);

    // A log that could be edited would make every derived number unprovable.
    assert.equal(
      await scalar(
        database,
        `SELECT quantity AS value FROM module_universal_listing.inventory_movement
          WHERE movement_id = 'mov_live_app_recv';`,
      ),
      '25',
    );
  });
});

test('the database refuses a movement kind outside the vocabulary', liveTestOptions, async () => {
  await withTestDatabase(async ({ database, directory }) => {
    await migrateUp(database, { directory });

    const result = await refuses(
      database,
      `INSERT INTO module_universal_listing.inventory_movement ${MOVEMENT_COLUMNS}
       VALUES ('mov_live_kind_001', 'lst_live_kind_001', 'ver_live_kind_001', 'shrinkage', 5,
               NULL, 'a reason', '2026-06-03T09:00:00Z', 'corr_live_kind_1', 'idem_live_kind_1');`,
    );
    assert.ok(result !== null, 'an unknown movement kind reached the table');
  });
});

test(
  'a quantity above Number.MAX_SAFE_INTEGER survives the round trip exactly',
  liveTestOptions,
  async () => {
    await withTestDatabase(async ({ database, directory }) => {
      await migrateUp(database, { directory });
      const service = new UniversalListingService(new PostgresUniversalListingRepository(database));
      const { listingId, versionId } = await seedListing(service, 'huge');
      const huge = 9_007_199_254_740_993n;

      await service.receiveInventory({
        movementId: 'mov_live_huge_001',
        listingId,
        versionId,
        quantity: huge,
        reason: 'a very large delivery',
        occurredAt: '2026-06-03T09:00:00Z',
        correlationId: 'corr_live_huge_1',
        idempotencyKey: 'idem_live_huge_1',
      });

      const availability = await service.getAvailability(listingId, versionId);
      assert.equal(
        availability.onHand,
        huge,
        'a quantity a double cannot represent must come back as the bigint that went in',
      );
      assert.equal(typeof availability.available, 'bigint');
    });
  },
);

test(
  'migration 0027 rolls back and leaves the listing tables intact',
  liveTestOptions,
  async () => {
    await withTestDatabase(async ({ database, directory }) => {
      await migrateUp(database, { directory });

      assert.equal(
        await scalar(
          database,
          `SELECT count(*)::text AS value FROM information_schema.tables
          WHERE table_schema = 'module_universal_listing'
            AND table_name IN ('inventory_movement', 'inventory_snapshot');`,
        ),
        '2',
      );

      await rollBackTo(database, directory, '0027');

      assert.equal(
        await scalar(
          database,
          `SELECT count(*)::text AS value FROM information_schema.tables
          WHERE table_schema = 'module_universal_listing'
            AND table_name IN ('inventory_movement', 'inventory_snapshot');`,
        ),
        '0',
        'the inventory tables survived their own rollback',
      );

      // 0027 extends the schema 0026 created, so rolling it back must leave the listing half whole.
      // A rollback that took the schema with it would make the two migrations one unit.
      assert.equal(
        await scalar(
          database,
          `SELECT count(*)::text AS value FROM information_schema.tables
          WHERE table_schema = 'module_universal_listing' AND table_name = 'listing';`,
        ),
        '1',
        'rolling back the inventory half destroyed the listing half',
      );
    });
  },
);
