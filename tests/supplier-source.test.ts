/**
 * The join that fills M-07's two middle rungs, and the four rules it exists to keep.
 *
 *   * **Prior trade is a fact, not a claim.** `findKnownSuppliers` starts from orders this buyer
 *     actually completed. A placed order is a promise and a cancelled one is a disappointment;
 *     counting either would make the strongest signal on the platform the easiest to fake.
 *   * **Category is still a gate here.** A past seller who no longer deals in what this Need is
 *     about is not a candidate, however well the last order went.
 *   * **Verification is M-02's answer, read per call.** The directory has no verification column
 *     and may never have one, so a party the directory lists is not thereby verified.
 *   * **Failing to look is not finding nobody.** A directory that throws must keep throwing, so the
 *     ladder records `lookup-failed` rather than an empty market — the difference between an
 *     outage somebody is paged for and every Need quietly escalating to a tender.
 *
 * The directory half is the real M-48 over its in-memory repository, because the query semantics —
 * the category gate, the permissive district filter, the pending party who is not in the market —
 * are exactly what this adapter depends on and a stub would let them drift.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { supplierDirectoryFor } from '../apps/api/supplier-source.ts';
import type { DirectoryReader } from '../apps/api/supplier-source.ts';
import type { VerificationLevel } from '../modules/capability-verification/index.ts';
import type { SourcingQuery } from '../modules/matching/index.ts';
import type { Order } from '../modules/orders/index.ts';
import {
  DirectoryService,
  InMemoryDirectoryRepository,
} from '../modules/supplier-directory/index.ts';

const BUYER = 'acct_01HR0SRCbuyer001';
const CEMENT_CO = 'acct_01HR0SRCcement01';
const STEEL_CO = 'acct_01HR0SRCsteel001';
const STRANGER = 'acct_01HR0SRCstrange1';

const NOW = '2026-07-01T09:00:00.000000Z';
const EARLIER = '2026-06-01T09:00:00.000000Z';
const LATER = '2026-07-05T09:00:00.000000Z';

interface OrderFacts {
  readonly seller: string;
  readonly status: string;
  readonly at: string;
}

/** Just enough of an order for the one field the adapter reads it for. */
function anOrder(facts: OrderFacts): Order {
  return {
    sellerAccountId: facts.seller,
    status: facts.status,
    updatedAt: facts.at,
  } as unknown as Order;
}

interface HarnessOptions {
  readonly orders?: readonly OrderFacts[];
  readonly levels?: Readonly<Record<string, VerificationLevel>>;
  readonly directoryThrows?: boolean;
}

interface Harness {
  readonly directory: DirectoryService;
  readonly source: ReturnType<typeof supplierDirectoryFor>;
  /** How many times M-02 was asked. A join that asks per candidate is a join that fans out. */
  levelReads: number;
}

function build(options: HarnessOptions = {}): Harness {
  const directory = new DirectoryService(new InMemoryDirectoryRepository());
  const harness: Harness = {
    directory,
    levelReads: 0,
    source: undefined as never,
  };

  const reader: DirectoryReader = options.directoryThrows
    ? {
        getSupplierForAccount: () => {
          throw new Error('the directory is unreachable');
        },
        getProfile: () => {
          throw new Error('the directory is unreachable');
        },
        findSuppliers: () => {
          throw new Error('the directory is unreachable');
        },
      }
    : directory;

  const source = supplierDirectoryFor({
    directory: reader,
    verification: {
      currentLevel: (accountId: string) => {
        harness.levelReads += 1;
        return Promise.resolve(options.levels?.[accountId] ?? 'none');
      },
    },
    orders: {
      listOrdersByBuyer: () =>
        Promise.resolve((options.orders ?? []).map((facts) => anOrder(facts))),
    },
  });

  return Object.assign(harness, { source });
}

interface PartyOptions {
  readonly tag: string;
  readonly accountId: string;
  readonly categories: readonly string[];
  readonly districts?: readonly string[];
  readonly activate?: boolean;
}

async function aParty(directory: DirectoryService, options: PartyOptions): Promise<string> {
  const { tag } = options;
  const supplierId = `sup_01HR0SRC${tag}`;

  await directory.registerSupplier({
    supplierId,
    accountId: options.accountId,
    kind: 'supplier',
    displayName: `Party ${tag}`,
    registeredAt: EARLIER,
    correlationId: `corr_01HR0SRC${tag}`,
    idempotencyKey: `idem_01HR0SRC${tag}`,
    eventId: `dev_01HR0SRC${tag}r`,
  });

  if (options.activate !== false) {
    await directory.activateSupplier({
      supplierId,
      reason: 'documents checked and the trade licence is current',
      occurredAt: EARLIER,
      correlationId: `corr_01HR0SRC${tag}a`,
      idempotencyKey: `idem_01HR0SRC${tag}a`,
      eventId: `dev_01HR0SRC${tag}a`,
    });
    // Active and open are separate axes in M-48: an active supplier who is full this week is closed
    // for orders without being suspended. A sourcing query wants the open ones.
    await directory.setAvailability({
      supplierId,
      acceptsOrders: true,
      occurredAt: EARLIER,
      correlationId: `corr_01HR0SRC${tag}v`,
      idempotencyKey: `idem_01HR0SRC${tag}v`,
    });
  }

  let index = 0;
  for (const category of options.categories) {
    index += 1;
    await directory.declareFacet({
      facetId: `fac_01HR0SRC${tag}c${String(index)}`,
      supplierId,
      kind: 'category',
      value: category,
      declaredAt: EARLIER,
      correlationId: `corr_01HR0SRC${tag}c${String(index)}`,
      idempotencyKey: `idem_01HR0SRC${tag}c${String(index)}`,
    });
  }

  index = 0;
  for (const district of options.districts ?? []) {
    index += 1;
    await directory.declareFacet({
      facetId: `fac_01HR0SRC${tag}d${String(index)}`,
      supplierId,
      kind: 'district',
      value: district,
      declaredAt: EARLIER,
      correlationId: `corr_01HR0SRC${tag}d${String(index)}`,
      idempotencyKey: `idem_01HR0SRC${tag}d${String(index)}`,
    });
  }

  return supplierId;
}

function aQuery(structured: Readonly<Record<string, unknown>>): SourcingQuery {
  return {
    requestId: 'req_01HR0SRCneed0001',
    accountId: BUYER,
    structured,
    confidencePerMille: 800,
    now: NOW,
    correlationId: 'corr_01HR0SRCneed001',
  };
}

// ---------------------------------------------------------------------------
// known: prior trade is a fact
// ---------------------------------------------------------------------------

void test('a known supplier is one this buyer actually completed an order with', async () => {
  const harness = build({
    orders: [
      { seller: CEMENT_CO, status: 'completed', at: EARLIER },
      { seller: CEMENT_CO, status: 'completed', at: LATER },
      // A promise rather than a delivery, and a supplier who was never asked to deliver.
      { seller: STEEL_CO, status: 'placed', at: LATER },
      { seller: STRANGER, status: 'cancelled', at: LATER },
    ],
  });

  await aParty(harness.directory, {
    tag: 'cement01',
    accountId: CEMENT_CO,
    categories: ['cement'],
  });
  await aParty(harness.directory, { tag: 'steel001', accountId: STEEL_CO, categories: ['cement'] });
  await aParty(harness.directory, { tag: 'strange1', accountId: STRANGER, categories: ['cement'] });

  const found = await harness.source.findKnownSuppliers(aQuery({ category: 'cement' }));

  assert.deepEqual(
    found.map((profile) => profile.supplierAccountId),
    [CEMENT_CO],
    'only the supplier who actually delivered is known. A placed order is a promise and a ' +
      'cancelled one is a disappointment; counting either would make the strongest signal on the ' +
      'platform the easiest to fake',
  );
  assert.equal(found[0]?.priorOrdersForBuyer, 2, 'both completed orders count');
  assert.equal(
    found[0]?.lastSuppliedAt,
    LATER,
    'and the most recent one is what recency is scored on. A supplier from 2019 is a stranger',
  );
});

void test('a past seller who no longer deals in this is not a known supplier', async () => {
  const harness = build({ orders: [{ seller: STEEL_CO, status: 'completed', at: EARLIER }] });

  await aParty(harness.directory, { tag: 'steel001', accountId: STEEL_CO, categories: ['steel'] });

  const found = await harness.source.findKnownSuppliers(aQuery({ category: 'cement' }));
  assert.deepEqual(found, [], 'category is a gate at this rung too, not a weight');
});

void test('a past seller who is not in the directory is not a candidate', async () => {
  // They traded once and never registered, or they closed their entry. Either way the platform has
  // nothing current to say about them, and inviting them would be inviting a record rather than a
  // business.
  const harness = build({ orders: [{ seller: STRANGER, status: 'completed', at: EARLIER }] });

  const found = await harness.source.findKnownSuppliers(aQuery({ category: 'cement' }));
  assert.deepEqual(found, []);
});

void test('a buyer with no history has no known suppliers, and the directory is not read', async () => {
  const harness = build({ orders: [] });
  await aParty(harness.directory, {
    tag: 'cement01',
    accountId: CEMENT_CO,
    categories: ['cement'],
  });

  const found = await harness.source.findKnownSuppliers(aQuery({ category: 'cement' }));
  assert.deepEqual(found, [], 'nobody is known to a buyer who has bought nothing');
  assert.equal(harness.levelReads, 0, 'and nothing was asked of M-02 on their behalf');
});

// ---------------------------------------------------------------------------
// verified: the directory lists them, M-02 decides
// ---------------------------------------------------------------------------

void test('a verified supplier is one M-02 verified, not one the directory lists', async () => {
  const harness = build({
    levels: { [CEMENT_CO]: 'standard', [STEEL_CO]: 'basic' },
  });

  await aParty(harness.directory, {
    tag: 'cement01',
    accountId: CEMENT_CO,
    categories: ['cement'],
  });
  await aParty(harness.directory, { tag: 'steel001', accountId: STEEL_CO, categories: ['cement'] });

  const found = await harness.source.findVerifiedSuppliers(aQuery({ category: 'cement' }));

  assert.deepEqual(
    found.map((profile) => profile.supplierAccountId),
    [CEMENT_CO],
    'basic is the level a party reaches by existing; a rung that accepted it would be the known ' +
      'rung with a misleading name',
  );
  assert.equal(found[0]?.verified, true);
  assert.equal(
    found[0]?.reliabilityPerMille,
    null,
    'and there is no delivery record yet. Null is not zero: M-07 scores an unknown record at 600 ' +
      'so a platform with no history stays joinable, and inventing a figure here would be worse ' +
      'than admitting there is none',
  );
});

void test('a pending party is verified and still not in the market', async () => {
  // The two facts are independent, and this is the case that proves it: M-02 has verified them and
  // the directory has not activated them. Sourcing must not reach them.
  const harness = build({ levels: { [CEMENT_CO]: 'full' } });
  await aParty(harness.directory, {
    tag: 'cement01',
    accountId: CEMENT_CO,
    categories: ['cement'],
    activate: false,
  });

  const found = await harness.source.findVerifiedSuppliers(aQuery({ category: 'cement' }));
  assert.deepEqual(found, [], 'registration is not activation, and verification is not either');
});

void test('the verified rung passes the district on, permissively', async () => {
  const harness = build({
    levels: { [CEMENT_CO]: 'standard', [STEEL_CO]: 'standard', [STRANGER]: 'standard' },
  });

  await aParty(harness.directory, {
    tag: 'cement01',
    accountId: CEMENT_CO,
    categories: ['cement'],
    districts: ['matale'],
  });
  await aParty(harness.directory, {
    tag: 'steel001',
    accountId: STEEL_CO,
    categories: ['cement'],
    districts: ['kandy'],
  });
  // Declared no district at all: "no restriction stated", not "serves nowhere".
  await aParty(harness.directory, { tag: 'strange1', accountId: STRANGER, categories: ['cement'] });

  const found = await harness.source.findVerifiedSuppliers(
    aQuery({ category: 'cement', district: 'matale' }),
  );

  assert.deepEqual(
    [...found.map((profile) => profile.supplierAccountId)].sort(),
    [CEMENT_CO, STRANGER].sort(),
    'the supplier who left the field alone is not excluded by it',
  );
});

void test('a Need with no readable category asks the directory for nothing', async () => {
  // M-48 refuses an ungated query, and it is right to: "every supplier on the platform" is the
  // commercial map. The adapter must not hand it one and must not work around the refusal either.
  const harness = build({ levels: { [CEMENT_CO]: 'standard' } });
  await aParty(harness.directory, {
    tag: 'cement01',
    accountId: CEMENT_CO,
    categories: ['cement'],
  });

  const found = await harness.source.findVerifiedSuppliers(aQuery({ quantity: 20 }));
  assert.deepEqual(
    found,
    [],
    'and the rung reports that it looked and found nobody, which is true',
  );
});

void test('the two rungs read the Need the same way M-07 does', async () => {
  // `commodity` is what M-03 produces for a great many Needs, and it is the third of the three
  // spellings M-07's own reader accepts. A separate reading here would gate the directory query on
  // a different set of categories from the one the rung scores against — the rung would return
  // suppliers and then exclude all of them, which from outside looks like an empty market.
  const harness = build({ levels: { [CEMENT_CO]: 'standard' } });
  await aParty(harness.directory, {
    tag: 'cement01',
    accountId: CEMENT_CO,
    categories: ['cement'],
  });

  for (const structured of [
    { category: 'cement' },
    { categories: ['cement'] },
    { commodity: 'CEMENT' },
  ]) {
    const found = await harness.source.findVerifiedSuppliers(aQuery(structured));
    assert.equal(
      found.length,
      1,
      `${JSON.stringify(structured)} must reach the same supplier the rung would score`,
    );
  }
});

// ---------------------------------------------------------------------------
// Failing to look is not finding nobody
// ---------------------------------------------------------------------------

void test('a directory that cannot be read throws rather than answering empty', async () => {
  const harness = build({
    directoryThrows: true,
    orders: [{ seller: CEMENT_CO, status: 'completed', at: EARLIER }],
  });

  await assert.rejects(
    harness.source.findVerifiedSuppliers(aQuery({ category: 'cement' })),
    /unreachable/,
    'M-07 records `lookup-failed` from a throw. Swallowing it would report an absence of ' +
      'suppliers nobody established, and would escalate every Need to a tender the week the ' +
      'database was slow — silently',
  );

  await assert.rejects(
    harness.source.findKnownSuppliers(aQuery({ category: 'cement' })),
    /unreachable/,
  );
});
