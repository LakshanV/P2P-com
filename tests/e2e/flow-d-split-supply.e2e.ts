/**
 * E2E-04 — FLOW D: no single supplier has enough, so several of them share it.
 *
 * A tender for 20 tonnes. One supplier has 12 and another has 8, and neither can fill the order
 * alone. A market that only accepted all-or-nothing offers would turn this into no sale at all: both
 * suppliers would decline, the buyer would be told nothing was available, and 20 tonnes of cement
 * would sit in two warehouses. **Partial offers are what make it a sale**, and they are the reason
 * `partial` is a first-class kind in M-10 rather than something a buyer works around.
 *
 * What this journey proves, and what it deliberately records as **not yet built**:
 *
 * **Two partial offers can cover one tender exactly.** The buyer accepts both, and each acceptance
 * opens its own order against its own supplier, priced from its own offer — through the outbox and a
 * consumer, so the two orders exist because the platform made them rather than because a test did.
 *
 * **A partial offer is ranked, not excluded.** It scores lower on completeness than a full one and
 * higher than nothing, so a buyer sees it in the comparison with the reason it scored what it did.
 *
 * **An award names exactly one winner, and a split has none.** M-09's CHECK ties `status = awarded`
 * to a single `awarded_quote_id`, in both directions. That is right for the ordinary case and it has
 * no answer for this one, so the tender here is **closed** rather than awarded — which is honest, and
 * is recorded in the backlog as a gap rather than worked around with a winner nobody chose.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { journey, liveTestOptions, type Response } from './harness.ts';

const CLOSES = '2026-07-08T17:00:00.000000Z';
const VALID_UNTIL = '2026-07-07T17:00:00.000000Z';

const READING = Object.freeze({
  commodity: 'titanium-flange',
  quantity: 20,
  unit: 'unit',
  district: 'matale',
  standard: 'DN80 PN16',
});

const body = <T>(response: Response): T => response.body as T;
const ok = (response: Response, status: number, what: string): void => {
  assert.equal(response.status, status, `${what}: ${JSON.stringify(response.body)}`);
};

void test(
  'E2E-04: two partial offers cover one tender, and each becomes its own order',
  liveTestOptions,
  async () => {
    await journey(async (context) => {
      const buyer = await context.signUp('flow-d-buyer', ['CUSTOMER']);
      const larger = await context.signUp('flow-d-larger', ['SUPPLIER']);
      const smaller = await context.signUp('flow-d-smaller', ['SUPPLIER']);

      // -- The Need, unsourceable, and the tender it justifies ---------------
      const stated = await context.call(
        'POST',
        '/v1/needs',
        { channel: 'text', rawText: '20 titanium flanges, DN80 PN16, Matale, three weeks' },
        { as: buyer, key: 'idem_e2e_d_need' },
      );
      ok(stated, 201, 'stating a Need');
      const requestId = body<{ request: { requestId: string } }>(stated).request.requestId;

      ok(
        await context.call(
          'POST',
          `/v1/needs/${requestId}/interpretations`,
          {
            origin: 'rule',
            confidencePerMille: 840,
            structured: READING,
            rationale: 'commodity, standard, quantity and district parsed from the stated Need',
          },
          { as: buyer, key: 'idem_e2e_d_interp' },
        ),
        201,
        'recording an interpretation',
      );

      const sourced = await context.call(
        'POST',
        `/v1/needs/${requestId}/sourcing`,
        {},
        { as: buyer, key: 'idem_e2e_d_source' },
      );
      ok(sourced, 201, 'running the ladder');
      assert.equal(body<{ run: { outcome: string } }>(sourced).run.outcome, 'escalate-to-rfq');

      const opened = await context.call(
        'POST',
        '/v1/rfqs',
        {
          requestId,
          visibility: 'private',
          structured: READING,
          itemDescription: 'Titanium flange, DN80 PN16, 20 units, delivered to Matale',
          substitutionPolicy: 'none',
          closesAt: CLOSES,
        },
        { as: buyer, key: 'idem_e2e_d_open' },
      );
      ok(opened, 201, 'opening the tender');
      const rfqId = body<{ rfq: { rfqId: string } }>(opened).rfq.rfqId;

      for (const [supplier, key] of [
        [larger, 'idem_e2e_d_inv1'],
        [smaller, 'idem_e2e_d_inv2'],
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

      // -- Neither can fill it, and both say so ------------------------------
      // An offer for more than was asked for is refused, so a supplier cannot quietly round up to
      // look like a full answer.
      const overreach = await context.call(
        'POST',
        `/v1/rfqs/${rfqId}/quotes`,
        {
          kind: 'partial',
          quantity: '24',
          unitPriceMinor: '400000',
          totalMinor: '9600000',
          currency: 'LKR',
          leadTimeDays: 14,
          deliveryTerms: 'delivered',
          validUntil: VALID_UNTIL,
        },
        { as: larger, key: 'idem_e2e_d_over' },
      );
      assert.equal(overreach.status, 400);
      assert.equal((overreach.body as { code?: string }).code, 'malformed-quantity');

      // And a `full` offer that does not cover the whole quantity is refused too: it is a partial
      // offer and should say so, because a buyer accepting it would think they were finished.
      const mislabelled = await context.call(
        'POST',
        `/v1/rfqs/${rfqId}/quotes`,
        {
          kind: 'full',
          quantity: '12',
          unitPriceMinor: '400000',
          totalMinor: '4800000',
          currency: 'LKR',
          leadTimeDays: 14,
          deliveryTerms: 'delivered',
          validUntil: VALID_UNTIL,
        },
        { as: larger, key: 'idem_e2e_d_mislabel' },
      );
      assert.equal(mislabelled.status, 400);
      assert.equal((mislabelled.body as { code?: string }).code, 'malformed-quantity');

      const twelve = await context.call(
        'POST',
        `/v1/rfqs/${rfqId}/quotes`,
        {
          kind: 'partial',
          quantity: '12',
          unitPriceMinor: '400000',
          // 4,800,000 of goods and 200,000 of delivery.
          totalMinor: '5000000',
          currency: 'LKR',
          leadTimeDays: 14,
          deliveryTerms: 'delivered',
          validUntil: VALID_UNTIL,
          evidenceReferences: ['doc_e2e_flowdcert1'],
        },
        { as: larger, key: 'idem_e2e_d_quote1' },
      );
      ok(twelve, 201, 'the twelve-unit offer');
      const twelveId = body<{ quote: { quoteId: string } }>(twelve).quote.quoteId;

      const eight = await context.call(
        'POST',
        `/v1/rfqs/${rfqId}/quotes`,
        {
          kind: 'partial',
          quantity: '8',
          unitPriceMinor: '420000',
          totalMinor: '3360000',
          currency: 'LKR',
          leadTimeDays: 10,
          deliveryTerms: 'ex-works',
          validUntil: VALID_UNTIL,
          evidenceReferences: ['doc_e2e_flowdcert2'],
        },
        { as: smaller, key: 'idem_e2e_d_quote2' },
      );
      ok(eight, 201, 'the eight-unit offer');
      const eightId = body<{ quote: { quoteId: string } }>(eight).quote.quoteId;

      // -- Both are ranked, neither excluded ---------------------------------
      const ranked = await context.call('GET', `/v1/rfqs/${rfqId}/evaluation`, undefined, {
        as: buyer,
      });
      ok(ranked, 200, 'reading the ranking');
      const evaluations = body<{
        evaluations: readonly {
          quoteId: string;
          ineligibleReason: string | null;
          explanation: string;
          factors: Record<string, number>;
        }[];
      }>(ranked).evaluations;

      assert.equal(evaluations.length, 2);
      assert.ok(
        evaluations.every((one) => one.ineligibleReason === null),
        'a partial offer can be accepted, so it is scored rather than set aside',
      );
      assert.equal(
        evaluations.find((one) => one.quoteId === twelveId)?.factors.completeness,
        600,
        '12 of 20 covered, scored proportionally rather than excluded',
      );
      assert.equal(evaluations.find((one) => one.quoteId === eightId)?.factors.completeness, 400);
      assert.ok(
        evaluations.every((one) => /covers \d+ of 20/.test(one.explanation)),
        'and each says how much of the order it would fill',
      );

      // -- The buyer takes both ----------------------------------------------
      for (const [quoteId, key] of [
        [twelveId, 'idem_e2e_d_accept1'],
        [eightId, 'idem_e2e_d_accept2'],
      ] as const) {
        ok(
          await context.call(
            'POST',
            `/v1/quotes/${quoteId}/acceptance`,
            { reason: 'together these two cover the whole order' },
            { as: buyer, key },
          ),
          200,
          'accepting a partial offer',
        );
      }

      // -- And each becomes its own order, priced from its own offer ---------
      const settled = await context.settle();
      assert.ok(settled.dispatched > 0 && settled.delivered > 0);

      const mine = await context.call('GET', `/v1/accounts/${buyer.accountId}/orders`, undefined, {
        as: buyer,
      });
      ok(mine, 200, 'reading MY ORDERS');
      const orders = body<{
        orders: readonly { orderId: string; sellerAccountId: string; totalMinor: string }[];
      }>(mine).orders;

      assert.equal(orders.length, 2, 'one order per accepted offer, with its own supplier');
      assert.deepEqual(
        [...orders].map((one) => one.sellerAccountId).sort(),
        [larger.accountId, smaller.accountId].sort(),
      );
      assert.equal(
        orders.reduce((sum, one) => sum + BigInt(one.totalMinor), 0n),
        5_000_000n + 3_360_000n,
        'and together they come to what the two suppliers said the buyer would pay',
      );

      // The quantities add up to the tender, which is the whole point of accepting two partials.
      let covered = 0n;
      for (const order of orders) {
        const items = await context.call('GET', `/v1/orders/${order.orderId}/items`, undefined, {
          as: buyer,
        });
        ok(items, 200, 'reading the lines');
        const goods = body<{
          items: readonly { lineKind: string; quantity: string; quoteId: string | null }[];
        }>(items).items.filter((one) => one.lineKind === 'goods');

        assert.equal(goods.length, 1);
        assert.ok(
          [twelveId, eightId].includes(goods[0]?.quoteId ?? ''),
          'each line pins the offer it was priced from',
        );
        covered += BigInt(goods[0]?.quantity ?? '0');
      }
      assert.equal(covered, 20n, '12 and 8: the tender is covered exactly');

      // -- The tender is closed, not awarded ---------------------------------
      // An award names exactly one winner, in both directions by CHECK. That is right for the
      // ordinary case and has no answer for a split, so the honest ending here is `closed`. A
      // split award is not modelled, and pretending one supplier won would be a record of a
      // decision nobody made.
      ok(
        await context.call(
          'POST',
          `/v1/rfqs/${rfqId}/closure`,
          { reason: 'covered by two partial offers, both accepted' },
          { as: buyer, key: 'idem_e2e_d_close' },
        ),
        200,
        'closing the tender',
      );

      const tender = await context.call('GET', `/v1/rfqs/${rfqId}`, undefined, { as: buyer });
      ok(tender, 200, 'reading the tender');
      const finished = body<{ rfq: { status: string; awardedQuoteId: string | null } }>(tender).rfq;
      assert.equal(finished.status, 'closed');
      assert.equal(
        finished.awardedQuoteId,
        null,
        'no single winner, because there was not one — and the schema will not let there appear to be',
      );
    });
  },
);
