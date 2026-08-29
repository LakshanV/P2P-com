/**
 * M-04 Universal Listing — service behaviour, slice A.
 *
 * The module's central claim is that **a listing is versioned, never edited**. An order placed in
 * March is against version 3, and publishing version 4 in June must not change what version 3 said,
 * because version 3 is the agreement. Most of what follows is that claim, tested from several
 * directions: version numbering, immutability, and the fact that no operation exists which edits a
 * published version.
 *
 * The second half is the refusals — money that is not an exact integer, a currency that is not
 * ISO-4217, and a media reference that is the artefact rather than a handle to it.
 *
 * Live-PostgreSQL properties are in `tests/integration/universal-listing.integration.ts`, because a
 * constraint that has never refused anything is not evidence of anything.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { stripNoise } from '../platform/db/migrations.ts';

import {
  DECLARATION_KINDS,
  FOREIGN_FIELDS,
  LISTING_STATUSES,
  MEDIA_KINDS,
  UniversalListingError,
} from '../modules/universal-listing/index.ts';

import {
  ACCOUNT,
  UNIT_TYPE,
  build,
  createRequest,
  declarationRequest,
  entriesOfKind,
  eventTypes,
  lastEventPayload,
  mediaRequest,
  publishRequest,
  suspendRequest,
  withdrawRequest,
} from './helpers/universal-listing-fixtures.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODULE_DIR = path.join(REPO_ROOT, 'modules', 'universal-listing');

/** The refusal code, or a rethrow when it is not one of M-04's. */
const codeOf = async (body: () => Promise<unknown>): Promise<string> => {
  try {
    await body();
  } catch (error) {
    if (error instanceof UniversalListingError) return error.code;
    throw error;
  }
  throw new Error('expected a refusal, and the call succeeded');
};

/** Create a listing and return its id. */
async function newListing(
  harness: ReturnType<typeof build>,
  overrides: Parameters<typeof createRequest>[0] = {},
): Promise<string> {
  const request = createRequest(overrides);
  await harness.service.createListing(request);
  return request.listingId;
}

/** Create and publish, returning both ids. */
async function published(
  harness: ReturnType<typeof build>,
): Promise<{ listingId: string; versionId: string }> {
  const listingId = await newListing(harness);
  const request = publishRequest(listingId);
  await harness.service.publishListing(request);
  return { listingId, versionId: request.versionId };
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

test('a new listing is a draft that has published nothing', async () => {
  const harness = build();
  const request = createRequest();

  const result = await harness.service.createListing(request);

  assert.equal(result.replayed, false);
  assert.equal(result.listing.status, 'draft');
  assert.equal(result.listing.currentVersion, 0);
  assert.equal(result.listing.publishedAt, null);
  assert.equal(result.listing.withdrawnAt, null);
  assert.equal(result.listing.accountId, ACCOUNT);
  assert.equal(result.listing.commerceUnitTypeId, UNIT_TYPE);

  assert.deepEqual(eventTypes(harness.repository), ['listing.created']);
  assert.equal(entriesOfKind(harness.repository, 'audit').length, 1);
  assert.deepEqual(lastEventPayload(harness.repository), {
    listing_id: request.listingId,
    account_id: ACCOUNT,
    commerce_unit_type_id: UNIT_TYPE,
    created_at: request.createdAt,
    idempotency_key: request.idempotencyKey,
  });
});

test('a replay with the same key and the same content changes nothing', async () => {
  const harness = build();
  const request = createRequest();

  const first = await harness.service.createListing(request);
  const second = await harness.service.createListing(request);

  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.deepEqual(second.listing, first.listing);
  assert.equal(harness.repository.listings().length, 1);
  assert.equal(entriesOfKind(harness.repository, 'event').length, 1);
});

test('the same listing id with different content is refused', async () => {
  const harness = build();
  const request = createRequest();
  await harness.service.createListing(request);

  const code = await codeOf(() =>
    harness.service.createListing({
      ...request,
      accountId: 'acct_01HQZXB0002',
      idempotencyKey: 'idem_create_other',
    }),
  );
  assert.match(code, /listing-already-exists|duplicate-listing-id/);
});

// ---------------------------------------------------------------------------
// Publishing, and the version chain
// ---------------------------------------------------------------------------

test('publishing appends version 1 and moves the listing out of draft', async () => {
  const harness = build();
  const listingId = await newListing(harness);
  const request = publishRequest(listingId);

  const result = await harness.service.publishListing(request);

  assert.equal(result.replayed, false);
  assert.equal(result.listing.status, 'published');
  assert.equal(result.listing.currentVersion, 1);
  assert.equal(result.listing.publishedAt, request.publishedAt);
  assert.equal(result.version.versionNumber, 1);
  assert.equal(result.version.unitPriceMinor, 249_500n);
  assert.equal(result.version.currency, 'LKR');
  assert.equal(result.version.quantityAvailable, 40n);

  assert.deepEqual(eventTypes(harness.repository), ['listing.created', 'listing.published']);

  // A bigint does not survive JSON, so the event carries the amounts as strings. A consumer that
  // parsed a number here would lose precision on anything above 2^53 minor units.
  const payload = lastEventPayload(harness.repository);
  assert.equal(payload.unit_price_minor, '249500');
  assert.equal(payload.quantity_available, '40');
  assert.equal(payload.version_number, 1);
});

test('republishing appends a new version and never edits the old one', async () => {
  const harness = build();
  const listingId = await newListing(harness);
  const first = publishRequest(listingId, { title: 'First title', unitPriceMinor: 100n });
  await harness.service.publishListing(first);

  const second = publishRequest(listingId, {
    title: 'Second title',
    unitPriceMinor: 200n,
    publishedAt: '2026-06-10T09:00:00Z',
  });
  const result = await harness.service.publishListing(second);

  assert.equal(result.listing.currentVersion, 2);
  assert.equal(result.version.versionNumber, 2);

  const versions = await harness.service.listVersions(listingId);
  assert.equal(versions.length, 2);
  assert.deepEqual(
    versions.map((version) => [version.versionNumber, version.title, version.unitPriceMinor]),
    [
      [1, 'First title', 100n],
      [2, 'Second title', 200n],
    ],
    'version 1 still says what version 1 said; that is the whole point of the module',
  );

  // publishedAt is the instant of the FIRST publication and does not move.
  assert.equal(result.listing.publishedAt, first.publishedAt);
});

test('a version stays readable by its own id after the listing moves on', async () => {
  const harness = build();
  const listingId = await newListing(harness);
  const first = publishRequest(listingId, { title: 'The agreement' });
  await harness.service.publishListing(first);
  await harness.service.publishListing(publishRequest(listingId, { title: 'Something else' }));

  // This is what an order does: it pinned a version id in March and reads it in September.
  const pinned = await harness.service.getVersion(first.versionId);
  assert.equal(pinned?.title, 'The agreement');
  assert.equal(pinned?.versionNumber, 1);
});

test('the service exposes no operation that edits a published version', () => {
  const surface = Object.getOwnPropertyNames(
    Object.getPrototypeOf(build().service) as object,
  ).filter((name) => name !== 'constructor');

  const mutating = surface.filter((name) =>
    /^(update|edit|amend|revise|patch|set|delete|remove)/i.test(name),
  );
  assert.deepEqual(
    mutating,
    [],
    `the public surface is ${surface.join(', ')}; a version is replaced by a new version, and an ` +
      'operation that edits one would make every order that pinned it wrong',
  );
});

test('publishing an unknown listing is refused', async () => {
  const harness = build();
  assert.equal(
    await codeOf(() => harness.service.publishListing(publishRequest('lst_01HQZXZ0404'))),
    'listing-not-found',
  );
});

// ---------------------------------------------------------------------------
// Media and declarations
// ---------------------------------------------------------------------------

test('media and declarations attach to a version and are read back by it', async () => {
  const harness = build();
  const { listingId, versionId } = await published(harness);

  await harness.service.addMedia(mediaRequest(listingId, versionId, { position: 0 }));
  await harness.service.addMedia(
    mediaRequest(listingId, versionId, { position: 1, kind: 'document' }),
  );
  await harness.service.addDeclaration(
    declarationRequest(listingId, versionId, { kind: 'origin' }),
  );

  const media = await harness.service.listMedia(versionId);
  assert.equal(media.length, 2);
  assert.deepEqual(
    media.map((item) => item.position),
    [0, 1],
    'media is ordered by position so a gallery renders the same way twice',
  );

  const declarations = await harness.service.listDeclarations(versionId);
  assert.equal(declarations.length, 1);
  assert.equal(declarations[0]?.kind, 'origin');
});

test('every media kind and declaration kind in the vocabulary is accepted', async () => {
  const harness = build();
  const { listingId, versionId } = await published(harness);

  let position = 0;
  for (const kind of MEDIA_KINDS) {
    await harness.service.addMedia(mediaRequest(listingId, versionId, { kind, position }));
    position += 1;
  }
  for (const kind of DECLARATION_KINDS) {
    await harness.service.addDeclaration(declarationRequest(listingId, versionId, { kind }));
  }

  assert.equal((await harness.service.listMedia(versionId)).length, MEDIA_KINDS.length);
  assert.equal(
    (await harness.service.listDeclarations(versionId)).length,
    DECLARATION_KINDS.length,
  );
});

test('media may not be attached to a superseded version', async () => {
  const harness = build();
  const listingId = await newListing(harness);
  const first = publishRequest(listingId);
  await harness.service.publishListing(first);
  await harness.service.publishListing(publishRequest(listingId));

  const code = await codeOf(() =>
    harness.service.addMedia(mediaRequest(listingId, first.versionId)),
  );
  assert.equal(
    code,
    'version-not-current',
    'a photograph added to last season’s version would show against terms nobody is offering',
  );
});

test('media and declarations against an unknown version are refused', async () => {
  const harness = build();
  const { listingId } = await published(harness);

  assert.equal(
    await codeOf(() => harness.service.addMedia(mediaRequest(listingId, 'ver_01HQZXZ0404'))),
    'version-not-found',
  );
  assert.equal(
    await codeOf(() =>
      harness.service.addDeclaration(declarationRequest(listingId, 'ver_01HQZXZ0404')),
    ),
    'version-not-found',
  );
});

// ---------------------------------------------------------------------------
// A media reference is a handle, never the artefact
// ---------------------------------------------------------------------------

test('a media reference that is the artefact, a URL or a natural key is refused', async () => {
  const harness = build();
  const { listingId, versionId } = await published(harness);

  const refused: readonly string[] = [
    'https://cdn.example.com/photo.jpg',
    'seller@example.com',
    'N1234567890123',
    'api_key_9f2b7c1d4e',
    'short',
  ];

  for (const reference of refused) {
    const code = await codeOf(() =>
      harness.service.addMedia(mediaRequest(listingId, versionId, { reference })),
    );
    assert.ok(
      [
        'malformed-reference',
        'malformed-identifier',
        'natural-identifier',
        'secret-bearing-input',
      ].includes(code),
      `"${reference}" was accepted as a media reference with code ${code}; a listing outlives its ` +
        'media, and this column holds a handle to an artefact, never the artefact',
    );
  }

  assert.deepEqual(await harness.service.listMedia(versionId), []);
});

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

test('a price is an exact integer in minor units, and a fractional one is refused', async () => {
  const harness = build();
  const listingId = await newListing(harness);

  assert.equal(
    await codeOf(() =>
      harness.service.publishListing(
        publishRequest(listingId, { unitPriceMinor: 12.5 as unknown as bigint }),
      ),
    ),
    'negative-amount',
    'a price with a fraction of a minor unit is not a price this platform can settle',
  );

  assert.equal(
    await codeOf(() =>
      harness.service.publishListing(publishRequest(listingId, { unitPriceMinor: -1n })),
    ),
    'negative-amount',
  );

  assert.equal(
    await codeOf(() =>
      harness.service.publishListing(publishRequest(listingId, { quantityAvailable: -1n })),
    ),
    'negative-quantity',
  );
});

test('a price above Number.MAX_SAFE_INTEGER survives exactly', async () => {
  const harness = build();
  const listingId = await newListing(harness);
  const huge = 9_007_199_254_740_993n; // MAX_SAFE_INTEGER + 2, which a double cannot represent

  const result = await harness.service.publishListing(
    publishRequest(listingId, { unitPriceMinor: huge }),
  );

  assert.equal(result.version.unitPriceMinor, huge);
  assert.equal(
    lastEventPayload(harness.repository).unit_price_minor,
    '9007199254740993',
    'the event carries the exact value as text; a number here would have rounded it',
  );
});

test('a currency that is not ISO-4217 is refused', async () => {
  const harness = build();
  const listingId = await newListing(harness);

  for (const currency of ['', 'lkr', 'LKRR', 'L K', '123']) {
    assert.equal(
      await codeOf(() => harness.service.publishListing(publishRequest(listingId, { currency }))),
      'malformed-currency',
      `"${currency}" should be refused as a currency`,
    );
  }
});

// ---------------------------------------------------------------------------
// Suspension and withdrawal
// ---------------------------------------------------------------------------

test('suspending stops the offer without destroying its versions', async () => {
  const harness = build();
  const { listingId, versionId } = await published(harness);

  const result = await harness.service.suspendListing(suspendRequest(listingId));

  assert.equal(result.listing.status, 'suspended');
  assert.equal(result.listing.currentVersion, 1, 'the version chain is untouched');
  assert.notEqual(await harness.service.getVersion(versionId), null);
  assert.deepEqual(eventTypes(harness.repository), [
    'listing.created',
    'listing.published',
    'listing.suspended',
  ]);
});

test('withdrawal is terminal: every further operation is refused', async () => {
  const harness = build();
  const { listingId, versionId } = await published(harness);
  const request = withdrawRequest(listingId);

  const result = await harness.service.withdrawListing(request);
  assert.equal(result.listing.status, 'withdrawn');
  assert.equal(result.listing.withdrawnAt, request.occurredAt);

  for (const attempt of [
    (): Promise<unknown> => harness.service.publishListing(publishRequest(listingId)),
    (): Promise<unknown> => harness.service.addMedia(mediaRequest(listingId, versionId)),
    (): Promise<unknown> =>
      harness.service.addDeclaration(declarationRequest(listingId, versionId)),
    (): Promise<unknown> => harness.service.suspendListing(suspendRequest(listingId)),
  ]) {
    assert.equal(await codeOf(attempt), 'listing-withdrawn');
  }
});

test('the status vocabulary is closed and matches the migration', () => {
  assert.deepEqual(
    [...LISTING_STATUSES],
    ['draft', 'published', 'suspended', 'withdrawn'],
    'the migration CHECK lists exactly these four',
  );
});

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

test('reads are scoped, sealed and return empty rather than refusing', async () => {
  const harness = build();
  const mine = await newListing(harness);
  await harness.service.createListing(
    createRequest({ accountId: 'acct_01HQZXB0003', listingId: 'lst_01HQZXB0003' }),
  );

  const listings = await harness.service.listListingsByAccount(ACCOUNT);
  assert.equal(listings.length, 1);
  assert.equal(listings[0]?.listingId, mine);

  assert.equal(await harness.service.getListing('lst_01HQZXZ0404'), null);
  assert.equal(await harness.service.getVersion('ver_01HQZXZ0404'), null);
  assert.deepEqual(await harness.service.listVersions('lst_01HQZXZ0404'), []);
  assert.deepEqual(await harness.service.listMedia('ver_01HQZXZ0404'), []);
  assert.deepEqual(await harness.service.listDeclarations('ver_01HQZXZ0404'), []);

  assert.throws(() => {
    (listings[0] as unknown as { status: string }).status = 'published';
  }, TypeError);
});

// ---------------------------------------------------------------------------
// Refusal by name
// ---------------------------------------------------------------------------

test('every field belonging to another unit is refused, by name, with its owner', async () => {
  const harness = build();

  for (const [field, owner] of Object.entries(FOREIGN_FIELDS)) {
    const request = { ...createRequest(), [field]: 'anything' };
    const code = await codeOf(() => harness.service.createListing(request));
    assert.equal(code, 'foreign-concern', `${field} was not refused as a foreign concern`);
    assert.match(
      owner,
      /K-\d\d|M-\d\d|document store|profile core|M-04/,
      `FOREIGN_FIELDS["${field}"] must name the unit that owns it, and says "${owner}"`,
    );
  }
});

test('the artefact itself is refused by name, not merely unused', async () => {
  const harness = build();
  for (const field of ['mediaBlob', 'imageData', 'documentBody']) {
    assert.equal(
      await codeOf(() => harness.service.createListing({ ...createRequest(), [field]: 'AAAA' })),
      'foreign-concern',
      `${field} must be refused: a document store holds the bytes, and M-04 holds a handle`,
    );
  }
});

test('a title, description, caption or statement that is empty, blank or too long is refused', async () => {
  const harness = build();
  const listingId = await newListing(harness);

  for (const title of ['', '   ', 'x'.repeat(201)]) {
    assert.equal(
      await codeOf(() => harness.service.publishListing(publishRequest(listingId, { title }))),
      'malformed-title',
      `title of length ${title.length}`,
    );
  }
  for (const description of ['', '   ', 'x'.repeat(5001)]) {
    assert.equal(
      await codeOf(() =>
        harness.service.publishListing(publishRequest(listingId, { description })),
      ),
      'malformed-description',
      `description of length ${description.length}`,
    );
  }

  const { listingId: other, versionId } = await published(build());
  const withVersion = build();
  const live = await published(withVersion);
  assert.ok(other !== undefined && versionId !== undefined);

  for (const caption of ['', '   ', 'x'.repeat(501)]) {
    assert.equal(
      await codeOf(() =>
        withVersion.service.addMedia(mediaRequest(live.listingId, live.versionId, { caption })),
      ),
      'malformed-caption',
      `caption of length ${caption.length}`,
    );
  }
  for (const statement of ['', '   ', 'x'.repeat(2001)]) {
    assert.equal(
      await codeOf(() =>
        withVersion.service.addDeclaration(
          declarationRequest(live.listingId, live.versionId, { statement }),
        ),
      ),
      'malformed-statement',
      `statement of length ${statement.length}`,
    );
  }
});

test('a malformed instant and a malformed identifier are each refused', async () => {
  const harness = build();
  assert.equal(
    await codeOf(() => harness.service.createListing(createRequest({ createdAt: 'yesterday' }))),
    'malformed-instant',
  );
  assert.equal(
    await codeOf(() =>
      harness.service.createListing(createRequest({ accountId: 'seller@example.com' })),
    ),
    'natural-identifier',
  );
  assert.equal(
    await codeOf(() => harness.service.createListing(createRequest({ listingId: 'short' }))),
    'malformed-identifier',
  );
});

// ---------------------------------------------------------------------------
// Atomicity and determinism
// ---------------------------------------------------------------------------

test('a refused operation leaves no row and no outbox entry', async () => {
  const harness = build();

  await assert.rejects(() => harness.service.createListing(createRequest({ createdAt: 'nope' })));

  assert.deepEqual(harness.repository.listings(), []);
  assert.deepEqual(harness.repository.outbox().entries(), []);
});

test('outbox ids are unique per fact, so a listing published three times does not collide', async () => {
  const harness = build();
  const listingId = await newListing(harness);

  await harness.service.publishListing(publishRequest(listingId));
  await harness.service.publishListing(publishRequest(listingId));
  await harness.service.publishListing(publishRequest(listingId));
  await harness.service.suspendListing(suspendRequest(listingId));

  const ids = harness.repository
    .outbox()
    .entries()
    .map((entry) => entry.outboxId);
  assert.equal(
    new Set(ids).size,
    ids.length,
    'two outbox entries share an id, so the second would be refused by outbox_pkey in PostgreSQL. ' +
      'Ids derive from the version or the decision, never from the listing id alone',
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
  assert.deepEqual(
    offenders,
    [],
    'the caller supplies every identifier and every instant; a clock read here would make a ' +
      'replayed request produce a different record',
  );
});

test('no floating point reaches the migration', () => {
  // Scanned over the *statements* rather than the raw file, the way the K-06 and K-10 equivalents
  // are: 0026's header says in prose that no such column exists, and a check that failed on its own
  // documentation would be one somebody deletes rather than fixes.
  const statements = stripNoise(
    readFileSync(
      path.join(
        REPO_ROOT,
        'db',
        'migrations',
        '0026_create_module_universal_listing_schema.up.sql',
      ),
      'utf8',
    ),
  );
  for (const type of ['double precision', 'real', 'float4', 'float8', 'money']) {
    assert.ok(
      !new RegExp(`\\b${type.replace(' ', '\\s+')}\\b`, 'i').test(statements),
      `migration 0026 declares a ${type} column; money is bigint minor units, and a price that ` +
        'cannot be represented exactly is a price somebody eventually disputes',
    );
  }
});
