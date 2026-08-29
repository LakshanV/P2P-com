/**
 * K-10 Ledger Foundation — domain types (FND-005d).
 *
 * K-10 owns every amount in the platform: the asset types money is measured in, the ledger accounts
 * that hold positions, and the transactions that move value between them. It does not own prices,
 * listings, orders, payouts or rewards — those are business-module concerns that post here — and it
 * does not depend on anything above the platform substrate.
 *
 * All amounts are stored and computed as integer minor units (`bigint`). Floating point is never used
 * for money.
 *
 * Deterministic by construction: the caller supplies every identifier and every instant. Nothing here
 * reads a clock or generates randomness.
 *
 * Owned by: K-10 Ledger Foundation. See kernel/ledger-foundation/CONTRACT.md.
 */

/** The classes of asset K-10 recognises. Closed rather than extensible by convention. */
export const ASSET_CLASSES = ['fiat', 'reward', 'digital_asset', 'community'] as const;
export type AssetClass = (typeof ASSET_CLASSES)[number];

/**
 * The normal balance side of a ledger account.
 *
 * A debit-normal account increases with debits and decreases with credits; a credit-normal account
 * does the opposite. The sign of a posted balance is derived from this, not stored.
 */
export const NORMAL_BALANCES = ['debit', 'credit'] as const;
export type NormalBalance = (typeof NORMAL_BALANCES)[number];

/** The two sides of a ledger entry. */
export const ENTRY_SIDES = ['debit', 'credit'] as const;
export type EntrySide = (typeof ENTRY_SIDES)[number];

/**
 * The position a ledger entry sits in within its account.
 *
 * One account holds three positions, not one. `available` is value the owner may spend now;
 * `pending` is value that has been promised but not settled; `locked` is value reserved against a
 * specific obligation and unavailable until it is released or committed.
 *
 * Moving value between positions is an ordinary balanced transaction on the same account — debit one
 * position, credit another — so the journal stays immutable and the account total does not change.
 * There is no balance column to disagree with the entries.
 */
export const BALANCE_STATES = ['available', 'pending', 'locked'] as const;
export type BalanceState = (typeof BALANCE_STATES)[number];

/**
 * An asset type: the unit in which a ledger account is denominated.
 *
 * Asset type ids are lower_snake_case and scoped to K-10. Symbols are the public, upper-case token.
 */
export interface AssetType {
  readonly assetTypeId: string;
  readonly assetClass: AssetClass;
  readonly symbol: string;
  readonly precision: number;
  readonly transferability: boolean;
  readonly withdrawability: boolean;
  /** Where the asset's value comes from: fixed, market, oracle, or a deployment-specific source. */
  readonly valuationSource: string;
  /**
   * The party that issued this value and stands behind it.
   *
   * A sovereign currency is issued by its monetary authority; a reward point is issued by the
   * platform or by a merchant; a community credit is issued by the scheme that defines it. The
   * issuer is who a holder has a claim against, which is why it is not optional.
   */
  readonly issuer: string;
  /** The name of the minor unit amounts are counted in, e.g. `cent`, `satoshi`, `point`. */
  readonly unit: string;
  /** May a holder redeem this value against goods or services from the issuer? */
  readonly redeemable: boolean;
  /** May this value be converted into another asset type? */
  readonly convertible: boolean;
  /** Days from issue until the value expires, or null when it never expires. */
  readonly expiryDays: number | null;
  /**
   * Structured limits on how this value may be used, e.g. an accepted-merchant list or a category
   * restriction. An empty object means unrestricted.
   *
   * K-10 stores and returns restrictions; it does not interpret them. Enforcement belongs to the
   * module spending the value, which is the only unit that knows what it is being spent on.
   */
  readonly restrictions: Readonly<Record<string, unknown>>;
  /** The custodian holding the underlying value, or null when the platform holds it itself. */
  readonly custodyProvider: string | null;
  /** ISO 3166-1 alpha-2 country code, or `GLOBAL` when the value is not jurisdiction-bound. */
  readonly jurisdiction: string;
}

/**
 * A ledger account: one position in one asset type.
 *
 * Accounts are write-once and never mutated. Every balance is derived from the entries posted to the
 * account, so there is no balance column to disagree with.
 */
export interface LedgerAccount {
  readonly accountId: string;
  readonly assetTypeId: string;
  /** The party or account that owns this ledger position. */
  readonly ownerId: string;
  readonly normalBalance: NormalBalance;
  readonly createdAt: string;
  readonly idempotencyKey: string;
}

/** One line of a ledger transaction. */
export interface LedgerEntry {
  readonly accountId: string;
  readonly side: EntrySide;
  /** Which of the account's three positions this line moves. */
  readonly balanceState: BalanceState;
  /** Non-negative integer minor units. */
  readonly amount: bigint;
}

/**
 * A balanced ledger transaction.
 *
 * Every line is in the same asset type. The transaction itself records the asset type so a reader
 * does not have to join every entry to an account to know what was moved.
 */
export interface LedgerTransaction {
  readonly transactionId: string;
  readonly idempotencyKey: string;
  readonly postedAt: string;
  readonly assetTypeId: string;
  readonly entries: readonly LedgerEntry[];
}

/** A derived balance, returned by `getBalance`. */
export interface AccountBalance {
  readonly accountId: string;
  readonly assetTypeId: string;
  readonly normalBalance: NormalBalance;
  readonly debitTotal: bigint;
  readonly creditTotal: bigint;
  /** Value the owner may spend now, derived from the normal balance side. */
  readonly available: bigint;
  /** Value promised but not yet settled. */
  readonly pending: bigint;
  /** Value reserved against an obligation and unavailable until released or committed. */
  readonly locked: bigint;
  /** `available + pending + locked` — everything the account holds, in every position. */
  readonly total: bigint;
}

export type LedgerErrorCode =
  | 'malformed-asset-type-id'
  | 'malformed-symbol'
  | 'unsupported-asset-class'
  | 'invalid-precision'
  | 'duplicate-asset-type-id'
  | 'malformed-identifier'
  | 'natural-identifier'
  | 'secret-bearing-input'
  | 'malformed-instant'
  | 'unknown-asset-type'
  | 'duplicate-account-id'
  | 'idempotency-key-reuse'
  | 'malformed-record'
  | 'duplicate-transaction-id'
  | 'unbalanced-transaction'
  | 'negative-amount'
  | 'unknown-account'
  | 'mixed-asset-type'
  | 'no-such-account'
  | 'no-such-transaction'
  | 'nested-transaction'
  | 'invalid-side'
  | 'invalid-balance-state'
  | 'malformed-unit'
  | 'malformed-issuer'
  | 'malformed-jurisdiction'
  | 'invalid-expiry'
  | 'foreign-concern';

/** A refusal the caller must act on, as distinct from an unexpected failure. */
export class LedgerError extends Error {
  readonly code: LedgerErrorCode;

  constructor(code: LedgerErrorCode, message: string) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
  }
}
