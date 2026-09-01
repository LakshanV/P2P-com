/**
 * M-36 User Cockpit — the shapes a buyer's own screens are built from.
 *
 * **This module owns no data and has no schema.** Every figure below is assembled at read time from
 * the units that own it: balances from K-10, wallets from M-13, orders from M-11, payments from
 * M-12. There is no cockpit table, no materialised view and no cached total — because a cached total
 * is a number that was true once, and a screen showing somebody a balance that was true an hour ago
 * is worse than a screen showing them nothing.
 *
 * The consequence is that this module cannot be wrong about money. It can only be slow.
 *
 * **Value in different asset types is never summed into one number.** A holder with 1,500 reward
 * points and LKR 8,000 does not have "9,500 of anything". Reward points are a restricted credit with
 * an issuer, an expiry and a list of things they may be spent on; rupees are not. Adding them
 * produces a figure that is wrong in a way nobody can see, and every downstream decision made from
 * it inherits the error. So `MoneyView` is a **list of positions**, one per asset type, and the only
 * totals are within an asset type.
 *
 * Owned by: M-36 User Cockpit.
 */

/** One position: what a holder has of one asset, for one purpose. */
export interface WalletPosition {
  readonly walletId: string;
  readonly assetTypeId: string;
  /** The public token for the asset: `LKR`, `JAYAREWARD`. */
  readonly symbol: string;
  /** What kind of value this is: `fiat`, `reward`, `digital_asset`, `community`. */
  readonly assetClass: string;
  /** Decimal places the asset divides into. Zero means indivisible. */
  readonly precision: number;
  readonly purpose: string;
  readonly status: string;
  /** Spendable now. */
  readonly available: bigint;
  /** Promised but not settled. */
  readonly pending: bigint;
  /** Reserved against an obligation. */
  readonly locked: bigint;
  /** Everything the position holds, in every state. */
  readonly total: bigint;
  /**
   * Whether this value may leave the platform.
   *
   * Shown because a holder looking at a reward balance needs to know it is not cash, and the honest
   * place to say so is next to the number rather than in a footnote.
   */
  readonly withdrawable: boolean;
  readonly transferable: boolean;
  /** Who stands behind the value. A holder's claim is against this party. */
  readonly issuer: string;
}

/** Everything of one asset type a holder has, across every purpose. */
export interface AssetHolding {
  readonly assetTypeId: string;
  readonly symbol: string;
  readonly assetClass: string;
  readonly precision: number;
  readonly available: bigint;
  readonly pending: bigint;
  readonly locked: bigint;
  readonly total: bigint;
  readonly positions: readonly WalletPosition[];
}

/**
 * MY MONEY.
 *
 * A list, not a total. See the header: summing across asset types produces a number that is wrong
 * in a way nobody can see.
 */
export interface MoneyView {
  readonly accountId: string;
  /** One entry per asset type the holder has a wallet in, ordered by symbol. */
  readonly holdings: readonly AssetHolding[];
  /**
   * True when the holder has no wallet at all.
   *
   * Distinguished from "every balance is zero", because the two mean different things to somebody
   * looking at the screen: one is "you have not started", the other is "you have spent it".
   */
  readonly empty: boolean;
  /** The instant these figures were assembled. Every one of them is derived, none is stored. */
  readonly asOf: string;
}

/** One order, as a buyer sees it in a list. */
export interface OrderSummary {
  readonly orderId: string;
  readonly status: string;
  readonly sellerAccountId: string;
  readonly currency: string;
  readonly totalMinor: bigint;
  readonly itemCount: number;
  readonly placedAt: string | null;
  readonly createdAt: string;
  /** True when this order was split across suppliers, so its children carry the fulfilment. */
  readonly split: boolean;
}

/** What a buyer owes and has paid on one order. */
export interface OrderPaymentSummary {
  readonly paymentId: string;
  readonly status: string;
  readonly assetCode: string;
  readonly assetScale: number;
  readonly amountMinor: bigint;
  readonly capturedMinor: bigint;
  readonly refundedMinor: bigint;
  readonly rail: string;
  /** The vocabulary reason it failed, or null. */
  readonly failureCode: string | null;
}

/** One order with everything a buyer needs to understand its state. */
export interface OrderDetailView {
  readonly order: OrderSummary;
  readonly payments: readonly OrderPaymentSummary[];
  /**
   * How the obligation was covered, when a value plan exists for it.
   *
   * Null when nothing has been allocated yet, which is different from "covered by nothing".
   */
  readonly coverage: {
    readonly targetAmountMinor: bigint;
    readonly postedMinor: bigint;
    readonly outstandingMinor: bigint;
    readonly internalMinor: bigint;
    readonly externalMinor: bigint;
    readonly fullySettled: boolean;
  } | null;
  readonly asOf: string;
}

/** The buyer's own list of orders. */
export interface OrdersView {
  readonly accountId: string;
  readonly orders: readonly OrderSummary[];
  readonly asOf: string;
}

export type UserCockpitErrorCode =
  /** An identifier is not well formed. */
  | 'malformed-identifier'
  /** An identifier looks like a natural key. */
  | 'natural-identifier'
  /** An identifier names or looks like a credential. */
  | 'secret-bearing-input'
  /** The instant is not a real UTC instant. */
  | 'malformed-instant'
  /** A wallet names a K-10 account that does not exist. */
  | 'dangling-wallet'
  /** A wallet names an asset type K-10 does not know. */
  | 'unknown-asset-type';

/** A refusal the caller must act on. */
export class UserCockpitError extends Error {
  readonly code: UserCockpitErrorCode;

  constructor(code: UserCockpitErrorCode, message: string) {
    super(message);
    this.name = 'UserCockpitError';
    this.code = code;
  }
}
