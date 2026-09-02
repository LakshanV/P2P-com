/**
 * M-48 Supplier & Merchant Directory against a live PostgreSQL server — opt-in, honestly skipped.
 *
 * Migration 0057 declares four things TypeScript cannot, and each is proved here by issuing the
 * offending statement rather than by asserting that the service does not issue it. The service has
 * no path that would try, which is exactly the case a constraint exists for: the defence has to
 * survive somebody adding one.
 *
 *   * **One account, one entry.** A party with two directory rows can be invited twice to one
 *     tender and answer once, and the buyer comparing offers has no way to know they are looking at
 *     the same business.
 *   * **One row per claim.** Declaring `cement` twice would leave a withdrawal able to retire one
 *     row while the other kept the supplier in every search.
 *   * **One primary branch, among the open ones.** "Where do we send this" must have exactly one
 *     answer, and a branch that has shut must not be it. The index is partial for that reason, and
 *     the second half of that rule is tested by closing a primary and opening another.
 *   * **The history cannot be rewritten.** How a party reached its status is what an appeal is
 *     judged against.
 *
 * The suite also covers what no in-memory test structurally can: a daily capacity larger than a
 * double survives the round trip, and the gated search runs as one statement rather than as a scan
 * the application filters afterwards.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DirectoryError,
  DirectoryService,
  InMemoryDirectoryRepository,
  PostgresDirectoryRepository,
  type DirectoryProfile,
} from '../../modules/supplier-directory/index.ts';
import { migrateUp } from '../../platform/db/runner.ts';
import { parseInstant } from '../../platform/time/instant.ts';
import type { Database } from '../../platform/db/client.ts';

import { liveTestOptions, withTestDatabase } from './harness.ts';

const CEMENT = 'acct_live_dircement1';
const FLANGE = 'acct_live_dirflange1';
const SHOP = 'acct_live_dirshop001';

const NOW = '2026-07-01T09:00:00.000000Z';
const MIDDAY = '2026-07-01T12:00:00.000000Z';
const LATER = '2026-07-01T15:30:00.000000Z';

/**
 * Larger than `Number.MAX_SAFE_INTEGER` (9007199254740991) on purpose.
 *
 * A daily capacity this large is implausible; the point is not the plausibility but that anything
 * on the path reading it through a double would round it, and a rounded ceiling is a supplier
 * quietly told they can take more than they said they could.
 */
const HUGE_CAPACITY = 9_007_199_254_740_993n;

function serviceFor(database: Database): DirectoryService {
  return new DirectoryService(new PostgresDirectoryRepository(database));
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

async function rows(database: Database, sql: string): Promise<readonly Record<string, unknown>[]> {
  const client = await database.connect();
  try {
    const result = await client.query<Record<string, unknown>>(sql);
    return result.rows;
  } finally {
    await client.release();
  }
}

interface PartyOptions {
  readonly tag?: string;
  readonly accountId?: string;
  readonly kind?: string;
  readonly displayName?: string;
  readonly categories?: readonly string[];
  readonly districts?: readonly string[];
  readonly activate?: boolean;
}

/** A registered, activated, open party that has declared what it does. */
async function aParty(service: DirectoryService, options: PartyOptions = {}): Promise<string> {
  const tag = options.tag ?? '0001';
  const supplierId = `sup_live_dir${tag}`;

  await service.registerSupplier({
    supplierId,
    accountId: options.accountId ?? CEMENT,
    kind: options.kind ?? 'supplier',
    displayName: options.displayName ?? 'Matale Cement Works',
    registeredAt: NOW,
    correlationId: `corr_live_dir${tag}`,
    idempotencyKey: `idem_live_dir${tag}`,
    eventId: `dev_live_dir${tag}r`,
  });

  if (options.activate !== false) {
    await service.activateSupplier({
      supplierId,
      reason: 'documents checked and the trade licence is current',
      occurredAt: MIDDAY,
      correlationId: `corr_live_dir${tag}a`,
      idempotencyKey: `idem_live_dir${tag}a`,
      eventId: `dev_live_dir${tag}a`,
    });
    // Active and open are separate axes: an active supplier who is full this week is closed for
    // orders without being suspended, and a sourcing query wants the open ones.
    await service.setAvailability({
      supplierId,
      acceptsOrders: true,
      occurredAt: MIDDAY,
      correlationId: `corr_live_dir${tag}v`,
      idempotencyKey: `idem_live_dir${tag}v`,
    });
  }

  let index = 0;
  for (const category of options.categories ?? ['cement']) {
    index += 1;
    await service.declareFacet({
      facetId: `fac_live_dir${tag}c${String(index)}`,
      supplierId,
      kind: 'category',
      value: category,
      declaredAt: MIDDAY,
      correlationId: `corr_live_dir${tag}c${String(index)}`,
      idempotencyKey: `idem_live_dir${tag}c${String(index)}`,
    });
  }

  index = 0;
  for (const district of options.districts ?? []) {
    index += 1;
    await service.declareFacet({
      facetId: `fac_live_dir${tag}d${String(index)}`,
      supplierId,
      kind: 'district',
      value: district,
      declaredAt: MIDDAY,
      correlationId: `corr_live_dir${tag}d${String(index)}`,
      idempotencyKey: `idem_live_dir${tag}d${String(index)}`,
    });
  }

  return supplierId;
}

function names(profiles: readonly DirectoryProfile[]): readonly string[] {
  return profiles.map((profile) => profile.entry.supplierId);
}

// ---------------------------------------------------------------------------
// The round trip
// ---------------------------------------------------------------------------

void test(
  'a directory entry round-trips through PostgreSQL with its capacity exact',
  liveTestOptions,
  async () => {
    await withTestDatabase(async ({ database, directory }) => {
      await migrateUp(database, { directory });
      const service = serviceFor(database);

      const supplierId = await aParty(service, { districts: ['matale'] });

      await service.setAvailability({
        supplierId,
        acceptsOrders: true,
        dailyCapacity: HUGE_CAPACITY,
        occurredAt: LATER,
        correlationId: 'corr_live_diravail',
        idempotencyKey: 'idem_live_diravail',
      });

      const entry = await service.getSupplier(supplierId);
      assert.ok(entry !== null);
      assert.equal(
        entry.dailyCapacity,
        HUGE_CAPACITY,
        'a capacity larger than a double can hold survives the round trip. Anything reading it ' +
          'through Number would round it, and a ceiling rounded on the way out is a supplier told ' +
          'they can take more than they said',
      );
      assert.equal(entry.status, 'active');
      assert.equal(entry.acceptsOrders, true);
      // Compared as instants rather than as text. The projection trims trailing zeros, so
      // `2026-07-01T09:00:00Z` and `2026-07-01T09:00:00.000000Z` are the same moment written two
      // ways, and a string comparison here would fail on a round trip that lost nothing.
      assert.equal(
        parseInstant(entry.registeredAt).epochMicros,
        parseInstant(NOW).epochMicros,
        'the instant survives the timestamptz round trip',
      );

      const profile = await service.getProfile(supplierId);
      assert.ok(profile !== null);
      assert.deepEqual(profile.categories, ['cement']);
      assert.deepEqual(profile.districts, ['matale']);
      assert.deepEqual(profile.brands, []);

      // And the account lookup finds the same row, which is what a registration route calls to
      // discover that the caller already trades.
      const byAccount = await service.getSupplierForAccount(CEMENT);
      assert.equal(byAccount?.supplierId, supplierId);
    });
  },
);

// ---------------------------------------------------------------------------
// One account, one entry
// ---------------------------------------------------------------------------

void test(
  'the database refuses a second directory entry for one account',
  liveTestOptions,
  async () => {
    await withTestDatabase(async ({ database, directory }) => {
      await migrateUp(database, { directory });
      const service = serviceFor(database);

      await aParty(service);

      // The service refuses it first, with a code that says what happened rather than naming a
      // constraint: a caller told "duplicate key" registers again with a new id.
      await assert.rejects(
        aParty(service, { tag: '0002', accountId: CEMENT }),
        (error: unknown) => error instanceof DirectoryError && error.code === 'already-registered',
        'the service refuses a second entry for one account',
      );

      // And a writer going round the service is refused by the database, which is the defence that
      // survives somebody adding such a path.
      const message = await refuses(
        database,
        `INSERT INTO module_supplier_directory.directory_entry
           (supplier_id, account_id, kind, display_name, status, accepts_orders,
            registered_at, updated_at, correlation_id, idempotency_key)
         VALUES ('sup_live_dirsecond', '${CEMENT}', 'supplier', 'The same business again',
                 'pending', false, '${NOW}', '${NOW}',
                 'corr_live_dirsecond', 'idem_live_dirsecond')`,
      );
      assert.ok(message !== null, 'a raw second entry for one account must be refused');
      assert.match(message, /directory_entry_account_unique/);
    });
  },
);

// ---------------------------------------------------------------------------
// One row per claim
// ---------------------------------------------------------------------------

void test('the database refuses the same claim declared twice', liveTestOptions, async () => {
  await withTestDatabase(async ({ database, directory }) => {
    await migrateUp(database, { directory });
    const service = serviceFor(database);

    const supplierId = await aParty(service);

    const message = await refuses(
      database,
      `INSERT INTO module_supplier_directory.supplier_facet
         (facet_id, supplier_id, facet_kind, value, status, declared_at,
          correlation_id, idempotency_key)
       VALUES ('fac_live_dirdouble1', '${supplierId}', 'category', 'cement', 'active',
               '${MIDDAY}', 'corr_live_dirdouble', 'idem_live_dirdouble')`,
    );
    assert.ok(message !== null, 'the same category twice must be refused');
    assert.match(message, /supplier_facet_once_per_value/);

    // Withdrawing moves the row rather than adding one, so the supplier is out of the search and
    // there is no second row left behind to put them back in it.
    await service.withdrawFacet({
      supplierId,
      kind: 'category',
      value: 'cement',
      occurredAt: LATER,
      correlationId: 'corr_live_dirwd',
      idempotencyKey: 'idem_live_dirwd',
    });

    const stored = await rows(
      database,
      `SELECT status FROM module_supplier_directory.supplier_facet
        WHERE supplier_id = '${supplierId}' AND facet_kind = 'category' AND value = 'cement'`,
    );
    assert.equal(stored.length, 1, 'a withdrawal moves the row rather than adding a second one');
    assert.equal(stored[0]?.status, 'withdrawn');

    const found = await service.findSuppliers({ categories: ['cement'] });
    assert.deepEqual(names(found), [], 'a withdrawn category takes the supplier out of the search');
  });
});

// ---------------------------------------------------------------------------
// One primary branch, among the open ones
// ---------------------------------------------------------------------------

void test(
  'a supplier has one primary branch, and closing it frees the slot',
  liveTestOptions,
  async () => {
    await withTestDatabase(async ({ database, directory }) => {
      await migrateUp(database, { directory });
      const service = serviceFor(database);

      const supplierId = await aParty(service);

      await service.addLocation({
        locationId: 'loc_live_dirbranch1',
        supplierId,
        name: 'Matale yard',
        district: 'matale',
        primary: true,
        openedAt: MIDDAY,
        correlationId: 'corr_live_dirbr1',
        idempotencyKey: 'idem_live_dirbr1',
      });

      await assert.rejects(
        service.addLocation({
          locationId: 'loc_live_dirbranch2',
          supplierId,
          name: 'Kandy yard',
          district: 'kandy',
          primary: true,
          openedAt: MIDDAY,
          correlationId: 'corr_live_dirbr2',
          idempotencyKey: 'idem_live_dirbr2',
        }),
        (error: unknown) =>
          error instanceof DirectoryError && error.code === 'primary-location-exists',
        'the service refuses a second primary branch',
      );

      const message = await refuses(
        database,
        `INSERT INTO module_supplier_directory.supplier_location
         (location_id, supplier_id, name, district, is_primary, status, opened_at,
          correlation_id, idempotency_key)
       VALUES ('loc_live_dirbranch3', '${supplierId}', 'Kandy yard', 'kandy', true, 'active',
               '${MIDDAY}', 'corr_live_dirbr3', 'idem_live_dirbr3')`,
      );
      assert.ok(message !== null, 'a raw second primary branch must be refused');
      assert.match(message, /supplier_location_one_primary_idx/);

      // The index is partial, and this is the half of the rule that a full unique index would get
      // wrong: a supplier who shuts their head office and opens another must be able to say which one
      // is now the main branch.
      await service.closeLocation({
        locationId: 'loc_live_dirbranch1',
        occurredAt: LATER,
        correlationId: 'corr_live_dirbr1c',
        idempotencyKey: 'idem_live_dirbr1c',
      });

      await service.addLocation({
        locationId: 'loc_live_dirbranch4',
        supplierId,
        name: 'Kandy yard',
        district: 'kandy',
        primary: true,
        openedAt: LATER,
        correlationId: 'corr_live_dirbr4',
        idempotencyKey: 'idem_live_dirbr4',
      });

      const open = await service.listLocations(supplierId);
      const primaries = open.filter((location) => location.primary && location.status === 'active');
      assert.equal(primaries.length, 1, 'exactly one open branch is primary');
      assert.equal(primaries[0]?.locationId, 'loc_live_dirbranch4');
    });
  },
);

// ---------------------------------------------------------------------------
// The history cannot be rewritten
// ---------------------------------------------------------------------------

void test('the status history is append-only in the database', liveTestOptions, async () => {
  await withTestDatabase(async ({ database, directory }) => {
    await migrateUp(database, { directory });
    const service = serviceFor(database);

    const supplierId = await aParty(service);

    await service.suspendSupplier({
      supplierId,
      reason: 'three deliveries short in one month, pending review',
      occurredAt: LATER,
      correlationId: 'corr_live_dirsusp',
      idempotencyKey: 'idem_live_dirsusp',
      eventId: 'dev_live_dirsusp',
    });

    const updated = await refuses(
      database,
      `UPDATE module_supplier_directory.directory_event
          SET reason = 'an administrative matter'
        WHERE supplier_id = '${supplierId}'`,
    );
    assert.ok(updated !== null, 'rewriting why a supplier was suspended must be refused');
    assert.match(updated, /append-only/);

    const deleted = await refuses(
      database,
      `DELETE FROM module_supplier_directory.directory_event WHERE supplier_id = '${supplierId}'`,
    );
    assert.ok(deleted !== null, 'deleting the history must be refused');
    assert.match(deleted, /append-only/);

    const history = await service.listHistory(supplierId);
    assert.deepEqual(
      history.map((event) => event.toStatus),
      ['pending', 'active', 'suspended'],
      'and the record still reads as the sequence it was',
    );
  });
});

// ---------------------------------------------------------------------------
// A status cycles, and the outbox has to survive that
// ---------------------------------------------------------------------------

void test(
  'reinstating a suspended supplier publishes a second activation',
  liveTestOptions,
  async () => {
    await withTestDatabase(async ({ database, directory }) => {
      await migrateUp(database, { directory });
      const service = serviceFor(database);

      const supplierId = await aParty(service);

      await service.suspendSupplier({
        supplierId,
        reason: 'three deliveries short in one month, pending review',
        occurredAt: LATER,
        correlationId: 'corr_live_dircycs',
        idempotencyKey: 'idem_live_dircycs',
        eventId: 'dev_live_dircycs',
      });

      await service.activateSupplier({
        supplierId,
        reason: 'review closed and the shortfall was the courier',
        occurredAt: '2026-07-02T09:00:00.000000Z',
        correlationId: 'corr_live_dircyca',
        idempotencyKey: 'idem_live_dircyca',
        eventId: 'dev_live_dircyca',
      });

      // Keyed on the transition rather than on the status. Keyed on `supplierId:status`, the second
      // activation would collide on the outbox primary key and the platform would silently stop
      // publishing reinstatements — a supplier back in business that no subscriber is told about.
      const published = await rows(
        database,
        `SELECT payload->>'type' AS type FROM module_supplier_directory.outbox
        WHERE kind = 'event' ORDER BY recorded_at, outbox_id`,
      );
      assert.deepEqual(
        published.map((row) => row.type),
        ['supplier.registered', 'supplier.activated', 'supplier.suspended', 'supplier.activated'],
        'every transition is published, including the second activation',
      );

      const entry = await service.getSupplier(supplierId);
      assert.equal(entry?.status, 'active');
    });
  },
);

// ---------------------------------------------------------------------------
// A code is a code, in the database too
// ---------------------------------------------------------------------------

void test('the database refuses a facet value that is not a code', liveTestOptions, async () => {
  await withTestDatabase(async ({ database, directory }) => {
    await migrateUp(database, { directory });
    const service = serviceFor(database);

    const supplierId = await aParty(service);

    // A telephone number in a category field would travel into every invitation this supplier ever
    // received. The service refuses it, and so does the column.
    await assert.rejects(
      service.declareFacet({
        facetId: 'fac_live_dirphone1',
        supplierId,
        kind: 'category',
        value: '0771234567',
        declaredAt: MIDDAY,
        correlationId: 'corr_live_dirphone',
        idempotencyKey: 'idem_live_dirphone',
      }),
      (error: unknown) => error instanceof DirectoryError,
      'the service refuses a telephone number as a category',
    );

    const message = await refuses(
      database,
      `INSERT INTO module_supplier_directory.supplier_facet
         (facet_id, supplier_id, facet_kind, value, status, declared_at,
          correlation_id, idempotency_key)
       VALUES ('fac_live_dirphone2', '${supplierId}', 'category', '0771234567', 'active',
               '${MIDDAY}', 'corr_live_dirphone2', 'idem_live_dirphone2')`,
    );
    assert.ok(message !== null, 'a raw telephone number as a category must be refused');
    assert.match(message, /supplier_facet_value_is_code/);

    // And an ordinary word still goes in, because the rule exists to keep personal data out rather
    // than to make the product invent padded nonsense for the words it actually uses.
    await service.declareFacet({
      facetId: 'fac_live_dirok0001',
      supplierId,
      kind: 'brand',
      value: 'opc-43',
      declaredAt: MIDDAY,
      correlationId: 'corr_live_dirok',
      idempotencyKey: 'idem_live_dirok',
    });
    const facets = await service.listFacets(supplierId);
    assert.ok(facets.some((facet) => facet.value === 'opc-43'));
  });
});

// ---------------------------------------------------------------------------
// The search, as one statement
// ---------------------------------------------------------------------------

void test('the gated search agrees with the in-memory reference', liveTestOptions, async () => {
  await withTestDatabase(async ({ database, directory }) => {
    await migrateUp(database, { directory });

    const live = serviceFor(database);
    const reference = new DirectoryService(new InMemoryDirectoryRepository());

    // The same four parties in both, built by the same helper so a disagreement is the adapter's.
    for (const service of [live, reference]) {
      await aParty(service, {
        tag: '0001',
        accountId: CEMENT,
        categories: ['cement'],
        districts: ['matale'],
      });
      await aParty(service, {
        tag: '0002',
        accountId: FLANGE,
        displayName: 'Flange and Fitting',
        categories: ['cement', 'steel'],
        districts: [],
      });
      await aParty(service, {
        tag: '0003',
        accountId: SHOP,
        kind: 'merchant',
        displayName: 'Kandy Hardware',
        categories: ['cement'],
        districts: ['kandy'],
      });
      // Registered but never activated: in the directory, and not in the market.
      await aParty(service, {
        tag: '0004',
        accountId: 'acct_live_dirpend001',
        displayName: 'Just signed up',
        activate: false,
        categories: ['cement'],
        districts: ['matale'],
      });
    }

    const cases: readonly Parameters<DirectoryService['findSuppliers']>[0][] = [
      { categories: ['cement'] },
      { categories: ['cement'], districts: ['matale'] },
      { categories: ['cement'], districts: ['kandy'] },
      { categories: ['steel'] },
      { categories: ['cement'], kind: 'merchant' },
      { categories: ['laptops'] },
      { categories: ['cement'], limit: 1 },
    ];

    for (const query of cases) {
      const fromDatabase = await live.findSuppliers(query);
      const fromMemory = await reference.findSuppliers(query);
      assert.deepEqual(
        names(fromDatabase),
        names(fromMemory),
        `the adapter and the reference disagree on ${JSON.stringify(query)}`,
      );
    }

    // The properties those cases are there to hold, stated rather than left implicit.
    const anywhere = await live.findSuppliers({ categories: ['cement'] });
    assert.deepEqual(
      [...names(anywhere)].sort(),
      ['sup_live_dir0001', 'sup_live_dir0002', 'sup_live_dir0003'],
      'a pending party is not in the market',
    );

    const inMatale = await live.findSuppliers({ categories: ['cement'], districts: ['matale'] });
    assert.deepEqual(
      [...names(inMatale)].sort(),
      ['sup_live_dir0001', 'sup_live_dir0002'],
      'a supplier who declared no district is not excluded: declaring nothing means no restriction ' +
        'stated, not serves nowhere, and excluding them would make the honest supplier invisible',
    );

    assert.deepEqual(
      names(await live.findSuppliers({ categories: ['laptops'] })),
      [],
      'a cement supplier is not asked about laptops',
    );

    await assert.rejects(
      live.findSuppliers({ categories: [] }),
      (error: unknown) => error instanceof DirectoryError && error.code === 'ungated-query',
      'an ungated query is the platform commercial map, and it is refused rather than answered',
    );
  });
});

// ---------------------------------------------------------------------------
// Retries, against the real unique indexes
// ---------------------------------------------------------------------------

void test('a retried registration converges against PostgreSQL', liveTestOptions, async () => {
  await withTestDatabase(async ({ database, directory }) => {
    await migrateUp(database, { directory });
    const service = serviceFor(database);

    const request = {
      supplierId: 'sup_live_dirretry1',
      accountId: CEMENT,
      kind: 'supplier',
      displayName: 'Matale Cement Works',
      registeredAt: NOW,
      correlationId: 'corr_live_dirretry1',
      idempotencyKey: 'idem_live_dirretry1',
      eventId: 'dev_live_dirretry1',
    };

    const first = await service.registerSupplier(request);
    assert.equal(first.replayed, false);

    // A retry arrives later and carries a fresh correlation id by definition. Comparing it would
    // report an honest retry as key reuse, and a caller following that advice registers twice.
    const second = await service.registerSupplier({
      ...request,
      correlationId: 'corr_live_dirretry2',
    });
    assert.equal(second.replayed, true, 'a retry converges rather than being refused');
    assert.equal(second.entry.correlationId, 'corr_live_dirretry1', 'and the first row stands');

    const written = await rows(
      database,
      `SELECT count(*)::int AS n FROM module_supplier_directory.directory_entry`,
    );
    assert.equal(written[0]?.n, 1, 'one row, not two');

    // A different registration under the same key is refused rather than converged: answering with
    // the entry that key belongs to would tell a caller they had registered a business they had
    // not.
    await assert.rejects(
      service.registerSupplier({
        ...request,
        supplierId: 'sup_live_dirretry2',
        accountId: FLANGE,
        displayName: 'A different business entirely',
      }),
      (error: unknown) => error instanceof DirectoryError && error.code === 'idempotency-key-reuse',
    );
  });
});
