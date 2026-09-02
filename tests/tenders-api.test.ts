/**
 * The sourcing, tender and offer routes: the first place two different parties reach the same
 * object and must see different things.
 *
 * Every other route in this API has one party, or two who legitimately see the same record. A
 * tender does not. The buyer sees the offers and decides; the invited supplier sees the requirement
 * and answers it, and must see **nothing else** — not who else was asked, not what they offered, not
 * the ranking. That asymmetry is what this suite is mostly about, because it is the part with a
 * victim: a supplier who can read the other bids knows exactly what to undercut, and a sealed tender
 * where one party sees everybody's cards is an auction pretending to be a tender.
 *
 * The other half is the sourcing ladder made reachable. A customer states a Need, the platform tries
 * to solve it, and only when every rung fails does it *recommend* asking the market. The suite
 * proves both endings — a catalogue match, and an escalation — and that the escalation says which
 * rungs were tried rather than merely that nothing was found.
 *
 * The security cases are the ones the brief names: unauthenticated, wrong user, wrong role, another
 * party's object, and privilege escalation through the request body.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CommerceRequestService,
  InMemoryCommerceRequestRepository,
} from '../modules/commerce-request/index.ts';
import {
  FinancialLedgerService,
  InMemoryFinancialLedgerRepository,
  K10LedgerPort,
} from '../modules/financial-ledger/index.ts';
import { InMemoryLedgerRepository, LedgerService } from '../kernel/ledger-foundation/index.ts';
import { InMemoryOrderRepository, OrderService } from '../modules/orders/index.ts';
import {
  InMemoryPaymentRepository,
  PaymentService,
  resolveMockProvider,
} from '../modules/payments/index.ts';
import {
  InMemoryUniversalListingRepository,
  UniversalListingService,
} from '../modules/universal-listing/index.ts';
import { UserCockpitService } from '../modules/user-cockpit/index.ts';
import { buildApi } from '../apps/api/app.ts';
import { handleRequest } from '../platform/http/pipeline.ts';
import type { HttpResponse } from '../platform/http/types.ts';

import { identityStack, type SignedIn } from './helpers/api-identity.ts';
import { inMemoryTendering, type TenderingServices } from './helpers/tendering-services.ts';

const NOW = '2026-07-01T09:00:00.000000Z';
const CLOSES = '2026-07-08T17:00:00.000000Z';
const VALID_UNTIL = '2026-07-07T17:00:00.000000Z';

/** A reading of a Need the catalogue can answer, and one it cannot. */
const CEMENT = Object.freeze({
  commodity: 'cement',
  quantity: 20,
  unit: 'tonne',
  district: 'matale',
  grade: 'OPC 43',
});
const UNOBTAINABLE = Object.freeze({
  commodity: 'titanium-flange',
  quantity: 4,
  unit: 'unit',
  district: 'matale',
});

interface Harness {
  readonly call: (
    method: string,
    target: string,
    body?: unknown,
    options?: { readonly as?: SignedIn | null; readonly key?: string },
  ) => Promise<HttpResponse>;
  readonly buyer: SignedIn;
  readonly supplierA: SignedIn;
  readonly supplierB: SignedIn;
  readonly stranger: SignedIn;
  readonly listings: UniversalListingService;
  readonly services: TenderingServices;
}

const codeOf = (response: HttpResponse): string =>
  (response.body as { code?: string }).code ?? '(no code)';

const bodyOf = <T>(response: HttpResponse): T => response.body as T;

async function build(): Promise<Harness> {
  const orders = new OrderService(new InMemoryOrderRepository());
  const payments = new PaymentService(new InMemoryPaymentRepository(), resolveMockProvider);
  const journal = new LedgerService(new InMemoryLedgerRepository());
  const ledger = new FinancialLedgerService(
    new InMemoryFinancialLedgerRepository(),
    new K10LedgerPort(journal),
  );
  const listings = new UniversalListingService(new InMemoryUniversalListingRepository());
  const needs = new CommerceRequestService(new InMemoryCommerceRequestRepository());
  const services = inMemoryTendering(listings);

  const identity = await identityStack(NOW);
  const buyer = await identity.register({ handle: 'tender-buyer', roles: ['CUSTOMER'] });
  const supplierA = await identity.register({ handle: 'tender-supplier-a', roles: ['SUPPLIER'] });
  const supplierB = await identity.register({ handle: 'tender-supplier-b', roles: ['SUPPLIER'] });
  const stranger = await identity.register({ handle: 'tender-stranger', roles: ['CUSTOMER'] });

  const api = buildApi({
    services: {
      orders,
      payments,
      ledger,
      listings,
      needs,
      ...services,
      cockpit: new UserCockpitService({ orders, payments, ledger, journal }),
    },
    access: identity,
    clock: () => NOW,
  });

  let sequence = 0;
  const call: Harness['call'] = (method, target, body, options = {}) => {
    sequence += 1;
    const principal = options.as === undefined ? buyer : options.as;
    return handleRequest(api, {
      method,
      target,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(principal === null ? {} : { authorization: `Bearer ${principal.token}` }),
        'idempotency-key': options.key ?? `idem_tnd_${String(sequence).padStart(5, '0')}`,
        'x-correlation-id': `corr_01HR0TND${String(sequence).padStart(6, '0')}`,
      },
      body: body === undefined ? null : JSON.stringify(body),
    });
  };

  return { call, buyer, supplierA, supplierB, stranger, listings, services };
}

/** A published listing with stock, so the catalogue rung has something to find. */
async function publishCement(harness: Harness, supplier: SignedIn): Promise<void> {
  await harness.listings.createListing({
    listingId: 'lst_01HR0TND000001',
    accountId: supplier.accountId,
    commerceUnitTypeId: 'cut_01HR0TND000001',
    createdAt: NOW,
    updatedAt: NOW,
    correlationId: 'corr_01HR0TNDsetup1',
    idempotencyKey: 'idem_tnd_listing01',
    recordId: 'rec_01HR0TND000001',
  });
  await harness.listings.publishListing({
    versionId: 'ver_01HR0TND000001',
    listingId: 'lst_01HR0TND000001',
    title: 'Ordinary Portland Cement, OPC 43',
    description: 'Bulk cement, delivered across Matale district.',
    unitPriceMinor: 1_250_000n,
    currency: 'LKR',
    quantityAvailable: 100n,
    inventoryMode: 'tracked',
    attributes: { commodity: 'cement', grade: 'OPC 43', district: 'matale', unit: 'tonne' },
    publishedAt: NOW,
    correlationId: 'corr_01HR0TNDsetup1',
    idempotencyKey: 'idem_tnd_version01',
  });
  await harness.listings.receiveInventory({
    movementId: 'mov_01HR0TND000001',
    listingId: 'lst_01HR0TND000001',
    versionId: 'ver_01HR0TND000001',
    quantity: 100n,
    reason: 'opening stock',
    occurredAt: NOW,
    correlationId: 'corr_01HR0TNDsetup1',
    idempotencyKey: 'idem_tnd_stock01',
  });
}

/** A Need, stated and interpreted, ready to be sourced. */
async function aNeed(
  harness: Harness,
  tag: string,
  structured: Readonly<Record<string, unknown>>,
): Promise<string> {
  const created = await harness.call(
    'POST',
    '/v1/needs',
    { channel: 'text', rawText: 'I need cement in Matale by Friday. Ring 0771234567.' },
    { key: `idem_tnd_need_${tag}` },
  );
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const requestId = bodyOf<{ request: { requestId: string } }>(created).request.requestId;

  const read = await harness.call(
    'POST',
    `/v1/needs/${requestId}/interpretations`,
    {
      origin: 'rule',
      confidencePerMille: 850,
      structured,
      rationale: 'parsed from the stated Need by the deterministic rule reader',
    },
    { key: `idem_tnd_int_${tag}` },
  );
  assert.equal(read.status, 201, JSON.stringify(read.body));
  return requestId;
}

// ---------------------------------------------------------------------------
// Sourcing: solving the Need before publishing it
// ---------------------------------------------------------------------------

test('a Need the catalogue can answer is matched, not tendered', async () => {
  // The product decision, over HTTP: JAYA tries to solve the Need first. A platform that turned this
  // into a tender would be a request board.
  const harness = await build();
  await publishCement(harness, harness.supplierA);
  const requestId = await aNeed(harness, 'a1', CEMENT);

  const sourced = await harness.call(
    'POST',
    `/v1/needs/${requestId}/sourcing`,
    {},
    { key: 'idem_tnd_source_a1' },
  );

  assert.equal(sourced.status, 201, JSON.stringify(sourced.body));
  const result = bodyOf<{
    run: { outcome: string; satisfiedBy: string | null };
    candidates: readonly { supplierAccountId: string; explanation: string }[];
  }>(sourced);

  assert.equal(result.run.outcome, 'matched');
  assert.equal(result.run.satisfiedBy, 'catalogue');
  assert.ok(result.candidates.length > 0, 'the match names what it found');
  assert.equal(result.candidates[0]?.supplierAccountId, harness.supplierA.accountId);
  assert.ok(
    (result.candidates[0]?.explanation ?? '').length > 0,
    'and says why, in words a customer could read',
  );
});

test('a Need nothing can answer escalates, and says which rungs were tried', async () => {
  // The escalation a customer is owed an explanation for. "Nothing found" is not an explanation;
  // "the catalogue holds none, and no supplier directory is wired" is.
  const harness = await build();
  await publishCement(harness, harness.supplierA);
  const requestId = await aNeed(harness, 'b1', UNOBTAINABLE);

  const sourced = await harness.call(
    'POST',
    `/v1/needs/${requestId}/sourcing`,
    {},
    { key: 'idem_tnd_source_b1' },
  );

  assert.equal(sourced.status, 201, JSON.stringify(sourced.body));
  const result = bodyOf<{
    run: { outcome: string; satisfiedBy: string | null };
    attempts: readonly { rung: string; outcome: string; reason: string }[];
  }>(sourced);

  assert.equal(result.run.outcome, 'escalate-to-rfq');
  assert.equal(result.run.satisfiedBy, null);
  assert.deepEqual(
    result.attempts.map((one) => one.rung),
    ['catalogue', 'known', 'verified', 'external', 'rfq'],
    'every rung is recorded, including the ones that were not wired',
  );

  const catalogue = result.attempts.find((one) => one.rung === 'catalogue');
  assert.ok(catalogue !== undefined);
  assert.ok(
    catalogue.outcome === 'empty' || catalogue.outcome === 'insufficient',
    'the catalogue looked and did not answer, which is not the same as not looking',
  );

  const known = result.attempts.find((one) => one.rung === 'known');
  assert.equal(
    known?.outcome,
    'unavailable',
    'a rung with no adapter says so rather than reporting an absence of supply nobody established',
  );
  assert.ok(result.attempts.every((one) => one.reason.length > 0));
});

test('a Need with no interpretation is refused rather than sourced against nothing', async () => {
  const harness = await build();
  const created = await harness.call(
    'POST',
    '/v1/needs',
    { channel: 'text', rawText: 'something, urgently' },
    { key: 'idem_tnd_need_c1' },
  );
  const requestId = bodyOf<{ request: { requestId: string } }>(created).request.requestId;

  const sourced = await harness.call(
    'POST',
    `/v1/needs/${requestId}/sourcing`,
    {},
    { key: 'idem_tnd_source_c1' },
  );
  assert.equal(sourced.status, 409);
  assert.equal(codeOf(sourced), 'need-not-interpreted');
});

test('a caller cannot supply the reading the ladder searches with', async () => {
  const harness = await build();
  const requestId = await aNeed(harness, 'd1', CEMENT);

  const sourced = await harness.call(
    'POST',
    `/v1/needs/${requestId}/sourcing`,
    { structured: { commodity: 'gold' } },
    { key: 'idem_tnd_source_d1' },
  );
  assert.equal(sourced.status, 400);
  assert.equal(codeOf(sourced), 'caller-asserted-sourcing-field');
});

test('a stranger cannot source somebody else’s Need, and cannot tell it exists', async () => {
  const harness = await build();
  const requestId = await aNeed(harness, 'e1', CEMENT);

  const sourced = await harness.call(
    'POST',
    `/v1/needs/${requestId}/sourcing`,
    {},
    { as: harness.stranger, key: 'idem_tnd_source_e1' },
  );
  assert.equal(sourced.status, 404, 'absent and forbidden are answered identically');
});

// ---------------------------------------------------------------------------
// The tender, and the two parties
// ---------------------------------------------------------------------------

/** Open a tender for an unsourceable Need, and invite one supplier. */
async function aTender(harness: Harness, tag: string): Promise<string> {
  const requestId = await aNeed(harness, tag, UNOBTAINABLE);
  const opened = await harness.call(
    'POST',
    '/v1/rfqs',
    {
      requestId,
      visibility: 'private',
      structured: UNOBTAINABLE,
      itemDescription: 'Titanium flange, 4 units, DN80 PN16, delivered to Matale',
      substitutionPolicy: 'equivalent-with-disclosure',
      qualityRequirements: ['ISO 9001 certified'],
      closesAt: CLOSES,
    },
    { key: `idem_tnd_open_${tag}` },
  );
  assert.equal(opened.status, 201, JSON.stringify(opened.body));
  const rfqId = bodyOf<{ rfq: { rfqId: string } }>(opened).rfq.rfqId;

  const invited = await harness.call(
    'POST',
    `/v1/rfqs/${rfqId}/invitations`,
    {
      supplier: harness.supplierA.accountId,
      sourceRung: 'verified',
      reason: 'verified for machined parts in this district, with prior deliveries on record',
    },
    { key: `idem_tnd_invite_${tag}` },
  );
  assert.equal(invited.status, 201, JSON.stringify(invited.body));
  return rfqId;
}

test('a buyer opens a tender, and its specification carries none of the customer’s words', async () => {
  const harness = await build();
  const rfqId = await aTender(harness, 'f1');

  const read = await harness.call('GET', `/v1/rfqs/${rfqId}`);
  assert.equal(read.status, 200);
  const published = JSON.stringify(read.body);

  assert.ok(!published.includes('0771234567'), 'no telephone number reaches a supplier');
  assert.ok(!published.includes('Ring'), 'and none of the sentence the customer wrote');
  assert.ok(published.includes('titanium-flange'), 'the structured requirement does travel');
});

test('an invited supplier reads the tender; a stranger cannot tell it exists', async () => {
  const harness = await build();
  const rfqId = await aTender(harness, 'g1');

  const invited = await harness.call('GET', `/v1/rfqs/${rfqId}`, undefined, {
    as: harness.supplierA,
  });
  assert.equal(invited.status, 200, 'a tender they cannot read is one they cannot answer');

  const uninvited = await harness.call('GET', `/v1/rfqs/${rfqId}`, undefined, {
    as: harness.supplierB,
  });
  assert.equal(uninvited.status, 404);

  const stranger = await harness.call('GET', `/v1/rfqs/${rfqId}`, undefined, {
    as: harness.stranger,
  });
  assert.equal(stranger.status, 404);
});

test('an invited supplier cannot see who else was asked', async () => {
  // Reading this is knowing exactly who you are bidding against, which a sealed tender tells nobody.
  const harness = await build();
  const rfqId = await aTender(harness, 'h1');

  const asBuyer = await harness.call('GET', `/v1/rfqs/${rfqId}/invitations`);
  assert.equal(asBuyer.status, 200);
  assert.equal(bodyOf<{ invitations: readonly unknown[] }>(asBuyer).invitations.length, 1);

  const asSupplier = await harness.call('GET', `/v1/rfqs/${rfqId}/invitations`, undefined, {
    as: harness.supplierA,
  });
  assert.equal(asSupplier.status, 404, 'even though they may reach the tender itself');
});

test('an invited supplier cannot invite anybody', async () => {
  // Otherwise a supplier could pack a tender with friends, or simply find out it is possible.
  const harness = await build();
  const rfqId = await aTender(harness, 'i1');

  const response = await harness.call(
    'POST',
    `/v1/rfqs/${rfqId}/invitations`,
    {
      supplier: harness.supplierB.accountId,
      reason: 'inviting a competitor, which is not mine to do',
    },
    { as: harness.supplierA, key: 'idem_tnd_invite_i2' },
  );
  // 403 rather than 404: K-04 refuses first, because a SUPPLIER holds no `update` on a tender at
  // all. They never reach the handler that would have compared them against its buyer.
  assert.equal(response.status, 403);
});

test('a caller cannot open a tender in somebody else’s name', async () => {
  const harness = await build();
  const requestId = await aNeed(harness, 'j1', UNOBTAINABLE);

  for (const field of ['accountId', 'buyerAccountId']) {
    const response = await harness.call(
      'POST',
      '/v1/rfqs',
      {
        requestId,
        visibility: 'private',
        structured: UNOBTAINABLE,
        itemDescription: 'Titanium flange, 4 units',
        substitutionPolicy: 'none',
        closesAt: CLOSES,
        [field]: harness.stranger.accountId,
      },
      { key: `idem_tnd_open_j_${field.slice(0, 6)}` },
    );
    assert.equal(response.status, 400, `"${field}" was accepted`);
    assert.equal(codeOf(response), 'caller-asserted-tender-field');
  }
});

// ---------------------------------------------------------------------------
// Offers
// ---------------------------------------------------------------------------

/** An offer from supplier A against a tender they were invited to. */
async function anOffer(harness: Harness, rfqId: string, tag: string): Promise<string> {
  const offered = await harness.call(
    'POST',
    `/v1/rfqs/${rfqId}/quotes`,
    {
      kind: 'full',
      quantity: '4',
      unitPriceMinor: '4500000',
      totalMinor: '18600000',
      currency: 'LKR',
      leadTimeDays: 12,
      deliveryTerms: 'delivered',
      validUntil: VALID_UNTIL,
      evidenceReferences: ['doc_01HR0TNDcert001'],
    },
    { as: harness.supplierA, key: `idem_tnd_quote_${tag}` },
  );
  assert.equal(offered.status, 201, JSON.stringify(offered.body));
  return bodyOf<{ quote: { quoteId: string } }>(offered).quote.quoteId;
}

test('an invited supplier offers, and an uninvited one cannot', async () => {
  const harness = await build();
  const rfqId = await aTender(harness, 'k1');

  const quoteId = await anOffer(harness, rfqId, 'k1');
  assert.ok(quoteId.length > 0);

  const uninvited = await harness.call(
    'POST',
    `/v1/rfqs/${rfqId}/quotes`,
    {
      kind: 'full',
      quantity: '4',
      unitPriceMinor: '4000000',
      totalMinor: '16000000',
      currency: 'LKR',
      leadTimeDays: 10,
      deliveryTerms: 'delivered',
      validUntil: VALID_UNTIL,
    },
    { as: harness.supplierB, key: 'idem_tnd_quote_k2' },
  );
  assert.equal(uninvited.status, 404, 'they cannot reach the tender, let alone quote for it');
});

test('a supplier cannot read the other offers, and the buyer can', async () => {
  // The case with the sharpest edge: knowing the other bids is knowing what to undercut.
  const harness = await build();
  const rfqId = await aTender(harness, 'l1');
  await anOffer(harness, rfqId, 'l1');

  const asBuyer = await harness.call('GET', `/v1/rfqs/${rfqId}/quotes`);
  assert.equal(asBuyer.status, 200);
  assert.equal(bodyOf<{ quotes: readonly unknown[] }>(asBuyer).quotes.length, 1);

  const asSupplier = await harness.call('GET', `/v1/rfqs/${rfqId}/quotes`, undefined, {
    as: harness.supplierA,
  });
  assert.equal(asSupplier.status, 404);

  const ranking = await harness.call('GET', `/v1/rfqs/${rfqId}/evaluation`, undefined, {
    as: harness.supplierA,
  });
  assert.equal(ranking.status, 404, 'nor the ranking');
});

test('a supplier sees their own offer and their own inbox', async () => {
  const harness = await build();
  const rfqId = await aTender(harness, 'm1');
  const quoteId = await anOffer(harness, rfqId, 'm1');

  const own = await harness.call('GET', `/v1/quotes/${quoteId}`, undefined, {
    as: harness.supplierA,
  });
  assert.equal(own.status, 200);

  const inbox = await harness.call('GET', '/v1/invitations', undefined, { as: harness.supplierA });
  assert.equal(inbox.status, 200);
  assert.equal(bodyOf<{ invitations: readonly unknown[] }>(inbox).invitations.length, 1);

  const otherInbox = await harness.call('GET', '/v1/invitations', undefined, {
    as: harness.supplierB,
  });
  assert.equal(
    bodyOf<{ invitations: readonly unknown[] }>(otherInbox).invitations.length,
    0,
    'scoped by construction: there is no parameter to get wrong',
  );
});

test('a supplier cannot accept their own offer', async () => {
  // The privilege escalation this whole file exists to refuse. Object-level ownership answers yes —
  // it *is* their quote — so the check has to be against the tender's buyer instead.
  const harness = await build();
  const rfqId = await aTender(harness, 'n1');
  const quoteId = await anOffer(harness, rfqId, 'n1');

  const response = await harness.call(
    'POST',
    `/v1/quotes/${quoteId}/acceptance`,
    { reason: 'awarding myself the order' },
    { as: harness.supplierA, key: 'idem_tnd_accept_n1' },
  );

  // 403 rather than 409: K-04 refuses first, because a SUPPLIER holds no `decide` capability at
  // all. M-10 refuses it a second time with `not-your-tender` -- proved in `tests/quotes.test.ts`
  // -- and two layers refusing is the point of splitting the verb.
  assert.equal(response.status, 403);
  assert.equal(codeOf(response), 'not-permitted');
});

test('a supplier withdraws their own offer and nobody else’s', async () => {
  const harness = await build();
  const rfqId = await aTender(harness, 'o1');
  const quoteId = await anOffer(harness, rfqId, 'o1');

  const stranger = await harness.call(
    'POST',
    `/v1/quotes/${quoteId}/withdrawal`,
    { reason: 'removing a competitor, which is not mine to do' },
    { as: harness.supplierB, key: 'idem_tnd_withdraw_o2' },
  );
  assert.equal(stranger.status, 404, 'they cannot even reach the offer');

  const own = await harness.call(
    'POST',
    `/v1/quotes/${quoteId}/withdrawal`,
    { reason: 'the flanges went to another buyer this morning' },
    { as: harness.supplierA, key: 'idem_tnd_withdraw_o1' },
  );
  assert.equal(own.status, 200);
  assert.equal(bodyOf<{ quote: { status: string } }>(own).quote.status, 'withdrawn');
});

test('the buyer ranks the offers, and may accept one the platform did not recommend', async () => {
  const harness = await build();
  const rfqId = await aTender(harness, 'p1');
  const first = await anOffer(harness, rfqId, 'p1');

  // A second offer from the same supplier, cheaper but far slower, so the ranking has a decision to
  // make rather than a single candidate.
  const invited = await harness.call(
    'POST',
    `/v1/rfqs/${rfqId}/quotes`,
    {
      kind: 'full',
      quantity: '4',
      unitPriceMinor: '3500000',
      totalMinor: '14000000',
      currency: 'LKR',
      leadTimeDays: 90,
      deliveryTerms: 'ex-works',
      validUntil: VALID_UNTIL,
    },
    { as: harness.supplierA, key: 'idem_tnd_quote_p2' },
  );
  assert.equal(invited.status, 201, JSON.stringify(invited.body));
  const second = bodyOf<{ quote: { quoteId: string } }>(invited).quote.quoteId;

  const ranked = await harness.call('GET', `/v1/rfqs/${rfqId}/evaluation`);
  assert.equal(ranked.status, 200);
  const evaluations = bodyOf<{
    evaluations: readonly {
      quoteId: string;
      rank: number;
      recommended: boolean;
      explanation: string;
    }[];
  }>(ranked).evaluations;

  assert.equal(evaluations.length, 2);
  assert.equal(evaluations.filter((one) => one.recommended).length, 1);
  assert.ok(evaluations.every((one) => one.explanation.length > 0));

  const notRecommended = evaluations.find((one) => !one.recommended);
  assert.ok(notRecommended !== undefined);
  assert.ok([first, second].includes(notRecommended.quoteId));

  const accepted = await harness.call(
    'POST',
    `/v1/quotes/${notRecommended.quoteId}/acceptance`,
    { reason: 'we can wait, and the saving matters more than the date this time' },
    { key: 'idem_tnd_accept_p1' },
  );
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal(bodyOf<{ quote: { status: string } }>(accepted).quote.status, 'accepted');
});

test('the buyer awards the tender, and a second different award is refused', async () => {
  const harness = await build();
  const rfqId = await aTender(harness, 'q1');
  const quoteId = await anOffer(harness, rfqId, 'q1');

  const awarded = await harness.call(
    'POST',
    `/v1/rfqs/${rfqId}/award`,
    { quoteId, reason: 'the only offer that met the specification' },
    { key: 'idem_tnd_award_q1' },
  );
  assert.equal(awarded.status, 200, JSON.stringify(awarded.body));
  assert.equal(bodyOf<{ rfq: { awardedQuoteId: string } }>(awarded).rfq.awardedQuoteId, quoteId);

  const again = await harness.call(
    'POST',
    `/v1/rfqs/${rfqId}/award`,
    { quoteId: 'quo_01HR0TNDother01', reason: 'a second decision, not a retry of the first' },
    { key: 'idem_tnd_award_q2' },
  );
  assert.equal(again.status, 422);
  assert.equal(codeOf(again), 'illegal-transition');
});

// ---------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------

test('every tender and sourcing route refuses an unauthenticated caller', async () => {
  const harness = await build();
  const rfqId = await aTender(harness, 'r1');

  const targets: ReadonlyArray<readonly [string, string]> = [
    ['GET', '/v1/rfqs'],
    ['POST', '/v1/rfqs'],
    ['GET', `/v1/rfqs/${rfqId}`],
    ['POST', `/v1/rfqs/${rfqId}/invitations`],
    ['GET', `/v1/rfqs/${rfqId}/invitations`],
    ['GET', `/v1/rfqs/${rfqId}/quotes`],
    ['POST', `/v1/rfqs/${rfqId}/quotes`],
    ['GET', `/v1/rfqs/${rfqId}/evaluation`],
    ['POST', `/v1/rfqs/${rfqId}/award`],
    ['GET', '/v1/quotes'],
    ['GET', '/v1/invitations'],
    ['GET', '/v1/sourcing-runs/mrun_01HR0TNDnothing'],
  ];

  for (const [method, target] of targets) {
    const response = await harness.call(method, target, method === 'POST' ? {} : undefined, {
      as: null,
      key: `idem_tnd_anon_${target.length}${method}`,
    });
    assert.equal(response.status, 401, `${method} ${target} answered ${String(response.status)}`);
  }
});

test('a customer cannot quote and a supplier cannot open a tender', async () => {
  // Role separation, not object ownership: neither call is refused because of *which* object it
  // names.
  const harness = await build();
  const rfqId = await aTender(harness, 's1');

  const customerQuotes = await harness.call(
    'POST',
    `/v1/rfqs/${rfqId}/quotes`,
    {
      kind: 'full',
      quantity: '4',
      unitPriceMinor: '1',
      totalMinor: '4',
      currency: 'LKR',
      leadTimeDays: 1,
      deliveryTerms: 'delivered',
      validUntil: VALID_UNTIL,
    },
    { as: harness.stranger, key: 'idem_tnd_role_s1' },
  );
  assert.equal(customerQuotes.status, 403, 'a CUSTOMER holds no quote capability at all');

  const supplierOpens = await harness.call(
    'POST',
    '/v1/rfqs',
    {
      requestId: 'req_01HR0TNDnothing1',
      visibility: 'private',
      structured: UNOBTAINABLE,
      itemDescription: 'Titanium flange',
      substitutionPolicy: 'none',
      closesAt: CLOSES,
    },
    { as: harness.supplierA, key: 'idem_tnd_role_s2' },
  );
  assert.equal(supplierOpens.status, 403, 'a SUPPLIER holds no create-rfq capability');
});

test('a sourcing run is readable only by the person whose Need it answers', async () => {
  const harness = await build();
  await publishCement(harness, harness.supplierA);
  const requestId = await aNeed(harness, 't1', CEMENT);

  const sourced = await harness.call(
    'POST',
    `/v1/needs/${requestId}/sourcing`,
    {},
    { key: 'idem_tnd_source_t1' },
  );
  const runId = bodyOf<{ run: { runId: string } }>(sourced).run.runId;

  const own = await harness.call('GET', `/v1/sourcing-runs/${runId}`);
  assert.equal(own.status, 200);

  const stranger = await harness.call('GET', `/v1/sourcing-runs/${runId}`, undefined, {
    as: harness.stranger,
  });
  assert.equal(stranger.status, 404);
});
