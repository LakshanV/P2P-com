/**
 * M-10 Quotes — what the market offered back, and how a customer chooses between offers.
 *
 * Three properties carry the weight of this suite, in order of how much damage their absence would
 * do:
 *
 *   * **An offer binds.** A quote cannot be edited after submission — not by its supplier, not by
 *     the service, and not by an UPDATE that reaches the table directly. A market where the offer
 *     you accepted is not the offer you saw is not a market. Tested through the service and again
 *     against the trigger text, because the two fail independently.
 *   * **A supplier acts only on their own offer.** Withdrawing a competitor's quote would be the
 *     cheapest way to win a tender. Tested from the wrong supplier, and against a tender the
 *     supplier was never invited to.
 *   * **Ranking is not price, and it is advice.** The cheapest offer that arrives three weeks late
 *     from an unreliable supplier must not be recommended, and the customer must be able to accept
 *     a valid offer the platform did not recommend.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_WEIGHTS,
  InMemoryQuoteRepository,
  QUOTE_TRANSITIONS,
  QuoteError,
  QuoteService,
  rankQuotes,
  validateQuote,
  type Quote,
  type QuoteContext,
  type TenderFacts,
  type TenderSource,
} from '../modules/quotes/index.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const RFQ = 'rfq_01HR0QUOTE00001';
const OTHER_RFQ = 'rfq_01HR0QUOTE00002';
const SUPPLIER_A = 'acct_01HR0QUOTsuplA1';
const SUPPLIER_B = 'acct_01HR0QUOTsuplB1';
const SUPPLIER_C = 'acct_01HR0QUOTsuplC1';
const BUYER = 'acct_01HR0QUOTbuyer1';

const NOW = '2026-07-01T09:00:00.000000Z';
const LATER = '2026-07-01T11:30:00.000000Z';
const VALID_UNTIL = '2026-07-08T09:00:00.000000Z';
const REQUIRED_BY = '2026-07-15T09:00:00.000000Z';

/**
 * A tender source standing in for M-09.
 *
 * A test double rather than the real service because M-10 depends on three facts about a tender, and
 * a double makes it obvious when the module starts depending on a fourth.
 */
class StubTenders implements TenderSource {
  readonly tenders = new Map<string, TenderFacts>();
  readonly invitations = new Set<string>();
  lookups = 0;

  constructor() {
    this.tenders.set(RFQ, {
      rfqId: RFQ,
      buyerAccountId: BUYER,
      status: 'open',
      quantity: 20n,
      substitutionPolicy: 'equivalent-with-disclosure',
      requiredBy: REQUIRED_BY,
      qualityRequirements: ['SLS 107 certified'],
    });
    this.tenders.set(OTHER_RFQ, {
      rfqId: OTHER_RFQ,
      buyerAccountId: BUYER,
      status: 'open',
      quantity: 5n,
      substitutionPolicy: 'none',
      requiredBy: null,
      qualityRequirements: [],
    });
    this.invitations.add(`${RFQ}:${SUPPLIER_A}`);
    this.invitations.add(`${RFQ}:${SUPPLIER_B}`);
    this.invitations.add(`${RFQ}:${SUPPLIER_C}`);
    this.invitations.add(`${OTHER_RFQ}:${SUPPLIER_A}`);
  }

  findTender(rfqId: string): Promise<TenderFacts | null> {
    this.lookups += 1;
    return Promise.resolve(this.tenders.get(rfqId) ?? null);
  }

  isInvited(rfqId: string, supplierAccountId: string): Promise<boolean> {
    return Promise.resolve(this.invitations.has(`${rfqId}:${supplierAccountId}`));
  }

  close(rfqId: string, status: string): void {
    const held = this.tenders.get(rfqId);
    if (held !== undefined) this.tenders.set(rfqId, { ...held, status });
  }
}

interface Harness {
  readonly service: QuoteService;
  readonly repository: InMemoryQuoteRepository;
  readonly tenders: StubTenders;
}

function build(): Harness {
  const repository = new InMemoryQuoteRepository();
  const tenders = new StubTenders();
  return { service: new QuoteService(repository, tenders), repository, tenders };
}

interface OfferOptions {
  readonly tag?: string;
  readonly rfqId?: string;
  readonly supplierAccountId?: string;
  readonly kind?: string;
  readonly quantity?: unknown;
  readonly unitPriceMinor?: unknown;
  readonly totalMinor?: unknown;
  readonly currency?: string;
  readonly leadTimeDays?: number;
  readonly deliveryTerms?: string;
  readonly validUntil?: string;
  readonly substitutionNote?: string | null;
  readonly evidenceReferences?: readonly string[];
  readonly submittedAt?: string;
}

/**
 * A unit price the landed total can actually cover.
 *
 * The total is what the buyer pays all in, and it is never below the goods it lands. Deriving the
 * unit price from the total keeps every fixture consistent with that rule, so a test that varies a
 * price varies one number rather than two that have to agree.
 */
function unitPriceFor(totalMinor: unknown, quantity: unknown): bigint {
  try {
    const total = typeof totalMinor === 'bigint' ? totalMinor : BigInt(String(totalMinor));
    const count = typeof quantity === 'bigint' ? quantity : BigInt(String(quantity));
    return total / count;
  } catch {
    // A total this cannot divide is a malformed amount, and the validator is the thing that should
    // say so. Zero keeps the fixture out of the way of that refusal.
    return 0n;
  }
}

async function anOffer(harness: Harness, options: OfferOptions = {}): Promise<Quote> {
  const tag = options.tag ?? '0001';
  const quantity = options.quantity ?? 20n;
  const totalMinor = options.totalMinor ?? 25_000_000n;
  const result = await harness.service.submitQuote({
    quoteId: `quo_01HR0QUOTE${tag}`,
    rfqId: options.rfqId ?? RFQ,
    supplierAccountId: options.supplierAccountId ?? SUPPLIER_A,
    kind: options.kind ?? 'full',
    quantity,
    unitPriceMinor: options.unitPriceMinor ?? unitPriceFor(totalMinor, quantity),
    totalMinor,
    currency: options.currency ?? 'LKR',
    leadTimeDays: options.leadTimeDays ?? 5,
    deliveryTerms: options.deliveryTerms ?? 'delivered',
    validUntil: options.validUntil ?? VALID_UNTIL,
    substitutionNote: options.substitutionNote ?? null,
    evidenceReferences: options.evidenceReferences ?? ['doc_01HR0QUOTEcert1'],
    submittedAt: options.submittedAt ?? NOW,
    correlationId: `corr_01HR0QUOTE${tag}`,
    idempotencyKey: `idem_01HR0QUOTE${tag}`,
  });
  return result.quote;
}

// ---------------------------------------------------------------------------
// Submitting
// ---------------------------------------------------------------------------

test('an invited supplier can offer against an open tender', async () => {
  const harness = build();
  const quote = await anOffer(harness);

  assert.equal(quote.status, 'submitted');
  assert.equal(quote.supplierAccountId, SUPPLIER_A);
  assert.equal(quote.totalMinor, 25_000_000n);
  assert.equal(quote.closedAt, null);
});

test('a supplier who was not invited cannot quote', async () => {
  const harness = build();
  harness.tenders.invitations.delete(`${RFQ}:${SUPPLIER_B}`);

  await assert.rejects(
    anOffer(harness, { tag: '0002', supplierAccountId: SUPPLIER_B }),
    (error: unknown) => error instanceof QuoteError && error.code === 'not-invited',
  );
});

test('an invitation cannot be asserted in the request', async () => {
  // The whole point of checking with M-09: a supplier who could state their own invitation would be
  // a supplier who needs none. There is no field for it, and adding one is refused as foreign.
  const harness = build();

  await assert.rejects(
    harness.service.submitQuote({
      quoteId: 'quo_01HR0QUOTE0003',
      rfqId: RFQ,
      supplierAccountId: SUPPLIER_B,
      kind: 'full',
      quantity: 20n,
      unitPriceMinor: 1n,
      totalMinor: 20n,
      currency: 'LKR',
      leadTimeDays: 1,
      deliveryTerms: 'delivered',
      validUntil: VALID_UNTIL,
      submittedAt: NOW,
      correlationId: 'corr_01HR0QUOTE0003',
      idempotencyKey: 'idem_01HR0QUOTE0003',
      // Not a field. A supplier saying so does not make it so.
      invited: true,
    } as never),
    (error: unknown) => error instanceof QuoteError && error.code === 'foreign-concern',
  );
});

test('an offer arriving after the tender closed is refused', async () => {
  const harness = build();
  harness.tenders.close(RFQ, 'closed');

  await assert.rejects(
    anOffer(harness, { tag: '0004' }),
    (error: unknown) => error instanceof QuoteError && error.code === 'rfq-not-open',
  );
});

test('a full offer must cover the whole quantity, and no offer may exceed it', async () => {
  const harness = build();

  await assert.rejects(
    anOffer(harness, { tag: '0005', kind: 'full', quantity: 12n }),
    (error: unknown) =>
      error instanceof QuoteError &&
      error.code === 'malformed-quantity' &&
      /partial offer and should say so/.test(error.message),
  );

  await assert.rejects(
    anOffer(harness, { tag: '0006', kind: 'partial', quantity: 25n }),
    (error: unknown) =>
      error instanceof QuoteError && /more than was asked for/.test(error.message),
  );
});

test('a partial offer is accepted, because three of them make a split', async () => {
  const harness = build();
  const quote = await anOffer(harness, {
    tag: '0007',
    kind: 'partial',
    quantity: 12n,
    totalMinor: 15_000_000n,
  });

  assert.equal(quote.kind, 'partial');
  assert.equal(quote.quantity, 12n);
});

test('a substitute must declare what differs, and nothing else may', async () => {
  const harness = build();

  await assert.rejects(
    anOffer(harness, { tag: '0008', kind: 'substitute', substitutionNote: null }),
    (error: unknown) => error instanceof QuoteError && error.code === 'undeclared-substitution',
  );

  await assert.rejects(
    anOffer(harness, { tag: '0009', kind: 'full', substitutionNote: 'OPC 53 rather than 43' }),
    (error: unknown) => error instanceof QuoteError && error.code === 'undeclared-substitution',
  );

  const quote = await anOffer(harness, {
    tag: '0010',
    kind: 'substitute',
    substitutionNote: 'OPC 53 grade rather than OPC 43, same SLS 107 certification',
  });
  assert.equal(quote.kind, 'substitute');
});

test('a substitute is refused where the tender asked for exactly what it specified', async () => {
  const harness = build();

  await assert.rejects(
    anOffer(harness, {
      tag: '0011',
      rfqId: OTHER_RFQ,
      kind: 'substitute',
      quantity: 5n,
      substitutionNote: 'a different grade entirely',
    }),
    (error: unknown) => error instanceof QuoteError && error.code === 'substitution-not-permitted',
  );
});

test('an offer that expires as it arrives is not an offer', async () => {
  const harness = build();

  await assert.rejects(
    anOffer(harness, { tag: '0012', validUntil: NOW }),
    (error: unknown) => error instanceof QuoteError && error.code === 'malformed-validity',
  );
});

test('an amount arrives as a string or a safe integer, never as an unsafe double', async () => {
  const harness = build();

  const fromStrings = await anOffer(harness, {
    tag: '0013',
    unitPriceMinor: '1250000',
    totalMinor: '25000000',
  });
  assert.equal(fromStrings.totalMinor, 25_000_000n);

  await assert.rejects(
    anOffer(harness, { tag: '0014', totalMinor: 25_000_000.5 }),
    (error: unknown) => error instanceof QuoteError && error.code === 'malformed-amount',
  );
});

test('the landed total covers the goods it lands', async () => {
  // Above the subtotal is delivery, duties and handling. Below it there is no honest reading: it
  // says the stated unit price is not the price. M-11 opens an order from this pair -- a goods line
  // at the exact product plus a charges line for the rest -- so a negative remainder would surface
  // far downstream as an arithmetic error nobody could trace back to the offer.
  const harness = build();

  await assert.rejects(
    anOffer(harness, { tag: '0031', unitPriceMinor: 1_250_000n, totalMinor: 23_000_000n }),
    (error: unknown) =>
      error instanceof QuoteError &&
      error.code === 'malformed-amount' &&
      /a discount is a lower unit price/.test(error.message),
  );

  // Equality is fine and common: an ex-works offer with no delivery has nothing to add.
  const exWorks = await anOffer(harness, {
    tag: '0032',
    unitPriceMinor: 1_250_000n,
    totalMinor: 25_000_000n,
    deliveryTerms: 'ex-works',
  });
  assert.equal(exWorks.totalMinor, 25_000_000n);
});

test('the database refuses a landed total below the goods, not just the validator', () => {
  const migration = readFileSync(
    path.join(REPO_ROOT, 'db/migrations/0055_quote_total_covers_goods.up.sql'),
    'utf8',
  );
  assert.match(migration, /quote_total_covers_goods/);
  assert.match(migration, /total_minor >= quantity \* unit_price_minor/);
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

test('a retry of the same submission converges rather than creating a second offer', async () => {
  const harness = build();
  const first = await anOffer(harness, { tag: '0015' });

  // A retry arrives later, with a fresh correlation id, by definition. Neither may defeat
  // convergence — comparing them would report a retry as key reuse, and a supplier following that
  // advice would send a new key and offer twice.
  const second = await harness.service.submitQuote({
    quoteId: 'quo_01HR0QUOTE0015',
    rfqId: RFQ,
    supplierAccountId: SUPPLIER_A,
    kind: 'full',
    quantity: 20n,
    unitPriceMinor: 1_250_000n,
    totalMinor: 25_000_000n,
    currency: 'LKR',
    leadTimeDays: 5,
    deliveryTerms: 'delivered',
    validUntil: VALID_UNTIL,
    evidenceReferences: ['doc_01HR0QUOTEcert1'],
    submittedAt: LATER,
    correlationId: 'corr_01HR0QUOTEretry',
    idempotencyKey: 'idem_01HR0QUOTE0015',
  });

  assert.equal(second.replayed, true);
  assert.equal(second.quote.quoteId, first.quoteId);
  assert.equal(second.quote.submittedAt, NOW, 'the stored offer keeps its original instant');
  assert.equal((await harness.service.listQuotesForRfq(RFQ)).length, 1);
});

test('a different offer under the same key is refused, not answered with somebody else’s', async () => {
  // The dangerous half of idempotency. Converging here would hand this supplier the offer that key
  // belongs to and a 200, and they would believe they had quoted when they had not.
  const harness = build();
  await anOffer(harness, { tag: '0029', supplierAccountId: SUPPLIER_A });

  await assert.rejects(
    harness.service.submitQuote({
      quoteId: 'quo_01HR0QUOTE0030',
      rfqId: RFQ,
      supplierAccountId: SUPPLIER_B,
      kind: 'full',
      quantity: 20n,
      unitPriceMinor: 1_000_000n,
      totalMinor: 20_000_000n,
      currency: 'LKR',
      leadTimeDays: 3,
      deliveryTerms: 'delivered',
      validUntil: VALID_UNTIL,
      evidenceReferences: [],
      submittedAt: NOW,
      correlationId: 'corr_01HR0QUOTE0030',
      // The key already belongs to supplier A's offer.
      idempotencyKey: 'idem_01HR0QUOTE0029',
    }),
    (error: unknown) => error instanceof QuoteError && error.code === 'idempotency-key-reuse',
  );

  const offers = await harness.service.listQuotesForRfq(RFQ);
  assert.equal(offers.length, 1, 'and nothing was written');
});

test('a retried withdrawal converges on the withdrawal already recorded', async () => {
  const harness = build();
  await anOffer(harness, { tag: '0016' });

  const withdraw = {
    quoteId: 'quo_01HR0QUOTE0016',
    actingAccountId: SUPPLIER_A,
    reason: 'the cement went to another buyer this morning',
    occurredAt: LATER,
    correlationId: 'corr_01HR0QUOTEwd001',
    idempotencyKey: 'idem_01HR0QUOTEwd001',
  };

  const first = await harness.service.withdrawQuote(withdraw);
  const second = await harness.service.withdrawQuote({
    ...withdraw,
    correlationId: 'corr_01HR0QUOTEwd002',
  });

  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.equal(second.quote.status, 'withdrawn');
});

// ---------------------------------------------------------------------------
// Whose offer it is
// ---------------------------------------------------------------------------

test('a supplier cannot withdraw another supplier’s offer', async () => {
  // The cheapest way to win a tender would be to withdraw everybody else's offer.
  const harness = build();
  await anOffer(harness, { tag: '0017', supplierAccountId: SUPPLIER_A });

  await assert.rejects(
    harness.service.withdrawQuote({
      quoteId: 'quo_01HR0QUOTE0017',
      actingAccountId: SUPPLIER_B,
      reason: 'not mine to withdraw, which is the point',
      occurredAt: LATER,
      correlationId: 'corr_01HR0QUOTEwd003',
      idempotencyKey: 'idem_01HR0QUOTEwd003',
    }),
    (error: unknown) => error instanceof QuoteError && error.code === 'not-your-quote',
  );

  const held = await harness.service.getQuote('quo_01HR0QUOTE0017');
  assert.equal(held?.status, 'submitted', 'and the offer is untouched');
});

test('a supplier cannot accept their own offer', async () => {
  // The more dangerous direction, and the one an ownership check on the *offer* gets wrong: "is this
  // your quote?" answers yes for the supplier who wrote it. Choosing between offers is checked
  // against the tender instead, because a supplier who could accept their own has awarded themselves
  // the order.
  const harness = build();
  await anOffer(harness, { tag: '0033', supplierAccountId: SUPPLIER_A });

  for (const operation of ['acceptQuote', 'rejectQuote'] as const) {
    await assert.rejects(
      harness.service[operation]({
        quoteId: 'quo_01HR0QUOTE0033',
        actingAccountId: SUPPLIER_A,
        reason: 'awarding myself the order, which is the thing this must refuse',
        occurredAt: LATER,
        correlationId: `corr_01HR0QUOTEself${operation.slice(0, 3)}`,
        idempotencyKey: `idem_01HR0QUOTEslf${operation.slice(0, 3)}`,
      }),
      (error: unknown) => error instanceof QuoteError && error.code === 'not-your-tender',
      `${operation} let the supplier decide`,
    );
  }

  assert.equal((await harness.service.getQuote('quo_01HR0QUOTE0033'))?.status, 'submitted');
});

test('a stranger cannot accept an offer against somebody else’s tender', async () => {
  const harness = build();
  await anOffer(harness, { tag: '0034' });

  await assert.rejects(
    harness.service.acceptQuote({
      quoteId: 'quo_01HR0QUOTE0034',
      actingAccountId: SUPPLIER_C,
      reason: 'not my tender, and not my decision to take',
      occurredAt: LATER,
      correlationId: 'corr_01HR0QUOTEstrng1',
      idempotencyKey: 'idem_01HR0QUOTEstrng1',
    }),
    (error: unknown) => error instanceof QuoteError && error.code === 'not-your-tender',
  );
});

test('a supplier withdraws their own offer, and the record keeps both prices', async () => {
  const harness = build();
  await anOffer(harness, { tag: '0018', totalMinor: 25_000_000n });

  await harness.service.withdrawQuote({
    quoteId: 'quo_01HR0QUOTE0018',
    actingAccountId: SUPPLIER_A,
    reason: 'cement price moved; offering again at the new rate',
    occurredAt: LATER,
    correlationId: 'corr_01HR0QUOTEwd004',
    idempotencyKey: 'idem_01HR0QUOTEwd004',
  });

  await anOffer(harness, { tag: '0019', totalMinor: 27_500_000n, submittedAt: LATER });

  const offers = await harness.service.listQuotesForRfq(RFQ);
  assert.equal(offers.length, 2, 'changing a price leaves both offers on the record');
  assert.deepEqual(
    offers.map((one) => [one.status, one.totalMinor]),
    [
      ['withdrawn', 25_000_000n],
      ['submitted', 27_500_000n],
    ],
  );
});

// ---------------------------------------------------------------------------
// An offer binds
// ---------------------------------------------------------------------------

test('there is no way to edit an offer through the service', () => {
  const service = build().service;
  const surface = Object.getOwnPropertyNames(QuoteService.prototype).filter(
    (name) => name !== 'constructor',
  );

  assert.deepEqual(surface.sort(), [
    'acceptQuote',
    'evaluateQuotes',
    'getQuote',
    'listQuotesForRfq',
    'listQuotesForSupplier',
    'rejectQuote',
    'submitQuote',
    'withdrawQuote',
  ]);
  assert.ok(!surface.some((name) => /update|edit|amend|reprice/i.test(name)));
  assert.ok(service instanceof QuoteService);
});

test('the database refuses to change the terms of an offer, not just the service', () => {
  // Defence at the layer that survives a refactor. The service could gain an edit path by accident;
  // the trigger would still refuse it.
  const migration = readFileSync(
    path.join(REPO_ROOT, 'db/migrations/0053_create_module_quotes_schema.up.sql'),
    'utf8',
  );

  assert.match(migration, /quote_terms_are_immutable/);
  assert.match(migration, /NEW\.total_minor\s+IS DISTINCT FROM OLD\.total_minor/);
  assert.match(migration, /NEW\.quantity\s+IS DISTINCT FROM OLD\.quantity/);
  assert.match(migration, /NEW\.valid_until\s+IS DISTINCT FROM OLD\.valid_until/);
  assert.match(
    migration,
    /OLD\.status <> 'submitted' AND NEW\.status IS DISTINCT FROM OLD\.status/,
    'an offer that has ended cannot be reopened',
  );
  assert.match(migration, /quote_substitution_declared/);
  assert.match(migration, /quote_valid_after_submission/);
});

test('an ended offer cannot be moved again', async () => {
  const harness = build();
  await anOffer(harness, { tag: '0020' });

  await harness.service.withdrawQuote({
    quoteId: 'quo_01HR0QUOTE0020',
    actingAccountId: SUPPLIER_A,
    reason: 'withdrawn before anybody accepted it',
    occurredAt: LATER,
    correlationId: 'corr_01HR0QUOTEwd005',
    idempotencyKey: 'idem_01HR0QUOTEwd005',
  });

  await assert.rejects(
    harness.service.acceptQuote({
      quoteId: 'quo_01HR0QUOTE0020',
      actingAccountId: BUYER,
      reason: 'accepting an offer that no longer stands',
      occurredAt: '2026-07-01T12:00:00.000000Z',
      correlationId: 'corr_01HR0QUOTEac001',
      idempotencyKey: 'idem_01HR0QUOTEac001',
    }),
    (error: unknown) => error instanceof QuoteError && error.code === 'quote-closed',
  );
});

test('every terminal status is terminal in the transition table', () => {
  for (const status of ['withdrawn', 'expired', 'accepted', 'rejected'] as const) {
    assert.deepEqual(QUOTE_TRANSITIONS[status], [], `${status} must be terminal`);
  }
  assert.deepEqual(QUOTE_TRANSITIONS.submitted, ['withdrawn', 'expired', 'accepted', 'rejected']);
});

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

/** A quote built directly, for ranking tests that do not need the service. */
function offer(overrides: Partial<Quote> & { quoteId: string }): Quote {
  const quantity = overrides.quantity ?? 20n;
  const totalMinor = overrides.totalMinor ?? 25_000_000n;
  return validateQuote(
    {
      rfqId: RFQ,
      supplierAccountId: SUPPLIER_A,
      kind: 'full',
      status: 'submitted',
      quantity,
      unitPriceMinor: unitPriceFor(totalMinor, quantity),
      totalMinor,
      currency: 'LKR',
      leadTimeDays: 5,
      deliveryTerms: 'delivered',
      validUntil: VALID_UNTIL,
      substitutionNote: null,
      evidenceReferences: ['doc_01HR0QUOTEcert1'],
      submittedAt: NOW,
      updatedAt: NOW,
      closedAt: null,
      closureReason: null,
      correlationId: 'corr_01HR0QUOTErank1',
      idempotencyKey: `idem_${overrides.quoteId}`,
      ...overrides,
    },
    'request',
  );
}

function context(overrides: Partial<QuoteContext> = {}): QuoteContext {
  return {
    supplierReliabilityPerMille: {},
    quantityRequired: 20n,
    requiredBy: REQUIRED_BY,
    qualityRequirements: ['SLS 107 certified'],
    now: NOW,
    ...overrides,
  };
}

test('the cheapest offer is not automatically the best one', async () => {
  // The case the whole module exists for: 8% cheaper, three weeks late, from a supplier who has
  // failed before. A platform that recommends it teaches its customers to ignore the ranking.
  const cheapAndLate = offer({
    quoteId: 'quo_01HR0QUOTEcheap',
    supplierAccountId: SUPPLIER_B,
    totalMinor: 23_000_000n,
    leadTimeDays: 30,
  });
  const solid = offer({
    quoteId: 'quo_01HR0QUOTEsolid',
    supplierAccountId: SUPPLIER_A,
    totalMinor: 25_000_000n,
    leadTimeDays: 5,
  });

  const ranked = rankQuotes(
    [cheapAndLate, solid],
    context({ supplierReliabilityPerMille: { [SUPPLIER_A]: 900, [SUPPLIER_B]: 300 } }),
  );

  const recommended = ranked.find((one) => one.recommended);
  assert.equal(recommended?.quoteId, 'quo_01HR0QUOTEsolid');
  assert.ok(
    ranked.every((one) => one.scorePerMille >= 0 && one.scorePerMille <= 1000),
    'a score is an integer per mille',
  );
  assert.ok(
    ranked.every((one) => Number.isInteger(one.scorePerMille)),
    'never a float: a score stored as a double compares unequal to itself across a round trip',
  );
  await Promise.resolve();
});

test('the cheapest offer does win when nothing else separates them', () => {
  const cheap = offer({ quoteId: 'quo_01HR0QUOTEcheap2', totalMinor: 23_000_000n });
  const dear = offer({ quoteId: 'quo_01HR0QUOTEdear02', totalMinor: 25_000_000n });

  const ranked = rankQuotes([dear, cheap], context());
  assert.equal(ranked[0]?.quoteId, 'quo_01HR0QUOTEcheap2');
  assert.equal(ranked[0]?.rank, 1);
  assert.equal(ranked[1]?.rank, 2);
});

test('a supplier with no record is not treated as an unreliable one', () => {
  // Scoring an unknown supplier as zero would close the market to new entrants, which is the
  // opposite of what a sourcing platform is for.
  const known = offer({ quoteId: 'quo_01HR0QUOTEknown1', supplierAccountId: SUPPLIER_A });
  const stranger = offer({ quoteId: 'quo_01HR0QUOTEnewsup', supplierAccountId: SUPPLIER_C });

  const ranked = rankQuotes(
    [known, stranger],
    context({ supplierReliabilityPerMille: { [SUPPLIER_A]: 200 } }),
  );

  const strangerScore = ranked.find((one) => one.quoteId === 'quo_01HR0QUOTEnewsup');
  const knownScore = ranked.find((one) => one.quoteId === 'quo_01HR0QUOTEknown1');
  assert.ok(strangerScore !== undefined && knownScore !== undefined);
  assert.ok(strangerScore.scorePerMille > knownScore.scorePerMille, 'no record beats a bad record');
  assert.match(strangerScore.explanation, /no delivery record/);
  assert.match(knownScore.explanation, /delivery record 200 of 1000/);
});

test('each offer is scored against its own supplier’s record', () => {
  const a = offer({ quoteId: 'quo_01HR0QUOTErelia1', supplierAccountId: SUPPLIER_A });
  const b = offer({ quoteId: 'quo_01HR0QUOTErelia2', supplierAccountId: SUPPLIER_B });

  const ranked = rankQuotes(
    [a, b],
    context({ supplierReliabilityPerMille: { [SUPPLIER_A]: 950, [SUPPLIER_B]: 100 } }),
  );

  assert.equal(ranked.find((one) => one.quoteId === a.quoteId)?.factors.reliability, 950);
  assert.equal(ranked.find((one) => one.quoteId === b.quoteId)?.factors.reliability, 100);
});

test('an unavailable offer is shown with its reason rather than dropped', () => {
  // A customer looking at two offers when three suppliers were invited deserves to know that the
  // third withdrew.
  const live = offer({ quoteId: 'quo_01HR0QUOTElive01' });
  const withdrawn = offer({
    quoteId: 'quo_01HR0QUOTEgone01',
    status: 'withdrawn',
    totalMinor: 10_000_000n,
    closedAt: LATER,
    closureReason: 'no longer available',
  });
  const lapsed = offer({
    quoteId: 'quo_01HR0QUOTElapse1',
    validUntil: '2026-06-30T09:00:00.000000Z',
    totalMinor: 9_000_000n,
  });

  const ranked = rankQuotes([withdrawn, lapsed, live], context());

  assert.equal(ranked.length, 3, 'nothing is dropped');
  assert.equal(ranked[0]?.quoteId, 'quo_01HR0QUOTElive01', 'the available offer ranks first');
  assert.equal(ranked[0]?.recommended, true);
  assert.ok(
    ranked.slice(1).every((one) => one.ineligibleReason !== null && !one.recommended),
    'and nothing unavailable is ever recommended, however cheap',
  );
  assert.match(
    ranked.find((one) => one.quoteId === 'quo_01HR0QUOTElapse1')?.ineligibleReason ?? '',
    /validity has passed/,
  );
});

test('exactly one offer is recommended, and none when none can be accepted', () => {
  const ranked = rankQuotes(
    [
      offer({ quoteId: 'quo_01HR0QUOTEone001' }),
      offer({ quoteId: 'quo_01HR0QUOTEtwo001', totalMinor: 25_000_000n }),
    ],
    context(),
  );
  assert.equal(ranked.filter((one) => one.recommended).length, 1);

  const allGone = rankQuotes(
    [
      offer({
        quoteId: 'quo_01HR0QUOTEgone02',
        status: 'withdrawn',
        closedAt: LATER,
        closureReason: 'withdrawn',
      }),
    ],
    context(),
  );
  assert.equal(allGone.filter((one) => one.recommended).length, 0);
});

test('the weights are data, and a buyer who only cares about price can say so', () => {
  const cheapAndLate = offer({
    quoteId: 'quo_01HR0QUOTEweigh1',
    supplierAccountId: SUPPLIER_B,
    totalMinor: 23_000_000n,
    leadTimeDays: 30,
  });
  const solid = offer({ quoteId: 'quo_01HR0QUOTEweigh2', leadTimeDays: 5 });
  const reliability = { [SUPPLIER_A]: 900, [SUPPLIER_B]: 300 };

  const balanced = rankQuotes(
    [cheapAndLate, solid],
    context({ supplierReliabilityPerMille: reliability }),
  );
  const priceOnly = rankQuotes(
    [cheapAndLate, solid],
    context({ supplierReliabilityPerMille: reliability }),
    { weights: { cost: 1000, reliability: 0, leadTime: 0, completeness: 0, quality: 0 } },
  );

  assert.equal(balanced.find((one) => one.recommended)?.quoteId, 'quo_01HR0QUOTEweigh2');
  assert.equal(priceOnly.find((one) => one.recommended)?.quoteId, 'quo_01HR0QUOTEweigh1');
  assert.equal(
    Object.values(DEFAULT_WEIGHTS).reduce((sum, weight) => sum + weight, 0),
    1000,
    'the default weights are a whole',
  );
});

test('ranking the same offers twice produces the same order', () => {
  // A ranking that reshuffled on every page load would be one nobody could discuss with a supplier.
  const tied = [
    offer({ quoteId: 'quo_01HR0QUOTEtieB01' }),
    offer({ quoteId: 'quo_01HR0QUOTEtieA01' }),
  ];

  const first = rankQuotes(tied, context()).map((one) => one.quoteId);
  const second = rankQuotes([...tied].reverse(), context()).map((one) => one.quoteId);

  assert.deepEqual(first, second);
  assert.deepEqual(first, ['quo_01HR0QUOTEtieA01', 'quo_01HR0QUOTEtieB01']);
});

test('a partial offer is scored down but not excluded', () => {
  const full = offer({ quoteId: 'quo_01HR0QUOTEfull01' });
  const partial = offer({
    quoteId: 'quo_01HR0QUOTEpart01',
    kind: 'partial',
    quantity: 12n,
    totalMinor: 14_000_000n,
  });

  const ranked = rankQuotes([full, partial], context());
  const partialScore = ranked.find((one) => one.quoteId === partial.quoteId);

  assert.ok(partialScore !== undefined);
  assert.equal(partialScore.ineligibleReason, null, 'a partial offer can still be accepted');
  assert.equal(partialScore.factors.completeness, 600);
  assert.match(partialScore.explanation, /covers 12 of 20/);
});

test('a missed deadline is scored by how badly it is missed', () => {
  const soon = context({ requiredBy: '2026-07-08T09:00:00.000000Z', now: NOW });

  const onTime = rankQuotes([offer({ quoteId: 'quo_01HR0QUOTEdate01', leadTimeDays: 7 })], soon);
  const oneDayLate = rankQuotes(
    [offer({ quoteId: 'quo_01HR0QUOTEdate02', leadTimeDays: 8 })],
    soon,
  );
  const monthLate = rankQuotes(
    [offer({ quoteId: 'quo_01HR0QUOTEdate03', leadTimeDays: 40 })],
    soon,
  );

  assert.equal(onTime[0]?.factors.leadTime, 1000);
  assert.equal(oneDayLate[0]?.factors.leadTime, 600);
  assert.equal(monthLate[0]?.factors.leadTime, 0);
  assert.match(oneDayLate[0]?.explanation ?? '', /misses the date you asked for/);
});

test('a tender asking for certification scores an offer with no evidence at zero for quality', () => {
  const withEvidence = offer({ quoteId: 'quo_01HR0QUOTEcert01' });
  const without = offer({ quoteId: 'quo_01HR0QUOTEcert02', evidenceReferences: [] });

  const ranked = rankQuotes([withEvidence, without], context());
  assert.equal(ranked.find((one) => one.quoteId === withEvidence.quoteId)?.factors.quality, 1000);
  assert.equal(ranked.find((one) => one.quoteId === without.quoteId)?.factors.quality, 0);
});

// ---------------------------------------------------------------------------
// Choosing
// ---------------------------------------------------------------------------

test('the evaluation runs over live data and explains itself', async () => {
  const harness = build();
  await anOffer(harness, { tag: '0021', supplierAccountId: SUPPLIER_A, totalMinor: 25_000_000n });
  await anOffer(harness, {
    tag: '0022',
    supplierAccountId: SUPPLIER_B,
    totalMinor: 23_000_000n,
    leadTimeDays: 30,
  });

  const evaluations = await harness.service.evaluateQuotes({
    rfqId: RFQ,
    now: NOW,
    reliability: { [SUPPLIER_A]: 900, [SUPPLIER_B]: 300 },
  });

  assert.equal(evaluations.length, 2);
  assert.equal(evaluations[0]?.recommended, true);
  assert.equal(evaluations[0]?.quoteId, 'quo_01HR0QUOTE0021');
  assert.ok(
    evaluations.every((one) => one.explanation.length > 0),
    'every score says why, in words a customer could read',
  );
});

test('a customer may accept a valid offer the platform did not recommend', async () => {
  // A recommendation is advice. One that could not be overridden would be a decision taken from
  // the customer rather than a service rendered to them.
  const harness = build();
  await anOffer(harness, { tag: '0023', supplierAccountId: SUPPLIER_A, totalMinor: 25_000_000n });
  await anOffer(harness, {
    tag: '0024',
    supplierAccountId: SUPPLIER_B,
    totalMinor: 23_000_000n,
    leadTimeDays: 30,
  });

  const evaluations = await harness.service.evaluateQuotes({
    rfqId: RFQ,
    now: NOW,
    reliability: { [SUPPLIER_A]: 900, [SUPPLIER_B]: 300 },
  });
  const notRecommended = evaluations.find(
    (one) => !one.recommended && one.ineligibleReason === null,
  );
  assert.ok(notRecommended !== undefined, 'there is a valid offer that was not recommended');

  const accepted = await harness.service.acceptQuote({
    quoteId: notRecommended.quoteId,
    actingAccountId: BUYER,
    reason: 'we can wait, and the saving matters more than the date this time',
    occurredAt: LATER,
    correlationId: 'corr_01HR0QUOTEac002',
    idempotencyKey: 'idem_01HR0QUOTEac002',
  });

  assert.equal(accepted.quote.status, 'accepted');
  assert.equal(accepted.quote.quoteId, notRecommended.quoteId);
});

test('losing is recorded as rejection, not as expiry', async () => {
  // A supplier is owed the difference between "somebody else won" and "you were too slow": only one
  // of those is worth changing anything about next time.
  const harness = build();
  await anOffer(harness, { tag: '0025' });

  const rejected = await harness.service.rejectQuote({
    quoteId: 'quo_01HR0QUOTE0025',
    actingAccountId: BUYER,
    reason: 'another supplier could deliver a week earlier',
    occurredAt: LATER,
    correlationId: 'corr_01HR0QUOTErj001',
    idempotencyKey: 'idem_01HR0QUOTErj001',
  });

  assert.equal(rejected.quote.status, 'rejected');
  assert.equal(rejected.quote.closureReason, 'another supplier could deliver a week earlier');
});

// ---------------------------------------------------------------------------
// What travels, and what does not
// ---------------------------------------------------------------------------

test('no price travels in an event, and the audit record carries it', async () => {
  const harness = build();
  await anOffer(harness, { tag: '0026', totalMinor: 25_000_000n, unitPriceMinor: 1_250_000n });

  const entries = harness.repository.outbox().entries();
  const events = entries.filter((entry) => entry.kind === 'event');
  const audits = entries.filter((entry) => entry.kind === 'audit');

  assert.equal(events.length, 1);
  assert.equal(audits.length, 1);

  const published = JSON.stringify(events[0]?.payload);
  assert.ok(!published.includes('25000000'), 'the total must not travel');
  assert.ok(!published.includes('1250000'), 'nor the unit price');
  assert.ok(published.includes('quote.submitted'), 'the fact that an offer exists does travel');
  assert.ok(published.includes('LKR'), 'and the currency, which a consumer routes on');

  const recorded = JSON.stringify(audits[0]?.payload);
  assert.ok(
    recorded.includes('25000000'),
    'the audit trail answers what was agreed, and without the price it would not',
  );
});

test('a foreign field is refused by name, with the component that owns it', async () => {
  const harness = build();

  for (const field of ['orderId', 'listingId', 'score', 'rank', 'recommended', 'verified']) {
    await assert.rejects(
      harness.service.submitQuote({
        quoteId: 'quo_01HR0QUOTE0027',
        rfqId: RFQ,
        supplierAccountId: SUPPLIER_A,
        kind: 'full',
        quantity: 20n,
        unitPriceMinor: 1n,
        totalMinor: 20n,
        currency: 'LKR',
        leadTimeDays: 1,
        deliveryTerms: 'delivered',
        validUntil: VALID_UNTIL,
        submittedAt: NOW,
        correlationId: 'corr_01HR0QUOTE0027',
        idempotencyKey: 'idem_01HR0QUOTE0027',
        [field]: 'anything',
      }),
      (error: unknown) =>
        error instanceof QuoteError &&
        error.code === 'foreign-concern' &&
        error.message.includes(field),
      `${field} must be refused`,
    );
  }
});

test('a stored row that fails validation is refused rather than presented as a record', () => {
  assert.throws(
    () =>
      validateQuote(
        {
          quoteId: 'quo_01HR0QUOTEbad001',
          rfqId: RFQ,
          supplierAccountId: SUPPLIER_A,
          kind: 'full',
          status: 'submitted',
          quantity: 20n,
          unitPriceMinor: 1n,
          totalMinor: 20n,
          currency: 'LKR',
          leadTimeDays: 1,
          deliveryTerms: 'delivered',
          validUntil: VALID_UNTIL,
          substitutionNote: null,
          evidenceReferences: [],
          // A driver that parsed the timestamp rather than projecting it through to_char.
          submittedAt: new Date('2026-07-01T09:00:00Z'),
          updatedAt: NOW,
          closedAt: null,
          closureReason: null,
          correlationId: 'corr_01HR0QUOTEbad001',
          idempotencyKey: 'idem_01HR0QUOTEbad001',
        },
        'stored row',
      ),
    (error: unknown) =>
      error instanceof QuoteError &&
      error.code === 'malformed-record' &&
      /was not written by this component/.test(error.message),
  );
});

test('a returned offer cannot be mutated by its caller', async () => {
  const harness = build();
  const quote = await anOffer(harness, { tag: '0028' });

  assert.throws(() => {
    (quote as { status: string }).status = 'accepted';
  });
  assert.throws(() => {
    (quote.evidenceReferences as string[]).push('doc_01HR0QUOTEsneak');
  });
});

test('the module reads no clock and generates no randomness', () => {
  // Determinism is what lets a retry converge and a test pin time. A module that read a clock could
  // not be replayed, and one that minted an id could not be made idempotent.
  const directory = path.join(REPO_ROOT, 'modules/quotes');
  const forbidden = [/Date\.now\(/, /new Date\(/, /Math\.random\(/, /crypto\.randomUUID\(/];

  for (const file of [
    'service.ts',
    'repository.ts',
    'validate.ts',
    'registry.ts',
    'outbox.ts',
    'ranking.ts',
    'immutable.ts',
  ]) {
    const source = readFileSync(path.join(directory, file), 'utf8');
    for (const pattern of forbidden) {
      assert.ok(
        pattern.exec(source) === null,
        `${file} uses ${String(pattern)}; the caller supplies every instant and identifier`,
      );
    }
  }
});
