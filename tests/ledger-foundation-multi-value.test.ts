/**
 * K-10 Ledger Foundation — the universal multi-value model.
 *
 * Two things are under test here, and they are the two things that separate a multi-value ledger
 * from a currency ledger with extra labels:
 *
 *   1. An asset type can say what kind of value it is — who issued it, whether it may be redeemed,
 *      converted or withdrawn, when it expires, what it may be spent on, who holds it and under
 *      which jurisdiction. Without those, a reward point and a rupee are the same object.
 *
 *   2. An account holds three positions, not one. Value can be moved from `available` to `locked`
 *      by an ordinary balanced transaction, which means a reservation is a journal entry rather
 *      than a mutable column, and the account's total does not move when its spendability does.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LedgerError } from '../kernel/ledger-foundation/index.ts';

import {
  accountRequest,
  assetType,
  build,
  transactionRequest,
} from './helpers/ledger-foundation-fixtures.ts';

// ---------------------------------------------------------------------------
// Asset type attributes
// ---------------------------------------------------------------------------

test('an asset type carries every attribute that distinguishes one kind of value from another', async () => {
  const { service } = build();

  const { assetType: stored } = await service.registerAssetType(
    assetType({
      assetTypeId: 'merchant_credit',
      symbol: 'MCRED',
      assetClass: 'reward',
      transferability: false,
      withdrawability: false,
      issuer: 'merchant_01HQZXA1',
      unit: 'point',
      redeemable: true,
      convertible: false,
      expiryDays: 365,
      restrictions: { acceptedMerchants: ['merchant_01HQZXA1'], minimumBasket: 500 },
      custodyProvider: null,
      jurisdiction: 'LK',
    }),
  );

  assert.equal(stored.issuer, 'merchant_01HQZXA1');
  assert.equal(stored.unit, 'point');
  assert.equal(stored.redeemable, true);
  assert.equal(stored.convertible, false);
  assert.equal(stored.withdrawability, false);
  assert.equal(stored.expiryDays, 365);
  assert.equal(stored.jurisdiction, 'LK');
  assert.equal(stored.custodyProvider, null);
  assert.deepEqual(stored.restrictions, {
    acceptedMerchants: ['merchant_01HQZXA1'],
    minimumBasket: 500,
  });
});

test('a restricted reward is a different record from unrestricted cash, not a relabelled one', async () => {
  const { service } = build();

  const { assetType: cash } = await service.registerAssetType(
    assetType({
      assetTypeId: 'lkr',
      symbol: 'LKR',
      assetClass: 'fiat',
      issuer: 'cbsl_issuer_01',
      unit: 'cent',
      redeemable: false,
      convertible: true,
      transferability: true,
      withdrawability: true,
      expiryDays: null,
      restrictions: {},
      jurisdiction: 'LK',
    }),
  );

  const { assetType: reward } = await service.registerAssetType(
    assetType({
      assetTypeId: 'jaya_reward',
      symbol: 'JAYAPTS',
      assetClass: 'reward',
      issuer: 'jaya_platform_v1',
      unit: 'point',
      redeemable: true,
      convertible: false,
      transferability: false,
      withdrawability: false,
      expiryDays: 180,
      restrictions: { categories: ['grocery'] },
      jurisdiction: 'LK',
    }),
  );

  // The whole point: nothing about the reward says "spendable like cash".
  assert.equal(cash.withdrawability, true);
  assert.equal(reward.withdrawability, false);
  assert.equal(cash.transferability, true);
  assert.equal(reward.transferability, false);
  assert.equal(cash.expiryDays, null);
  assert.equal(reward.expiryDays, 180);
  assert.deepEqual(cash.restrictions, {});
  assert.deepEqual(reward.restrictions, { categories: ['grocery'] });
});

test('restrictions cannot be edited through the record the service handed back', async () => {
  const { service } = build();
  const { assetType: stored } = await service.registerAssetType(
    assetType({ restrictions: { categories: ['grocery'] } }),
  );

  assert.ok(Object.isFrozen(stored.restrictions), 'restrictions must be frozen');
  assert.ok(
    Object.isFrozen(stored.restrictions.categories),
    'a nested array inside restrictions must be frozen too, or the seal is only skin deep',
  );
});

test('an issuer must be an opaque handle, because every account copies it', async () => {
  const { service } = build();
  await assert.rejects(
    () => service.registerAssetType(assetType({ issuer: 'treasury@example.com' })),
    (error: unknown) => error instanceof LedgerError && error.code === 'natural-identifier',
  );
});

test('an asset type without an issuer is refused: value nobody stands behind is not a value type', async () => {
  const { service } = build();
  await assert.rejects(
    () => service.registerAssetType(assetType({ issuer: undefined as unknown as string })),
    (error: unknown) => error instanceof LedgerError && error.code === 'malformed-issuer',
  );
});

test('a unit name must be lower_snake_case', async () => {
  const { service } = build();
  await assert.rejects(
    () => service.registerAssetType(assetType({ unit: 'Cent' })),
    (error: unknown) => error instanceof LedgerError && error.code === 'malformed-unit',
  );
});

test('a jurisdiction must be ISO 3166-1 alpha-2 or GLOBAL', async () => {
  const { service } = build();
  await assert.rejects(
    () => service.registerAssetType(assetType({ jurisdiction: 'Sri Lanka' })),
    (error: unknown) => error instanceof LedgerError && error.code === 'malformed-jurisdiction',
  );

  const { assetType: global } = await service.registerAssetType(
    assetType({ jurisdiction: 'GLOBAL' }),
  );
  assert.equal(global.jurisdiction, 'GLOBAL');
});

test('an expiry must be a positive whole number of days, or null', async () => {
  const { service } = build();

  for (const bad of [0, -1, 1.5]) {
    await assert.rejects(
      () => service.registerAssetType(assetType({ expiryDays: bad })),
      (error: unknown) => error instanceof LedgerError && error.code === 'invalid-expiry',
      `expiryDays ${bad} must be refused`,
    );
  }

  const { assetType: never } = await service.registerAssetType(assetType({ expiryDays: null }));
  assert.equal(never.expiryDays, null);
});

test('restrictions must be an object, so "unrestricted" is a decision rather than an absence', async () => {
  const { service } = build();
  for (const bad of [null, [], 'none']) {
    await assert.rejects(
      () =>
        service.registerAssetType(
          assetType({ restrictions: bad as unknown as Record<string, unknown> }),
        ),
      (error: unknown) => error instanceof LedgerError && error.code === 'malformed-record',
      `restrictions ${JSON.stringify(bad)} must be refused`,
    );
  }
});

test('re-registering an asset type with different attributes is refused, not merged', async () => {
  const { service } = build();
  await service.registerAssetType(assetType({ assetTypeId: 'jaya_reward', expiryDays: 180 }));

  await assert.rejects(
    () => service.registerAssetType(assetType({ assetTypeId: 'jaya_reward', expiryDays: 365 })),
    (error: unknown) => error instanceof LedgerError && error.code === 'duplicate-asset-type-id',
    'changing an expiry silently would change what every balance denominated in it is worth',
  );
});

test('re-registering an identical asset type deduplicates, including the new attributes', async () => {
  const { service } = build();
  const request = assetType({
    assetTypeId: 'jaya_reward',
    restrictions: { categories: ['grocery'] },
  });

  const first = await service.registerAssetType(request);
  const second = await service.registerAssetType(request);

  assert.equal(first.deduplicated, false);
  assert.equal(second.deduplicated, true);
  assert.deepEqual(second.assetType.restrictions, { categories: ['grocery'] });
});

// ---------------------------------------------------------------------------
// Balance positions
// ---------------------------------------------------------------------------

/** A ledger with one asset type and two accounts, ready to post against. */
async function twoAccounts(normalBalance: 'debit' | 'credit' = 'credit') {
  const harness = build();
  await harness.service.registerAssetType(assetType({ assetTypeId: 'lkr', symbol: 'LKR' }));
  await harness.service.createAccount(
    accountRequest({ accountId: 'acct_wallet_01HQ', assetTypeId: 'lkr', normalBalance }),
  );
  await harness.service.createAccount(
    accountRequest({ accountId: 'acct_source_01HQ', assetTypeId: 'lkr', normalBalance }),
  );
  return harness;
}

test('an entry that does not name a position is an available-position entry', async () => {
  const { service } = await twoAccounts();

  await service.postTransaction(
    transactionRequest([
      { accountId: 'acct_wallet_01HQ', side: 'credit', amount: 10_000n },
      { accountId: 'acct_source_01HQ', side: 'debit', amount: 10_000n },
    ]),
  );

  const balance = await service.getBalance('acct_wallet_01HQ');
  assert.equal(balance.available, 10_000n);
  assert.equal(balance.pending, 0n);
  assert.equal(balance.locked, 0n);
  assert.equal(balance.total, 10_000n);
});

test('locking value moves it out of available without changing the total', async () => {
  const { service } = await twoAccounts();

  await service.postTransaction(
    transactionRequest([
      { accountId: 'acct_wallet_01HQ', side: 'credit', amount: 10_000n },
      { accountId: 'acct_source_01HQ', side: 'debit', amount: 10_000n },
    ]),
  );

  // The reservation: same account, available down, locked up. Debits equal credits, so the
  // transaction balances and the balanced-transaction rule is untouched.
  await service.postTransaction(
    transactionRequest([
      {
        accountId: 'acct_wallet_01HQ',
        side: 'debit',
        balanceState: 'available',
        amount: 2_500n,
      },
      { accountId: 'acct_wallet_01HQ', side: 'credit', balanceState: 'locked', amount: 2_500n },
    ]),
  );

  const balance = await service.getBalance('acct_wallet_01HQ');
  assert.equal(balance.available, 7_500n, 'the reservation must reduce spendable value');
  assert.equal(balance.locked, 2_500n, 'the reservation must appear as locked');
  assert.equal(balance.pending, 0n);
  assert.equal(
    balance.total,
    10_000n,
    'a reservation moves value, it does not create or destroy it',
  );
});

test('releasing a lock restores available value exactly', async () => {
  const { service } = await twoAccounts();

  await service.postTransaction(
    transactionRequest([
      { accountId: 'acct_wallet_01HQ', side: 'credit', amount: 10_000n },
      { accountId: 'acct_source_01HQ', side: 'debit', amount: 10_000n },
    ]),
  );
  await service.postTransaction(
    transactionRequest([
      { accountId: 'acct_wallet_01HQ', side: 'debit', balanceState: 'available', amount: 2_500n },
      { accountId: 'acct_wallet_01HQ', side: 'credit', balanceState: 'locked', amount: 2_500n },
    ]),
  );
  // The release is the same movement in reverse.
  await service.postTransaction(
    transactionRequest([
      { accountId: 'acct_wallet_01HQ', side: 'debit', balanceState: 'locked', amount: 2_500n },
      {
        accountId: 'acct_wallet_01HQ',
        side: 'credit',
        balanceState: 'available',
        amount: 2_500n,
      },
    ]),
  );

  const balance = await service.getBalance('acct_wallet_01HQ');
  assert.equal(balance.available, 10_000n);
  assert.equal(balance.locked, 0n);
  assert.equal(balance.total, 10_000n);
});

test('the three positions are derived independently on a debit-normal account too', async () => {
  const { service } = await twoAccounts('debit');

  await service.postTransaction(
    transactionRequest([
      { accountId: 'acct_wallet_01HQ', side: 'debit', amount: 8_000n },
      { accountId: 'acct_source_01HQ', side: 'credit', amount: 8_000n },
    ]),
  );
  await service.postTransaction(
    transactionRequest([
      { accountId: 'acct_wallet_01HQ', side: 'credit', balanceState: 'available', amount: 3_000n },
      { accountId: 'acct_wallet_01HQ', side: 'debit', balanceState: 'pending', amount: 3_000n },
    ]),
  );

  const balance = await service.getBalance('acct_wallet_01HQ');
  assert.equal(balance.normalBalance, 'debit');
  assert.equal(balance.available, 5_000n);
  assert.equal(balance.pending, 3_000n);
  assert.equal(balance.locked, 0n);
  assert.equal(balance.total, 8_000n);
});

test('debitTotal and creditTotal stay the totals across every position', async () => {
  const { service } = await twoAccounts();

  await service.postTransaction(
    transactionRequest([
      { accountId: 'acct_wallet_01HQ', side: 'credit', amount: 10_000n },
      { accountId: 'acct_source_01HQ', side: 'debit', amount: 10_000n },
    ]),
  );
  await service.postTransaction(
    transactionRequest([
      { accountId: 'acct_wallet_01HQ', side: 'debit', balanceState: 'available', amount: 4_000n },
      { accountId: 'acct_wallet_01HQ', side: 'credit', balanceState: 'locked', amount: 4_000n },
    ]),
  );

  const balance = await service.getBalance('acct_wallet_01HQ');
  // 10,000 credited into available, then 4,000 debited from available and 4,000 credited to locked.
  assert.equal(balance.debitTotal, 4_000n);
  assert.equal(balance.creditTotal, 14_000n);
  assert.equal(
    balance.creditTotal - balance.debitTotal,
    balance.total,
    'on a credit-normal account the signed total must reconcile with the raw column totals',
  );
});

test('value in three positions at once is reported as three numbers that sum to the total', async () => {
  const { service } = await twoAccounts();

  await service.postTransaction(
    transactionRequest([
      { accountId: 'acct_wallet_01HQ', side: 'credit', amount: 10_000n },
      { accountId: 'acct_source_01HQ', side: 'debit', amount: 10_000n },
    ]),
  );
  await service.postTransaction(
    transactionRequest([
      { accountId: 'acct_wallet_01HQ', side: 'debit', balanceState: 'available', amount: 2_000n },
      { accountId: 'acct_wallet_01HQ', side: 'credit', balanceState: 'locked', amount: 2_000n },
    ]),
  );
  await service.postTransaction(
    transactionRequest([
      { accountId: 'acct_wallet_01HQ', side: 'debit', balanceState: 'available', amount: 1_500n },
      { accountId: 'acct_wallet_01HQ', side: 'credit', balanceState: 'pending', amount: 1_500n },
    ]),
  );

  const balance = await service.getBalance('acct_wallet_01HQ');
  assert.equal(balance.available, 6_500n);
  assert.equal(balance.locked, 2_000n);
  assert.equal(balance.pending, 1_500n);
  assert.equal(balance.available + balance.pending + balance.locked, balance.total);
  assert.equal(balance.total, 10_000n);
});

test('an unknown balance state is refused rather than silently treated as available', async () => {
  const { service } = await twoAccounts();

  await assert.rejects(
    () =>
      service.postTransaction(
        transactionRequest([
          {
            accountId: 'acct_wallet_01HQ',
            side: 'credit',
            balanceState: 'frozen' as 'locked',
            amount: 1_000n,
          },
          { accountId: 'acct_source_01HQ', side: 'debit', amount: 1_000n },
        ]),
      ),
    (error: unknown) => error instanceof LedgerError && error.code === 'invalid-balance-state',
  );
});

test('a position transfer still has to balance', async () => {
  const { service } = await twoAccounts();

  await assert.rejects(
    () =>
      service.postTransaction(
        transactionRequest([
          {
            accountId: 'acct_wallet_01HQ',
            side: 'debit',
            balanceState: 'available',
            amount: 2_500n,
          },
          {
            accountId: 'acct_wallet_01HQ',
            side: 'credit',
            balanceState: 'locked',
            amount: 2_400n,
          },
        ]),
      ),
    (error: unknown) => error instanceof LedgerError && error.code === 'unbalanced-transaction',
    'moving value between positions must not be a way to lose a hundred cents',
  );
});

test('locking more than the account holds is arithmetic the ledger permits and the caller must not', async () => {
  // K-10 is a journal, not a policy engine: it records what it is told and refuses only what is
  // structurally wrong. An overdrawn available position is a real, representable state — this test
  // pins that down so no caller assumes K-10 is enforcing a spending limit on its behalf.
  const { service } = await twoAccounts();

  await service.postTransaction(
    transactionRequest([
      { accountId: 'acct_wallet_01HQ', side: 'credit', amount: 1_000n },
      { accountId: 'acct_source_01HQ', side: 'debit', amount: 1_000n },
    ]),
  );
  await service.postTransaction(
    transactionRequest([
      { accountId: 'acct_wallet_01HQ', side: 'debit', balanceState: 'available', amount: 5_000n },
      { accountId: 'acct_wallet_01HQ', side: 'credit', balanceState: 'locked', amount: 5_000n },
    ]),
  );

  const balance = await service.getBalance('acct_wallet_01HQ');
  assert.equal(balance.available, -4_000n, 'the position goes negative rather than being clamped');
  assert.equal(balance.locked, 5_000n);
  assert.equal(
    balance.total,
    1_000n,
    'the total is still right, which is what makes this safe to detect',
  );
});
