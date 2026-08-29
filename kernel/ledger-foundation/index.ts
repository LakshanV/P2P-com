/**
 * K-10 Ledger Foundation — public surface.
 *
 * Everything another unit may depend on is re-exported here. Anything not listed is internal and may
 * change without notice; see kernel/ledger-foundation/CONTRACT.md for the contract this fixes.
 *
 * K-10 owns every amount in the platform: asset types, ledger accounts, balanced transactions, and
 * the derived balances. It does not own prices, listings, orders, payouts or rewards. It depends
 * only on the platform substrate.
 *
 * Owned by: K-10 Ledger Foundation.
 */

export {
  ASSET_CLASSES,
  BALANCE_STATES,
  ENTRY_SIDES,
  LedgerError,
  NORMAL_BALANCES,
  type AccountBalance,
  type AssetClass,
  type AssetType,
  type BalanceState,
  type EntrySide,
  type LedgerAccount,
  type LedgerEntry,
  type LedgerErrorCode,
  type LedgerTransaction,
  type NormalBalance,
} from './types.ts';

export {
  IDENTITY_REFUSALS,
  assertAssetSymbol,
  assertAssetTypeId,
  assertOpaqueIdentifier,
} from './registry.ts';

export { computeBalance, LedgerService } from './service.ts';
export type {
  CreateAccountRequest,
  PostTransactionRequest,
  PostTransactionRequestEntry,
  RegisterAssetTypeRequest,
} from './service.ts';

export { InMemoryLedgerRepository } from './repository.ts';
export type { LedgerRepository, LedgerTransactionPort } from './repository.ts';

export {
  ACCOUNT_TABLE,
  ASSET_TYPE_TABLE,
  ENTRY_TABLE,
  EnlistedLedgerRepository,
  LEDGER_SCHEMA,
  OUTBOX_TABLE,
  PostgresLedgerRepository,
  TRANSACTION_TABLE,
  enlistedClient,
} from './postgres-repository.ts';

export {
  LEDGER_TRANSACTION_POSTED_ACTION,
  LEDGER_TRANSACTION_POSTED_EVENT,
  makeLedgerTransactionPostedAction,
  makeLedgerTransactionPostedEvent,
} from './outbox.ts';
