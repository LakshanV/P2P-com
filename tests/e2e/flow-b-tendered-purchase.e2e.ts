/**
 * E2E-02 — FLOW B: nobody has it, so JAYA asks, and the answer becomes an order.
 *
 * The other half of the product, and the harder half to get right. The customer states a Need; the
 * ladder searches and finds nothing; the platform **recommends** a tender rather than opening one;
 * the buyer opens it and invites two suppliers; both offer; the platform ranks the offers and
 * explains each score; the buyer chooses; and the accepted offer becomes a placed, confirmed order
 * without anybody typing it in again.
 *
 * The last step is the one that only an end-to-end test can prove. The buyer's acceptance commits a
 * quote row and an outbox row in one transaction; the relay publishes it to K-08; K-08 delivers it
 * to a consumer in `apps/`; and the consumer reads the terms from M-10 and the buyer from M-09 and
 * opens the order. Four components and two module boundaries, none of which an API test crosses.
 *
 * The suite also proves what the two parties may **not** see, over the wire, because that is where
 * the failure would have a victim: an invited supplier reading the other offers would know exactly
 * what to undercut.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { journey, liveTestOptions, type Response } from './harness.ts';

const CLOSES = '2026-07-08T17:00:00.000000Z';
const VALID_UNTIL = '2026-07-07T17:00:00.000000Z';

const READING = Object.freeze({
  commodity: 'titanium-flange',
  quantity: 4,
  unit: 'unit',
  district: 'matale',
  standard: 'DN80 PN16',
});

const body = <T>(response: Response): T => response.body as T;
const ok = (response: Response, status: number, what: string): void => {
  assert.equal(response.status, status, `${what}: ${JSON.stringify(response.body)}`);
};

void test(
  'E2E-02: a Need nothing can answer becomes a tender, an offer, and an order',
  liveTestOptions,
  async () => {
    await journey(async (context) => {
      const buyer = await context.signUp('flow-b-buyer', ['CUSTOMER']);
      const fast = await context.signUp('flow-b-fast', ['SUPPLIER']);
      const cheap = await context.signUp('flow-b-cheap', ['SUPPLIER']);

      // -- 1. The Need, and the platform's reading of it ----------------------
      const stated = await context.call(
        'POST',
        '/v1/needs',
        {
          channel: 'text',
          rawText: 'I need 4 titanium flanges, DN80 PN16, in Matale. Call 0771234567.',
        },
        { as: buyer, key: 'idem_e2e_b_need' },
      );
      ok(stated, 201, 'stating a Need');
      const requestId = body<{ request: { requestId: string } }>(stated).request.requestId;

      ok(
        await context.call(
          'POST',
          `/v1/needs/${requestId}/interpretations`,
          {
            origin: 'rule',
            confidencePerMille: 820,
            structured: READING,
            rationale: 'commodity, standard, quantity and district parsed from the stated Need',
          },
          { as: buyer, key: 'idem_e2e_b_interp' },
        ),
        201,
        'recording an interpretation',
      );

      // -- 2. The ladder tries everything, and recommends asking ---------------
      const sourced = await context.call(
        'POST',
        `/v1/needs/${requestId}/sourcing`,
        {},
        { as: buyer, key: 'idem_e2e_b_source' },
      );
      ok(sourced, 201, 'running the sourcing ladder');
      const run = body<{
        run: { runId: string; outcome: string };
        attempts: readonly { rung: string; outcome: string; reason: string }[];
      }>(sourced);

      assert.equal(run.run.outcome, 'escalate-to-rfq');
      assert.deepEqual(
        run.attempts.map((one) => one.rung),
        ['catalogue', 'known', 'verified', 'external', 'rfq'],
        'every rung is on the record, which is what makes the escalation explainable',
      );
      assert.ok(
        run.attempts.every((one) => one.reason.length > 0),
        'and each says why it did not answer',
      );

      // The ladder recommends; it does not act. A customer whose Need went to the market without
      // their asking would have discovered a tender in their name.
      const beforeOpening = await context.call('GET', '/v1/rfqs', undefined, { as: buyer });
      assert.deepEqual(body<{ rfqs: readonly unknown[] }>(beforeOpening).rfqs, []);

      // -- 3. The buyer opens the tender and invites two suppliers -------------
      const opened = await context.call(
        'POST',
        '/v1/rfqs',
        {
          requestId,
          matchRunId: run.run.runId,
          visibility: 'private',
          structured: READING,
          itemDescription: 'Titanium flange, DN80 PN16, 4 units, delivered to Matale',
          substitutionPolicy: 'equivalent-with-disclosure',
          qualityRequirements: ['ISO 9001 certified'],
          closesAt: CLOSES,
        },
        { as: buyer, key: 'idem_e2e_b_open' },
      );
      ok(opened, 201, 'opening the tender');
      const rfqId = body<{ rfq: { rfqId: string } }>(opened).rfq.rfqId;

      for (const [supplier, key] of [
        [fast, 'idem_e2e_b_inv1'],
        [cheap, 'idem_e2e_b_inv2'],
      ] as const) {
        ok(
          await context.call(
            'POST',
            `/v1/rfqs/${rfqId}/invitations`,
            {
              supplier: supplier.accountId,
              sourceRung: 'verified',
              reason: 'verified for machined parts in this district, and asked for that reason',
            },
            { as: buyer, key },
          ),
          201,
          'inviting a supplier',
        );
      }

      // The tender a supplier sees carries the requirement and none of the customer's sentence.
      const asSupplier = await context.call('GET', `/v1/rfqs/${rfqId}`, undefined, { as: fast });
      ok(asSupplier, 200, 'an invited supplier reading the tender');
      const seen = JSON.stringify(asSupplier.body);
      assert.ok(!seen.includes('0771234567'), 'no telephone number crosses to a supplier');
      assert.ok(!seen.includes('Call '), 'and none of the words the customer wrote');
      assert.ok(seen.includes('titanium-flange'), 'the structured requirement does');

      // -- 4. Both suppliers offer --------------------------------------------
      const fastOffer = await context.call(
        'POST',
        `/v1/rfqs/${rfqId}/quotes`,
        {
          kind: 'full',
          quantity: '4',
          unitPriceMinor: '4500000',
          totalMinor: '18600000',
          currency: 'LKR',
          leadTimeDays: 6,
          deliveryTerms: 'delivered',
          validUntil: VALID_UNTIL,
          evidenceReferences: ['doc_e2e_flowbcert01'],
        },
        { as: fast, key: 'idem_e2e_b_quote1' },
      );
      ok(fastOffer, 201, 'the first offer');
      const fastQuoteId = body<{ quote: { quoteId: string } }>(fastOffer).quote.quoteId;

      const cheapOffer = await context.call(
        'POST',
        `/v1/rfqs/${rfqId}/quotes`,
        {
          kind: 'full',
          quantity: '4',
          unitPriceMinor: '3600000',
          totalMinor: '14400000',
          currency: 'LKR',
          // Cheaper, and eleven weeks away. The comparison the ranking exists to make.
          leadTimeDays: 78,
          deliveryTerms: 'ex-works',
          evidenceReferences: [],
          validUntil: VALID_UNTIL,
        },
        { as: cheap, key: 'idem_e2e_b_quote2' },
      );
      ok(cheapOffer, 201, 'the second offer');
      const cheapQuoteId = body<{ quote: { quoteId: string } }>(cheapOffer).quote.quoteId;

      // -- 5. Neither supplier can see the other's bid -------------------------
      const peek = await context.call('GET', `/v1/rfqs/${rfqId}/quotes`, undefined, { as: cheap });
      assert.equal(
        peek.status,
        404,
        'a supplier who could read the other bids knows exactly what to undercut',
      );
      const peekAtRanking = await context.call('GET', `/v1/rfqs/${rfqId}/evaluation`, undefined, {
        as: fast,
      });
      assert.equal(peekAtRanking.status, 404);
      const peekAtRivals = await context.call('GET', `/v1/rfqs/${rfqId}/invitations`, undefined, {
        as: fast,
      });
      assert.equal(peekAtRivals.status, 404, 'nor who else was asked');

      // -- 6. The buyer compares them, and the ranking explains itself ---------
      const ranked = await context.call('GET', `/v1/rfqs/${rfqId}/evaluation`, undefined, {
        as: buyer,
      });
      ok(ranked, 200, 'the buyer reading the ranking');
      const evaluations = body<{
        evaluations: readonly {
          quoteId: string;
          rank: number;
          scorePerMille: number;
          recommended: boolean;
          explanation: string;
        }[];
      }>(ranked).evaluations;

      assert.equal(evaluations.length, 2);
      assert.equal(evaluations.filter((one) => one.recommended).length, 1);
      assert.equal(
        evaluations.find((one) => one.recommended)?.quoteId,
        fastQuoteId,
        'the cheapest offer is not the recommended one: it is eleven weeks away and has no evidence',
      );
      assert.ok(
        evaluations.every((one) => one.explanation.length > 0),
        'and every score says why, in words a customer could argue with',
      );

      // -- 7. The buyer chooses, and only the buyer can ------------------------
      const supplierTriesToDecide = await context.call(
        'POST',
        `/v1/quotes/${cheapQuoteId}/acceptance`,
        { reason: 'awarding myself the order' },
        { as: cheap, key: 'idem_e2e_b_selfaccept' },
      );
      assert.equal(
        supplierTriesToDecide.status,
        403,
        'a supplier who could accept their own offer has awarded themselves the order',
      );

      const accepted = await context.call(
        'POST',
        `/v1/quotes/${fastQuoteId}/acceptance`,
        { reason: 'we need them on site next week, and the certification matters' },
        { as: buyer, key: 'idem_e2e_b_accept' },
      );
      ok(accepted, 200, 'accepting the recommended offer');

      ok(
        await context.call(
          'POST',
          `/v1/quotes/${cheapQuoteId}/rejection`,
          { reason: 'another supplier could deliver eleven weeks earlier' },
          { as: buyer, key: 'idem_e2e_b_reject' },
        ),
        200,
        'rejecting the other',
      );

      ok(
        await context.call(
          'POST',
          `/v1/rfqs/${rfqId}/award`,
          { quoteId: fastQuoteId, reason: 'awarded on lead time and certification' },
          { as: buyer, key: 'idem_e2e_b_award' },
        ),
        200,
        'awarding the tender',
      );

      // -- 8. The acceptance becomes an order, by itself -----------------------
      // Nobody types the order in. The acceptance committed an outbox row; the relay publishes it;
      // K-08 delivers it; a consumer opens the order. This is the step no API test reaches.
      const before = await context.call(
        'GET',
        `/v1/accounts/${buyer.accountId}/orders`,
        undefined,
        {
          as: buyer,
        },
      );
      assert.deepEqual(body<{ orders: readonly unknown[] }>(before).orders, []);

      const settled = await context.settle();
      assert.ok(settled.dispatched > 0, 'the acceptance reached K-08');
      assert.ok(settled.delivered > 0, 'and K-08 delivered it to the consumer');

      const after = await context.call('GET', `/v1/accounts/${buyer.accountId}/orders`, undefined, {
        as: buyer,
      });
      ok(after, 200, 'reading MY ORDERS');
      const orders = body<{
        orders: readonly { orderId: string; status: string; totalMinor: string }[];
      }>(after).orders;

      assert.equal(orders.length, 1, 'the accepted offer became exactly one order');
      const order = orders[0];
      assert.ok(order !== undefined);
      assert.equal(
        order.status,
        'confirmed',
        'placed and confirmed: a quote binds, so the supplier does not get a second chance to decline',
      );
      assert.equal(
        order.totalMinor,
        '18600000',
        'for exactly what the supplier said the buyer would pay, all in',
      );

      // -- 9. And the order is priced from the offer, in two honest lines ------
      const items = await context.call('GET', `/v1/orders/${order.orderId}/items`, undefined, {
        as: buyer,
      });
      ok(items, 200, 'reading the order lines');
      const lines = body<{
        items: readonly {
          lineKind: string;
          quoteId: string | null;
          listingId: string | null;
          lineTotalMinor: string;
        }[];
      }>(items).items;

      assert.equal(lines.length, 2, 'goods, and the delivery the landed total included');
      const goods = lines.find((one) => one.lineKind === 'goods');
      const charges = lines.find((one) => one.lineKind === 'charges');
      assert.ok(goods !== undefined && charges !== undefined);
      assert.equal(goods.lineTotalMinor, '18000000', '4 × 4,500,000');
      assert.equal(charges.lineTotalMinor, '600000', 'and the rest, visible rather than absorbed');
      assert.equal(
        goods.listingId,
        null,
        'no listing answered — that is why there was a tender — so the line pins the offer instead',
      );
      assert.equal(goods.quoteId, fastQuoteId);

      // -- 10. A redelivery does not buy it twice ------------------------------
      const again = await context.settle();
      assert.equal(
        again.delivered,
        0,
        'there is nothing left due; the deliveries were acknowledged',
      );
      const stillOne = await context.call(
        'GET',
        `/v1/accounts/${buyer.accountId}/orders`,
        undefined,
        { as: buyer },
      );
      assert.equal(body<{ orders: readonly unknown[] }>(stillOne).orders.length, 1);
    });
  },
);

void test(
  'E2E-02a: an uninvited supplier cannot find, read or answer the tender',
  liveTestOptions,
  async () => {
    // The privacy boundary, over the wire, from the outside. A private tender that a stranger can
    // confirm the existence of is a tender that leaks who is buying what.
    await journey(async (context) => {
      const buyer = await context.signUp('flow-b2-buyer', ['CUSTOMER']);
      const invited = await context.signUp('flow-b2-invited', ['SUPPLIER']);
      const outsider = await context.signUp('flow-b2-outsider', ['SUPPLIER']);

      const stated = await context.call(
        'POST',
        '/v1/needs',
        { channel: 'text', rawText: 'four titanium flanges, DN80 PN16' },
        { as: buyer, key: 'idem_e2e_b2_need' },
      );
      const requestId = body<{ request: { requestId: string } }>(stated).request.requestId;
      await context.call(
        'POST',
        `/v1/needs/${requestId}/interpretations`,
        {
          origin: 'rule',
          confidencePerMille: 800,
          structured: READING,
          rationale: 'parsed from the stated Need',
        },
        { as: buyer, key: 'idem_e2e_b2_interp' },
      );

      const opened = await context.call(
        'POST',
        '/v1/rfqs',
        {
          requestId,
          visibility: 'private',
          structured: READING,
          itemDescription: 'Titanium flange, DN80 PN16, 4 units',
          substitutionPolicy: 'none',
          closesAt: CLOSES,
        },
        { as: buyer, key: 'idem_e2e_b2_open' },
      );
      const rfqId = body<{ rfq: { rfqId: string } }>(opened).rfq.rfqId;

      await context.call(
        'POST',
        `/v1/rfqs/${rfqId}/invitations`,
        { supplier: invited.accountId, reason: 'verified for machined parts in this district' },
        { as: buyer, key: 'idem_e2e_b2_invite' },
      );

      assert.equal(
        (await context.call('GET', `/v1/rfqs/${rfqId}`, undefined, { as: outsider })).status,
        404,
        'a tender they were not asked about is one they cannot confirm exists',
      );

      const answered = await context.call(
        'POST',
        `/v1/rfqs/${rfqId}/quotes`,
        {
          kind: 'full',
          quantity: '4',
          unitPriceMinor: '3000000',
          totalMinor: '12000000',
          currency: 'LKR',
          leadTimeDays: 5,
          deliveryTerms: 'delivered',
          validUntil: VALID_UNTIL,
        },
        { as: outsider, key: 'idem_e2e_b2_quote' },
      );
      assert.equal(answered.status, 404, 'and not one they can quote for');

      const inbox = await context.call('GET', '/v1/invitations', undefined, { as: outsider });
      ok(inbox, 200, 'their own inbox');
      assert.deepEqual(
        body<{ invitations: readonly unknown[] }>(inbox).invitations,
        [],
        'which is empty, because they were not asked',
      );
    });
  },
);
