/**
 * M-07 Matching — the sourcing ladder, and above all the fact that it stops.
 *
 * The behaviour under test is a product decision, not an algorithm: **JAYA tries to solve a Need
 * before it publishes one.** A customer says "I need 20 tonnes of cement in Matale by Friday", and
 * if that cement is already on a shelf forty kilometres away then sending an RFQ to eleven suppliers
 * is the wrong answer — it wastes their time, delays the customer, and teaches everybody to ignore
 * RFQs.
 *
 * So the first and most important test is that a Need answered by the catalogue never reaches the
 * suppliers at all. Everything after it is about the ways that could quietly stop being true:
 *
 *   * a rung that finds something mediocre and stops anyway;
 *   * a broken adapter that looks like an absence of supply;
 *   * an escalation nobody can explain to the customer it inconvenienced;
 *   * a run that gets re-climbed on a retry, asking real suppliers twice.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_SUFFICIENCY_PER_MILLE,
  InMemoryMatchingRepository,
  MatchingService,
  SOURCING_RUNGS,
  type MatchingError,
  type RungCandidate,
  type RungPorts,
  type SourcingQuery,
} from '../modules/matching/index.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUYER = 'acct_01HR0MTCHbuyer1';
const SUPPLIER = 'acct_01HR0MTCHsuppl1';
const NEED = 'req_01HR0MTCHneed01';
const NOW = '2026-07-01T09:00:00.000000Z';
const DONE = '2026-07-01T09:00:02.000000Z';

/** A rung that finds exactly what it is told to, and records that it was asked. */
function rung(
  candidates: readonly RungCandidate[],
  asked: SourcingQuery[] = [],
): {
  port: { find: (query: SourcingQuery) => Promise<readonly RungCandidate[]> };
  asked: SourcingQuery[];
} {
  return {
    port: {
      find: (query) => {
        asked.push(query);
        return Promise.resolve(candidates);
      },
    },
    asked,
  };
}

/** A rung that cannot look. Distinct from one that looks and finds nothing. */
function brokenRung(asked: SourcingQuery[] = []): {
  port: { find: (query: SourcingQuery) => Promise<readonly RungCandidate[]> };
  asked: SourcingQuery[];
} {
  return {
    port: {
      find: (query) => {
        asked.push(query);
        return Promise.reject(new Error('the supplier directory is unreachable'));
      },
    },
    asked,
  };
}

function listingCandidate(score: number, tag = '01'): RungCandidate {
  return {
    kind: 'listing',
    listingId: `lst_01HR0MTCH0000${tag}`,
    versionId: `ver_01HR0MTCH0000${tag}`,
    supplierAccountId: SUPPLIER,
    scorePerMille: score,
    explanation: 'same grade, in stock in Matale, 12km from the delivery address',
    evidence: { grade: 'OPC 43', distanceKm: 12, inStock: true },
  };
}

function supplierCandidate(score: number, tag = '01'): RungCandidate {
  return {
    kind: 'supplier',
    listingId: null,
    versionId: null,
    supplierAccountId: `acct_01HR0MTCHsup${tag}`,
    scorePerMille: score,
    explanation: 'has filled four similar cement orders for this buyer in the last year',
    evidence: { priorOrders: 4, category: 'cement' },
  };
}

function build(rungs: RungPorts = {}): {
  service: MatchingService;
  repository: InMemoryMatchingRepository;
} {
  const repository = new InMemoryMatchingRepository();
  return { service: new MatchingService(repository, rungs), repository };
}

function ladderRequest(
  overrides: Record<string, unknown> = {},
): Parameters<MatchingService['runLadder']>[0] {
  return {
    runId: 'mrun_01HR0MTCH0001',
    requestId: NEED,
    accountId: BUYER,
    interpretationId: 'int_01HR0MTCH00001',
    structured: { commodity: 'cement', quantity: 20, unit: 'tonne', district: 'Matale' },
    confidencePerMille: 880,
    startedAt: NOW,
    completedAt: DONE,
    correlationId: 'corr_01HR0MTCHrun01',
    idempotencyKey: 'idem_mtch_run_0001',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The ladder stops
// ---------------------------------------------------------------------------

test('a Need the catalogue can answer never reaches the suppliers', async () => {
  // The whole product decision, in one test. If this ever stops holding, JAYA has become a request
  // board: every Need broadcast to every supplier, suppliers trained to ignore RFQs, and a customer
  // waiting three days for something that was on a shelf.
  const catalogue = rung([listingCandidate(910)]);
  const known = rung([supplierCandidate(800)]);
  const verified = rung([supplierCandidate(750)]);
  const external = rung([supplierCandidate(720)]);

  const { service } = build({
    catalogue: catalogue.port,
    known: known.port,
    verified: verified.port,
    external: external.port,
  });

  const result = await service.runLadder(ladderRequest());

  assert.equal(result.run.outcome, 'matched');
  assert.equal(result.run.satisfiedBy, 'catalogue');
  assert.equal(result.candidates.length, 1);

  assert.equal(catalogue.asked.length, 1, 'the catalogue was searched');
  assert.deepEqual(
    [known.asked.length, verified.asked.length, external.asked.length],
    [0, 0, 0],
    'and no supplier was troubled, because the Need was already answered',
  );
});

test('the rungs that were never tried are recorded as skipped, not omitted', async () => {
  // So the run reads as a sequence rather than as a set of unexplained gaps. Somebody reviewing it
  // should see that rung 4 was skipped *because* rung 1 answered, not wonder whether it failed
  // silently.
  const { service } = build({ catalogue: rung([listingCandidate(910)]).port });

  const result = await service.runLadder(ladderRequest());

  assert.deepEqual(
    result.attempts.map((one) => [one.rung, one.outcome]),
    [
      ['catalogue', 'satisfied'],
      ['known', 'skipped'],
      ['verified', 'skipped'],
      ['external', 'skipped'],
      ['rfq', 'skipped'],
    ],
  );
  for (const attempt of result.attempts.slice(1)) {
    assert.match(
      attempt.reason,
      /already answered/,
      'a skipped rung says why it was skipped, or the sequence is unreadable',
    );
  }
});

test('the ladder climbs in order, and each rung is tried only when the one above did not answer', async () => {
  const catalogue = rung([]);
  const known = rung([]);
  const verified = rung([supplierCandidate(880)]);
  const external = rung([supplierCandidate(999)]);

  const { service } = build({
    catalogue: catalogue.port,
    known: known.port,
    verified: verified.port,
    external: external.port,
  });

  const result = await service.runLadder(ladderRequest());

  assert.equal(result.run.satisfiedBy, 'verified');
  assert.deepEqual(
    [catalogue.asked.length, known.asked.length, verified.asked.length, external.asked.length],
    [1, 1, 1, 0],
    'external was never asked, even though it would have scored higher: the ladder is cheapest ' +
      'first, not best-of-all, because asking everybody costs everybody',
  );
});

test('a mediocre match does not stop the ladder', async () => {
  // The bar is deliberately high. Stopping on a poor match wastes the customer's attention and may
  // lose the sale; climbing one rung too far costs a supplier an email. The two failure modes are
  // not symmetric, and the threshold reflects that.
  const catalogue = rung([listingCandidate(DEFAULT_SUFFICIENCY_PER_MILLE - 1)]);
  const known = rung([supplierCandidate(DEFAULT_SUFFICIENCY_PER_MILLE + 1)]);

  const { service } = build({ catalogue: catalogue.port, known: known.port });
  const result = await service.runLadder(ladderRequest());

  assert.equal(result.run.satisfiedBy, 'known');

  const first = result.attempts[0];
  assert.equal(first?.outcome, 'insufficient');
  assert.equal(first?.candidatesFound, 1, 'it found something');
  assert.equal(first?.bestScorePerMille, DEFAULT_SUFFICIENCY_PER_MILLE - 1);
  assert.match(
    first?.reason ?? '',
    /below the 700 this run required/,
    'and the reason says by how much, so a customer can be shown the near miss',
  );
});

test('a deployment may hold its own bar', async () => {
  const { service } = build({ catalogue: rung([listingCandidate(650)]).port });

  const strict = await service.runLadder(ladderRequest());
  assert.equal(strict.run.outcome, 'escalate-to-rfq', '650 is below the default 700');

  const lenient = await service.runLadder(
    ladderRequest({
      runId: 'mrun_01HR0MTCH0002',
      idempotencyKey: 'idem_mtch_run_0002',
      sufficiencyPerMille: 600,
    }),
  );
  assert.equal(lenient.run.outcome, 'matched');
  assert.equal(lenient.run.sufficiencyPerMille, 600, 'and the run records the bar it was held to');
});

// ---------------------------------------------------------------------------
// Escalation, and why it must be explainable
// ---------------------------------------------------------------------------

test('a Need nothing can answer escalates, and every rung says why', async () => {
  const { service } = build({
    catalogue: rung([]).port,
    known: rung([]).port,
    verified: rung([supplierCandidate(400)]).port,
    // No external adapter wired.
  });

  const result = await service.runLadder(ladderRequest());

  assert.equal(result.run.outcome, 'escalate-to-rfq');
  assert.equal(result.run.satisfiedBy, null);
  assert.equal(
    result.candidates.length,
    0,
    'an escalation carries no candidates, or it is not one',
  );

  assert.deepEqual(
    result.attempts.map((one) => [one.rung, one.outcome]),
    [
      ['catalogue', 'empty'],
      ['known', 'empty'],
      ['verified', 'insufficient'],
      ['external', 'unavailable'],
      ['rfq', 'insufficient'],
    ],
  );

  // The point of the record: a customer whose Need became an RFQ is owed a reason, and every rung
  // has one.
  for (const attempt of result.attempts) {
    assert.ok(
      attempt.reason.length >= 12,
      `the ${attempt.rung} rung gave no reason; "empty" is not an explanation`,
    );
  }
});

test('three different facts: found nothing, could not look, and never wired', async () => {
  // `empty` is a claim about the world. `lookup-failed` and `unavailable` are claims about us, and
  // they are not the same claim: the first means somebody should be paged, the second means this
  // deployment chose not to wire the rung. A broken directory recorded as a configuration choice is
  // an outage nobody is alerted to.
  const broken = brokenRung();
  const { service } = build({ catalogue: rung([]).port, known: broken.port });

  const result = await service.runLadder(ladderRequest());

  const [catalogue, known, verified] = result.attempts;
  assert.equal(catalogue?.outcome, 'empty', 'it looked, and there was nothing');
  assert.equal(known?.outcome, 'lookup-failed', 'it was called and it broke');
  assert.equal(verified?.outcome, 'unavailable', 'it was never wired, which is a different fact');
  assert.match(
    known?.reason ?? '',
    /could not be searched: the supplier directory is unreachable/,
    'and the reason carries the failure, so a broken directory shows up as a broken directory',
  );
  assert.equal(broken.asked.length, 1, 'it was genuinely attempted');
});

test('an unwired rung is unavailable rather than empty', async () => {
  const { service } = build({ catalogue: rung([]).port });
  const result = await service.runLadder(ladderRequest());

  for (const rungName of ['known', 'verified', 'external'] as const) {
    const attempt = result.attempts.find((one) => one.rung === rungName);
    assert.equal(attempt?.outcome, 'unavailable', `${rungName} claimed to have searched`);
    assert.match(attempt?.reason ?? '', /no adapter is wired/);
  }
});

test('the RFQ rung is a recommendation, never a search', async () => {
  // M-07 decides; M-09 acts. A matching engine that could open tenders would be two modules wearing
  // one name, and the one that opens tenders would be the one nobody reviewed.
  const { service } = build({ catalogue: rung([]).port });
  const result = await service.runLadder(ladderRequest());

  const rfq = result.attempts.at(-1);
  assert.equal(rfq?.rung, 'rfq');
  assert.equal(rfq?.candidatesFound, 0);
  assert.match(
    rfq?.reason ?? '',
    /the right thing to do rather than the first thing/,
    'the last rung explains the escalation as a decision rather than a fallback',
  );
});

// ---------------------------------------------------------------------------
// What the rungs are given, and what they are not
// ---------------------------------------------------------------------------

test('a rung is given the interpretation, never the words', async () => {
  // A rung may talk to an external supplier. Handing it a sentence a customer wrote — which is
  // deliberately exempt from the identifier rules and may hold a telephone number — would send that
  // sentence outside the platform.
  const catalogue = rung([]);
  const { service } = build({ catalogue: catalogue.port });

  await service.runLadder(ladderRequest());

  const query = catalogue.asked[0];
  assert.ok(query !== undefined);
  assert.deepEqual(Object.keys(query).sort(), [
    'accountId',
    'confidencePerMille',
    'correlationId',
    'now',
    'requestId',
    'structured',
  ]);
  assert.ok(!('rawText' in query), 'the words must not reach a rung');
  assert.equal(query.structured.commodity, 'cement');
  assert.equal(
    query.confidencePerMille,
    880,
    'and the confidence travels, so a rung may search more broadly for a vague Need',
  );
});

test('the ladder refuses a request carrying another module’s concern', async () => {
  const { service } = build();

  for (const [field, expected] of [
    ['rawText', /M-03 Commerce Request/],
    ['orderId', /M-11 Orders/],
    ['rfqId', /M-09 RFQ/],
    ['price', /fit is scored rather than costed/],
  ] as const) {
    await assert.rejects(
      service.runLadder(ladderRequest({ [field]: 'anything' })),
      (error: unknown) => {
        assert.equal((error as MatchingError).code, 'foreign-concern', `${field} was accepted`);
        assert.match((error as Error).message, expected);
        return true;
      },
    );
  }
});

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

test('candidates come back best first, and every one explains itself', async () => {
  const { service } = build({
    catalogue: rung([
      listingCandidate(760, '01'),
      listingCandidate(940, '02'),
      listingCandidate(850, '03'),
    ]).port,
  });

  const result = await service.runLadder(ladderRequest());

  assert.deepEqual(
    result.candidates.map((one) => one.scorePerMille),
    [940, 850, 760],
    'a caller that takes the head takes the best rather than the first found',
  );
  for (const candidate of result.candidates) {
    assert.ok(
      candidate.explanation.length >= 12,
      'a candidate a customer cannot understand is one they cannot sensibly accept or reject',
    );
  }
});

test('candidates below the bar are not returned, even from the rung that satisfied', async () => {
  // The rung answered, so the ladder stops — but a poor candidate found alongside a good one is
  // still poor, and offering it would undo the threshold.
  const { service } = build({
    catalogue: rung([listingCandidate(940, '01'), listingCandidate(300, '02')]).port,
  });

  const result = await service.runLadder(ladderRequest());

  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]?.scorePerMille, 940);
  assert.equal(
    result.attempts[0]?.candidatesFound,
    2,
    'though the attempt records that two were found, so the near miss is not invisible',
  );
});

test('a listing candidate names its version, and a supplier candidate names neither', async () => {
  // An order pins a version, so a listing candidate that named no version would be one nobody could
  // act on. A supplier candidate names none because nobody has offered anything yet — which is
  // exactly what distinguishes the two kinds.
  const { service } = build({ catalogue: rung([listingCandidate(900)]).port });
  const matched = await service.runLadder(ladderRequest());
  assert.ok(matched.candidates[0]?.versionId !== null);

  const { service: second } = build({
    catalogue: rung([]).port,
    known: rung([supplierCandidate(900)]).port,
  });
  const asked = await second.runLadder(
    ladderRequest({ runId: 'mrun_01HR0MTCH0003', idempotencyKey: 'idem_mtch_run_0003' }),
  );
  assert.equal(asked.candidates[0]?.listingId, null);
  assert.equal(asked.candidates[0]?.versionId, null);
});

test('an incoherent candidate from a rung is refused rather than stored', async () => {
  const { service } = build({
    catalogue: rung([
      {
        kind: 'listing',
        listingId: 'lst_01HR0MTCH000099',
        // A listing candidate with no version: nothing could be ordered from it.
        versionId: null,
        supplierAccountId: SUPPLIER,
        scorePerMille: 900,
        explanation: 'a listing candidate that cannot be ordered',
        evidence: {},
      },
    ]).port,
  });

  await assert.rejects(service.runLadder(ladderRequest()), (error: unknown) => {
    assert.equal((error as MatchingError).code, 'incoherent-candidate');
    return true;
  });
});

test('a score outside 0..1000 is refused rather than clamped', async () => {
  // Clamping would hide a rung's arithmetic error and produce a candidate whose score is a lie.
  const { service } = build({ catalogue: rung([listingCandidate(1200)]).port });

  await assert.rejects(service.runLadder(ladderRequest()), (error: unknown) => {
    assert.equal((error as MatchingError).code, 'malformed-score');
    return true;
  });
});

// ---------------------------------------------------------------------------
// Running it twice
// ---------------------------------------------------------------------------

test('a retry answers from what was recorded, without asking the suppliers again', async () => {
  // Re-climbing would query real suppliers a second time for a request the caller already has an
  // answer to — which is both rude and, for a rung that costs money to call, expensive.
  const catalogue = rung([listingCandidate(910)]);
  const { service } = build({ catalogue: catalogue.port });

  const first = await service.runLadder(ladderRequest());
  const second = await service.runLadder(ladderRequest());

  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.equal(second.run.runId, first.run.runId);
  assert.deepEqual(
    second.candidates.map((one) => one.candidateId),
    first.candidates.map((one) => one.candidateId),
  );
  assert.equal(catalogue.asked.length, 1, 'the suppliers were asked once');
});

test('a genuinely new run against the same Need is a second run, not an edit', async () => {
  // Supply changes. Comparing two runs is how anybody answers "why did this find nothing on Tuesday
  // and something on Thursday", and that only works if the first is still there.
  const { service } = build({ catalogue: rung([]).port });
  await service.runLadder(ladderRequest());

  const { service: later } = build({ catalogue: rung([listingCandidate(900)]).port });
  void later;

  const second = await service.runLadder(
    ladderRequest({
      runId: 'mrun_01HR0MTCH0004',
      idempotencyKey: 'idem_mtch_run_0004',
      startedAt: '2026-07-03T09:00:00.000000Z',
      completedAt: '2026-07-03T09:00:02.000000Z',
    }),
  );

  const runs = await service.listRunsForRequest(NEED);
  assert.equal(runs.length, 2, 'the first run is still there');
  assert.equal(runs[0]?.startedAt, NOW);
  assert.equal(second.run.runId, 'mrun_01HR0MTCH0004');
});

// ---------------------------------------------------------------------------
// What leaves the module
// ---------------------------------------------------------------------------

test('an escalation is published as its own event, and carries no words', async () => {
  // Two event types rather than one with a status field, because M-09 subscribes to exactly one of
  // them. A consumer filtering a shared type on a payload field receives every successful match it
  // has no use for.
  const { service, repository } = build({ catalogue: rung([]).port });
  await service.runLadder(ladderRequest());

  const published = JSON.stringify(repository.outbox().entries());
  assert.ok(published.includes('matching.escalated_to_rfq'));
  assert.ok(!published.includes('matching.match_found'));
  assert.ok(!published.includes('cement'), 'the structured reading must not travel either');
  assert.ok(published.includes('candidates_found'));
});

test('a match publishes the other event', async () => {
  const { service, repository } = build({ catalogue: rung([listingCandidate(910)]).port });
  await service.runLadder(ladderRequest());

  const published = JSON.stringify(repository.outbox().entries());
  assert.ok(published.includes('matching.match_found'));
  assert.ok(!published.includes('matching.escalated_to_rfq'));
});

// ---------------------------------------------------------------------------
// The shape of the ladder itself
// ---------------------------------------------------------------------------

test('the ladder order is the product decision, and the database agrees with the code', () => {
  // Reordering this list changes what the platform is: putting `rfq` first makes JAYA a request
  // board, and putting `external` before `known` ignores the suppliers who have already served this
  // buyer well. The CHECK constraint pins the same order, so the two cannot drift.
  assert.deepEqual([...SOURCING_RUNGS], ['catalogue', 'known', 'verified', 'external', 'rfq']);

  const migration = readFileSync(
    path.join(REPO_ROOT, 'db/migrations/0050_create_module_matching_schema.up.sql'),
    'utf8',
  );
  for (const [index, name] of SOURCING_RUNGS.entries()) {
    assert.match(
      migration,
      new RegExp(`WHEN '${name}'\\s+THEN ${String(index + 1)}`),
      `the database does not place ${name} at position ${String(index + 1)}`,
    );
  }
});

test('the module reads no clock and generates no randomness', () => {
  const directory = path.join(REPO_ROOT, 'modules/matching');
  const forbidden = [/Date\.now\(/, /new Date\(/, /Math\.random\(/, /crypto\.randomUUID\(/];

  for (const file of ['service.ts', 'repository.ts', 'validate.ts', 'registry.ts', 'outbox.ts']) {
    const source = readFileSync(path.join(directory, file), 'utf8');
    for (const pattern of forbidden) {
      assert.ok(
        pattern.exec(source) === null,
        `${file} uses ${String(pattern)}; the caller supplies every instant and identifier`,
      );
    }
  }
});
