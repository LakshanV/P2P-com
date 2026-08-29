/**
 * Shared fixtures for the K-10 Ledger Foundation suites.
 */

import {
  InMemoryLedgerRepository,
  LedgerService,
  type AssetType,
  type CreateAccountRequest,
  type LedgerAccount,
  type LedgerTransaction,
  type PostTransactionRequest,
  type RegisterAssetTypeRequest,
} from '../../kernel/ledger-foundation/index.ts';

export interface Harness {
  readonly service: LedgerService;
  readonly repository: InMemoryLedgerRepository;
}

export function build(): Harness {
  const repository = new InMemoryLedgerRepository();
  return { service: new LedgerService(repository), repository };
}

let sequence = 0;

function seq(): string {
  sequence += 1;
  return String(sequence).padStart(4, '0');
}

export function assetType(
  overrides: Partial<RegisterAssetTypeRequest> = {},
): RegisterAssetTypeRequest {
  const n = seq();
  return {
    assetTypeId: `asset_${n}`,
    assetClass: 'fiat',
    symbol: `SYM${n}`,
    precision: 2,
    transferability: true,
    withdrawability: true,
    valuationSource: 'fixed',
    issuer: 'jaya_platform_v1',
    unit: 'cent',
    redeemable: false,
    convertible: true,
    expiryDays: null,
    restrictions: {},
    custodyProvider: null,
    jurisdiction: 'LK',
    ...overrides,
  };
}

export function assetTypeRecord(overrides: Partial<AssetType> = {}): AssetType {
  const n = seq();
  return {
    assetTypeId: `asset_${n}`,
    assetClass: 'fiat',
    symbol: `SYM${n}`,
    precision: 2,
    transferability: true,
    withdrawability: true,
    valuationSource: 'fixed',
    issuer: 'jaya_platform_v1',
    unit: 'cent',
    redeemable: false,
    convertible: true,
    expiryDays: null,
    restrictions: {},
    custodyProvider: null,
    jurisdiction: 'LK',
    ...overrides,
  };
}

export function accountRequest(
  overrides: Partial<CreateAccountRequest> = {},
): CreateAccountRequest {
  const n = seq();
  return {
    accountId: `acct_01HQZX${n}`,
    assetTypeId: `lkr`,
    ownerId: `owner_01HQZX${n}`,
    normalBalance: 'debit',
    createdAt: '2026-04-01T12:00:00Z',
    idempotencyKey: `idem_acct_${n}`,
    ...overrides,
  };
}

export function accountRecord(overrides: Partial<LedgerAccount> = {}): LedgerAccount {
  const n = seq();
  return {
    accountId: `acct_01HQZY${n}`,
    assetTypeId: `lkr`,
    ownerId: `owner_01HQZY${n}`,
    normalBalance: 'debit',
    createdAt: '2026-04-01T12:00:00Z',
    idempotencyKey: `idem_acct_${n}`,
    ...overrides,
  };
}

export function transactionRequest(
  entries: {
    readonly accountId: string;
    readonly side: 'debit' | 'credit';
    readonly balanceState?: 'available' | 'pending' | 'locked';
    readonly amount: bigint;
  }[],
  overrides: Partial<PostTransactionRequest> = {},
): PostTransactionRequest {
  const n = seq();
  return {
    transactionId: `txn_01HQZX${n}`,
    idempotencyKey: `idem_txn_${n}`,
    postedAt: '2026-04-01T12:00:00Z',
    assetTypeId: 'lkr',
    entries,
    ...overrides,
  };
}

export function transactionRecord(
  entries: {
    readonly accountId: string;
    readonly side: 'debit' | 'credit';
    readonly balanceState?: 'available' | 'pending' | 'locked';
    readonly amount: bigint;
  }[],
  overrides: Partial<LedgerTransaction> = {},
): LedgerTransaction {
  const n = seq();
  return {
    transactionId: `txn_01HQZY${n}`,
    idempotencyKey: `idem_txn_${n}`,
    postedAt: '2026-04-01T12:00:00Z',
    assetTypeId: 'lkr',
    // A stored record always states its position; the service defaults it on the way in, so the
    // fixture defaults it here to build the same record the service would have written.
    entries: entries.map((entry) => ({
      accountId: entry.accountId,
      side: entry.side,
      balanceState: entry.balanceState ?? ('available' as const),
      amount: entry.amount,
    })),
    ...overrides,
  };
}

export function assetTypeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    asset_type_id: 'lkr',
    asset_class: 'fiat',
    symbol: 'LKR',
    precision: 2,
    transferability: true,
    withdrawability: true,
    valuation_source: 'fixed',
    issuer: 'jaya_platform_v1',
    unit: 'cent',
    redeemable: false,
    convertible: true,
    expiry_days: null,
    restrictions: {},
    custody_provider: null,
    jurisdiction: 'LK',
    ...overrides,
  };
}

export function accountRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    account_id: 'acct_01HQZXTESTROW',
    asset_type_id: 'lkr',
    owner_id: 'owner_01HQZXTESTROW',
    normal_balance: 'debit',
    created_at: '2026-04-01T12:00:00.000000Z',
    idempotency_key: 'idem_01HQZXTESTROW',
    ...overrides,
  };
}

export function transactionRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    transaction_id: 'txn_01HQZXTESTROW',
    idempotency_key: 'idem_01HQZXTESTROW',
    posted_at: '2026-04-01T12:00:00.000000Z',
    asset_type_id: 'lkr',
    ...overrides,
  };
}

export function entryRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    transaction_id: 'txn_01HQZXTESTROW',
    account_id: 'acct_01HQZXTESTROW',
    side: 'debit',
    balance_state: 'available',
    amount: '1000',
    ...overrides,
  };
}
