/**
 * M-04 Universal Listing — the persistence port's reference implementation.
 *
 * The in-memory repository is the specification the PostgreSQL adapter has to meet, so the cases
 * that matter are the ones a single caller never reaches: uniqueness checked **at commit against the
 * store as it stands**, not against the snapshot the transaction opened with.
 *
 * M-04 adds a rule the earlier modules did not have: version numbers are dense and per listing. Two
 * publications that both read "the current version is 1" must not both write version 2, because the
 * pair `(listing, version)` is the permanent address an order pins.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  InMemoryUniversalListingRepository,
  UniversalListingError,
} from '../modules/universal-listing/index.ts';

import {
  ACCOUNT,
  declarationRecord,
  listingRecord,
  mediaRecord,
  versionRecord,
} from './helpers/universal-listing-fixtures.ts';

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

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

test('a committed listing is found by id, by idempotency key and by account', async () => {
  const repository = new InMemoryUniversalListingRepository();
  const listing = listingRecord();

  await repository.withTransaction(async (tx) => {
    await tx.insertListing(listing);
  });

  await repository.withTransaction(async (tx) => {
    assert.deepEqual(await tx.findListingById(listing.listingId), listing);
    assert.deepEqual(await tx.findListingByIdempotencyKey(listing.idempotencyKey), listing);
    assert.deepEqual(await tx.findListingsByAccountId(ACCOUNT), [listing]);

    assert.equal(await tx.findListingById('lst_01HQZY00404'), null);
    assert.equal(await tx.findListingByIdempotencyKey('idem_absent_0001'), null);
    assert.deepEqual(await tx.findListingsByAccountId('acct_01HQZY00404'), []);
  });
});

test('versions, media and declarations are found by id, by key and by their parent', async () => {
  const repository = new InMemoryUniversalListingRepository();
  const version = versionRecord();
  const media = mediaRecord({ listingId: version.listingId, versionId: version.versionId });
  const declaration = declarationRecord({
    listingId: version.listingId,
    versionId: version.versionId,
  });

  await repository.withTransaction(async (tx) => {
    await tx.insertVersion(version);
    await tx.insertMedia(media);
    await tx.insertDeclaration(declaration);
  });

  await repository.withTransaction(async (tx) => {
    assert.deepEqual(await tx.findVersionById(version.versionId), version);
    assert.deepEqual(await tx.findVersionsByListingId(version.listingId), [version]);

    assert.deepEqual(await tx.findMediaById(media.mediaId), media);
    assert.deepEqual(await tx.findMediaByVersionId(version.versionId), [media]);

    assert.deepEqual(await tx.findDeclarationById(declaration.declarationId), declaration);
    assert.deepEqual(await tx.findDeclarationsByVersionId(version.versionId), [declaration]);
  });
});

test('versions come back in version order, whatever order they were written in', async () => {
  const repository = new InMemoryUniversalListingRepository();
  const listingId = 'lst_01HQZY10001';

  await repository.withTransaction(async (tx) => {
    for (const versionNumber of [3, 1, 2]) {
      await tx.insertVersion(versionRecord({ listingId, versionNumber }));
    }
  });

  await repository.withTransaction(async (tx) => {
    assert.deepEqual(
      (await tx.findVersionsByListingId(listingId)).map((version) => version.versionNumber),
      [1, 2, 3],
      'a caller reading the history of an offer must not depend on insertion order',
    );
  });
});

test('reads inside a transaction see that transaction’s own uncommitted writes', async () => {
  const repository = new InMemoryUniversalListingRepository();
  const listing = listingRecord();

  await repository.withTransaction(async (tx) => {
    assert.equal(await tx.findListingById(listing.listingId), null);
    await tx.insertListing(listing);
    assert.deepEqual(
      await tx.findListingById(listing.listingId),
      listing,
      'a transaction that cannot read its own write forces the service to track state itself',
    );
  });
});

// ---------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------

test('a failed transaction leaves nothing at all behind', async () => {
  const repository = new InMemoryUniversalListingRepository();
  const listing = listingRecord();
  const version = versionRecord({ listingId: listing.listingId });

  await assert.rejects(
    repository.withTransaction(async (tx) => {
      await tx.insertListing(listing);
      await tx.insertVersion(version);
      await tx.insertMedia(
        mediaRecord({ listingId: listing.listingId, versionId: version.versionId }),
      );
      await tx.insertDeclaration(
        declarationRecord({ listingId: listing.listingId, versionId: version.versionId }),
      );
      await tx.insertOutbox({
        outboxId: 'M-04:rolled-back',
        idempotencyKey: 'M-04:rolled-back',
        kind: 'event',
        payload: {},
        recordedAt: '2026-06-01T09:00:00Z',
        producer: 'M-04',
        correlationId: 'corr_01HQZY00001',
        causationId: null,
        processedAt: null,
        retryCount: 0,
        lastError: null,
      });
      throw new Error('the supplier changed their mind');
    }),
    /changed their mind/,
  );

  assert.deepEqual(repository.listings(), []);
  assert.deepEqual(repository.versions(), []);
  assert.deepEqual(repository.medias(), []);
  assert.deepEqual(repository.declarations(), []);
  assert.deepEqual(repository.outbox().entries(), []);
  assert.equal(repository.transactionsRolledBack, 1);
  assert.equal(repository.transactionsCommitted, 0);
});

// ---------------------------------------------------------------------------
// Conflict detection at commit, not at read
// ---------------------------------------------------------------------------

test('two transactions that both read "no such listing" do not both win', async () => {
  const repository = new InMemoryUniversalListingRepository();
  const listing = listingRecord({ listingId: 'lst_01HQZY20001' });

  const code = await codeOf(() =>
    repository.withTransaction(async (tx) => {
      assert.equal(await tx.findListingById(listing.listingId), null);

      await repository.withTransaction(async (other) => {
        await other.insertListing(listing);
      });

      await tx.insertListing(listing);
    }),
  );

  assert.equal(code, 'duplicate-listing-id');
  assert.equal(repository.listings().length, 1);
});

test('two publications racing for the same version number do not both win', async () => {
  const repository = new InMemoryUniversalListingRepository();
  const listingId = 'lst_01HQZY30001';

  // This is the race the whole module turns on. Both callers read "current version is 1" and both
  // decide to write version 2. The pair (listing, version) is the address an order pins, so exactly
  // one of them may have it.
  const code = await codeOf(() =>
    repository.withTransaction(async (tx) => {
      assert.deepEqual(await tx.findVersionsByListingId(listingId), []);

      await repository.withTransaction(async (other) => {
        await other.insertVersion(
          versionRecord({ listingId, versionNumber: 2, versionId: 'ver_01HQZY30001' }),
        );
      });

      await tx.insertVersion(
        versionRecord({ listingId, versionNumber: 2, versionId: 'ver_01HQZY30002' }),
      );
    }),
  );

  assert.equal(
    code,
    'version-number-conflict',
    'a second version 2 would make "listing L, version 2" ambiguous, and an order that pinned it ' +
      'would no longer identify one set of terms',
  );
  assert.equal(repository.versions().length, 1);
});

test('a contested idempotency key, media id and declaration id are each refused at commit', async () => {
  const repository = new InMemoryUniversalListingRepository();

  const keyCode = await codeOf(() =>
    repository.withTransaction(async (tx) => {
      assert.equal(await tx.findListingByIdempotencyKey('idem_contested'), null);
      await repository.withTransaction(async (other) => {
        await other.insertListing(
          listingRecord({ listingId: 'lst_01HQZY40001', idempotencyKey: 'idem_contested' }),
        );
      });
      await tx.insertListing(
        listingRecord({ listingId: 'lst_01HQZY40002', idempotencyKey: 'idem_contested' }),
      );
    }),
  );
  assert.equal(keyCode, 'idempotency-key-reuse');

  const mediaCode = await codeOf(() =>
    repository.withTransaction(async (tx) => {
      assert.equal(await tx.findMediaById('med_01HQZY50001'), null);
      await repository.withTransaction(async (other) => {
        await other.insertMedia(mediaRecord({ mediaId: 'med_01HQZY50001' }));
      });
      await tx.insertMedia(mediaRecord({ mediaId: 'med_01HQZY50001' }));
    }),
  );
  assert.equal(mediaCode, 'duplicate-media-id');

  const declarationCode = await codeOf(() =>
    repository.withTransaction(async (tx) => {
      assert.equal(await tx.findDeclarationById('dec_01HQZY60001'), null);
      await repository.withTransaction(async (other) => {
        await other.insertDeclaration(declarationRecord({ declarationId: 'dec_01HQZY60001' }));
      });
      await tx.insertDeclaration(declarationRecord({ declarationId: 'dec_01HQZY60001' }));
    }),
  );
  assert.equal(declarationCode, 'duplicate-declaration-id');
});

// ---------------------------------------------------------------------------
// Updates and sealing
// ---------------------------------------------------------------------------

test('updateListing replaces the row rather than appending a second one', async () => {
  const repository = new InMemoryUniversalListingRepository();
  const listing = listingRecord();

  await repository.withTransaction(async (tx) => {
    await tx.insertListing(listing);
  });
  await repository.withTransaction(async (tx) => {
    await tx.updateListing({
      ...listing,
      status: 'published',
      currentVersion: 1,
      publishedAt: '2026-06-02T09:00:00Z',
      updatedAt: '2026-06-02T09:00:00Z',
    });
  });

  const held = repository.listings();
  assert.equal(held.length, 1);
  assert.equal(held[0]?.status, 'published');
  assert.equal(held[0]?.currentVersion, 1);
});

test('records handed out by the repository are sealed and severed from the store', async () => {
  const repository = new InMemoryUniversalListingRepository();
  const listing = listingRecord();

  await repository.withTransaction(async (tx) => {
    await tx.insertListing(listing);
  });

  assert.throws(() => {
    (repository.listings()[0] as unknown as { status: string }).status = 'published';
  }, TypeError);

  await repository.withTransaction(async (tx) => {
    const found = await tx.findListingById(listing.listingId);
    assert.notEqual(found, null);
    assert.throws(() => {
      (found as unknown as { status: string }).status = 'published';
    }, TypeError);
  });
});

test('a bigint amount survives the repository unchanged', async () => {
  const repository = new InMemoryUniversalListingRepository();
  const huge = 9_007_199_254_740_993n;
  const version = versionRecord({ unitPriceMinor: huge, quantityAvailable: huge });

  await repository.withTransaction(async (tx) => {
    await tx.insertVersion(version);
  });

  const held = repository.versions()[0];
  assert.equal(held?.unitPriceMinor, huge);
  assert.equal(held?.quantityAvailable, huge);
  assert.equal(
    typeof held?.unitPriceMinor,
    'bigint',
    'sealing must not coerce a bigint to a number on the way out',
  );
});

test('seed accepts a starting point without going through a transaction', () => {
  const repository = new InMemoryUniversalListingRepository();
  const listing = listingRecord();

  repository.seed({ listings: [listing] });

  assert.deepEqual(repository.listings(), [listing]);
  assert.equal(
    repository.transactionsCommitted,
    0,
    'seeding is not a transaction, and must not be counted as one',
  );
});
