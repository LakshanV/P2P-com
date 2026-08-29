/**
 * K-10 Ledger Foundation — contract, every refusal, and balance derivation.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { LedgerError } from '../kernel/ledger-foundation/index.ts';

import {
  accountRequest,
  assetType,
  build,
  transactionRequest,
} from './helpers/ledger-foundation-fixtures.ts';

const codeOf = (error: unknown): string | undefined =>
  error instanceof LedgerError ? error.code : undefined;

const rejectsWith = async (
  fn: () => Promise<unknown>,
  code: string,
  message: RegExp,
): Promise<void> => {
  await assert.rejects(fn, (error: unknown) => {
    assert.equal(codeOf(error), code, `expected ${code}, got ${String(codeOf(error))}`);
    assert.match((error as LedgerError).message, message);
    return true;
  });
};

// ---------------------------------------------------------------------------
// Asset type registration
// ---------------------------------------------------------------------------

test('registers an asset type and refuses a duplicate id', async () => {
  const { service, repository } = build();
  const first = await service.registerAssetType(assetType({ assetTypeId: 'lkr', symbol: 'LKR' }));
  assert.equal(first.deduplicated, false);
  assert.equal(first.assetType.assetTypeId, 'lkr');
  assert.equal(first.assetType.symbol, 'LKR');

  const second = await service.registerAssetType(assetType({ assetTypeId: 'lkr', symbol: 'LKR' }));
  assert.equal(second.deduplicated, true);
  assert.equal(repository.assetTypes().length, 1);

  await rejectsWith(
    () => service.registerAssetType(assetType({ assetTypeId: 'lkr', symbol: 'JAYA' })),
    'duplicate-asset-type-id',
    /already exists with different properties/,
  );
});

test('refuses malformed or unsupported asset type definitions', async () => {
  const { service } = build();
  await rejectsWith(
    () => service.registerAssetType(assetType({ assetTypeId: 'LKR' })),
    'malformed-asset-type-id',
    /lower_snake_case/,
  );
  await rejectsWith(
    () => service.registerAssetType(assetType({ symbol: 'lkr' })),
    'malformed-symbol',
    /upper-case/,
  );
  await rejectsWith(
    () => service.registerAssetType(assetType({ assetClass: 'crypto' as 'fiat' })),
    'unsupported-asset-class',
    /expected one of/,
  );
  await rejectsWith(
    () => service.registerAssetType(assetType({ precision: 0 })),
    'invalid-precision',
    /positive integer/,
  );
  await rejectsWith(
    () => service.registerAssetType(assetType({ precision: 1.5 })),
    'invalid-precision',
    /positive integer/,
  );
});

// ---------------------------------------------------------------------------
// Account creation
// ---------------------------------------------------------------------------

test('creates a ledger account after its asset type exists', async () => {
  const { service, repository } = build();
  await service.registerAssetType(assetType({ assetTypeId: 'lkr', symbol: 'LKR' }));

  const result = await service.createAccount(
    accountRequest({
      accountId: 'acct_01HQZXASSET',
      assetTypeId: 'lkr',
      ownerId: 'owner_asset_01HQZX',
      idempotencyKey: 'idem_acct_asset_01HQZX',
    }),
  );
  assert.equal(result.deduplicated, false);
  assert.equal(result.account.assetTypeId, 'lkr');
  assert.equal(result.account.normalBalance, 'debit');
  assert.equal(repository.accounts().length, 1);

  const retry = await service.createAccount(
    accountRequest({
      accountId: 'acct_01HQZXASSET',
      assetTypeId: 'lkr',
      ownerId: 'owner_asset_01HQZX',
      idempotencyKey: 'idem_acct_asset_01HQZX',
    }),
  );
  assert.equal(retry.deduplicated, true);
});

test('refuses an account for an unknown asset type', async () => {
  const { service, repository } = build();
  await rejectsWith(
    () => service.createAccount(accountRequest({ assetTypeId: 'missing_asset' })),
    'unknown-asset-type',
    /missing_asset is not registered/,
  );
  assert.equal(repository.accounts().length, 0);
});

test('refuses duplicate account ids and reused idempotency keys', async () => {
  const { service, repository } = build();
  await service.registerAssetType(assetType({ assetTypeId: 'lkr' }));
  await service.createAccount(
    accountRequest({ accountId: 'acct_01HQZXDUP', idempotencyKey: 'idem_key_01' }),
  );

  await rejectsWith(
    () =>
      service.createAccount(
        accountRequest({ accountId: 'acct_01HQZXDUP', idempotencyKey: 'idem_key_02' }),
      ),
    'duplicate-account-id',
    /already exists/,
  );
  await rejectsWith(
    () =>
      service.createAccount(
        accountRequest({ accountId: 'acct_01HQZXDUP2', idempotencyKey: 'idem_key_01' }),
      ),
    'idempotency-key-reuse',
    /already been used/,
  );

  assert.equal(repository.accounts().length, 1);
});

test('refuses malformed identifiers on accounts', async () => {
  const { service, repository } = build();
  await service.registerAssetType(assetType({ assetTypeId: 'lkr' }));

  await rejectsWith(
    () => service.createAccount(accountRequest({ accountId: 'alice@example.com' })),
    'natural-identifier',
    /email/,
  );
  await rejectsWith(
    () => service.createAccount(accountRequest({ accountId: 'short' })),
    'malformed-identifier',
    /shorter than 8/,
  );
  await rejectsWith(
    () => service.createAccount(accountRequest({ idempotencyKey: 'bearer-token-12345678' })),
    'secret-bearing-input',
    /credential/,
  );

  assert.equal(repository.accounts().length, 0);
});

// ---------------------------------------------------------------------------
// Transaction posting and balance calculation
// ---------------------------------------------------------------------------

test('posts a balanced transaction and derives balances', async () => {
  const { service } = build();
  await service.registerAssetType(assetType({ assetTypeId: 'lkr', symbol: 'LKR' }));
  await service.createAccount(
    accountRequest({ accountId: 'acct_asset_01HQZX', assetTypeId: 'lkr', normalBalance: 'debit' }),
  );
  await service.createAccount(
    accountRequest({
      accountId: 'acct_liability_01HQZX',
      assetTypeId: 'lkr',
      normalBalance: 'credit',
    }),
  );

  const result = await service.postTransaction(
    transactionRequest([
      { accountId: 'acct_asset_01HQZX', side: 'debit', amount: 5000n },
      { accountId: 'acct_liability_01HQZX', side: 'credit', amount: 5000n },
    ]),
  );
  assert.equal(result.deduplicated, false);
  assert.equal(result.transaction.entries.length, 2);

  const assetBalance = await service.getBalance('acct_asset_01HQZX');
  assert.equal(assetBalance.available, 5000n);
  assert.equal(assetBalance.debitTotal, 5000n);
  assert.equal(assetBalance.creditTotal, 0n);

  const liabilityBalance = await service.getBalance('acct_liability_01HQZX');
  assert.equal(liabilityBalance.available, 5000n);
  assert.equal(liabilityBalance.debitTotal, 0n);
  assert.equal(liabilityBalance.creditTotal, 5000n);
});

test('a retry with the same idempotency key returns the original transaction', async () => {
  const { service, repository } = build();
  await service.registerAssetType(assetType({ assetTypeId: 'lkr' }));
  await service.createAccount(
    accountRequest({ accountId: 'acct_idem_01HQZX', assetTypeId: 'lkr' }),
  );
  await service.createAccount(
    accountRequest({ accountId: 'acct_idem2_01HQZX', assetTypeId: 'lkr', normalBalance: 'credit' }),
  );

  const request = transactionRequest([
    { accountId: 'acct_idem_01HQZX', side: 'debit', amount: 1000n },
    { accountId: 'acct_idem2_01HQZX', side: 'credit', amount: 1000n },
  ]);
  const first = await service.postTransaction(request);
  const second = await service.postTransaction(request);
  assert.equal(second.deduplicated, true);
  assert.equal(first.transaction.transactionId, second.transaction.transactionId);
  assert.equal(repository.transactions().length, 1);
});

test('refuses an unbalanced transaction', async () => {
  const { service, repository } = build();
  await service.registerAssetType(assetType({ assetTypeId: 'lkr' }));
  await service.createAccount(
    accountRequest({ accountId: 'acct_unbal_01HQZX', assetTypeId: 'lkr' }),
  );
  await service.createAccount(
    accountRequest({
      accountId: 'acct_unbal2_01HQZX',
      assetTypeId: 'lkr',
      normalBalance: 'credit',
    }),
  );

  await rejectsWith(
    () =>
      service.postTransaction(
        transactionRequest([
          { accountId: 'acct_unbal_01HQZX', side: 'debit', amount: 3000n },
          { accountId: 'acct_unbal2_01HQZX', side: 'credit', amount: 2000n },
        ]),
      ),
    'unbalanced-transaction',
    /do not equal credits/,
  );
  assert.equal(repository.transactions().length, 0);
});

test('refuses a negative amount', async () => {
  const { service } = build();
  await service.registerAssetType(assetType({ assetTypeId: 'lkr' }));
  await service.createAccount(accountRequest({ accountId: 'acct_neg_01HQZX', assetTypeId: 'lkr' }));
  await service.createAccount(
    accountRequest({ accountId: 'acct_neg2_01HQZX', assetTypeId: 'lkr', normalBalance: 'credit' }),
  );

  await rejectsWith(
    () =>
      service.postTransaction(
        transactionRequest([
          { accountId: 'acct_neg_01HQZX', side: 'debit', amount: -100n },
          { accountId: 'acct_neg2_01HQZX', side: 'credit', amount: -100n },
        ]),
      ),
    'negative-amount',
    /negative/,
  );
});

test('refuses a transaction referencing an unknown account', async () => {
  const { service } = build();
  await service.registerAssetType(assetType({ assetTypeId: 'lkr' }));

  await rejectsWith(
    () =>
      service.postTransaction(
        transactionRequest([
          { accountId: 'acct_nobody_01HQZX', side: 'debit', amount: 1000n },
          { accountId: 'acct_nobody2_01HQZX', side: 'credit', amount: 1000n },
        ]),
      ),
    'unknown-account',
    /acct_nobody_01HQZX/,
  );
});

test('refuses a transaction that mixes asset types', async () => {
  const { service } = build();
  await service.registerAssetType(assetType({ assetTypeId: 'lkr' }));
  await service.registerAssetType(assetType({ assetTypeId: 'points', symbol: 'POINTS' }));
  await service.createAccount(accountRequest({ accountId: 'acct_lkr_01HQZX', assetTypeId: 'lkr' }));
  await service.createAccount(
    accountRequest({
      accountId: 'acct_points_01HQZX',
      assetTypeId: 'points',
      normalBalance: 'credit',
    }),
  );

  await rejectsWith(
    () =>
      service.postTransaction(
        transactionRequest(
          [
            { accountId: 'acct_lkr_01HQZX', side: 'debit', amount: 1000n },
            { accountId: 'acct_points_01HQZX', side: 'credit', amount: 1000n },
          ],
          { assetTypeId: 'lkr' },
        ),
      ),
    'mixed-asset-type',
    /acct_points_01HQZX/,
  );
});

test('refuses a duplicate transaction id', async () => {
  const { service } = build();
  await service.registerAssetType(assetType({ assetTypeId: 'lkr' }));
  await service.createAccount(
    accountRequest({ accountId: 'acct_dup1_01HQZX', assetTypeId: 'lkr' }),
  );
  await service.createAccount(
    accountRequest({ accountId: 'acct_dup2_01HQZX', assetTypeId: 'lkr', normalBalance: 'credit' }),
  );

  const first = await service.postTransaction(
    transactionRequest([
      { accountId: 'acct_dup1_01HQZX', side: 'debit', amount: 1000n },
      { accountId: 'acct_dup2_01HQZX', side: 'credit', amount: 1000n },
    ]),
  );

  await rejectsWith(
    () =>
      service.postTransaction(
        transactionRequest(
          [
            { accountId: 'acct_dup1_01HQZX', side: 'debit', amount: 1000n },
            { accountId: 'acct_dup2_01HQZX', side: 'credit', amount: 1000n },
          ],
          { transactionId: first.transaction.transactionId },
        ),
      ),
    'duplicate-transaction-id',
    /already exists/,
  );
});

// ---------------------------------------------------------------------------
// Outbox emission
// ---------------------------------------------------------------------------

test('posting a transaction emits one event and one audit record', async () => {
  const { service, repository } = build();
  await service.registerAssetType(assetType({ assetTypeId: 'lkr' }));
  await service.createAccount(
    accountRequest({ accountId: 'acct_out1_01HQZX', assetTypeId: 'lkr' }),
  );
  await service.createAccount(
    accountRequest({ accountId: 'acct_out2_01HQZX', assetTypeId: 'lkr', normalBalance: 'credit' }),
  );

  const result = await service.postTransaction(
    transactionRequest([
      { accountId: 'acct_out1_01HQZX', side: 'debit', amount: 2000n },
      { accountId: 'acct_out2_01HQZX', side: 'credit', amount: 2000n },
    ]),
  );

  const entries = repository.outbox().entries();
  assert.equal(entries.length, 2);

  const event = entries.find((entry) => entry.kind === 'event');
  const audit = entries.find((entry) => entry.kind === 'audit');
  assert.ok(event !== undefined);
  assert.ok(audit !== undefined);
  assert.ok((event.payload as { type: string }).type === 'ledger.transaction_posted');
  assert.ok((audit.payload as { action: string }).action === 'ledger.transaction_posted');
  assert.equal(
    (event.payload as { payload: { transaction_id: string } }).payload.transaction_id,
    result.transaction.transactionId,
  );
});

// ---------------------------------------------------------------------------
// Surface checks
// ---------------------------------------------------------------------------

test('the service exposes no operation that mutates history', () => {
  const { service } = build();
  const operations = new Set<string>();
  let proto: object | null = Object.getPrototypeOf(service) as object | null;
  while (proto !== null && proto !== Object.prototype) {
    for (const key of Object.getOwnPropertyNames(proto)) operations.add(key);
    proto = Object.getPrototypeOf(proto) as object | null;
  }
  operations.delete('constructor');

  const mutators = [...operations].filter((operation) =>
    /^(update|delete|remove|amend|reverse|void|rewrite|set[A-Z])/i.test(operation),
  );
  assert.deepEqual(mutators, [], 'the ledger is append-only; no operation may rewrite history');
});
