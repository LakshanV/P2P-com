/**
 * The supplier rungs, and the external discovery boundary.
 *
 * When the catalogue holds no answer, the question is not "who is on this platform" — it is **"who
 * plausibly supplies this"**. The difference is the whole point: a rung that returned every supplier
 * would be a broadcast wearing a lookup's clothes, and a platform that broadcasts teaches its
 * suppliers to ignore it.
 *
 * So the tests that matter most here are the exclusions. A cement supplier must not be asked about
 * laptops, however convenient their geography; a suspended account must not be asked at all; and a
 * lead found on the open web must not outrank a supplier the platform has actually verified.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_SUFFICIENCY_PER_MILLE,
  externalDiscoveryRung,
  failingExternalDiscovery,
  knownSupplierRung,
  mockExternalDiscovery,
  verifiedSupplierRung,
  type SourcingQuery,
  type SupplierDirectory,
  type SupplierLead,
  type SupplierProfile,
} from '../modules/matching/index.ts';

const BUYER = 'acct_01HR0SUPbuyer01';
const NOW = '2026-07-01T09:00:00.000000Z';

function profile(overrides: Partial<SupplierProfile> = {}): SupplierProfile {
  return {
    supplierAccountId: 'acct_01HR0SUPcement1',
    categories: ['cement'],
    capabilities: ['bulk-delivery'],
    districts: ['matale'],
    brands: ['Tokyo Cement'],
    verified: true,
    status: 'active',
    reliabilityPerMille: 850,
    priorOrdersForBuyer: 0,
    lastSuppliedAt: null,
    ...overrides,
  };
}

function query(structured: Readonly<Record<string, unknown>> = {}): SourcingQuery {
  return {
    requestId: 'req_01HR0SUPneed001',
    accountId: BUYER,
    structured: { category: 'cement', district: 'matale', ...structured },
    confidencePerMille: 880,
    now: NOW,
    correlationId: 'corr_01HR0SUPrun001',
  };
}

/** A directory that returns exactly what it is given, and records that it was asked. */
function directory(
  known: readonly SupplierProfile[],
  verified: readonly SupplierProfile[] = [],
): SupplierDirectory {
  return {
    findKnownSuppliers: () => Promise.resolve(known),
    findVerifiedSuppliers: () => Promise.resolve(verified),
  };
}

// ---------------------------------------------------------------------------
// The known rung: prior trade is a fact, not a claim
// ---------------------------------------------------------------------------

test('a supplier who has actually supplied this buyer scores strongly', async () => {
  const rung = knownSupplierRung({
    directory: directory([
      profile({ priorOrdersForBuyer: 4, lastSuppliedAt: '2026-06-01T09:00:00.000000Z' }),
    ]),
  });

  const found = await rung.find(query());

  assert.equal(found.length, 1);
  const candidate = found[0];
  assert.ok(candidate !== undefined);
  assert.ok(
    candidate.scorePerMille >= DEFAULT_SUFFICIENCY_PER_MILLE,
    `prior trade is the strongest signal on the platform; got ${String(candidate.scorePerMille)}`,
  );
  assert.equal(candidate.kind, 'supplier');
  assert.equal(candidate.listingId, null, 'nobody has offered anything yet');
  assert.match(candidate.explanation, /has supplied you 4 time\(s\)/);
  assert.match(candidate.explanation, /most recently on 2026-06-01/);
  assert.equal(candidate.evidence.priorOrdersForBuyer, 4);
});

test('a supplier with no prior trade does not belong on the known rung', async () => {
  // Letting them through would make "known" mean nothing, and would ask a stranger before the
  // ladder had decided a stranger was appropriate.
  const rung = knownSupplierRung({ directory: directory([profile({ priorOrdersForBuyer: 0 })]) });
  assert.deepEqual([...(await rung.find(query()))], []);
});

test('a stale relationship scores below a live one', async () => {
  // A supplier who served this buyer last month is a live relationship. One who served them in 2019
  // is a stranger with a record, and recommending them may mean recommending somebody who no longer
  // trades at all.
  const recent = knownSupplierRung({
    directory: directory([
      profile({ priorOrdersForBuyer: 3, lastSuppliedAt: '2026-06-15T09:00:00.000000Z' }),
    ]),
  });
  const stale = knownSupplierRung({
    directory: directory([
      profile({ priorOrdersForBuyer: 3, lastSuppliedAt: '2021-01-01T09:00:00.000000Z' }),
    ]),
  });

  const recentScore = (await recent.find(query()))[0]?.scorePerMille ?? 0;
  const staleScore = (await stale.find(query()))[0]?.scorePerMille ?? 0;

  assert.ok(recentScore > staleScore, 'recency has to count, or 2019 looks like last month');
  assert.ok(staleScore > 0, 'but a real history is still worth something');
});

// ---------------------------------------------------------------------------
// The gate: only relevant suppliers qualify
// ---------------------------------------------------------------------------

test('a supplier who sells something else is not asked, however convenient they are', async () => {
  // The behaviour that makes people stop reading requests from a platform. No amount of geographic
  // convenience makes asking a cement supplier about laptops less wrong.
  const rung = knownSupplierRung({
    directory: directory([
      profile({ categories: ['laptops'], priorOrdersForBuyer: 9, districts: ['matale'] }),
    ]),
  });

  assert.deepEqual(
    [...(await rung.find(query({ category: 'cement' })))],
    [],
    'nine prior orders for laptops is not evidence about cement',
  );
});

test('a suspended supplier is not a weak candidate, they are not a candidate', async () => {
  for (const status of ['suspended', 'closed']) {
    const rung = knownSupplierRung({
      directory: directory([profile({ status, priorOrdersForBuyer: 5 })]),
    });
    assert.deepEqual([...(await rung.find(query()))], [], `a ${status} supplier was asked`);
  }
});

test('a supplier outside the configured scope is excluded, not scored down', async () => {
  // Geographic scope is a business decision, not a technical one: a platform serving one province
  // and one serving an island want different answers and neither is wrong.
  const rung = knownSupplierRung({
    directory: directory([profile({ districts: ['jaffna'], priorOrdersForBuyer: 5 })]),
    districtScope: ['matale', 'kandy'],
  });

  assert.deepEqual([...(await rung.find(query()))], []);
});

test('a Need with no category in its reading does not exclude everybody', async () => {
  // The reading failed, not the supplier. Excluding everybody would escalate the Need for a reason
  // that is ours rather than the market's.
  const rung = knownSupplierRung({
    directory: directory([profile({ priorOrdersForBuyer: 3 })]),
  });

  const found = await rung.find({
    requestId: 'req_01HR0SUPneed002',
    accountId: BUYER,
    structured: { quantity: 20 },
    confidencePerMille: 300,
    now: NOW,
    correlationId: 'corr_01HR0SUPrun002',
  });

  assert.equal(found.length, 1);
});

// ---------------------------------------------------------------------------
// The verified rung
// ---------------------------------------------------------------------------

test('a verified supplier new to this buyer qualifies, and says so', async () => {
  const rung = verifiedSupplierRung({
    directory: directory([], [profile({ verified: true, priorOrdersForBuyer: 0 })]),
  });

  const found = await rung.find(query());
  assert.equal(found.length, 1);
  assert.match(found[0]?.explanation ?? '', /verified for cement, and new to you/);
  assert.match(found[0]?.explanation ?? '', /serves matale/);
  assert.equal(found[0]?.evidence.verified, true);
});

test('an unverified supplier is refused even if the directory returned one', async () => {
  // This rung is the platform vouching for somebody it has checked. Vouching for an unchecked
  // supplier is the one thing it must not do, so the flag is re-checked rather than assumed from
  // which method was called.
  const rung = verifiedSupplierRung({
    directory: directory([], [profile({ verified: false })]),
  });
  assert.deepEqual([...(await rung.find(query()))], []);
});

test('a supplier with no delivery record is not treated as an unreliable one', async () => {
  // Null is not zero. A new supplier who has never failed is not the same as one who fails half the
  // time, and scoring them identically closes the marketplace to new entrants.
  const unknown = verifiedSupplierRung({
    directory: directory([], [profile({ reliabilityPerMille: null })]),
  });
  const poor = verifiedSupplierRung({
    directory: directory([], [profile({ reliabilityPerMille: 100 })]),
  });

  const unknownScore = (await unknown.find(query()))[0]?.scorePerMille ?? 0;
  const poorScore = (await poor.find(query()))[0]?.scorePerMille ?? 0;

  assert.ok(unknownScore > poorScore, 'no record must not be scored as a bad record');
  assert.match(
    (await unknown.find(query()))[0]?.explanation ?? '',
    /no delivery record with JAYA yet/,
  );
});

test('a supplier who has not said where they serve is scored neutrally, not penalised', async () => {
  // Not having filled in a profile field is not the same as not serving there.
  const silent = verifiedSupplierRung({ directory: directory([], [profile({ districts: [] })]) });
  const wrong = verifiedSupplierRung({
    directory: directory([], [profile({ districts: ['jaffna'] })]),
  });

  const silentScore = (await silent.find(query()))[0]?.scorePerMille ?? 0;
  const wrongScore = (await wrong.find(query()))[0]?.scorePerMille ?? 0;

  assert.ok(silentScore > wrongScore);
  assert.match(
    (await silent.find(query()))[0]?.explanation ?? '',
    /has not said whether they serve matale/,
  );
});

test('a known supplier outranks an identical verified stranger', async () => {
  // The ladder tries `known` first, but the scores must agree with the ordering — otherwise the
  // ladder's shape and its scoring would be telling a customer two different stories.
  const known = knownSupplierRung({
    directory: directory([
      profile({ priorOrdersForBuyer: 4, lastSuppliedAt: '2026-06-01T09:00:00.000000Z' }),
    ]),
  });
  const verified = verifiedSupplierRung({ directory: directory([], [profile()]) });

  const knownScore = (await known.find(query()))[0]?.scorePerMille ?? 0;
  const verifiedScore = (await verified.find(query()))[0]?.scorePerMille ?? 0;

  assert.ok(
    knownScore > verifiedScore,
    'somebody who actually supplied you beats somebody who says they could',
  );
});

// ---------------------------------------------------------------------------
// Failing to look
// ---------------------------------------------------------------------------

test('a directory that cannot be read throws rather than reporting nobody', async () => {
  const broken: SupplierDirectory = {
    findKnownSuppliers: () => Promise.reject(new Error('the supplier index is unreachable')),
    findVerifiedSuppliers: () => Promise.reject(new Error('the supplier index is unreachable')),
  };

  await assert.rejects(
    knownSupplierRung({ directory: broken }).find(query()),
    /supplier index is unreachable/,
  );
  await assert.rejects(
    verifiedSupplierRung({ directory: broken }).find(query()),
    /supplier index is unreachable/,
  );
});

// ---------------------------------------------------------------------------
// External discovery
// ---------------------------------------------------------------------------

function lead(overrides: Partial<SupplierLead> = {}): SupplierLead {
  return {
    leadId: 'lead_01HR0SUPext0001',
    categories: ['cement'],
    districts: ['matale'],
    confidencePerMille: 900,
    source: 'Chamber of Commerce building-materials directory, 2026 edition',
    evidence: { listedSince: 2019 },
    ...overrides,
  };
}

test('a lead is found, carries its source, and is honest about what it is', async () => {
  const rung = externalDiscoveryRung({ provider: mockExternalDiscovery([lead()]) });
  const found = await rung.find(query());

  assert.equal(found.length, 1);
  const candidate = found[0];
  assert.ok(candidate !== undefined);
  assert.equal(candidate.kind, 'supplier');
  assert.match(candidate.explanation, /found outside JAYA via mock-discovery/);
  assert.match(
    candidate.explanation,
    /a lead to follow up rather than an offer/,
    'a lead has agreed to nothing and may not know JAYA exists',
  );
  assert.equal(candidate.evidence.source, lead().source);
  assert.equal(candidate.evidence.provider, 'mock-discovery');
  assert.equal(candidate.evidence.listedSince, 2019, 'the provider’s own evidence is carried');
});

test('a lead can never satisfy the ladder on its own', async () => {
  // The ceiling is deliberately below the sufficiency default. The best a lead can do is be recorded
  // as the strongest thing found before escalation, so whoever opens the RFQ can see who to invite.
  const rung = externalDiscoveryRung({
    provider: mockExternalDiscovery([lead({ confidencePerMille: 1000 })]),
  });

  const found = await rung.find(query());
  const score = found[0]?.scorePerMille ?? 0;

  assert.ok(
    score < DEFAULT_SUFFICIENCY_PER_MILLE,
    `a provider claiming total confidence still must not stop the ladder; got ${String(score)}`,
  );
  assert.ok(score > 0, 'but it is still worth recording, because somebody has to be invited');
});

test('a lead with no source is refused', async () => {
  // A lead nobody can trace is a lead nobody can check, and the first question anybody asks about an
  // unfamiliar supplier is where we got them.
  const rung = externalDiscoveryRung({ provider: mockExternalDiscovery([lead({ source: '  ' })]) });
  assert.deepEqual([...(await rung.find(query()))], []);
});

test('a provider that fails is not a world with no suppliers in it', async () => {
  const rung = externalDiscoveryRung({ provider: failingExternalDiscovery() });
  await assert.rejects(rung.find(query()), /discovery provider returned 503/);
});

test('the boundary is a contract, not a crawler', async () => {
  // No web access, no HTTP client, no provider-specific field anywhere in the module. Whether the
  // thing on the other side is a directory, a search API or a person with a spreadsheet is a
  // deployment decision — and hardcoding one would make the module untestable everywhere and
  // unusable in any deployment that chose differently.
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(
    new URL('../modules/matching/rungs/external-discovery.ts', import.meta.url),
    'utf8',
  );

  for (const forbidden of ['fetch(', 'node:http', 'axios', 'puppeteer', 'cheerio']) {
    assert.ok(
      !source.includes(forbidden),
      `${forbidden} has no business in the matching module; it belongs behind the provider`,
    );
  }

  // And a provider is two members, so writing a live one later is a small, obvious job.
  const provider = mockExternalDiscovery([]);
  assert.deepEqual(Object.keys(provider).sort(), ['discover', 'name']);
});
