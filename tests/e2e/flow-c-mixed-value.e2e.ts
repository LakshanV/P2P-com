/**
 * E2E-03 — FLOW C: one purchase, paid three ways at once.
 *
 * LKR 10,000, settled as **1,500 in reward points + 500 in merchant credit + 8,000 on a card**. This
 * is the platform's distinctive financial claim, and it is the one most likely to be quietly wrong,
 * because being quietly wrong about it means somebody was charged the wrong amount.
 *
 * Four properties this journey exists to prove, in order of how much they would cost if false:
 *
 * **The pieces add up exactly.** M-13 refuses a plan whose legs do not sum to the obligation, and
 * the arithmetic is integer throughout: 1,500 points at 100 minor units each is 150,000, not
 * 149,999.99. Nothing rounds, because a rate that does not divide evenly is refused rather than
 * losing a fraction per leg.
 *
 * **Reward points are not money and do not travel through a card rail.** The internal legs move
 * inside K-10's journal; only the 8,000 reaches M-12, and M-12 refuses an internal asset code by
 * name. A platform that let a reward point out through a payment provider would be claiming money it
 * never held.
 *
 * **A committed plan is not a settled one.** The two internal legs post at commit; the external leg
 * stays outstanding until the card is actually captured. The plan sits at `committed` in between,
 * which is the truth: the platform has moved what it holds and is still waiting for the rest.
 *
 * **The capture settles it, through the event log.** Nothing calls M-13 when the payment is
 * captured. M-12 writes an outbox row; the relay publishes it; K-08 delivers it to a consumer in
 * `apps/`; the consumer settles the external leg. Same-layer modules communicating by event, which
 * is the only reason a crash between the two does not lose the settlement.
 *
 * **No balance is stored anywhere.** Every figure asserted below is derived by K-10 from its
 * journal. A cached balance on a screen showing somebody's money is a number that is wrong for as
 * long as nobody notices.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { journey, liveTestOptions, type Journey, type Response } from './harness.ts';

/** LKR 10,000.00, in minor units. */
const TOTAL_MINOR = 1_000_000n;
/** 1,500 whole reward points, worth LKR 15.00 each — 150,000 minor of the total. */
const REWARD_POINTS = 1_500n;
const REWARD_RATE_MINOR = 100n;
const REWARD_SETTLEMENT = REWARD_POINTS * REWARD_RATE_MINOR;
/** LKR 500.00 of merchant credit, at par. */
const CREDIT_MINOR = 50_000n;
/** And the rest on a card. */
const EXTERNAL_MINOR = TOTAL_MINOR - REWARD_SETTLEMENT - CREDIT_MINOR;

const body = <T>(response: Response): T => response.body as T;
const ok = (response: Response, status: number, what: string): void => {
  assert.equal(response.status, status, `${what}: ${JSON.stringify(response.body)}`);
};

/**
 * The three kinds of value this journey moves.
 *
 * Registered directly rather than over HTTP: there is no route for it and inventing one for a test
 * would be a route nothing else uses. Asset types are a deployment decision, not a request.
 */
async function registerAssets(context: Journey): Promise<void> {
  await context.ledger.registerAssetType({
    assetTypeId: 'jaya_reward',
    assetClass: 'reward',
    symbol: 'JAYAREWARD',
    // Indivisible. Half a loyalty point is not a thing, and the schema says so.
    precision: 0,
    transferability: false,
    withdrawability: false,
    valuationSource: 'fixed',
    issuer: 'iss_e2e_jayaplatform',
    unit: 'point',
    redeemable: true,
    convertible: false,
    expiryDays: null,
    restrictions: {},
    custodyProvider: null,
    jurisdiction: 'GLOBAL',
  });

  await context.ledger.registerAssetType({
    assetTypeId: 'merchant_credit',
    // `community` rather than a class of its own: merchant credit is value issued inside the
    // platform and redeemable within it, which is what that class is for. K-10's vocabulary is
    // closed on purpose, and inventing a fifth entry for one deployment's product would widen a
    // kernel to fit a module.
    assetClass: 'community',
    symbol: 'JAYACREDIT',
    precision: 2,
    transferability: false,
    withdrawability: false,
    valuationSource: 'fixed',
    issuer: 'iss_e2e_jayaplatform',
    unit: 'rupee',
    redeemable: true,
    convertible: false,
    expiryDays: null,
    restrictions: {},
    custodyProvider: null,
    jurisdiction: 'LK',
  });

  await context.ledger.registerAssetType({
    assetTypeId: 'lkr_cash',
    assetClass: 'fiat',
    symbol: 'LKR',
    precision: 2,
    transferability: true,
    withdrawability: true,
    valuationSource: 'market',
    issuer: 'iss_e2e_centralbanklk',
    unit: 'rupee',
    redeemable: false,
    convertible: true,
    expiryDays: null,
    restrictions: {},
    custodyProvider: null,
    jurisdiction: 'LK',
  });
}

void test(
  'E2E-03: LKR 10,000 paid as 1,500 rewards, 500 merchant credit and 8,000 on a card',
  liveTestOptions,
  async () => {
    await journey(async (context) => {
      const buyer = await context.signUp('flow-c-buyer', ['CUSTOMER']);
      const seller = await context.signUp('flow-c-seller', ['SUPPLIER']);
      await registerAssets(context);

      // -- 1. Each party opens their own wallets ----------------------------
      // Their own, and only their own. `ownerAccountId` is not a field: a caller who could name the
      // holder would be opening wallets in somebody else's name.
      const wallet = async (
        as: typeof buyer,
        assetTypeId: string,
        purpose: string,
        key: string,
      ): Promise<string> => {
        const response = await context.call(
          'POST',
          '/v1/wallets',
          { assetTypeId, purpose, normalBalance: 'credit' },
          { as, key },
        );
        ok(response, 201, `opening a ${assetTypeId} wallet`);
        return body<{ wallet: { walletId: string } }>(response).wallet.walletId;
      };

      const buyerRewards = await wallet(buyer, 'jaya_reward', 'spending', 'idem_e2e_c_w1');
      const buyerCredit = await wallet(buyer, 'merchant_credit', 'spending', 'idem_e2e_c_w2');
      const sellerRewards = await wallet(seller, 'jaya_reward', 'earnings', 'idem_e2e_c_w3');
      const sellerCredit = await wallet(seller, 'merchant_credit', 'earnings', 'idem_e2e_c_w4');
      const sellerCash = await wallet(seller, 'lkr_cash', 'earnings', 'idem_e2e_c_w5');
      // And a **settlement** position on the payer's side, which is where external value lands
      // when it arrives. M-13 refuses a single-sided posting: money paid onward has to come from
      // somewhere, and 'somewhere' is a wallet or it is nothing.
      await wallet(buyer, 'lkr_cash', 'settlement', 'idem_e2e_c_w6');

      // A caller cannot open a wallet for somebody else, and is told so by name rather than ignored.
      const forged = await context.call(
        'POST',
        '/v1/wallets',
        {
          ownerAccountId: seller.accountId,
          assetTypeId: 'jaya_reward',
          purpose: 'spending',
          normalBalance: 'credit',
        },
        { as: buyer, key: 'idem_e2e_c_forge' },
      );
      assert.equal(forged.status, 400);
      assert.equal((forged.body as { code?: string }).code, 'caller-asserted-party');

      // -- 2. The buyer actually holds the value they are about to spend -----
      // Issued from the platform's own positions. Without this the internal legs would post from
      // empty wallets, and the journey would prove the arithmetic while proving nothing about the
      // money.
      await context.fund(buyerRewards, 'jaya_reward', REWARD_POINTS, 'opening reward balance');
      await context.fund(buyerCredit, 'merchant_credit', CREDIT_MINOR, 'opening merchant credit');

      // -- 3. An order for LKR 10,000 ----------------------------------------
      const created = await context.call(
        'POST',
        '/v1/orders',
        { sellerAccountId: seller.accountId, currency: 'LKR', reason: 'a mixed-value purchase' },
        { as: buyer, key: 'idem_e2e_c_order' },
      );
      ok(created, 201, 'creating the order');
      const orderId = body<{ order: { orderId: string } }>(created).order.orderId;

      // -- 4. The plan: three kinds of value, adding up exactly --------------
      const allocated = await context.call(
        'POST',
        '/v1/value-plans',
        {
          obligationId: orderId,
          obligationKind: 'order',
          payeeAccountId: seller.accountId,
          settlementAssetTypeId: 'lkr_cash',
          targetAmountMinor: TOTAL_MINOR.toString(),
          legs: [
            {
              kind: 'internal',
              assetTypeId: 'jaya_reward',
              sourceWalletId: buyerRewards,
              destinationWalletId: sellerRewards,
              amountMinor: REWARD_POINTS.toString(),
              // 1 point is worth LKR 1.00, which is 100 minor units. An integer pair, checked by
              // cross-multiplication, so nothing divides and nothing rounds.
              rateNumerator: REWARD_RATE_MINOR.toString(),
              rateDenominator: '1',
              settlementEquivalentMinor: REWARD_SETTLEMENT.toString(),
            },
            {
              kind: 'internal',
              assetTypeId: 'merchant_credit',
              sourceWalletId: buyerCredit,
              destinationWalletId: sellerCredit,
              amountMinor: CREDIT_MINOR.toString(),
              rateNumerator: '1',
              rateDenominator: '1',
              settlementEquivalentMinor: CREDIT_MINOR.toString(),
            },
            {
              kind: 'external',
              assetTypeId: 'lkr_cash',
              // No source: this value comes from outside the platform.
              destinationWalletId: sellerCash,
              amountMinor: EXTERNAL_MINOR.toString(),
              rateNumerator: '1',
              rateDenominator: '1',
              settlementEquivalentMinor: EXTERNAL_MINOR.toString(),
            },
          ],
        },
        { as: buyer, key: 'idem_e2e_c_plan' },
      );
      ok(allocated, 201, 'allocating the plan');
      const planId = body<{ plan: { planId: string } }>(allocated).plan.planId;

      // -- 5. Commit: what the platform holds moves now ----------------------
      const committed = await context.call(
        'POST',
        `/v1/value-plans/${planId}/commitment`,
        {},
        { as: buyer, key: 'idem_e2e_c_commit' },
      );
      ok(committed, 200, 'committing the plan');
      assert.equal(
        body<{ plan: { status: string } }>(committed).plan.status,
        'committed',
        'committed and not settled: the card has not been captured, so the obligation is not met',
      );

      const midway = await context.call('GET', `/v1/value-plans/${planId}/coverage`, undefined, {
        as: buyer,
      });
      ok(midway, 200, 'reading the coverage');
      const partial = body<{
        coverage: { postedMinor: string; outstandingMinor: string; fullySettled: boolean };
      }>(midway).coverage;

      assert.equal(
        partial.postedMinor,
        (REWARD_SETTLEMENT + CREDIT_MINOR).toString(),
        'the two internal legs posted: 1,500 points and 500 of credit, in settlement terms',
      );
      assert.equal(partial.outstandingMinor, EXTERNAL_MINOR.toString());
      assert.equal(partial.fullySettled, false);

      // The buyer's reward points really left their wallet, and K-10 derived that from the journal.
      const spent = await context.call('GET', `/v1/accounts/${buyer.accountId}/money`, undefined, {
        as: buyer,
      });
      ok(spent, 200, 'reading MY MONEY');
      const holdings = body<{
        holdings: readonly { assetTypeId: string; available: string }[];
      }>(spent).holdings;
      assert.equal(
        holdings.find((one) => one.assetTypeId === 'jaya_reward')?.available,
        '0',
        'the points were spent, not merely marked as spent',
      );

      // -- 6. The card, for the rest and only the rest ------------------------
      const requested = await context.call(
        'POST',
        '/v1/payments',
        {
          orderId,
          payeeAccountId: seller.accountId,
          provider: 'mock',
          rail: 'card',
          instrumentToken: 'tok_e2e_flowc000001',
          assetCode: 'LKR',
          assetScale: 2,
          amountMinor: EXTERNAL_MINOR.toString(),
          reason: 'the external portion of a mixed-value purchase',
        },
        { as: buyer, key: 'idem_e2e_c_pay' },
      );
      ok(requested, 201, 'requesting the payment');
      const paymentId = body<{ payment: { paymentId: string } }>(requested).payment.paymentId;

      // A reward point cannot leave through a card rail, and M-12 says so by name.
      const internalThroughARail = await context.call(
        'POST',
        '/v1/payments',
        {
          orderId,
          payeeAccountId: seller.accountId,
          provider: 'mock',
          rail: 'card',
          instrumentToken: 'tok_e2e_flowc000002',
          assetCode: 'jaya_reward',
          assetScale: 0,
          amountMinor: '1500',
          reason: 'sending reward points through a payment provider',
        },
        { as: buyer, key: 'idem_e2e_c_internal' },
      );
      assert.equal(
        internalThroughARail.status,
        422,
        'no bank has heard of a reward point, and a row claiming one settled externally is a ' +
          'claim on money the platform never held',
      );
      assert.equal(
        (internalThroughARail.body as { code?: string }).code,
        'internal-value-not-settleable',
      );

      ok(
        await context.call(
          'POST',
          `/v1/payments/${paymentId}/authorisation`,
          { amountMinor: EXTERNAL_MINOR.toString(), reason: 'authorised' },
          { as: buyer, key: 'idem_e2e_c_auth' },
        ),
        200,
        'authorising',
      );

      const captured = await context.call(
        'POST',
        `/v1/payments/${paymentId}/capture`,
        { amountMinor: EXTERNAL_MINOR.toString(), reason: 'captured on despatch' },
        { as: seller, key: 'idem_e2e_c_capture' },
      );
      ok(captured, 200, 'capturing');

      // -- 7. And the capture settles the plan, through the event log --------
      // Nothing called M-13. M-12 wrote an outbox row, the relay published it, K-08 delivered it,
      // and a consumer in apps/ settled the leg — which is the only arrangement that survives a
      // crash between the two modules.
      const stillOutstanding = await context.call(
        'GET',
        `/v1/value-plans/${planId}/coverage`,
        undefined,
        { as: buyer },
      );
      assert.equal(
        body<{ coverage: { fullySettled: boolean } }>(stillOutstanding).coverage.fullySettled,
        false,
        'until the relay runs, nothing has told M-13 anything',
      );

      const settled = await context.settle();
      assert.ok(settled.dispatched > 0 && settled.delivered > 0);

      const finished = await context.call('GET', `/v1/value-plans/${planId}`, undefined, {
        as: buyer,
      });
      ok(finished, 200, 'reading the plan');
      assert.equal(
        body<{ plan: { status: string } }>(finished).plan.status,
        'settled',
        'the obligation is met, and nobody typed that in',
      );

      const coverage = await context.call('GET', `/v1/value-plans/${planId}/coverage`, undefined, {
        as: buyer,
      });
      const final = body<{
        coverage: { postedMinor: string; outstandingMinor: string; fullySettled: boolean };
      }>(coverage).coverage;

      assert.equal(final.postedMinor, TOTAL_MINOR.toString(), 'all 10,000, in settlement terms');
      assert.equal(final.outstandingMinor, '0');
      assert.equal(final.fullySettled, true);

      // -- 8. And the seller holds three kinds of value, kept apart -----------
      const earnings = await context.call(
        'GET',
        `/v1/accounts/${seller.accountId}/money`,
        undefined,
        { as: seller },
      );
      ok(earnings, 200, 'the seller reading MY MONEY');
      const held = body<{
        holdings: readonly { assetTypeId: string; available: string }[];
        total?: unknown;
        totalMinor?: unknown;
      }>(earnings);

      assert.equal(held.total, undefined, 'MY MONEY never sums across asset types');
      assert.equal(held.totalMinor, undefined);
      assert.equal(
        held.holdings.find((one) => one.assetTypeId === 'jaya_reward')?.available,
        REWARD_POINTS.toString(),
        '1,500 points, as points — not as their rupee equivalent',
      );
      assert.equal(
        held.holdings.find((one) => one.assetTypeId === 'merchant_credit')?.available,
        CREDIT_MINOR.toString(),
      );
      assert.equal(
        held.holdings.find((one) => one.assetTypeId === 'lkr_cash')?.available,
        EXTERNAL_MINOR.toString(),
      );
    });
  },
);

void test(
  'E2E-03a: a plan whose legs do not add up is refused before anything moves',
  liveTestOptions,
  async () => {
    // Under-covering is a short payment nobody noticed; over-covering takes value for nothing.
    // Both are refused at allocation, so the failure happens before a single entry is posted.
    await journey(async (context) => {
      const buyer = await context.signUp('flow-c2-buyer', ['CUSTOMER']);
      const seller = await context.signUp('flow-c2-seller', ['SUPPLIER']);
      await registerAssets(context);

      const open = async (
        as: typeof buyer,
        assetTypeId: string,
        purpose: string,
        key: string,
      ): Promise<string> => {
        const response = await context.call(
          'POST',
          '/v1/wallets',
          { assetTypeId, purpose, normalBalance: 'credit' },
          { as, key },
        );
        ok(response, 201, 'opening a wallet');
        return body<{ wallet: { walletId: string } }>(response).wallet.walletId;
      };

      const buyerRewards = await open(buyer, 'jaya_reward', 'spending', 'idem_e2e_c2_w1');
      const sellerRewards = await open(seller, 'jaya_reward', 'earnings', 'idem_e2e_c2_w2');

      // The **target** is varied, not the leg. Changing a leg's settlement equivalent would break
      // that leg's own rate, which M-13 refuses first and more precisely as `rate-mismatch`; what is
      // being tested here is the rule one level up, that the legs add up to the obligation.
      for (const [label, target, key] of [
        ['short', (REWARD_SETTLEMENT + 100n).toString(), 'idem_e2e_c2_short'],
        ['over', (REWARD_SETTLEMENT - 100n).toString(), 'idem_e2e_c2_over'],
      ] as const) {
        const response = await context.call(
          'POST',
          '/v1/value-plans',
          {
            obligationId: `ord_e2e_c2_${label}`,
            obligationKind: 'order',
            payeeAccountId: seller.accountId,
            settlementAssetTypeId: 'lkr_cash',
            targetAmountMinor: target,
            legs: [
              {
                kind: 'internal',
                assetTypeId: 'jaya_reward',
                sourceWalletId: buyerRewards,
                destinationWalletId: sellerRewards,
                amountMinor: REWARD_POINTS.toString(),
                rateNumerator: REWARD_RATE_MINOR.toString(),
                rateDenominator: '1',
                settlementEquivalentMinor: REWARD_SETTLEMENT.toString(),
              },
            ],
          },
          { as: buyer, key },
        );

        assert.equal(response.status, 422, `a ${label} plan was allocated`);
        assert.equal((response.body as { code?: string }).code, 'allocation-mismatch');
      }
    });
  },
);

void test(
  'E2E-03b: a rate that does not divide evenly is refused rather than rounded',
  liveTestOptions,
  async () => {
    // The rule that keeps a mixed-value platform honest. Three points at LKR 10 for every 3 points
    // is exact; the same rate against 1,000 points is not, and losing a fraction of a cent per leg
    // is how a ledger drifts without anybody editing it.
    await journey(async (context) => {
      const buyer = await context.signUp('flow-c3-buyer', ['CUSTOMER']);
      const seller = await context.signUp('flow-c3-seller', ['SUPPLIER']);
      await registerAssets(context);

      const openWallet = async (
        as: typeof buyer,
        purpose: string,
        key: string,
      ): Promise<string> => {
        const response = await context.call(
          'POST',
          '/v1/wallets',
          { assetTypeId: 'jaya_reward', purpose, normalBalance: 'credit' },
          { as, key },
        );
        ok(response, 201, 'opening a wallet');
        return body<{ wallet: { walletId: string } }>(response).wallet.walletId;
      };

      const from = await openWallet(buyer, 'spending', 'idem_e2e_c3_w1');
      const to = await openWallet(seller, 'earnings', 'idem_e2e_c3_w2');

      const response = await context.call(
        'POST',
        '/v1/value-plans',
        {
          obligationId: 'ord_e2e_c3_rate001',
          obligationKind: 'order',
          payeeAccountId: seller.accountId,
          settlementAssetTypeId: 'lkr_cash',
          targetAmountMinor: '3334',
          legs: [
            {
              kind: 'internal',
              assetTypeId: 'jaya_reward',
              sourceWalletId: from,
              destinationWalletId: to,
              amountMinor: '1000',
              // 10 minor units for every 3 points: 1,000 points is 3,333.33..., which is not a
              // number of minor units and so is not a number this platform will store.
              rateNumerator: '10',
              rateDenominator: '3',
              settlementEquivalentMinor: '3334',
            },
          ],
        },
        { as: buyer, key: 'idem_e2e_c3_plan' },
      );

      assert.equal(response.status, 422);
      assert.equal((response.body as { code?: string }).code, 'rate-mismatch');
    });
  },
);
