/**
 * M-36 User Cockpit — public surface.
 *
 * A buyer's own screens: MY MONEY, MY ORDERS, and one order in detail.
 *
 * **This module owns no data, writes nothing, and has no schema.** Every figure it returns is
 * assembled at read time from the units that own it — K-10 for balances, M-13 for the wallet map,
 * M-11 for orders, M-12 for payments. There is no cockpit table and no cached total, because a
 * cached total on a screen showing somebody their money is a lie with a timestamp.
 *
 * M-36 is L8 and terminal: it reads from below and nothing reads from it.
 *
 * Owned by: M-36 User Cockpit.
 */

export { UserCockpitError } from './types.ts';
export type {
  AssetHolding,
  MoneyView,
  OrderDetailView,
  OrderPaymentSummary,
  OrderSummary,
  OrdersView,
  UserCockpitErrorCode,
  WalletPosition,
} from './types.ts';

export { UserCockpitService } from './service.ts';
export type { UserCockpitDependencies } from './service.ts';
