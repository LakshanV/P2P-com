/**
 * E2E-01 — FLOW A: somebody says what they need, JAYA finds it, and they buy it.
 *
 * The journey the whole sourcing ladder exists to make short. A customer states a Need in their own
 * words; the platform reads it; the ladder searches the catalogue and finds a supplier who already
 * has the goods; the customer places an order against that listing, pays for it, and sees it in
 * their cockpit. **No tender is opened**, and that is the point of the flow: a platform that turned
 * this into a request for quotations would have cost a customer days and four suppliers an
 * afternoon, to buy something that was already on a shelf.
 *
 * Everything here goes over a real socket, against a real database, as a real signed-in person, and
 * the cross-module steps go through the outbox and K-08 exactly as they would in production.
 *
 * What this journey deliberately does **not** hide:
 *
 *   * the payment provider is the mock — no live gateway adapter ships (BL-05);
 *   * the interpretation is recorded by a rule rather than by a model, because no model adapter
 *     ships either. What is being proved is the path, and the path is the same one a model's
 *     reading would travel.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { journey, liveTestOptions, type Journey, type Response } from './harness.ts';

const NOW = '2026-07-01T09:00:00.000000Z';

/** What the customer typed, awkward on purpose: an emoji, a newline, and a telephone number. */
const IN_THEIR_OWN_WORDS =
  '  20 tonnes of OPC 43 cement for Matale, by Friday 🙏\nRing me on 0771234567 if there is a delay.  ';

const READING = Object.freeze({
  commodity: 'cement',
  quantity: 20,
  unit: 'tonne',
  district: 'matale',
  grade: 'OPC 43',
});

const body = <T>(response: Response): T => response.body as T;
const ok = (response: Response, status: number, what: string): void => {
  assert.equal(response.status, status, `${what}: ${JSON.stringify(response.body)}`);
};

/** A supplier with cement actually in stock. */
async function supplierWithCement(context: Journey, accountId: string): Promise<void> {
  await context.listings.createListing({
    listingId: 'lst_e2e_flowa000001',
    accountId,
    commerceUnitTypeId: 'cut_e2e_flowa000001',
    createdAt: NOW,
    updatedAt: NOW,
    correlationId: 'corr_e2e_flowasetup',
    idempotencyKey: 'idem_e2e_flowa_lst1',
    recordId: 'rec_e2e_flowa000001',
  });
  await context.listings.publishListing({
    versionId: 'ver_e2e_flowa000001',
    listingId: 'lst_e2e_flowa000001',
    title: 'Ordinary Portland Cement, OPC 43',
    description: 'Bulk cement from a single works, delivered across Matale district.',
    unitPriceMinor: 1_250_000n,
    currency: 'LKR',
    quantityAvailable: 100n,
    inventoryMode: 'tracked',
    attributes: { commodity: 'cement', grade: 'OPC 43', district: 'matale', unit: 'tonne' },
    publishedAt: NOW,
    correlationId: 'corr_e2e_flowasetup',
    idempotencyKey: 'idem_e2e_flowa_ver1',
  });
  await context.listings.receiveInventory({
    movementId: 'mov_e2e_flowa000001',
    listingId: 'lst_e2e_flowa000001',
    versionId: 'ver_e2e_flowa000001',
    quantity: 100n,
    reason: 'opening stock at the works',
    occurredAt: NOW,
    correlationId: 'corr_e2e_flowasetup',
    idempotencyKey: 'idem_e2e_flowa_stk1',
  });
}

void test(
  'E2E-01: a Need is stated, matched from the catalogue, ordered and paid',
  liveTestOptions,
  async () => {
    await journey(async (context) => {
      const buyer = await context.signUp('flow-a-buyer', ['CUSTOMER']);
      const supplier = await context.signUp('flow-a-supplier', ['SUPPLIER']);
      await supplierWithCement(context, supplier.accountId);

      // -- 1. The customer says what they need, in their own words ------------
      const stated = await context.call(
        'POST',
        '/v1/needs',
        { channel: 'text', rawText: IN_THEIR_OWN_WORDS, neededBy: '2026-07-04T17:00:00.000000Z' },
        { as: buyer, key: 'idem_e2e_a_need' },
      );
      ok(stated, 201, 'stating a Need');
      const need = body<{ request: { requestId: string; rawText: string } }>(stated).request;

      assert.equal(
        need.rawText,
        IN_THEIR_OWN_WORDS,
        'the words survive the wire byte for byte, including the whitespace and the emoji',
      );

      // -- 2. The platform reads it -------------------------------------------
      const read = await context.call(
        'POST',
        `/v1/needs/${need.requestId}/interpretations`,
        {
          origin: 'rule',
          confidencePerMille: 880,
          structured: READING,
          rationale: 'commodity, grade, quantity, unit and district parsed from the stated Need',
        },
        { as: buyer, key: 'idem_e2e_a_interp' },
      );
      ok(read, 201, 'recording an interpretation');

      // -- 3. The ladder solves it, without asking the market ------------------
      const sourced = await context.call(
        'POST',
        `/v1/needs/${need.requestId}/sourcing`,
        {},
        { as: buyer, key: 'idem_e2e_a_source' },
      );
      ok(sourced, 201, 'running the sourcing ladder');
      const run = body<{
        run: { runId: string; outcome: string; satisfiedBy: string | null };
        attempts: readonly { rung: string; outcome: string }[];
        candidates: readonly {
          listingId: string | null;
          versionId: string | null;
          supplierAccountId: string;
          scorePerMille: number;
          explanation: string;
        }[];
      }>(sourced);

      assert.equal(run.run.outcome, 'matched', 'the catalogue answered, so nothing is tendered');
      assert.equal(run.run.satisfiedBy, 'catalogue');
      assert.equal(
        run.attempts.filter((one) => one.outcome === 'skipped').length,
        4,
        'the rungs above it were skipped, and recorded as skipped rather than as empty',
      );

      const match = run.candidates[0];
      assert.ok(match !== undefined, 'a match names what it found');
      assert.equal(match.supplierAccountId, supplier.accountId);
      assert.ok(match.scorePerMille >= 700, 'and it cleared the sufficiency threshold');
      assert.ok(match.explanation.length > 0, 'with a reason a customer could read');

      // -- 4. The customer buys it --------------------------------------------
      const created = await context.call(
        'POST',
        '/v1/orders',
        {
          sellerAccountId: supplier.accountId,
          currency: 'LKR',
          reason: 'matched from the catalogue by the sourcing ladder',
        },
        { as: buyer, key: 'idem_e2e_a_order' },
      );
      ok(created, 201, 'creating the order');
      const orderId = body<{ order: { orderId: string } }>(created).order.orderId;

      const line = await context.call(
        'POST',
        `/v1/orders/${orderId}/items`,
        {
          listingId: match.listingId,
          versionId: match.versionId,
          commerceUnitTypeId: 'cut_e2e_flowa000001',
          quantity: '20',
          unitPriceMinor: '1250000',
          lineTotalMinor: '25000000',
          currency: 'LKR',
        },
        { as: buyer, key: 'idem_e2e_a_item' },
      );
      ok(line, 201, 'adding the line');
      assert.ok(
        body<{ item: { reservationId: string | null } }>(line).item.reservationId !== null,
        'a tracked listing holds real stock for the line: the server reserved it, not the client',
      );

      const placed = await context.call(
        'POST',
        `/v1/orders/${orderId}/placement`,
        { expectedTotalMinor: '25000000', policyVersionId: null, reason: 'placed by the buyer' },
        { as: buyer, key: 'idem_e2e_a_place' },
      );
      ok(placed, 200, 'placing the order');

      const confirmed = await context.call(
        'POST',
        `/v1/orders/${orderId}/confirmation`,
        { reason: 'the works confirmed the load' },
        { as: supplier, key: 'idem_e2e_a_confirm' },
      );
      ok(confirmed, 200, 'the supplier confirming');

      // -- 5. And pays -------------------------------------------------------
      const requested = await context.call(
        'POST',
        '/v1/payments',
        {
          orderId,
          payeeAccountId: supplier.accountId,
          provider: 'mock',
          rail: 'card',
          // The provider's opaque handle, never an instrument. M-12 refuses a card number here, and
          // the schema refuses one that looks like a token but is not opaque.
          instrumentToken: 'tok_e2e_flowa000001',
          assetCode: 'LKR',
          assetScale: 2,
          amountMinor: '25000000',
          reason: 'paying for the cement',
        },
        { as: buyer, key: 'idem_e2e_a_pay' },
      );
      ok(requested, 201, 'requesting the payment');
      const paymentId = body<{ payment: { paymentId: string } }>(requested).payment.paymentId;

      const authorised = await context.call(
        'POST',
        `/v1/payments/${paymentId}/authorisation`,
        { amountMinor: '25000000', reason: 'authorised by the mock provider' },
        { as: buyer, key: 'idem_e2e_a_auth' },
      );
      ok(authorised, 200, 'authorising');

      const captured = await context.call(
        'POST',
        `/v1/payments/${paymentId}/capture`,
        { amountMinor: '25000000', reason: 'captured on despatch' },
        { as: supplier, key: 'idem_e2e_a_capture' },
      );
      ok(captured, 200, 'capturing');
      assert.equal(body<{ payment: { status: string } }>(captured).payment.status, 'captured');

      // -- 6. The platform settles what the journey produced -------------------
      const settled = await context.settle();
      assert.ok(
        settled.dispatched > 0,
        'the facts this journey committed reached K-08 and K-09 through the outbox',
      );

      // -- 7. The customer sees it in their cockpit ---------------------------
      const cockpit = await context.call(
        'GET',
        `/v1/accounts/${buyer.accountId}/orders`,
        undefined,
        { as: buyer },
      );
      ok(cockpit, 200, 'reading MY ORDERS');
      const mine = body<{ orders: readonly { orderId: string; status: string }[] }>(cockpit).orders;
      assert.equal(mine.length, 1);
      assert.equal(mine[0]?.orderId, orderId);

      const detail = await context.call('GET', `/v1/cockpit/orders/${orderId}`, undefined, {
        as: buyer,
      });
      ok(detail, 200, 'reading the order in detail');
      const view = body<{ order: { totalMinor: string }; payments: readonly unknown[] }>(detail);
      assert.equal(
        view.order.totalMinor,
        '25000000',
        'and the amount crosses the wire as a string, because a double cannot hold every one',
      );
      assert.equal(view.payments.length, 1, 'with the payment against it');

      // -- 8. Nothing was tendered --------------------------------------------
      const tenders = await context.call('GET', '/v1/rfqs', undefined, { as: buyer });
      ok(tenders, 200, 'listing tenders');
      assert.deepEqual(
        body<{ rfqs: readonly unknown[] }>(tenders).rfqs,
        [],
        'the whole point of the ladder: a Need the catalogue could answer never reached the market',
      );
    });
  },
);

void test(
  'E2E-01a: the stock the order held is committed when it completes',
  liveTestOptions,
  async () => {
    // The half that is easy to leave for later and expensive to. A reservation nobody resolves is
    // stock the platform believes is spoken for and nobody can buy — and it fails silently, in the
    // direction of lost revenue. This proves the consumer actually runs, through K-08, over the wire.
    await journey(async (context) => {
      const buyer = await context.signUp('flow-a2-buyer', ['CUSTOMER']);
      const supplier = await context.signUp('flow-a2-supplier', ['SUPPLIER']);
      await supplierWithCement(context, supplier.accountId);

      const created = await context.call(
        'POST',
        '/v1/orders',
        { sellerAccountId: supplier.accountId, currency: 'LKR', reason: 'a straightforward buy' },
        { as: buyer, key: 'idem_e2e_a2_order' },
      );
      const orderId = body<{ order: { orderId: string } }>(created).order.orderId;

      await context.call(
        'POST',
        `/v1/orders/${orderId}/items`,
        {
          listingId: 'lst_e2e_flowa000001',
          versionId: 'ver_e2e_flowa000001',
          commerceUnitTypeId: 'cut_e2e_flowa000001',
          quantity: '20',
          unitPriceMinor: '1250000',
          lineTotalMinor: '25000000',
          currency: 'LKR',
        },
        { as: buyer, key: 'idem_e2e_a2_item' },
      );

      const held = await context.listings.getAvailability(
        'lst_e2e_flowa000001',
        'ver_e2e_flowa000001',
      );
      assert.equal(held.reserved, 20n, 'the line holds real stock while the order is open');
      assert.equal(held.available, 80n);

      await context.call(
        'POST',
        `/v1/orders/${orderId}/placement`,
        { expectedTotalMinor: '25000000', policyVersionId: null, reason: 'placed' },
        { as: buyer, key: 'idem_e2e_a2_place' },
      );
      await context.call(
        'POST',
        `/v1/orders/${orderId}/confirmation`,
        { reason: 'confirmed' },
        { as: supplier, key: 'idem_e2e_a2_confirm' },
      );
      await context.call(
        'POST',
        `/v1/orders/${orderId}/fulfilment`,
        { reason: 'loaded and away' },
        { as: supplier, key: 'idem_e2e_a2_fulfil' },
      );
      const completed = await context.call(
        'POST',
        `/v1/orders/${orderId}/completion`,
        { reason: 'delivered and signed for' },
        { as: supplier, key: 'idem_e2e_a2_complete' },
      );
      ok(completed, 200, 'completing the order');

      // Before settlement nothing has consumed the hold: the event is written and not yet published.
      const beforeSettling = await context.listings.getAvailability(
        'lst_e2e_flowa000001',
        'ver_e2e_flowa000001',
      );
      assert.equal(beforeSettling.reserved, 20n, 'still held until the consumer runs');

      const settled = await context.settle();
      assert.ok(settled.delivered > 0, 'the completion reached the inventory consumer');

      const after = await context.listings.getAvailability(
        'lst_e2e_flowa000001',
        'ver_e2e_flowa000001',
      );
      assert.equal(after.reserved, 0n, 'the hold was consumed rather than left standing');
      assert.equal(after.onHand, 80n, 'and the goods left the warehouse');
      assert.equal(after.available, 80n);
    });
  },
);
