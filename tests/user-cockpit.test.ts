/**
 * M-36 User Cockpit — the buyer's own screens.
 *
 * The module owns no data, writes nothing and has no schema, so what is tested here is whether the
 * views it assembles tell the truth about what the owning units hold.
 *
 * Two properties are the point of the module.
 *
 * **Value in different asset types is never summed into one number.** A holder with 1,500 reward
 * points and LKR 8,000 does not have "9,500 of anything": points are a restricted credit with an
 * issuer, an expiry and a list of things they may be spent on, and rupees are not. A screen that
 * added them would show a figure that is wrong in a way the reader cannot see, and every decision
 * made from it would inherit the error.
 *
 * **Nothing is cached.** Every figure is read from K-10, M-13, M-11 and M-12 at the moment it is
 * asked for, so the cockpit cannot be stale. A test that moves money and then reads the screen must
 * see the new number, and that is asserted rather than assumed.
 *
 * The suite also covers what the module refuses to guess at: a wallet pointing at a K-10 account
 * that does not exist, and an asset type K-10 does not know. Showing a zero for either would be
 * inventing a balance.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  InMemoryLedgerRepository,
  LedgerService,
  type RegisterAssetTypeRequest,
} from '../kernel/ledger-foundation/index.ts';
import {
  FinancialLedgerService,
  InMemoryFinancialLedgerRepository,
  K10LedgerPort,
} from '../modules/financial-ledger/index.ts';
import { InMemoryOrderRepository, OrderService } from '../modules/orders/index.ts';
import {
  InMemoryPaymentRepository,
  PaymentService,
  resolveMockProvider,
} from '../modules/payments/index.ts';
import { UserCockpitError, UserCockpitService } from '../modules/user-cockpit/index.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODULE_DIR = path.join(REPO_ROOT, 'modules', 'user-cockpit');

const BUYER = 'acct_01HR0CKPT0buyer';
const SELLER = 'acct_01HR0CKPT0selr1';
const NOW = '2026-07-01T12:00:00Z';

interface Harness {
  readonly cockpit: UserCockpitService;
  readonly orders: OrderService;
  readonly payments: PaymentService;
  readonly ledger: FinancialLedgerService;
  readonly journal: LedgerService;
}

const asset = (overrides: Partial<RegisterAssetTypeRequest>): RegisterAssetTypeRequest => ({
  assetTypeId: 'lkr',
  assetClass: 'fiat',
  symbol: 'LKR',
  precision: 2,
  transferability: true,
  withdrawability: true,
  valuationSource: 'fixed',
  issuer: 'iss_01HR0CKPTcentrl',
  unit: 'cent',
  redeemable: true,
  convertible: true,
  expiryDays: null,
  restrictions: {},
  custodyProvider: null,
  jurisdiction: 'LK',
  ...overrides,
});

async function build(): Promise<Harness> {
  const journal = new LedgerService(new InMemoryLedgerRepository());
  await journal.registerAssetType(asset({}));
  await journal.registerAssetType(
    asset({
      assetTypeId: 'jaya_reward',
      assetClass: 'reward',
      symbol: 'JAYAREWARD',
      precision: 0,
      unit: 'point',
      // The attributes that make a reward point not cash. The cockpit shows these next to the
      // number, which is the whole reason K-10 records them.
      transferability: false,
      withdrawability: false,
      convertible: false,
      issuer: 'iss_01HR0CKPTjayapl',
      jurisdiction: 'GLOBAL',
    }),
  );

  const ledger = new FinancialLedgerService(
    new InMemoryFinancialLedgerRepository(),
    new K10LedgerPort(journal),
  );
  const orders = new OrderService(new InMemoryOrderRepository());
  const payments = new PaymentService(new InMemoryPaymentRepository(), resolveMockProvider);

  return {
    cockpit: new UserCockpitService({ orders, payments, ledger, journal }),
    orders,
    payments,
    ledger,
    journal,
  };
}

let sequence = 0;
const seq = (): string => String((sequence += 1)).padStart(4, '0');

async function openWallet(
  harness: Harness,
  assetTypeId: string,
  purpose: string,
  owner = BUYER,
): Promise<string> {
  const n = seq();
  const walletId = `wal_01HR0CKPT${n}`;
  await harness.ledger.openWallet({
    walletId,
    ownerAccountId: owner,
    assetTypeId,
    purpose,
    ledgerAccountId: `lac_01HR0CKPT${n}`,
    normalBalance: 'credit',
    openedAt: '2026-07-01T09:00:00Z',
    correlationId: `corr_01HR0CKPT${n}`,
    idempotencyKey: `idem_ckpt_wal_${n}`,
  });
  return walletId;
}

/** Move value between two wallets through a plan, so the balances are real journal entries. */
async function move(
  harness: Harness,
  from: string,
  to: string,
  assetTypeId: string,
  amount: bigint,
  obligationId: string,
): Promise<void> {
  const n = seq();
  const planId = `pln_01HR0CKPT${n}`;
  const legId = `leg_01HR0CKPT${n}`;
  await harness.ledger.allocatePlan({
    planId,
    obligationId,
    obligationKind: 'order',
    payerAccountId: BUYER,
    payeeAccountId: SELLER,
    settlementAssetTypeId: assetTypeId,
    targetAmountMinor: amount,
    legs: [
      {
        legId,
        kind: 'internal',
        assetTypeId,
        sourceWalletId: from,
        destinationWalletId: to,
        amountMinor: amount,
        rate: { numerator: 1n, denominator: 1n },
        settlementEquivalentMinor: amount,
        idempotencyKey: `idem_ckpt_leg_${n}`,
      },
    ],
    allocatedAt: '2026-07-01T10:00:00Z',
    correlationId: `corr_01HR0CKPTa${n}`,
    idempotencyKey: `idem_ckpt_pln_${n}`,
    eventId: `fev_01HR0CKPT${n}`,
  });
  await harness.ledger.commitPlan({
    planId,
    postings: [{ legId, ledgerTransactionId: `ltx_01HR0CKPT${n}` }],
    committedAt: '2026-07-01T11:00:00Z',
    correlationId: `corr_01HR0CKPTc${n}`,
    idempotencyKey: `idem_ckpt_cmt_${n}`,
    eventId: `fev_01HR0CKPTc${n}`,
  });
}

const codeOf = async (body: () => Promise<unknown>): Promise<string> => {
  try {
    await body();
  } catch (error) {
    if (error instanceof UserCockpitError) return error.code;
    throw error;
  }
  throw new Error('expected a refusal, and the call succeeded');
};

// ---------------------------------------------------------------------------
// MY MONEY
// ---------------------------------------------------------------------------

test('a holder with no wallets is empty, which is not the same as zero', async () => {
  const harness = await build();
  const view = await harness.cockpit.myMoney(BUYER, NOW);

  assert.equal(view.empty, true);
  assert.deepEqual(view.holdings, []);
  assert.equal(
    view.asOf,
    NOW,
    'the instant is stated, because every figure here is derived and none is stored',
  );
});

test('a holder with wallets but no value is not empty', async () => {
  const harness = await build();
  await openWallet(harness, 'lkr', 'spending');
  const view = await harness.cockpit.myMoney(BUYER, NOW);

  assert.equal(
    view.empty,
    false,
    '"you have not started" and "you have spent it" mean different things to the reader',
  );
  assert.equal(view.holdings.length, 1);
  assert.equal(view.holdings[0]?.total, 0n);
});

test('MY MONEY never sums across asset types', async () => {
  const harness = await build();
  const rupees = await openWallet(harness, 'lkr', 'spending');
  const points = await openWallet(harness, 'jaya_reward', 'spending');
  const sellerRupees = await openWallet(harness, 'lkr', 'earnings', SELLER);
  const sellerPoints = await openWallet(harness, 'jaya_reward', 'earnings', SELLER);

  // Fund the buyer by moving value in from the seller's side, which is a real posting either way.
  await move(harness, sellerRupees, rupees, 'lkr', 800_000n, 'ord_01HR0CKPTfund1');
  await move(harness, sellerPoints, points, 'jaya_reward', 1_500n, 'ord_01HR0CKPTfund2');

  const view = await harness.cockpit.myMoney(BUYER, NOW);

  assert.equal(view.holdings.length, 2, 'two asset types, two holdings');
  const bySymbol = new Map(view.holdings.map((holding) => [holding.symbol, holding]));
  assert.equal(bySymbol.get('LKR')?.total, 800_000n);
  assert.equal(bySymbol.get('JAYAREWARD')?.total, 1_500n);

  assert.ok(
    !Object.keys(view).includes('total'),
    'there is no single total, and there must not be: 800,000 cents plus 1,500 points is not ' +
      '801,500 of anything',
  );
});

test('a holding sums across purposes within one asset type', async () => {
  const harness = await build();
  const spending = await openWallet(harness, 'lkr', 'spending');
  const savings = await openWallet(harness, 'lkr', 'savings');
  const source = await openWallet(harness, 'lkr', 'earnings', SELLER);

  await move(harness, source, spending, 'lkr', 30_000n, 'ord_01HR0CKPTsum01');
  await move(harness, source, savings, 'lkr', 70_000n, 'ord_01HR0CKPTsum02');

  const view = await harness.cockpit.myMoney(BUYER, NOW);
  const lkr = view.holdings.find((holding) => holding.symbol === 'LKR');

  assert.equal(lkr?.total, 100_000n, 'spending and savings are both rupees, so they add');
  assert.equal(lkr?.positions.length, 2);
  assert.deepEqual(
    lkr?.positions.map((position) => position.purpose),
    ['savings', 'spending'],
    'positions are ordered, so a screen renders the same way twice',
  );
});

test('a position says whether the value can leave the platform', async () => {
  const harness = await build();
  await openWallet(harness, 'lkr', 'spending');
  await openWallet(harness, 'jaya_reward', 'spending');

  const view = await harness.cockpit.myMoney(BUYER, NOW);
  const rupees = view.holdings.find((holding) => holding.symbol === 'LKR')?.positions[0];
  const points = view.holdings.find((holding) => holding.symbol === 'JAYAREWARD')?.positions[0];

  assert.equal(rupees?.withdrawable, true);
  assert.equal(
    points?.withdrawable,
    false,
    'a holder looking at a reward balance needs to know it is not cash, and next to the number is ' +
      'the honest place to say so',
  );
  assert.equal(points?.transferable, false);
  assert.equal(points?.issuer, 'iss_01HR0CKPTjayapl', 'a holder’s claim is against the issuer');
  assert.equal(points?.precision, 0, 'an indivisible unit: the screen must not render decimals');
});

test('the three positions of an account are reported separately', async () => {
  const harness = await build();
  const wallet = await openWallet(harness, 'lkr', 'spending');
  const source = await openWallet(harness, 'lkr', 'earnings', SELLER);
  await move(harness, source, wallet, 'lkr', 50_000n, 'ord_01HR0CKPTpos001');

  const view = await harness.cockpit.myMoney(BUYER, NOW);
  const position = view.holdings[0]?.positions[0];

  assert.equal(position?.available, 50_000n);
  assert.equal(position?.pending, 0n);
  assert.equal(position?.locked, 0n);
  assert.equal(
    position?.total,
    50_000n,
    'available plus pending plus locked; a screen showing only one of them would mislead',
  );
});

test('the view is never stale, because nothing is cached', async () => {
  const harness = await build();
  const wallet = await openWallet(harness, 'lkr', 'spending');
  const source = await openWallet(harness, 'lkr', 'earnings', SELLER);

  const before = await harness.cockpit.myMoney(BUYER, NOW);
  assert.equal(before.holdings[0]?.total, 0n);

  await move(harness, source, wallet, 'lkr', 12_345n, 'ord_01HR0CKPTfresh1');

  const after = await harness.cockpit.myMoney(BUYER, NOW);
  assert.equal(
    after.holdings[0]?.total,
    12_345n,
    'a cached total on a screen showing somebody their money is a lie with a timestamp',
  );
});

test('a wallet naming a K-10 account that does not exist is refused, not shown as zero', async () => {
  const harness = await build();
  // Seeded straight into the repository, so the wallet exists without its journal account. The
  // service would never produce this, and a screen must not paper over it.
  const repository = new InMemoryFinancialLedgerRepository();
  repository.seed({
    wallets: [
      {
        walletId: 'wal_01HR0CKPTghost1',
        ownerAccountId: BUYER,
        assetTypeId: 'lkr',
        purpose: 'spending',
        ledgerAccountId: 'lac_01HR0CKPTghost1',
        status: 'open',
        createdAt: '2026-07-01T09:00:00Z',
        updatedAt: '2026-07-01T09:00:00Z',
        correlationId: 'corr_01HR0CKPTgho1',
        idempotencyKey: 'idem_ckpt_ghost1',
      },
    ],
  });

  const cockpit = new UserCockpitService({
    orders: harness.orders,
    payments: harness.payments,
    ledger: new FinancialLedgerService(repository, new K10LedgerPort(harness.journal)),
    journal: harness.journal,
  });

  assert.equal(
    await codeOf(() => cockpit.myMoney(BUYER, NOW)),
    'dangling-wallet',
    'showing a zero for a position that is not in the journal would be inventing a balance',
  );
});

test('a malformed instant is refused', async () => {
  const harness = await build();
  assert.equal(
    await codeOf(() => harness.cockpit.myMoney(BUYER, 'yesterday')),
    'malformed-instant',
  );
});

// ---------------------------------------------------------------------------
// MY ORDERS
// ---------------------------------------------------------------------------

test('MY ORDERS lists this buyer’s own orders', async () => {
  const harness = await build();

  for (const suffix of ['0001', '0002']) {
    await harness.orders.createOrder({
      orderId: `ord_01HR0CKPTL${suffix}`,
      buyerAccountId: BUYER,
      sellerAccountId: SELLER,
      currency: 'LKR',
      createdAt: '2026-07-01T09:00:00Z',
      updatedAt: '2026-07-01T09:00:00Z',
      correlationId: `corr_01HR0CKPTL${suffix}`,
      idempotencyKey: `idem_ckpt_ord_${suffix}`,
      eventId: `oev_01HR0CKPTL${suffix}`,
      reason: 'the buyer started a basket',
    });
  }
  // Somebody else's order, which must not appear.
  await harness.orders.createOrder({
    orderId: 'ord_01HR0CKPTOTHER',
    buyerAccountId: SELLER,
    sellerAccountId: BUYER,
    currency: 'LKR',
    createdAt: '2026-07-01T09:00:00Z',
    updatedAt: '2026-07-01T09:00:00Z',
    correlationId: 'corr_01HR0CKPTOTH1',
    idempotencyKey: 'idem_ckpt_ord_oth',
    eventId: 'oev_01HR0CKPTOTHER',
    reason: 'a different buyer',
  });

  const view = await harness.cockpit.myOrders(BUYER, NOW);

  assert.equal(view.orders.length, 2);
  assert.ok(
    view.orders.every((order) => order.orderId.startsWith('ord_01HR0CKPTL')),
    'a cockpit that showed somebody else’s orders would be a disclosure, not a bug',
  );
  assert.equal(view.orders[0]?.split, false);
});

test('an order’s detail shows what has been paid and how it was covered', async () => {
  const harness = await build();
  const orderId = 'ord_01HR0CKPTD0001';

  await harness.orders.createOrder({
    orderId,
    buyerAccountId: BUYER,
    sellerAccountId: SELLER,
    currency: 'LKR',
    createdAt: '2026-07-01T09:00:00Z',
    updatedAt: '2026-07-01T09:00:00Z',
    correlationId: 'corr_01HR0CKPTD001',
    idempotencyKey: 'idem_ckpt_det_ord',
    eventId: 'oev_01HR0CKPTD0001',
    reason: 'a basket',
  });

  await harness.payments.requestPayment({
    paymentId: 'pay_01HR0CKPTD0001',
    orderId,
    payerAccountId: BUYER,
    payeeAccountId: SELLER,
    provider: 'mock',
    rail: 'card',
    instrumentToken: 'tok_01HR0CKPTgood1',
    assetCode: 'LKR',
    assetScale: 2,
    amountMinor: 500_000n,
    requestedAt: '2026-07-01T09:30:00Z',
    correlationId: 'corr_01HR0CKPTD002',
    idempotencyKey: 'idem_ckpt_det_pay',
  });

  const view = await harness.cockpit.orderDetail(orderId, NOW);

  assert.equal(view.order.orderId, orderId);
  assert.equal(view.payments.length, 1);
  assert.equal(view.payments[0]?.amountMinor, 500_000n);
  assert.equal(view.payments[0]?.status, 'requires-authorisation');
  assert.equal(
    view.coverage,
    null,
    'no plan exists yet, which is a different thing from a plan covering nothing',
  );
});

test('an order’s coverage appears once a plan exists', async () => {
  const harness = await build();
  const orderId = 'ord_01HR0CKPTC0001';
  const from = await openWallet(harness, 'lkr', 'spending');
  const to = await openWallet(harness, 'lkr', 'earnings', SELLER);

  await harness.orders.createOrder({
    orderId,
    buyerAccountId: BUYER,
    sellerAccountId: SELLER,
    currency: 'LKR',
    createdAt: '2026-07-01T09:00:00Z',
    updatedAt: '2026-07-01T09:00:00Z',
    correlationId: 'corr_01HR0CKPTC001',
    idempotencyKey: 'idem_ckpt_cov_ord',
    eventId: 'oev_01HR0CKPTC0001',
    reason: 'a basket',
  });

  await move(harness, from, to, 'lkr', 25_000n, orderId);

  const view = await harness.cockpit.orderDetail(orderId, NOW);
  assert.equal(view.coverage?.targetAmountMinor, 25_000n);
  assert.equal(view.coverage?.postedMinor, 25_000n);
  assert.equal(view.coverage?.internalMinor, 25_000n);
  assert.equal(view.coverage?.externalMinor, 0n);
  assert.equal(view.coverage?.fullySettled, true);
});

// ---------------------------------------------------------------------------
// What the module is
// ---------------------------------------------------------------------------

test('the module stores nothing: no repository, no migration, no schema', () => {
  const files = readdirSync(MODULE_DIR).filter((name) => name.endsWith('.ts'));

  assert.ok(
    !files.includes('repository.ts'),
    'a cockpit with its own store is a second source of truth about money, and the second source ' +
      'is the one that goes stale',
  );
  assert.ok(!files.includes('postgres-repository.ts'));

  const migrations = readdirSync(path.join(REPO_ROOT, 'db', 'migrations')).filter((name) =>
    name.includes('user_cockpit'),
  );
  assert.deepEqual(migrations, [], 'M-36 owns no schema');

  for (const file of files) {
    const source = readFileSync(path.join(MODULE_DIR, file), 'utf8');
    assert.ok(
      !/\bINSERT\b|\bUPDATE\b|\bDELETE\b/.test(source),
      `${file} contains a write statement. M-36 reads and assembles; it never writes`,
    );
  }
});

test('the module reads no clock and generates no randomness', () => {
  const offenders: string[] = [];
  for (const file of readdirSync(MODULE_DIR).filter((name) => name.endsWith('.ts'))) {
    const source = readFileSync(path.join(MODULE_DIR, file), 'utf8');
    if (/\bDate\.now\b|\bnew Date\b|\bMath\.random\b|\bcrypto\.randomUUID\b/.test(source)) {
      offenders.push(file);
    }
  }
  assert.deepEqual(offenders, [], 'the caller supplies the instant, as everywhere else');
});

test('M-36 is terminal: nothing in the repository imports it', () => {
  // MODULE_MAP §7: cockpits compose, and are never composed into. A module that depended on a
  // cockpit would invert the whole dependency graph.
  const roots = ['kernel', 'modules', 'platform'];
  const offenders: string[] = [];

  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.ts')) continue;
      if (full.includes(path.join('modules', 'user-cockpit'))) continue;
      // An import specifier, not a mention. The architecture manifest names every module by
      // design — that is a declaration of what exists, not a dependency on it.
      if (readFileSync(full, 'utf8').includes('modules/user-cockpit/')) {
        offenders.push(path.relative(REPO_ROOT, full));
      }
    }
  };

  for (const root of roots) walk(path.join(REPO_ROOT, root));
  assert.deepEqual(offenders, []);
});
