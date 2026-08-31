/**
 * M-12 Payments — the provider port.
 *
 * The one boundary between JAYA and a payment gateway. Business modules address payment by calling
 * `PaymentService`; `PaymentService` addresses a gateway by calling this interface; and the only
 * code that knows a gateway exists is the adapter behind it.
 *
 * **A provider is told what to move, never who is moving it.** Every request below carries an
 * amount, an asset, a rail, an opaque token and an idempotency key — and nothing else. Not the payer, not
 * the payee, not the order, not a name, not an address. A gateway does not need to know who its
 * counterparty's customers are in order to move money, and telling it anyway is a disclosure with
 * no purpose. It also means an adapter cannot leak what it was never given.
 *
 * `docs/JAYA_TEST_MATRIX.md` §1.3 lists Payments as a mandatory contract suite: a replacement
 * adapter is valid exactly when it passes `tests/contracts/payment-provider.contract.test.ts`.
 *
 * Owned by: M-12 Payments.
 */

import type { FailureCode, PaymentRail } from './types.ts';

/** What every provider call carries, and the ceiling on what any provider is told. */
export interface ProviderRequest {
  /** The provider's own opaque handle for the instrument. Never an instrument. */
  readonly instrumentToken: string;
  /** The amount to move, in integer minor units. */
  readonly amountMinor: bigint;
  /** The settlement asset. Not assumed to be a three-letter fiat code. */
  readonly assetCode: string;
  /** Minor units per major unit as a power of ten, so the adapter need not look it up. */
  readonly assetScale: number;
  /** How the value crosses the platform boundary. */
  readonly rail: PaymentRail;
  /**
   * Stable across retries of one logical operation.
   *
   * Passed through to the provider so that a retry after a timeout is recognised by the gateway as
   * the same operation rather than a second one — which is the difference between charging somebody
   * once and charging them twice.
   */
  readonly idempotencyKey: string;
  /**
   * The provider's reference from an earlier step, when this operation continues one.
   *
   * A capture references its authorisation; a refund references its capture. Null for the first
   * step of a chain.
   */
  readonly providerReference: string | null;
}

export type ProviderAuthoriseRequest = ProviderRequest;
export type ProviderCaptureRequest = ProviderRequest;
export type ProviderCancelRequest = ProviderRequest;
export type ProviderRefundRequest = ProviderRequest;

/**
 * What a provider says happened.
 *
 * A failure carries a **vocabulary** `failureCode` rather than the provider's own message: prose in
 * a language nobody chose cannot be branched on, and an adapter that passed it through would push
 * the parsing problem onto every caller.
 */
export interface ProviderResult {
  readonly outcome: 'succeeded' | 'failed';
  /** The provider's handle for this operation, used for reconciliation. Null when it failed early. */
  readonly providerReference: string | null;
  readonly failureCode: FailureCode | null;
}

/**
 * A payment gateway, as M-12 sees it.
 *
 * Four operations and no state: the adapter holds no records, because M-12 already records every
 * attempt. An adapter that kept its own view of a payment would be a second source of truth about
 * money.
 */
export interface PaymentProvider {
  /** Vocabulary name, matching `Payment.provider`. */
  readonly name: string;
  /**
   * The rails this adapter can actually settle on.
   *
   * Declared rather than assumed, so the service refuses an impossible pairing before calling out
   * — asking a card processor for a bank transfer is a mistake worth catching locally rather than
   * discovering from a gateway error in a language nobody chose.
   */
  readonly supportedRails: readonly PaymentRail[];
  /**
   * The settlement assets this adapter can move.
   *
   * A card processor might declare `['LKR', 'USD']` and a digital-asset custodian `['BTC', 'USDC']`.
   * **No adapter may declare an internally issued JAYA value**: those are M-13's to allocate and no
   * external counterparty settles them, which `assertSettlementAsset` enforces at the boundary.
   */
  readonly supportedAssets: readonly string[];
  authorise(request: ProviderAuthoriseRequest): Promise<ProviderResult>;
  capture(request: ProviderCaptureRequest): Promise<ProviderResult>;
  cancel(request: ProviderCancelRequest): Promise<ProviderResult>;
  refund(request: ProviderRefundRequest): Promise<ProviderResult>;
}

/**
 * How the service finds an adapter for a payment's `provider`.
 *
 * Injected the way K-14 Notifications injects `resolveProvider`, so M-12 itself holds no registry
 * of gateways and a deployment wires whichever it has.
 */
export type ResolveProvider = (provider: string) => PaymentProvider;
