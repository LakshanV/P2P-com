/**
 * M-13 Financial Ledger — service behaviour.
 *
 * The suite is organised around the one operation a single-currency platform never needs: paying an
 * obligation from several kinds of value at once, and proving afterwards that the pieces added up.
 *
 * The proof this module exists for is `a purchase of LKR 10,000 is paid with rewards, merchant
 * credit and a card`. Three units, three journal transactions, one obligation, and the arithmetic
 * checked at every step against a real K-10 ledger rather than a stub — because a stub would accept
 * postings K-10 would refuse, which is precisely the bug worth catching.
 *
 * Four properties carry the module:
 *
 * **The allocation is exact.** No tolerance, no rounding, no remainder absorbed into the last leg.
 *
 * **A rate never rounds.** Rates are integer pairs checked by cross-multiplication, so an
 * allocation that does not divide evenly is refused rather than losing a fraction of a cent.
 *
 * **Every leg lands in K-10 balanced.** The journal is the authority; M-13 keeps no balance of its
 * own and every figure it reports is summed from rows.
 *
 * **Nothing is deleted.** A cancelled plan is reversed by compensating transactions, and the
 * original postings stay in the journal because they happened.
 *
 * Live-PostgreSQL properties are in `tests/integration/financial-ledger.integration.ts`.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  FOREIGN_FIELDS,
  FinancialLedgerError,
  PLAN_STATUSES,
  PLAN_TRANSITIONS,
  WALLET_PURPOSES,
  WALLET_TRANSITIONS,
  coverageOf,
} from '../modules/financial-ledger/index.ts';

import {
  BUYER,
  JAYA_REWARD,
  LKR,
  MERCHANT_CREDIT,
  PARITY,
  PLATFORM,
  SELLER,
  allocateRequest,
  build,
  entriesOfKind,
  eventTypes,
  idFor,
  lastEventPayload,
  legRequest,
  openWallet,
  openWalletRequest,
  transactionId,
  type Harness,
} from './helpers/financial-ledger-fixtures.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODULE_DIR = path.join(REPO_ROOT, 'modules', 'financial-ledger');

/** The refusal code, or a rethrow when it is not one of M-13's. */
const codeOf = async (body: () => Promise<unknown>): Promise<string> => {
  try {
    await body();
  } catch (error) {
    if (error instanceof FinancialLedgerError) return error.code;
    throw error;
  }
  throw new Error('expected a refusal, and the call succeeded');
};

/** The K-10 balance of the account a wallet names, in every position. */
async function balanceOf(harness: Harness, walletId: string): Promise<bigint> {
  const wallet = await harness.service.getWallet(walletId);
  const balance = await harness.ledger.getBalance(wallet.ledgerAccountId);
  return balance.total;
}

// ---------------------------------------------------------------------------
// Wallets
// ---------------------------------------------------------------------------

test('a wallet names a K-10 account, and opening one creates it', async () => {
  const harness = await build();
  const request = openWalletRequest();
  const { wallet, replayed } = await harness.service.openWallet(request);

  assert.equal(replayed, false);
  assert.equal(wallet.status, 'open');
  assert.equal(wallet.ledgerAccountId, request.ledgerAccountId);

  const account = await harness.ledger.findAccount(request.ledgerAccountId);
  assert.ok(account !== null, 'the K-10 account a wallet names must exist');
  assert.equal(account.assetTypeId, LKR);
  assert.equal(account.ownerId, BUYER);
});

test('opening the same wallet twice creates one wallet and one account', async () => {
  const harness = await build();
  const request = openWalletRequest();

  const first = await harness.service.openWallet(request);
  const second = await harness.service.openWallet(request);

  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.equal(harness.repository.wallets().length, 1);
  assert.equal(
    entriesOfKind(harness.repository, 'event').length,
    1,
    'a replay must not publish a second wallet.opened',
  );
});

test('one party may hold only one wallet per asset type and purpose', async () => {
  const harness = await build();
  await openWallet(harness, { ownerAccountId: BUYER, assetTypeId: LKR, purpose: 'spending' });

  assert.equal(
    await codeOf(() =>
      harness.service.openWallet(
        openWalletRequest({ ownerAccountId: BUYER, assetTypeId: LKR, purpose: 'spending' }),
      ),
    ),
    'wallet-exists',
    'two would split the same money in half with nothing to say which half is theirs',
  );
});

test('the same party may hold the same asset for different purposes', async () => {
  const harness = await build();
  const spending = await openWallet(harness, { purpose: 'spending' });
  const earnings = await openWallet(harness, { purpose: 'earnings' });

  const wallets = await harness.service.listWallets(BUYER);
  assert.equal(wallets.length, 2);
  assert.notEqual(spending, earnings);
  assert.deepEqual(
    wallets.map((w) => w.purpose).sort(),
    ['earnings', 'spending'],
    'earnings is a purpose, not an asset class: both are rupees',
  );
});

test('every declared purpose is usable', async () => {
  const harness = await build();
  for (const purpose of WALLET_PURPOSES) {
    const walletId = await openWallet(harness, { purpose });
    assert.equal((await harness.service.getWallet(walletId)).purpose, purpose);
  }
});

test('a wallet can be frozen and unfrozen, and every change is recorded', async () => {
  const harness = await build();
  const walletId = await openWallet(harness);

  const frozen = await harness.service.setWalletStatus({
    walletId,
    stateId: idFor('wst'),
    toStatus: 'frozen',
    reason: 'a fraud hold while the dispute is investigated',
    occurredAt: '2026-07-02T09:00:00Z',
    correlationId: idFor('corr'),
    idempotencyKey: idFor('idem'),
  });
  assert.equal(frozen.wallet.status, 'frozen');
  assert.equal(frozen.record.fromStatus, 'open');

  const thawed = await harness.service.setWalletStatus({
    walletId,
    stateId: idFor('wst'),
    toStatus: 'open',
    reason: 'the dispute was resolved in the holder’s favour',
    occurredAt: '2026-07-03T09:00:00Z',
    correlationId: idFor('corr'),
    idempotencyKey: idFor('idem'),
  });
  assert.equal(thawed.wallet.status, 'open');

  const history = await harness.service.getWalletHistory(walletId);
  assert.equal(history.length, 2, 'the log of how a wallet reached its status is append-only');
});

test('a closed wallet is terminal', async () => {
  const harness = await build();
  const walletId = await openWallet(harness);
  await harness.service.setWalletStatus({
    walletId,
    stateId: idFor('wst'),
    toStatus: 'closed',
    reason: 'the holder left the platform',
    occurredAt: '2026-07-02T09:00:00Z',
    correlationId: idFor('corr'),
    idempotencyKey: idFor('idem'),
  });

  assert.deepEqual(WALLET_TRANSITIONS.closed, []);
  assert.equal(
    await codeOf(() =>
      harness.service.setWalletStatus({
        walletId,
        stateId: idFor('wst'),
        toStatus: 'open',
        reason: 'reopening',
        occurredAt: '2026-07-03T09:00:00Z',
        correlationId: idFor('corr'),
        idempotencyKey: idFor('idem'),
      }),
    ),
    'illegal-transition',
  );
});

// ---------------------------------------------------------------------------
// The allocation invariant
// ---------------------------------------------------------------------------

test('every status has a declared transition list, and only cancelled is terminal', () => {
  for (const status of PLAN_STATUSES) {
    assert.ok(Array.isArray(PLAN_TRANSITIONS[status]));
  }
  assert.deepEqual(
    PLAN_TRANSITIONS.settled,
    ['cancelled'],
    'an order paid for in full still gets cancelled. A terminal settled state would put the only ' +
      'route back outside the ledger, which is another way of saying no route back',
  );
  assert.deepEqual(PLAN_TRANSITIONS.cancelled, []);
});

test('an allocation that does not add up is refused', async () => {
  const harness = await build();
  const from = await openWallet(harness, { purpose: 'spending' });
  const to = await openWallet(harness, { ownerAccountId: SELLER, purpose: 'earnings' });

  const short = allocateRequest(
    [
      legRequest({
        sourceWalletId: from,
        destinationWalletId: to,
        amountMinor: 900n,
        settlementEquivalentMinor: 900n,
      }),
    ],
    { targetAmountMinor: 1_000n },
  );
  assert.equal(
    await codeOf(() => harness.service.allocatePlan(short)),
    'allocation-mismatch',
    'a committed plan that under-covers is a short payment nobody noticed',
  );

  const over = allocateRequest(
    [
      legRequest({
        sourceWalletId: from,
        destinationWalletId: to,
        amountMinor: 1_100n,
        settlementEquivalentMinor: 1_100n,
      }),
    ],
    { targetAmountMinor: 1_000n },
  );
  assert.equal(await codeOf(() => harness.service.allocatePlan(over)), 'allocation-mismatch');
});

test('a rate that would need rounding is refused rather than absorbed', async () => {
  const harness = await build();
  const from = await openWallet(harness, { assetTypeId: JAYA_REWARD, purpose: 'spending' });
  const to = await openWallet(harness, {
    ownerAccountId: SELLER,
    assetTypeId: JAYA_REWARD,
    purpose: 'earnings',
  });

  // 7 points at 3 cents per 2 points is 10.5 cents. There is no honest integer answer, so there is
  // no answer: rounding it would lose half a cent somewhere nobody looks.
  const leg = legRequest({
    assetTypeId: JAYA_REWARD,
    sourceWalletId: from,
    destinationWalletId: to,
    amountMinor: 7n,
    rate: { numerator: 3n, denominator: 2n },
    settlementEquivalentMinor: 10n,
  });

  assert.equal(
    await codeOf(() =>
      harness.service.allocatePlan(allocateRequest([leg], { targetAmountMinor: 10n })),
    ),
    'rate-mismatch',
  );
});

test('a rate that divides evenly is accepted', async () => {
  const harness = await build();
  const from = await openWallet(harness, { assetTypeId: JAYA_REWARD, purpose: 'spending' });
  const to = await openWallet(harness, {
    ownerAccountId: SELLER,
    assetTypeId: JAYA_REWARD,
    purpose: 'earnings',
  });

  // 8 points at 3 cents per 2 points is exactly 12 cents.
  const leg = legRequest({
    assetTypeId: JAYA_REWARD,
    sourceWalletId: from,
    destinationWalletId: to,
    amountMinor: 8n,
    rate: { numerator: 3n, denominator: 2n },
    settlementEquivalentMinor: 12n,
  });

  const { plan } = await harness.service.allocatePlan(
    allocateRequest([leg], { targetAmountMinor: 12n }),
  );
  assert.equal(plan.status, 'draft');
  assert.equal(plan.targetAmountMinor, 12n);
});

test('a rate with a zero term is refused', async () => {
  const harness = await build();
  const from = await openWallet(harness, { purpose: 'spending' });
  const to = await openWallet(harness, { ownerAccountId: SELLER, purpose: 'earnings' });

  assert.equal(
    await codeOf(() =>
      harness.service.allocatePlan(
        allocateRequest(
          [
            legRequest({
              sourceWalletId: from,
              destinationWalletId: to,
              rate: { numerator: 0n, denominator: 1n },
              settlementEquivalentMinor: 0n,
            }),
          ],
          { targetAmountMinor: 1_000n },
        ),
      ),
    ),
    'malformed-rate',
    'a zero numerator makes value worthless and a zero denominator makes it undefined',
  );
});

test('a plan with no legs is refused', async () => {
  const harness = await build();
  assert.equal(
    await codeOf(() =>
      harness.service.allocatePlan(allocateRequest([], { targetAmountMinor: 1_000n })),
    ),
    'empty-allocation',
  );
});

test('a plan carrying two external legs is refused', async () => {
  const harness = await build();
  const settlement = await openWallet(harness, { purpose: 'settlement' });
  const to = await openWallet(harness, { ownerAccountId: SELLER, purpose: 'earnings' });
  void settlement;

  const external = (amount: bigint): ReturnType<typeof legRequest> =>
    legRequest({
      kind: 'external',
      sourceWalletId: null,
      destinationWalletId: to,
      amountMinor: amount,
      settlementEquivalentMinor: amount,
    });

  assert.equal(
    await codeOf(() =>
      harness.service.allocatePlan(
        allocateRequest([external(500n), external(500n)], { targetAmountMinor: 1_000n }),
      ),
    ),
    'multiple-external-legs',
    'one obligation crosses the platform boundary at most once; two would be two payments',
  );
});

test('an external leg in an asset other than the settlement asset is refused', async () => {
  const harness = await build();
  const to = await openWallet(harness, {
    ownerAccountId: SELLER,
    assetTypeId: JAYA_REWARD,
    purpose: 'earnings',
  });

  assert.equal(
    await codeOf(() =>
      harness.service.allocatePlan(
        allocateRequest(
          [
            legRequest({
              kind: 'external',
              assetTypeId: JAYA_REWARD,
              sourceWalletId: null,
              destinationWalletId: to,
              amountMinor: 1_000n,
              settlementEquivalentMinor: 1_000n,
            }),
          ],
          { settlementAssetTypeId: LKR, targetAmountMinor: 1_000n },
        ),
      ),
    ),
    'external-leg-mismatch',
  );
});

test('a leg naming a wallet in a different asset type is refused', async () => {
  const harness = await build();
  const rupees = await openWallet(harness, { assetTypeId: LKR, purpose: 'spending' });
  const points = await openWallet(harness, {
    ownerAccountId: SELLER,
    assetTypeId: JAYA_REWARD,
    purpose: 'earnings',
  });

  assert.equal(
    await codeOf(() =>
      harness.service.allocatePlan(
        allocateRequest(
          [
            legRequest({
              assetTypeId: LKR,
              sourceWalletId: rupees,
              destinationWalletId: points,
              amountMinor: 1_000n,
              settlementEquivalentMinor: 1_000n,
            }),
          ],
          { targetAmountMinor: 1_000n },
        ),
      ),
    ),
    'leg-asset-mismatch',
    'a journal line denominated in two units is not a line',
  );
});

test('a leg from a wallet to itself is refused', async () => {
  const harness = await build();
  const wallet = await openWallet(harness, { purpose: 'spending' });

  assert.equal(
    await codeOf(() =>
      harness.service.allocatePlan(
        allocateRequest([legRequest({ sourceWalletId: wallet, destinationWalletId: wallet })], {
          targetAmountMinor: 1_000n,
        }),
      ),
    ),
    'leg-self-transfer',
  );
});

test('a leg out of a frozen wallet is refused', async () => {
  const harness = await build();
  const from = await openWallet(harness, { purpose: 'spending' });
  const to = await openWallet(harness, { ownerAccountId: SELLER, purpose: 'earnings' });
  await harness.service.setWalletStatus({
    walletId: from,
    stateId: idFor('wst'),
    toStatus: 'frozen',
    reason: 'a fraud hold',
    occurredAt: '2026-07-01T09:30:00Z',
    correlationId: idFor('corr'),
    idempotencyKey: idFor('idem'),
  });

  assert.equal(
    await codeOf(() =>
      harness.service.allocatePlan(
        allocateRequest([legRequest({ sourceWalletId: from, destinationWalletId: to })], {
          targetAmountMinor: 1_000n,
        }),
      ),
    ),
    'wallet-frozen',
  );
});

// ---------------------------------------------------------------------------
// The proof this module exists for
// ---------------------------------------------------------------------------

test('a purchase of LKR 10,000 is paid with rewards, merchant credit and a card', async () => {
  const harness = await build();

  // The buyer's three positions, and the seller's three. Three units, so three pairs of wallets:
  // K-10 refuses a transaction whose lines are not all in one asset type, and it is right to.
  const buyerRewards = await openWallet(harness, {
    ownerAccountId: BUYER,
    assetTypeId: JAYA_REWARD,
    purpose: 'spending',
  });
  const buyerCredit = await openWallet(harness, {
    ownerAccountId: BUYER,
    assetTypeId: MERCHANT_CREDIT,
    purpose: 'spending',
  });
  const buyerSettlement = await openWallet(harness, {
    ownerAccountId: BUYER,
    assetTypeId: LKR,
    purpose: 'settlement',
    normalBalance: 'debit',
  });

  const sellerRewards = await openWallet(harness, {
    ownerAccountId: SELLER,
    assetTypeId: JAYA_REWARD,
    purpose: 'earnings',
  });
  const sellerCredit = await openWallet(harness, {
    ownerAccountId: SELLER,
    assetTypeId: MERCHANT_CREDIT,
    purpose: 'earnings',
  });
  const sellerCash = await openWallet(harness, {
    ownerAccountId: SELLER,
    assetTypeId: LKR,
    purpose: 'earnings',
  });

  // LKR 10,000 = 1,000,000 cents: 1,500 rewards + 500 merchant credit + 8,000 on a card, each at
  // parity, each in its own unit.
  const request = allocateRequest(
    [
      legRequest({
        legId: 'leg_01HR0FMIX0001',
        kind: 'internal',
        assetTypeId: JAYA_REWARD,
        sourceWalletId: buyerRewards,
        destinationWalletId: sellerRewards,
        amountMinor: 150_000n,
        rate: PARITY,
        settlementEquivalentMinor: 150_000n,
        idempotencyKey: 'idem_mix_rewards',
      }),
      legRequest({
        legId: 'leg_01HR0FMIX0002',
        kind: 'internal',
        assetTypeId: MERCHANT_CREDIT,
        sourceWalletId: buyerCredit,
        destinationWalletId: sellerCredit,
        amountMinor: 50_000n,
        rate: PARITY,
        settlementEquivalentMinor: 50_000n,
        idempotencyKey: 'idem_mix_credit',
      }),
      legRequest({
        legId: 'leg_01HR0FMIX0003',
        kind: 'external',
        assetTypeId: LKR,
        sourceWalletId: null,
        destinationWalletId: sellerCash,
        amountMinor: 800_000n,
        rate: PARITY,
        settlementEquivalentMinor: 800_000n,
        idempotencyKey: 'idem_mix_card',
      }),
    ],
    { planId: 'pln_01HR0FMIX001', targetAmountMinor: 1_000_000n },
  );

  const allocated = await harness.service.allocatePlan(request);
  assert.equal(allocated.plan.status, 'draft');
  assert.equal(allocated.legs.length, 3);

  // Committing posts the two internal legs. The external one waits for M-12's money.
  const committed = await harness.service.commitPlan({
    planId: request.planId,
    postings: [
      { legId: 'leg_01HR0FMIX0001', ledgerTransactionId: transactionId() },
      { legId: 'leg_01HR0FMIX0002', ledgerTransactionId: transactionId() },
    ],
    committedAt: '2026-07-01T11:00:00Z',
    correlationId: idFor('corr'),
    idempotencyKey: idFor('idem'),
    eventId: idFor('fev'),
  });
  assert.equal(
    committed.plan.status,
    'committed',
    'a plan with an external leg waits for the money to arrive',
  );

  const midway = await harness.service.getCoverage(request.planId);
  assert.equal(midway.postedMinor, 200_000n, 'the two internal legs have moved');
  assert.equal(midway.outstandingMinor, 800_000n, 'the card leg has not');
  assert.equal(midway.fullyAllocated, true);
  assert.equal(midway.fullySettled, false);

  // The money lands. This is the fact a consumer of M-12's payment.captured hands over.
  const settled = await harness.service.settleExternalLeg({
    planId: request.planId,
    legId: 'leg_01HR0FMIX0003',
    ledgerTransactionId: transactionId(),
    externalReference: 'pay_01HR0FMIXPAY1',
    settledAt: '2026-07-01T11:05:00Z',
    correlationId: idFor('corr'),
    idempotencyKey: idFor('idem'),
    eventId: idFor('fev'),
  });
  assert.equal(settled.plan.status, 'settled');

  // The obligation is covered exactly, and the three parts are separately visible.
  const coverage = await harness.service.getCoverage(request.planId);
  assert.equal(coverage.targetAmountMinor, 1_000_000n);
  assert.equal(coverage.postedMinor, 1_000_000n);
  assert.equal(coverage.outstandingMinor, 0n);
  assert.equal(coverage.internalMinor, 200_000n);
  assert.equal(coverage.externalMinor, 800_000n);
  assert.equal(coverage.fullySettled, true);
  assert.equal(
    coverage.internalMinor + coverage.externalMinor,
    coverage.targetAmountMinor,
    '1,500 rewards + 500 merchant credit + 8,000 card is LKR 10,000, and nothing was rounded',
  );

  // And the journal agrees, in each unit separately. This is the check a stub could not make.
  assert.equal(await balanceOf(harness, buyerRewards), -150_000n);
  assert.equal(await balanceOf(harness, sellerRewards), 150_000n);
  assert.equal(await balanceOf(harness, buyerCredit), -50_000n);
  assert.equal(await balanceOf(harness, sellerCredit), 50_000n);
  assert.equal(await balanceOf(harness, sellerCash), 800_000n);
  assert.equal(
    await balanceOf(harness, buyerSettlement),
    800_000n,
    'the platform holds the money that arrived from the gateway, and owes it onward',
  );

  assert.deepEqual(eventTypes(harness.repository).slice(-6), [
    'value_plan.allocated',
    'value_leg.posted',
    'value_leg.posted',
    'value_plan.committed',
    'value_leg.posted',
    'value_plan.settled',
  ]);
});

test('a plan with no external leg settles at commit', async () => {
  const harness = await build();
  const from = await openWallet(harness, { assetTypeId: JAYA_REWARD, purpose: 'spending' });
  const to = await openWallet(harness, {
    ownerAccountId: SELLER,
    assetTypeId: JAYA_REWARD,
    purpose: 'earnings',
  });

  const request = allocateRequest(
    [
      legRequest({
        assetTypeId: JAYA_REWARD,
        sourceWalletId: from,
        destinationWalletId: to,
        amountMinor: 500n,
        settlementEquivalentMinor: 500n,
      }),
    ],
    { settlementAssetTypeId: JAYA_REWARD, targetAmountMinor: 500n },
  );
  const allocated = await harness.service.allocatePlan(request);
  const legId = allocated.legs[0]?.legId ?? '';

  const committed = await harness.service.commitPlan({
    planId: request.planId,
    postings: [{ legId, ledgerTransactionId: transactionId() }],
    committedAt: '2026-07-01T11:00:00Z',
    correlationId: idFor('corr'),
    idempotencyKey: idFor('idem'),
    eventId: idFor('fev'),
  });

  assert.equal(
    committed.plan.status,
    'settled',
    'everything it needed has moved; there is nothing left to wait for',
  );
});

// ---------------------------------------------------------------------------
// Idempotency and lifecycle
// ---------------------------------------------------------------------------

test('allocating the same plan twice creates one plan', async () => {
  const harness = await build();
  const from = await openWallet(harness, { purpose: 'spending' });
  const to = await openWallet(harness, { ownerAccountId: SELLER, purpose: 'earnings' });
  const request = allocateRequest(
    [legRequest({ sourceWalletId: from, destinationWalletId: to })],
    {},
  );

  const first = await harness.service.allocatePlan(request);
  const second = await harness.service.allocatePlan(request);

  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.equal(harness.repository.plans().length, 1);
  assert.equal(harness.repository.legs().length, 1);
});

test('one obligation may not have two live plans', async () => {
  const harness = await build();
  const from = await openWallet(harness, { purpose: 'spending' });
  const to = await openWallet(harness, { ownerAccountId: SELLER, purpose: 'earnings' });
  const first = allocateRequest([legRequest({ sourceWalletId: from, destinationWalletId: to })], {
    obligationId: 'ord_01HR0FDOUBLE1',
  });
  await harness.service.allocatePlan(first);

  assert.equal(
    await codeOf(() =>
      harness.service.allocatePlan(
        allocateRequest([legRequest({ sourceWalletId: from, destinationWalletId: to })], {
          obligationId: 'ord_01HR0FDOUBLE1',
        }),
      ),
    ),
    'duplicate-plan-id',
    'two committed plans against one order is the order paid twice',
  );
});

test('committing twice posts the value once', async () => {
  const harness = await build();
  const from = await openWallet(harness, { purpose: 'spending' });
  const to = await openWallet(harness, { ownerAccountId: SELLER, purpose: 'earnings' });
  const request = allocateRequest([
    legRequest({
      sourceWalletId: from,
      destinationWalletId: to,
      amountMinor: 400n,
      settlementEquivalentMinor: 400n,
    }),
  ]);
  const allocated = await harness.service.allocatePlan(request);
  const legId = allocated.legs[0]?.legId ?? '';

  const commit = {
    planId: request.planId,
    postings: [{ legId, ledgerTransactionId: transactionId() }],
    committedAt: '2026-07-01T11:00:00Z',
    correlationId: idFor('corr'),
    idempotencyKey: idFor('idem'),
    eventId: idFor('fev'),
  };
  const first = await harness.service.commitPlan(commit);
  const second = await harness.service.commitPlan(commit);

  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.equal(
    await balanceOf(harness, to),
    400n,
    'the second commit must not move the value again',
  );
});

test('committing a plan that names no transaction for a leg is refused', async () => {
  const harness = await build();
  const from = await openWallet(harness, { purpose: 'spending' });
  const to = await openWallet(harness, { ownerAccountId: SELLER, purpose: 'earnings' });
  const request = allocateRequest([legRequest({ sourceWalletId: from, destinationWalletId: to })]);
  await harness.service.allocatePlan(request);

  assert.equal(
    await codeOf(() =>
      harness.service.commitPlan({
        planId: request.planId,
        postings: [],
        committedAt: '2026-07-01T11:00:00Z',
        correlationId: idFor('corr'),
        idempotencyKey: idFor('idem'),
        eventId: idFor('fev'),
      }),
    ),
    'malformed-record',
  );
});

test('an external leg cannot settle before its plan is committed', async () => {
  const harness = await build();
  const to = await openWallet(harness, { ownerAccountId: SELLER, purpose: 'earnings' });
  await openWallet(harness, { purpose: 'settlement', normalBalance: 'debit' });

  const request = allocateRequest([
    legRequest({
      legId: 'leg_01HR0FEARLY01',
      kind: 'external',
      sourceWalletId: null,
      destinationWalletId: to,
      amountMinor: 1_000n,
      settlementEquivalentMinor: 1_000n,
    }),
  ]);
  await harness.service.allocatePlan(request);

  assert.equal(
    await codeOf(() =>
      harness.service.settleExternalLeg({
        planId: request.planId,
        legId: 'leg_01HR0FEARLY01',
        ledgerTransactionId: transactionId(),
        externalReference: 'pay_01HR0FEARLYP1',
        settledAt: '2026-07-01T11:00:00Z',
        correlationId: idFor('corr'),
        idempotencyKey: idFor('idem'),
        eventId: idFor('fev'),
      }),
    ),
    'illegal-transition',
  );
});

test('settling an internal leg as though it were external is refused', async () => {
  const harness = await build();
  const from = await openWallet(harness, { purpose: 'spending' });
  const to = await openWallet(harness, { ownerAccountId: SELLER, purpose: 'earnings' });
  const request = allocateRequest([
    legRequest({ legId: 'leg_01HR0FINNER01', sourceWalletId: from, destinationWalletId: to }),
  ]);
  await harness.service.allocatePlan(request);

  assert.equal(
    await codeOf(() =>
      harness.service.settleExternalLeg({
        planId: request.planId,
        legId: 'leg_01HR0FINNER01',
        ledgerTransactionId: transactionId(),
        externalReference: 'pay_01HR0FINNERP1',
        settledAt: '2026-07-01T11:00:00Z',
        correlationId: idFor('corr'),
        idempotencyKey: idFor('idem'),
        eventId: idFor('fev'),
      }),
    ),
    'illegal-transition',
  );
});

// ---------------------------------------------------------------------------
// Reversal
// ---------------------------------------------------------------------------

test('cancelling a committed plan reverses the value and keeps both postings', async () => {
  const harness = await build();
  const from = await openWallet(harness, { assetTypeId: JAYA_REWARD, purpose: 'spending' });
  const to = await openWallet(harness, {
    ownerAccountId: SELLER,
    assetTypeId: JAYA_REWARD,
    purpose: 'earnings',
  });

  const request = allocateRequest(
    [
      legRequest({
        legId: 'leg_01HR0FREV0001',
        assetTypeId: JAYA_REWARD,
        sourceWalletId: from,
        destinationWalletId: to,
        amountMinor: 600n,
        settlementEquivalentMinor: 600n,
      }),
    ],
    { settlementAssetTypeId: JAYA_REWARD, targetAmountMinor: 600n },
  );
  await harness.service.allocatePlan(request);
  await harness.service.commitPlan({
    planId: request.planId,
    postings: [{ legId: 'leg_01HR0FREV0001', ledgerTransactionId: transactionId() }],
    committedAt: '2026-07-01T11:00:00Z',
    correlationId: idFor('corr'),
    idempotencyKey: idFor('idem'),
    eventId: idFor('fev'),
  });
  assert.equal(await balanceOf(harness, to), 600n);

  const cancelled = await harness.service.cancelPlan({
    planId: request.planId,
    reversals: [{ legId: 'leg_01HR0FREV0001', reversalTransactionId: transactionId() }],
    reason: 'the order was cancelled before delivery',
    cancelledAt: '2026-07-02T09:00:00Z',
    correlationId: idFor('corr'),
    idempotencyKey: idFor('idem'),
    eventId: idFor('fev'),
  });

  assert.equal(cancelled.plan.status, 'cancelled');
  assert.equal(await balanceOf(harness, to), 0n, 'the value came back');
  assert.equal(await balanceOf(harness, from), 0n);

  const leg = cancelled.legs[0];
  assert.ok(leg !== undefined);
  assert.equal(leg.status, 'reversed');
  assert.notEqual(
    leg.ledgerTransactionId,
    null,
    'the original posting is still named: it happened, and a journal that can forget is not a journal',
  );
  assert.notEqual(leg.reversalTransactionId, null);
  assert.notEqual(leg.ledgerTransactionId, leg.reversalTransactionId);
});

test('cancelling a plan that leaves a posted leg unreversed is refused', async () => {
  const harness = await build();
  const from = await openWallet(harness, { purpose: 'spending' });
  const to = await openWallet(harness, { ownerAccountId: SELLER, purpose: 'earnings' });
  const request = allocateRequest([
    legRequest({ legId: 'leg_01HR0FSTRAND1', sourceWalletId: from, destinationWalletId: to }),
  ]);
  await harness.service.allocatePlan(request);
  await harness.service.commitPlan({
    planId: request.planId,
    postings: [{ legId: 'leg_01HR0FSTRAND1', ledgerTransactionId: transactionId() }],
    committedAt: '2026-07-01T11:00:00Z',
    correlationId: idFor('corr'),
    idempotencyKey: idFor('idem'),
    eventId: idFor('fev'),
  });

  assert.equal(
    await codeOf(() =>
      harness.service.cancelPlan({
        planId: request.planId,
        reversals: [],
        reason: 'cancelled',
        cancelledAt: '2026-07-02T09:00:00Z',
        correlationId: idFor('corr'),
        idempotencyKey: idFor('idem'),
        eventId: idFor('fev'),
      }),
    ),
    'malformed-record',
    'cancelling while leaving value moved would strand the money with nobody accountable for it',
  );
});

test('a cancelled obligation may be allocated again', async () => {
  const harness = await build();
  const from = await openWallet(harness, { purpose: 'spending' });
  const to = await openWallet(harness, { ownerAccountId: SELLER, purpose: 'earnings' });
  const first = allocateRequest([legRequest({ sourceWalletId: from, destinationWalletId: to })], {
    obligationId: 'ord_01HR0FRETRY01',
  });
  await harness.service.allocatePlan(first);
  await harness.service.cancelPlan({
    planId: first.planId,
    reversals: [],
    reason: 'the buyer changed their payment method',
    cancelledAt: '2026-07-01T10:30:00Z',
    correlationId: idFor('corr'),
    idempotencyKey: idFor('idem'),
    eventId: idFor('fev'),
  });

  const second = await harness.service.allocatePlan(
    allocateRequest([legRequest({ sourceWalletId: from, destinationWalletId: to })], {
      obligationId: 'ord_01HR0FRETRY01',
    }),
  );
  assert.equal(second.plan.status, 'draft', 'a failed attempt must not block the next one');
});

test('a settled plan can still be reversed, which is what a refund is', async () => {
  const harness = await build();
  const from = await openWallet(harness, { assetTypeId: JAYA_REWARD, purpose: 'spending' });
  const to = await openWallet(harness, {
    ownerAccountId: SELLER,
    assetTypeId: JAYA_REWARD,
    purpose: 'earnings',
  });
  const request = allocateRequest(
    [
      legRequest({
        legId: 'leg_01HR0FTERM001',
        assetTypeId: JAYA_REWARD,
        sourceWalletId: from,
        destinationWalletId: to,
        amountMinor: 300n,
        settlementEquivalentMinor: 300n,
      }),
    ],
    { settlementAssetTypeId: JAYA_REWARD, targetAmountMinor: 300n },
  );
  await harness.service.allocatePlan(request);
  await harness.service.commitPlan({
    planId: request.planId,
    postings: [{ legId: 'leg_01HR0FTERM001', ledgerTransactionId: transactionId() }],
    committedAt: '2026-07-01T11:00:00Z',
    correlationId: idFor('corr'),
    idempotencyKey: idFor('idem'),
    eventId: idFor('fev'),
  });

  assert.equal(await balanceOf(harness, to), 300n);

  const reversed = await harness.service.cancelPlan({
    planId: request.planId,
    reversals: [{ legId: 'leg_01HR0FTERM001', reversalTransactionId: transactionId() }],
    reason: 'the buyer returned the goods after delivery',
    cancelledAt: '2026-07-02T09:00:00Z',
    correlationId: idFor('corr'),
    idempotencyKey: idFor('idem'),
    eventId: idFor('fev'),
  });

  assert.equal(reversed.plan.status, 'cancelled');
  assert.equal(await balanceOf(harness, to), 0n, 'the value came back');

  // Cancelling again is a no-op that reports the existing state, not a second reversal. A retry
  // after a lost response must not send the value back twice.
  const again = await harness.service.cancelPlan({
    planId: request.planId,
    reversals: [],
    reason: 'a retry of the same cancellation',
    cancelledAt: '2026-07-03T09:00:00Z',
    correlationId: idFor('corr'),
    idempotencyKey: idFor('idem'),
    eventId: idFor('fev'),
  });
  assert.equal(again.replayed, true);
  assert.equal(await balanceOf(harness, to), 0n);
  assert.equal(
    await balanceOf(harness, from),
    0n,
    'the payer is back where they started: debited 300 by the posting, credited 300 by the reversal',
  );
});

// ---------------------------------------------------------------------------
// Events, boundaries and determinism
// ---------------------------------------------------------------------------

test('a leg event carries both what moved and what it counted for', async () => {
  const harness = await build();
  const from = await openWallet(harness, { assetTypeId: JAYA_REWARD, purpose: 'spending' });
  const to = await openWallet(harness, {
    ownerAccountId: SELLER,
    assetTypeId: JAYA_REWARD,
    purpose: 'earnings',
  });

  // 8 points worth 12 cents. The two figures are genuinely different, which is the point.
  const request = allocateRequest(
    [
      legRequest({
        legId: 'leg_01HR0FEVENT01',
        assetTypeId: JAYA_REWARD,
        sourceWalletId: from,
        destinationWalletId: to,
        amountMinor: 8n,
        rate: { numerator: 3n, denominator: 2n },
        settlementEquivalentMinor: 12n,
      }),
    ],
    { targetAmountMinor: 12n },
  );
  await harness.service.allocatePlan(request);
  await harness.service.commitPlan({
    planId: request.planId,
    postings: [{ legId: 'leg_01HR0FEVENT01', ledgerTransactionId: transactionId() }],
    committedAt: '2026-07-01T11:00:00Z',
    correlationId: idFor('corr'),
    idempotencyKey: idFor('idem'),
    eventId: idFor('fev'),
  });

  const payload = lastEventPayload(harness.repository, 'value_leg.posted');
  assert.equal(payload.amount_minor, '8');
  assert.equal(payload.settlement_equivalent_minor, '12');
  assert.equal(payload.asset_type_id, JAYA_REWARD);
  assert.equal(payload.rate_numerator, '3');
  assert.equal(payload.rate_denominator, '2');
  assert.notEqual(
    payload.ledger_transaction_id,
    '',
    'a consumer must be able to reconcile the leg against K-10',
  );
});

test('outbox ids are unique across a full plan lifecycle', async () => {
  const harness = await build();
  const from = await openWallet(harness, { assetTypeId: JAYA_REWARD, purpose: 'spending' });
  const to = await openWallet(harness, {
    ownerAccountId: SELLER,
    assetTypeId: JAYA_REWARD,
    purpose: 'earnings',
  });
  const request = allocateRequest(
    [
      legRequest({
        legId: 'leg_01HR0FUNIQ001',
        assetTypeId: JAYA_REWARD,
        sourceWalletId: from,
        destinationWalletId: to,
        amountMinor: 100n,
        settlementEquivalentMinor: 100n,
      }),
    ],
    { settlementAssetTypeId: JAYA_REWARD, targetAmountMinor: 100n },
  );
  await harness.service.allocatePlan(request);
  await harness.service.commitPlan({
    planId: request.planId,
    postings: [{ legId: 'leg_01HR0FUNIQ001', ledgerTransactionId: transactionId() }],
    committedAt: '2026-07-01T11:00:00Z',
    correlationId: idFor('corr'),
    idempotencyKey: idFor('idem'),
    eventId: idFor('fev'),
  });

  const ids = harness.repository
    .outbox()
    .entries()
    .map((entry) => entry.outboxId);
  assert.equal(
    new Set(ids).size,
    ids.length,
    'two entries share an id, so the second would be refused by outbox_pkey. Ids derive from the ' +
      'record that produced the fact, never the plan alone',
  );
});

test('coverage is derived, so it cannot disagree with the legs', () => {
  const plan = {
    planId: 'pln_01HR0FCOVER01',
    obligationId: 'ord_01HR0FCOVER01',
    obligationKind: 'order',
    payerAccountId: BUYER,
    payeeAccountId: SELLER,
    status: 'draft' as const,
    settlementAssetTypeId: LKR,
    targetAmountMinor: 1_000n,
    committedAt: null,
    settledAt: null,
    cancelledAt: null,
    cancellationReason: null,
    createdAt: '2026-07-01T10:00:00Z',
    updatedAt: '2026-07-01T10:00:00Z',
    correlationId: 'corr_01HR0FCOVER1',
    idempotencyKey: 'idem_cover_0001',
  };

  const coverage = coverageOf(plan, []);
  assert.equal(coverage.allocatedMinor, 0n);
  assert.equal(
    coverage.fullyAllocated,
    false,
    'a plan with no legs covers nothing, whatever a stored column might have said',
  );
  assert.equal(coverage.fullySettled, false);
});

test('a request carrying another unit’s concern is refused by name', async () => {
  const harness = await build();
  const foreign = ['balance', 'commissionMinor', 'unitPrice', 'entries', 'instrumentToken'];

  for (const field of foreign) {
    assert.ok(FOREIGN_FIELDS[field], `${field} is not named in the foreign-field table`);
    const carrying = { ...openWalletRequest(), [field]: 'anything' };
    assert.equal(
      await codeOf(() => harness.service.openWallet(carrying)),
      'foreign-concern',
      `${field} was accepted. M-13 records where value is; it does not decide what is owed`,
    );
  }
});

test('M-13 imports no same-layer module and cannot reach the AI gateway', () => {
  const forbidden = [
    'modules/orders',
    'modules/payments',
    'modules/commission-rules',
    'modules/settlements',
    'modules/seller-payouts',
    'kernel/ai-gateway',
  ];
  for (const file of sourceFiles()) {
    const source = readFileSync(file.path, 'utf8');
    for (const target of forbidden) {
      assert.ok(
        !source.includes(`from '../../${target}`) && !source.includes(`from '../../../${target}`),
        `${file.name} imports ${target}. Same-layer modules communicate by event ` +
          '(MODULE_MAP §10.3), and a ledger module that could reach the AI gateway would put AI ' +
          'in the financial authority path (MODULE_MAP §11, rule F-1) — a P0 defect',
      );
    }
  }
});

test('no balance is stored anywhere in the module', () => {
  // K-10 derives every balance by summing entries. A column here would be a second source of truth
  // about money, and it would be the one that is wrong.
  const offenders: string[] = [];
  for (const file of sourceFiles()) {
    if (file.name === 'registry.ts') continue; // names them in order to refuse them
    const source = readFileSync(file.path, 'utf8');
    for (const field of ['balanceMinor:', 'availableMinor:', 'currentBalance:']) {
      if (source.includes(field)) offenders.push(`${file.name}:${field}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('the module reads no clock and generates no randomness', () => {
  const offenders: string[] = [];
  for (const file of sourceFiles()) {
    const source = readFileSync(file.path, 'utf8');
    if (/\bDate\.now\b|\bnew Date\b|\bMath\.random\b|\bcrypto\.randomUUID\b/.test(source)) {
      offenders.push(file.name);
    }
  }
  assert.deepEqual(offenders, [], 'the caller supplies every identifier and every instant');
});

test('a refused allocation leaves no plan, no leg and no outbox entry', async () => {
  const harness = await build();
  const from = await openWallet(harness, { purpose: 'spending' });
  const to = await openWallet(harness, { ownerAccountId: SELLER, purpose: 'earnings' });
  const before = harness.repository.outbox().entries().length;

  await assert.rejects(() =>
    harness.service.allocatePlan(
      allocateRequest([legRequest({ sourceWalletId: from, destinationWalletId: to })], {
        targetAmountMinor: 999_999n,
      }),
    ),
  );

  assert.deepEqual(harness.repository.plans(), []);
  assert.deepEqual(harness.repository.legs(), []);
  assert.equal(harness.repository.outbox().entries().length, before);
});

test('the platform account is usable as a wallet owner', async () => {
  const harness = await build();
  const walletId = await openWallet(harness, {
    ownerAccountId: PLATFORM,
    purpose: 'issuance',
    normalBalance: 'debit',
  });
  assert.equal((await harness.service.getWallet(walletId)).ownerAccountId, PLATFORM);
});

/** Every TypeScript file in the module, provider adapters included. */
function sourceFiles(): readonly { readonly name: string; readonly path: string }[] {
  const files: { name: string; path: string }[] = [];
  for (const entry of readdirSync(MODULE_DIR, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const directory = path.join(MODULE_DIR, entry.name);
      for (const nested of readdirSync(directory).filter((name) => name.endsWith('.ts'))) {
        files.push({ name: `${entry.name}/${nested}`, path: path.join(directory, nested) });
      }
      continue;
    }
    if (entry.name.endsWith('.ts')) {
      files.push({ name: entry.name, path: path.join(MODULE_DIR, entry.name) });
    }
  }
  return files;
}
