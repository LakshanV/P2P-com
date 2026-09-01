/**
 * M-36 User Cockpit — service.
 *
 * Assembles a buyer's own screens from the units that own the data. It holds no repository, writes
 * nothing, and has no schema: every figure it returns is read from M-11, M-12, M-13 and K-10 at the
 * moment it is asked for.
 *
 * That is the design, not a stage it will grow out of. A cockpit with its own tables is a second
 * source of truth about money, and the second source is the one that goes stale — which on a screen
 * showing somebody their balance is not a performance characteristic, it is a lie with a timestamp.
 * If this ever becomes too slow, the answer is a cache with an explicit age shown to the reader, not
 * a table nobody remembers to update.
 *
 * **M-36 is L8 and terminal.** It reads from L5 and below; nothing reads from it.
 *
 * Deterministic: the caller supplies the instant, as everywhere else.
 *
 * Owned by: M-36 User Cockpit.
 */

import { assertAccountIdentifier } from '../../kernel/accounts/index.ts';
import type { AssetType, LedgerService } from '../../kernel/ledger-foundation/index.ts';
import type { FinancialLedgerService, Wallet } from '../../modules/financial-ledger/index.ts';
import type { OrderService } from '../../modules/orders/index.ts';
import type { PaymentService } from '../../modules/payments/index.ts';
import { InvalidInstantError, parseInstant } from '../../platform/time/instant.ts';

import {
  UserCockpitError,
  type AssetHolding,
  type MoneyView,
  type OrderDetailView,
  type OrderSummary,
  type OrdersView,
  type WalletPosition,
} from './types.ts';

export interface UserCockpitDependencies {
  readonly orders: OrderService;
  readonly payments: PaymentService;
  readonly ledger: FinancialLedgerService;
  /** K-10, for the balances and the asset-type metadata. M-13 stores neither. */
  readonly journal: LedgerService;
}

export class UserCockpitService {
  readonly #orders: OrderService;
  readonly #payments: PaymentService;
  readonly #ledger: FinancialLedgerService;
  readonly #journal: LedgerService;

  constructor(dependencies: UserCockpitDependencies) {
    this.#orders = dependencies.orders;
    this.#payments = dependencies.payments;
    this.#ledger = dependencies.ledger;
    this.#journal = dependencies.journal;
  }

  /**
   * MY MONEY: every position this holder has, grouped by asset type.
   *
   * Deliberately **not** a single total. A holder with 1,500 reward points and LKR 8,000 does not
   * have "9,500 of anything": points are a restricted credit with an issuer and a list of things
   * they may be spent on, and rupees are not. A screen that added them would be showing a number
   * that is wrong in a way the reader cannot see.
   */
  async myMoney(accountId: string, asOf: string): Promise<MoneyView> {
    assertAccountIdentifier(accountId, 'accountId');
    const instant = checkInstant(asOf);

    const wallets = await this.#ledger.listWallets(accountId);
    const positions: WalletPosition[] = [];

    for (const wallet of wallets) {
      positions.push(await this.#positionOf(wallet));
    }

    // Grouped by asset type, and summed **only** within one.
    const byAsset = new Map<string, WalletPosition[]>();
    for (const position of positions) {
      const held = byAsset.get(position.assetTypeId) ?? [];
      held.push(position);
      byAsset.set(position.assetTypeId, held);
    }

    const holdings: AssetHolding[] = [...byAsset.entries()]
      .map(([assetTypeId, held]) => {
        const first = held[0];
        // Unreachable: a group exists because a position put it there.
        if (first === undefined) {
          throw new UserCockpitError('unknown-asset-type', `no positions for ${assetTypeId}`);
        }
        return Object.freeze({
          assetTypeId,
          symbol: first.symbol,
          assetClass: first.assetClass,
          precision: first.precision,
          available: sum(held, (position) => position.available),
          pending: sum(held, (position) => position.pending),
          locked: sum(held, (position) => position.locked),
          total: sum(held, (position) => position.total),
          positions: Object.freeze([...held].sort((a, b) => a.purpose.localeCompare(b.purpose))),
        }) satisfies AssetHolding;
      })
      .sort((a, b) => a.symbol.localeCompare(b.symbol));

    return Object.freeze({
      accountId,
      holdings: Object.freeze(holdings),
      // "You have no wallets" and "every balance is zero" mean different things to the reader.
      empty: wallets.length === 0,
      asOf: instant,
    }) satisfies MoneyView;
  }

  /** MY ORDERS: what this buyer has bought, newest last. */
  async myOrders(accountId: string, asOf: string): Promise<OrdersView> {
    assertAccountIdentifier(accountId, 'accountId');
    const instant = checkInstant(asOf);

    const orders = await this.#orders.listOrdersByBuyer(accountId);
    return Object.freeze({
      accountId,
      orders: Object.freeze(orders.map(summarise)),
      asOf: instant,
    }) satisfies OrdersView;
  }

  /**
   * One order, with what has been paid and how the obligation was covered.
   *
   * The coverage is null when no plan exists yet, which is a different thing from a plan covering
   * nothing — and the screen should be able to tell them apart.
   */
  async orderDetail(orderId: string, asOf: string): Promise<OrderDetailView> {
    const instant = checkInstant(asOf);

    const order = await this.#orders.getOrder(orderId);
    if (order === null) {
      throw new UserCockpitError('malformed-identifier', `there is no order ${orderId}`);
    }

    const payments = await this.#payments.listPaymentsForOrder(orderId);
    const plans = await this.#ledger.listPlansForObligation(orderId);
    const live = plans.find((plan) => plan.status !== 'cancelled') ?? null;

    const coverage =
      live === null
        ? null
        : await (async () => {
            const figures = await this.#ledger.getCoverage(live.planId);
            return Object.freeze({
              targetAmountMinor: figures.targetAmountMinor,
              postedMinor: figures.postedMinor,
              outstandingMinor: figures.outstandingMinor,
              internalMinor: figures.internalMinor,
              externalMinor: figures.externalMinor,
              fullySettled: figures.fullySettled,
            });
          })();

    return Object.freeze({
      order: summarise(order),
      payments: Object.freeze(
        payments.map((payment) =>
          Object.freeze({
            paymentId: payment.paymentId,
            status: payment.status,
            assetCode: payment.assetCode,
            assetScale: payment.assetScale,
            amountMinor: payment.amountMinor,
            capturedMinor: payment.capturedMinor,
            refundedMinor: payment.refundedMinor,
            rail: payment.rail,
            failureCode: payment.failureCode,
          }),
        ),
      ),
      coverage,
      asOf: instant,
    }) satisfies OrderDetailView;
  }

  /**
   * One wallet's position, with the asset's own attributes beside it.
   *
   * The attributes are not decoration. A holder looking at a reward balance needs to know it cannot
   * be withdrawn, and the honest place to say so is next to the number.
   */
  async #positionOf(wallet: Wallet): Promise<WalletPosition> {
    const balance = await this.#journal.getBalance(wallet.ledgerAccountId).catch(() => null);
    if (balance === null) {
      throw new UserCockpitError(
        'dangling-wallet',
        `wallet ${wallet.walletId} names K-10 account ${wallet.ledgerAccountId}, which does not ` +
          'exist. A balance cannot be shown for a position that is not in the journal, and showing ' +
          'a zero would be inventing one',
      );
    }

    const asset = await this.#assetType(wallet.assetTypeId);

    return Object.freeze({
      walletId: wallet.walletId,
      assetTypeId: wallet.assetTypeId,
      symbol: asset.symbol,
      assetClass: asset.assetClass,
      precision: asset.precision,
      purpose: wallet.purpose,
      status: wallet.status,
      available: balance.available,
      pending: balance.pending,
      locked: balance.locked,
      total: balance.total,
      withdrawable: asset.withdrawability,
      transferable: asset.transferability,
      issuer: asset.issuer,
    }) satisfies WalletPosition;
  }

  /** The asset type a wallet is denominated in, refused rather than guessed at when absent. */
  async #assetType(assetTypeId: string): Promise<AssetType> {
    const asset = await this.#journal.findAssetType(assetTypeId);
    if (asset === null) {
      throw new UserCockpitError(
        'unknown-asset-type',
        `asset type ${assetTypeId} is not registered with K-10, so there is nothing that says what ` +
          'this balance is denominated in. A number without its unit is not a balance',
      );
    }
    return asset;
  }
}

function summarise(order: {
  readonly orderId: string;
  readonly status: string;
  readonly sellerAccountId: string;
  readonly currency: string;
  readonly totalMinor: bigint;
  readonly itemCount: number;
  readonly placedAt: string | null;
  readonly createdAt: string;
  readonly fulfilmentRole: string;
}): OrderSummary {
  return Object.freeze({
    orderId: order.orderId,
    status: order.status,
    sellerAccountId: order.sellerAccountId,
    currency: order.currency,
    totalMinor: order.totalMinor,
    itemCount: order.itemCount,
    placedAt: order.placedAt,
    createdAt: order.createdAt,
    split: order.fulfilmentRole === 'parent',
  });
}

function sum<T>(items: readonly T[], of: (item: T) => bigint): bigint {
  return items.reduce((total, item) => total + of(item), 0n);
}

function checkInstant(value: string): string {
  try {
    return parseInstant(value).source;
  } catch (error) {
    if (error instanceof InvalidInstantError) {
      throw new UserCockpitError('malformed-instant', `asOf: ${error.message}`);
    }
    throw error;
  }
}
