/**
 * M-04 Universal Listing against a live PostgreSQL server — opt-in, and honestly skipped otherwise.
 *
 * Migration 0026 declares what TypeScript cannot: `UNIQUE (listing_id, version_number)` making the
 * pair an order pins a permanent address, append-only triggers on all three history tables, CHECKs
 * tying the status to the version counter and the withdrawal instant, `bigint` money columns with no
 * floating-point type anywhere, and the opacity rule on `listing_media.reference`.
 *
 * Each is proved by issuing the offending statement, not by asserting that the service does not.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PostgresUniversalListingRepository,
  UniversalListingService,
} from '../../modules/universal-listing/index.ts';
import { migrateUp } from '../../platform/db/runner.ts';
import type { Database } from '../../platform/db/client.ts';

import {
  ACCOUNT,
  UNIT_TYPE,
  createRequest,
  declarationRequest,
  mediaRequest,
  publishRequest,
  withdrawRequest,
} from '../helpers/universal-listing-fixtures.ts';
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

const LISTING_COLUMNS =
  '(listing_id, account_id, commerce_unit_type_id, status, current_version, created_at, ' +
  'updated_at, published_at, withdrawn_at, correlation_id, idempotency_key)';

const VERSION_COLUMNS =
  '(version_id, listing_id, version_number, title, description, unit_price_minor, currency, ' +
  'quantity_available, attributes, published_at, correlation_id, idempotency_key)';

const MEDIA_COLUMNS =
  '(media_id, listing_id, version_id, kind, reference, position, caption, added_at, ' +
  'correlation_id, idempotency_key)';

function draftListingValues(listingId: string, suffix: string): string {
  return (
    `('${listingId}', '${ACCOUNT}', '${UNIT_TYPE}', 'draft', 0, '2026-06-01T09:00:00Z', ` +
    `'2026-06-01T09:00:00Z', NULL, NULL, 'corr_live_${suffix}', 'idem_live_${suffix}')`
  );
}

function versionValues(
  versionId: string,
  listingId: string,
  versionNumber: number,
  suffix: string,
): string {
  return (
    `('${versionId}', '${listingId}', ${versionNumber}, 'A title', 'A description', 1000, ` +
    `'LKR', 5, '{}', '2026-06-02T09:00:00Z', 'corr_live_${suffix}', 'idem_live_${suffix}')`
  );
}

test(
  'creates, publishes twice, annotates and withdraws end-to-end against the real schema',
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

      const service = new UniversalListingService(new PostgresUniversalListingRepository(database));

      const created = createRequest();
      await service.createListing(created);

      const first = publishRequest(created.listingId, {
        title: 'The agreement',
        unitPriceMinor: 9_007_199_254_740_993n,
      });
      const published = await service.publishListing(first);
      assert.equal(published.version.versionNumber, 1);
      assert.equal(
        published.version.unitPriceMinor,
        9_007_199_254_740_993n,
        'a bigint above MAX_SAFE_INTEGER round-trips through PostgreSQL exactly; a double would ' +
          'have rounded it, and the price would be wrong by one minor unit forever',
      );
      assert.equal(
        published.version.publishedAt,
        first.publishedAt,
        'an instant projected through to_char comes back as the string that went in',
      );

      await service.addMedia(mediaRequest(created.listingId, first.versionId, { position: 0 }));
      await service.addDeclaration(declarationRequest(created.listingId, first.versionId));

      const second = publishRequest(created.listingId, { title: 'Something else' });
      await service.publishListing(second);

      // The property the whole module exists for, read back from a real database.
      const pinned = await service.getVersion(first.versionId);
      assert.equal(pinned?.title, 'The agreement');
      assert.equal(pinned?.versionNumber, 1);

      await service.withdrawListing(withdrawRequest(created.listingId));

      assert.equal(await count(database, 'module_universal_listing.listing'), 1);
      assert.equal(await count(database, 'module_universal_listing.listing_version'), 2);
      assert.equal(await count(database, 'module_universal_listing.listing_media'), 1);
      assert.equal(await count(database, 'module_universal_listing.listing_declaration'), 1);
      assert.equal(
        await count(database, 'module_universal_listing.outbox'),
        8,
        'four facts — created, published, published, withdrawn — each emitting an event and an ' +
          'audit record; a reused outbox id would have been refused by outbox_pkey instead',
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

test('the database refuses a second version with the same number', liveTestOptions, async () => {
  await withTestDatabase(async ({ database, directory }) => {
    await migrateUp(database, { directory });

    const client = await database.connect();
    try {
      await client.query(
        `INSERT INTO module_universal_listing.listing ${LISTING_COLUMNS}
         VALUES ${draftListingValues('lst_live_ver_001', 'ver_l001')};`,
      );
      await client.query(
        `INSERT INTO module_universal_listing.listing_version ${VERSION_COLUMNS}
         VALUES ${versionValues('ver_live_num_001', 'lst_live_ver_001', 1, 'ver_v001')};`,
      );
    } finally {
      await client.release();
    }

    const duplicate = await refuses(
      database,
      `INSERT INTO module_universal_listing.listing_version ${VERSION_COLUMNS}
       VALUES ${versionValues('ver_live_num_002', 'lst_live_ver_001', 1, 'ver_v002')};`,
    );
    assert.ok(
      duplicate !== null,
      'a second version 1 would make "listing L, version 1" ambiguous, and every order that ' +
        'pinned it would stop identifying one set of terms',
    );
    assert.match(duplicate, /listing_version_number_unique|unique/i);

    // A different listing may of course have its own version 1.
    const other = await refuses(
      database,
      `INSERT INTO module_universal_listing.listing ${LISTING_COLUMNS}
       VALUES ${draftListingValues('lst_live_ver_002', 'ver_l002')};`,
    );
    assert.equal(other, null);
  });
});

test(
  'the database refuses a status that disagrees with the version counter',
  liveTestOptions,
  async () => {
    await withTestDatabase(async ({ database, directory }) => {
      await migrateUp(database, { directory });

      const draftWithVersion = await refuses(
        database,
        `INSERT INTO module_universal_listing.listing ${LISTING_COLUMNS}
       VALUES ('lst_live_chk_001', '${ACCOUNT}', '${UNIT_TYPE}', 'draft', 3,
               '2026-06-01T09:00:00Z', '2026-06-01T09:00:00Z', '2026-06-02T09:00:00Z', NULL,
               'corr_live_chk001', 'idem_live_chk001');`,
      );
      assert.ok(draftWithVersion !== null, 'a draft that has published three versions');
      assert.match(draftWithVersion, /draft_has_no_version/);

      const publishedWithoutInstant = await refuses(
        database,
        `INSERT INTO module_universal_listing.listing ${LISTING_COLUMNS}
       VALUES ('lst_live_chk_002', '${ACCOUNT}', '${UNIT_TYPE}', 'published', 1,
               '2026-06-01T09:00:00Z', '2026-06-01T09:00:00Z', NULL, NULL,
               'corr_live_chk002', 'idem_live_chk002');`,
      );
      assert.ok(publishedWithoutInstant !== null, 'a published listing that was never published');
      assert.match(publishedWithoutInstant, /published_at_matches_version/);

      const withdrawnWithoutInstant = await refuses(
        database,
        `INSERT INTO module_universal_listing.listing ${LISTING_COLUMNS}
       VALUES ('lst_live_chk_003', '${ACCOUNT}', '${UNIT_TYPE}', 'withdrawn', 1,
               '2026-06-01T09:00:00Z', '2026-06-01T09:00:00Z', '2026-06-02T09:00:00Z', NULL,
               'corr_live_chk003', 'idem_live_chk003');`,
      );
      assert.ok(withdrawnWithoutInstant !== null, 'a withdrawn listing with no withdrawal instant');
      assert.match(withdrawnWithoutInstant, /withdrawn_at_matches_status/);
    });
  },
);

test(
  'the database refuses a negative price and a malformed currency',
  liveTestOptions,
  async () => {
    await withTestDatabase(async ({ database, directory }) => {
      await migrateUp(database, { directory });

      const client = await database.connect();
      try {
        await client.query(
          `INSERT INTO module_universal_listing.listing ${LISTING_COLUMNS}
         VALUES ${draftListingValues('lst_live_money_01', 'money_l01')};`,
        );
      } finally {
        await client.release();
      }

      const negative = await refuses(
        database,
        `INSERT INTO module_universal_listing.listing_version ${VERSION_COLUMNS}
       VALUES ('ver_live_money_01', 'lst_live_money_01', 1, 'A title', 'A description', -1,
               'LKR', 5, '{}', '2026-06-02T09:00:00Z', 'corr_live_m01', 'idem_live_m01');`,
      );
      assert.ok(negative !== null, 'a negative price is not a discount');
      assert.match(negative, /unit_price_non_negative/);

      const currency = await refuses(
        database,
        `INSERT INTO module_universal_listing.listing_version ${VERSION_COLUMNS}
       VALUES ('ver_live_money_02', 'lst_live_money_01', 2, 'A title', 'A description', 1000,
               'lkr', 5, '{}', '2026-06-02T09:00:00Z', 'corr_live_m02', 'idem_live_m02');`,
      );
      assert.ok(currency !== null, 'a lowercase currency is not ISO-4217');
      assert.match(currency, /currency_well_formed/);
    });
  },
);

test(
  'the database refuses a URL or a natural key as a media reference',
  liveTestOptions,
  async () => {
    await withTestDatabase(async ({ database, directory }) => {
      await migrateUp(database, { directory });

      const client = await database.connect();
      try {
        await client.query(
          `INSERT INTO module_universal_listing.listing ${LISTING_COLUMNS}
         VALUES ${draftListingValues('lst_live_ref_001', 'ref_l001')};`,
        );
        await client.query(
          `INSERT INTO module_universal_listing.listing_version ${VERSION_COLUMNS}
         VALUES ${versionValues('ver_live_ref_001', 'lst_live_ref_001', 1, 'ref_v001')};`,
        );
      } finally {
        await client.release();
      }

      const forbidden: readonly string[] = [
        'https://cdn.example.com/photo.jpg',
        'seller@example.com',
        'N1234567890123',
        'api_key_9f2b7c1d4e',
      ];

      for (const [index, reference] of forbidden.entries()) {
        const result = await refuses(
          database,
          `INSERT INTO module_universal_listing.listing_media ${MEDIA_COLUMNS}
         VALUES ('med_live_ref_00${index}', 'lst_live_ref_001', 'ver_live_ref_001', 'image',
                 '${reference}', ${index}, 'A caption', '2026-06-02T10:00:00Z',
                 'corr_live_ref_00${index}', 'idem_live_ref_00${index}');`,
        );
        assert.ok(
          result !== null,
          `"${reference}" reached the media table; a listing outlives its media, and this column ` +
            'holds a handle to an artefact, never the artefact and never a URL to it',
        );
        assert.match(result, /media_reference_opaque/);
      }
    });
  },
);

test(
  'the database refuses to rewrite or delete a version, media or declaration',
  liveTestOptions,
  async () => {
    await withTestDatabase(async ({ database, directory }) => {
      await migrateUp(database, { directory });
      const service = new UniversalListingService(new PostgresUniversalListingRepository(database));

      const created = createRequest({ listingId: 'lst_live_app_001' });
      await service.createListing(created);
      const version = publishRequest(created.listingId);
      await service.publishListing(version);
      await service.addMedia(mediaRequest(created.listingId, version.versionId));
      await service.addDeclaration(declarationRequest(created.listingId, version.versionId));

      const targets: readonly (readonly [string, string, string])[] = [
        ['listing_version', 'title', `version_id = '${version.versionId}'`],
        ['listing_media', 'caption', `version_id = '${version.versionId}'`],
        ['listing_declaration', 'statement', `version_id = '${version.versionId}'`],
      ];

      for (const [table, column, where] of targets) {
        const update = await refuses(
          database,
          `UPDATE module_universal_listing.${table} SET ${column} = 'rewritten' WHERE ${where};`,
        );
        assert.ok(update !== null, `the append-only trigger must refuse an UPDATE on ${table}`);
        assert.match(update, /append-only/i);

        const remove = await refuses(
          database,
          `DELETE FROM module_universal_listing.${table} WHERE ${where};`,
        );
        assert.ok(remove !== null, `the append-only trigger must refuse a DELETE on ${table}`);
        assert.match(remove, /append-only/i);
      }

      assert.equal(await count(database, 'module_universal_listing.listing_version'), 1);
      assert.equal(await count(database, 'module_universal_listing.listing_media'), 1);
      assert.equal(await count(database, 'module_universal_listing.listing_declaration'), 1);
    });
  },
);

test('migration 0026 rolls back and leaves no trace of the schema', liveTestOptions, async () => {
  await withTestDatabase(async ({ database, directory }) => {
    await migrateUp(database, { directory });

    const present = await database.connect();
    try {
      const rows = await present.query<{ count: string }>(
        `SELECT count(*) AS count FROM information_schema.schemata
          WHERE schema_name = 'module_universal_listing';`,
      );
      assert.equal(Number(rows.rows[0]?.count ?? 0), 1);
    } finally {
      await present.release();
    }

    await rollBackTo(database, directory, '0026');

    const after = await database.connect();
    try {
      const rows = await after.query<{ count: string }>(
        `SELECT count(*) AS count FROM information_schema.schemata
          WHERE schema_name = 'module_universal_listing';`,
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
