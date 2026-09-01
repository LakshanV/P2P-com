/**
 * The catalogue rung: what JAYA can already sell you.
 *
 * The rung that decides whether the platform feels like a shop or a request board. If the cement is
 * on a shelf forty kilometres away, this finds it and the customer never learns an RFQ was possible.
 *
 * Everything here runs against a **real M-04** — real listings, real published versions, real
 * inventory movements — because the questions this rung has to answer are questions only M-04 can
 * answer, and a stub that agreed with the test author would prove nothing about either.
 *
 * The four outcomes the ladder must be able to tell apart:
 *
 *   * a match, good enough to stop the ladder;
 *   * no acceptable match, having genuinely looked;
 *   * the lookup itself failing, which establishes nothing about supply;
 *   * the rung not being wired at all, which is a deployment choice rather than an outage.
 *
 * The third and fourth are covered by the ladder's own suite. This file proves the first two, and
 * the thing between them that matters most: **a tracked listing with no stock is not a match**,
 * however well its title reads.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  InMemoryUniversalListingRepository,
  UniversalListingService,
  type InventoryMode,
} from '../modules/universal-listing/index.ts';
import {
  catalogueRung,
  type CatalogueEntry,
  type SourcingQuery,
} from '../modules/matching/index.ts';

const SUPPLIER = 'acct_01HR0CATsupplr1';
const BUYER = 'acct_01HR0CATbuyer01';
const UNIT_TYPE = 'cut_01HR0CAT000001';
const NOW = '2026-07-01T09:00:00.000000Z';

interface Catalogue {
  readonly listings: UniversalListingService;
  readonly entries: CatalogueEntry[];
  /** Publish a version and, for a tracked one, receive the stock it claims. */
  readonly publish: (options: {
    readonly tag: string;
    readonly title: string;
    readonly description?: string;
    readonly mode: InventoryMode;
    readonly attributes?: Readonly<Record<string, unknown>>;
    readonly stock?: bigint;
  }) => Promise<CatalogueEntry>;
}

function catalogue(): Catalogue {
  const listings = new UniversalListingService(new InMemoryUniversalListingRepository());
  const entries: CatalogueEntry[] = [];

  const publish: Catalogue['publish'] = async (options) => {
    const listingId = `lst_01HR0CAT${options.tag}`;
    const versionId = `ver_01HR0CAT${options.tag}`;

    await listings.createListing({
      listingId,
      accountId: SUPPLIER,
      commerceUnitTypeId: UNIT_TYPE,
      createdAt: NOW,
      updatedAt: NOW,
      correlationId: 'corr_01HR0CATsetup1',
      idempotencyKey: `idem_cat_lst_${options.tag}`,
      recordId: `rec_01HR0CAT${options.tag}`,
    });
    const published = await listings.publishListing({
      versionId,
      listingId,
      title: options.title,
      description: options.description ?? 'Published to exercise the catalogue rung.',
      unitPriceMinor: 25_000n,
      currency: 'LKR',
      quantityAvailable: options.stock ?? 0n,
      inventoryMode: options.mode,
      attributes: options.attributes ?? {},
      publishedAt: NOW,
      correlationId: 'corr_01HR0CATsetup1',
      idempotencyKey: `idem_cat_ver_${options.tag}`,
    });

    if (options.stock !== undefined && options.stock > 0n && options.mode === 'tracked') {
      await listings.receiveInventory({
        movementId: `mov_01HR0CAT${options.tag}`,
        listingId,
        versionId,
        quantity: options.stock,
        reason: 'opening stock',
        occurredAt: NOW,
        correlationId: 'corr_01HR0CATsetup1',
        idempotencyKey: `idem_cat_stk_${options.tag}`,
      });
    }

    const entry: CatalogueEntry = { version: published.version, supplierAccountId: SUPPLIER };
    entries.push(entry);
    return entry;
  };

  return { listings, entries, publish };
}

/** A source that hands the rung everything published, so the rung does the deciding. */
function sourceOver(entries: readonly CatalogueEntry[]): {
  searchVersions: () => Promise<readonly CatalogueEntry[]>;
} {
  return { searchVersions: () => Promise.resolve(entries) };
}

function query(structured: Readonly<Record<string, unknown>>): SourcingQuery {
  return {
    requestId: 'req_01HR0CATneed001',
    accountId: BUYER,
    structured,
    confidencePerMille: 880,
    now: NOW,
    correlationId: 'corr_01HR0CATrun001',
  };
}

// ---------------------------------------------------------------------------
// A match
// ---------------------------------------------------------------------------

test('a stocked listing that sells the thing asked for is a strong match', async () => {
  const shop = catalogue();
  await shop.publish({
    tag: '000001',
    title: 'Ordinary Portland Cement, OPC 43 grade, 50kg bag',
    mode: 'tracked',
    attributes: { grade: 'OPC 43', district: 'Matale' },
    stock: 500n,
  });

  const rung = catalogueRung({ source: sourceOver(shop.entries), listings: shop.listings });
  const found = await rung.find(
    query({ commodity: 'cement', grade: 'OPC 43', district: 'Matale', quantity: 20 }),
  );

  assert.equal(found.length, 1);
  const candidate = found[0];
  assert.ok(candidate !== undefined);
  assert.ok(
    candidate.scorePerMille >= 900,
    `everything asked for was met, so the score should be high; got ${String(candidate.scorePerMille)}`,
  );
  assert.equal(candidate.kind, 'listing');
  assert.equal(
    candidate.versionId,
    'ver_01HR0CAT000001',
    'a listing candidate names the version, because an order pins one',
  );
  assert.match(candidate.explanation, /matches what you asked for/);
  assert.match(candidate.explanation, /listed in matale/i);
  assert.match(candidate.explanation, /500 available, 20 wanted/);
});

test('the explanation names what was checked, not a number', async () => {
  // "score: 0.86" tells the person deciding whether to spend money nothing at all.
  const shop = catalogue();
  await shop.publish({
    tag: '000002',
    title: 'Cement, bulk',
    mode: 'tracked',
    attributes: { grade: 'OPC 53' },
    stock: 100n,
  });

  const rung = catalogueRung({ source: sourceOver(shop.entries), listings: shop.listings });
  const found = await rung.find(query({ commodity: 'cement', grade: 'OPC 43', district: 'Kandy' }));

  const candidate = found[0];
  assert.ok(candidate !== undefined);
  assert.match(candidate.explanation, /checked against grade/);
  assert.match(
    candidate.explanation,
    /not listed in kandy/i,
    'a near miss says what did not match, which is what a customer wants to see',
  );
  assert.equal(candidate.evidence.availableQuantity, '100');
});

test('every word of a multi-word commodity counts, in any order', async () => {
  // "portland cement" matches "Cement, ordinary portland", which a substring test would miss for no
  // good reason.
  const shop = catalogue();
  await shop.publish({
    tag: '000003',
    title: 'Cement, ordinary portland, 50kg',
    mode: 'tracked',
    stock: 40n,
  });

  const rung = catalogueRung({ source: sourceOver(shop.entries), listings: shop.listings });
  const found = await rung.find(query({ commodity: 'portland cement' }));

  assert.equal(found.length, 1);
  assert.match(found[0]?.explanation ?? '', /close match/);
});

// ---------------------------------------------------------------------------
// No acceptable match
// ---------------------------------------------------------------------------

test('a listing selling something else is not a near miss, it is excluded', async () => {
  // A different commodity is not a poor match; it is a different order. Returning it with a low
  // score would put sand in front of somebody who asked for cement.
  const shop = catalogue();
  await shop.publish({ tag: '000004', title: 'River sand, washed', mode: 'tracked', stock: 900n });

  const rung = catalogueRung({ source: sourceOver(shop.entries), listings: shop.listings });
  const found = await rung.find(query({ commodity: 'cement' }));

  assert.deepEqual(
    [...found],
    [],
    'and an empty result is a real answer: the catalogue was searched',
  );
});

test('a tracked listing with no stock is not a match, however well it reads', async () => {
  // The most important exclusion in this file. Offering it produces an order nobody can fulfil,
  // which costs the customer more than seeing nothing would — they wait, and then it fails.
  const shop = catalogue();
  await shop.publish({
    tag: '000005',
    title: 'Ordinary Portland Cement, OPC 43 grade',
    mode: 'tracked',
    attributes: { grade: 'OPC 43', district: 'Matale' },
    stock: 0n,
  });

  const rung = catalogueRung({ source: sourceOver(shop.entries), listings: shop.listings });
  const found = await rung.find(query({ commodity: 'cement', quantity: 20 }));

  assert.deepEqual([...found], []);
});

test('a tracked listing with too little stock is excluded, not scored down', async () => {
  const shop = catalogue();
  await shop.publish({ tag: '000006', title: 'Cement, OPC 43', mode: 'tracked', stock: 5n });

  const rung = catalogueRung({ source: sourceOver(shop.entries), listings: shop.listings });

  assert.deepEqual(
    [...(await rung.find(query({ commodity: 'cement', quantity: 20 })))],
    [],
    'twenty tonnes wanted and five available is not a partial match, it is an unfulfillable order',
  );
  assert.equal(
    (await rung.find(query({ commodity: 'cement', quantity: 5 }))).length,
    1,
    'and exactly five is enough',
  );
});

test('stock already reserved by somebody else is not available to this Need', async () => {
  // Availability is derived from movements, so a hold placed by another order reduces it. A rung
  // reading the version's published `quantityAvailable` instead would offer stock that is spoken for.
  const shop = catalogue();
  const entry = await shop.publish({
    tag: '000007',
    title: 'Cement, OPC 43',
    mode: 'tracked',
    stock: 20n,
  });

  await shop.listings.reserveInventory({
    movementId: 'mov_01HR0CATres0007',
    listingId: entry.version.listingId,
    versionId: entry.version.versionId,
    reservationId: 'rsv_01HR0CATres0007',
    quantity: 18n,
    reason: 'another buyer got there first',
    occurredAt: NOW,
    correlationId: 'corr_01HR0CATsetup1',
    idempotencyKey: 'idem_cat_res_0007',
  });

  const rung = catalogueRung({ source: sourceOver(shop.entries), listings: shop.listings });

  assert.deepEqual(
    [...(await rung.find(query({ commodity: 'cement', quantity: 10 })))],
    [],
    'the version says 20 and two are actually available',
  );
  assert.equal((await rung.find(query({ commodity: 'cement', quantity: 2 }))).length, 1);
});

// ---------------------------------------------------------------------------
// The inventory modes
// ---------------------------------------------------------------------------

test('an offer that holds no JAYA stock by design is matched without an availability check', async () => {
  // A service, a made-to-order part and a digital entitlement. Demanding availability from these
  // would make the platform unable to sell most of what it exists to sell.
  const modes: readonly InventoryMode[] = ['untracked', 'made-to-order', 'digital'];

  for (const [index, mode] of modes.entries()) {
    const shop = catalogue();
    await shop.publish({
      tag: `00001${String(index)}`,
      title: 'Cement delivery and pouring service',
      mode,
      stock: 0n,
    });

    const rung = catalogueRung({ source: sourceOver(shop.entries), listings: shop.listings });
    const found = await rung.find(query({ commodity: 'cement', quantity: 20 }));

    assert.equal(found.length, 1, `${mode} was excluded for holding no stock, which is its design`);
    assert.equal(found[0]?.evidence.availableQuantity, null);
    assert.equal(found[0]?.evidence.inventoryMode, mode);
  }
});

test('each mode explains itself in words rather than by naming the mode', async () => {
  const expected: ReadonlyArray<readonly [InventoryMode, RegExp]> = [
    ['untracked', /a service, so there is no stock to hold/],
    ['made-to-order', /made after the order/],
    ['digital', /digital entitlement/],
    ['external', /supplier-direct stock/],
  ];

  for (const [index, [mode, pattern]] of expected.entries()) {
    const shop = catalogue();
    await shop.publish({ tag: `00002${String(index)}`, title: 'Cement', mode });
    const rung = catalogueRung({ source: sourceOver(shop.entries), listings: shop.listings });
    const found = await rung.find(query({ commodity: 'cement' }));
    assert.match(found[0]?.explanation ?? '', pattern, `${mode} did not explain itself`);
  }
});

test('a supplier-direct listing is scored but capped, and says so', async () => {
  // JAYA does not hold the ledger for external stock, so it cannot promise it the way it promises
  // its own shelf. Capping rather than excluding is the honest middle: it can still win when nothing
  // else comes close, and it loses to an equally good listing the platform can actually see.
  const external = catalogue();
  await external.publish({
    tag: '000030',
    title: 'Ordinary Portland Cement, OPC 43 grade',
    mode: 'external',
    attributes: { grade: 'OPC 43', district: 'Matale' },
  });

  const own = catalogue();
  await own.publish({
    tag: '000031',
    title: 'Ordinary Portland Cement, OPC 43 grade',
    mode: 'tracked',
    attributes: { grade: 'OPC 43', district: 'Matale' },
    stock: 500n,
  });

  const asked = query({ commodity: 'cement', grade: 'OPC 43', district: 'Matale', quantity: 20 });
  const externalFound = await catalogueRung({
    source: sourceOver(external.entries),
    listings: external.listings,
  }).find(asked);
  const ownFound = await catalogueRung({
    source: sourceOver(own.entries),
    listings: own.listings,
  }).find(asked);

  const externalScore = externalFound[0]?.scorePerMille ?? 0;
  const ownScore = ownFound[0]?.scorePerMille ?? 0;

  assert.ok(externalScore > 0, 'it is a real offer and must still be findable');
  assert.ok(
    externalScore < ownScore,
    'an identical listing whose stock JAYA can see must win, or the cap does nothing',
  );
  assert.equal(externalFound[0]?.evidence.externalCeilingApplied, true);
  assert.match(externalFound[0]?.explanation ?? '', /this supplier holds the stock/);
});

// ---------------------------------------------------------------------------
// Failing to look
// ---------------------------------------------------------------------------

test('a catalogue that cannot be searched throws rather than returning nothing', async () => {
  // The distinction the whole ladder rests on. Catching this and returning `[]` would report an
  // absence of supply that nobody established, and every Need would escalate for a reason that has
  // nothing to do with supply.
  const shop = catalogue();
  const rung = catalogueRung({
    source: {
      searchVersions: () => Promise.reject(new Error('the search index is rebuilding')),
    },
    listings: shop.listings,
  });

  await assert.rejects(rung.find(query({ commodity: 'cement' })), /search index is rebuilding/);
});

test('an availability lookup that fails is not an absence of stock either', async () => {
  const shop = catalogue();
  await shop.publish({ tag: '000040', title: 'Cement, OPC 43', mode: 'tracked', stock: 50n });

  const rung = catalogueRung({
    source: sourceOver(shop.entries),
    listings: {
      getAvailability: () => Promise.reject(new Error('the inventory snapshot is unreadable')),
    },
  });

  await assert.rejects(
    rung.find(query({ commodity: 'cement', quantity: 20 })),
    /inventory snapshot is unreadable/,
  );
});

// ---------------------------------------------------------------------------
// What the rung is given
// ---------------------------------------------------------------------------

test('the rung never sees the words, only the reading', async () => {
  // A rung may talk to an external supplier. The raw text is a sentence a customer wrote, is exempt
  // from the identifier rules, and may hold their telephone number.
  const shop = catalogue();
  let seen: SourcingQuery | null = null;
  const rung = catalogueRung({
    source: {
      searchVersions: (asked: SourcingQuery) => {
        seen = asked;
        return Promise.resolve([]);
      },
    },
    listings: shop.listings,
  });

  await rung.find(query({ commodity: 'cement' }));

  assert.ok(seen !== null);
  assert.ok(!('rawText' in (seen as SourcingQuery)));
  assert.deepEqual(Object.keys(seen as SourcingQuery).sort(), [
    'accountId',
    'confidencePerMille',
    'correlationId',
    'now',
    'requestId',
    'structured',
  ]);
});

test('a Need whose reading found no commodity still matches, rather than escalating on our failure', async () => {
  // The reading is poor, not the listing. Penalising every listing equally would mean the rung finds
  // nothing and the Need escalates for a reason that is ours rather than the market's.
  const shop = catalogue();
  await shop.publish({ tag: '000050', title: 'Cement, OPC 43', mode: 'tracked', stock: 50n });

  const rung = catalogueRung({ source: sourceOver(shop.entries), listings: shop.listings });
  const found = await rung.find(query({ quantity: 10 }));

  assert.equal(found.length, 1);
});
