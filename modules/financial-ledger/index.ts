/**
 * M-13 Financial Ledger — public surface.
 *
 * Everything another unit may depend on is re-exported here. Anything not listed is internal and
 * may change without notice.
 *
 * M-13 owns the wallet map — which K-10 account holds whose value, in what asset, for what purpose
 * — and the value plan, which lets one obligation be paid from several kinds of value at once and
 * proves afterwards that the pieces added up exactly.
 *
 * It depends on the platform substrate, K-03 Accounts and K-10 Ledger Foundation. It imports no
 * other business module: M-11, M-12, M-14 and M-15 are the same layer and reach M-13 by event.
 *
 * **M-13 keeps no balance.** K-10 derives every balance by summing entries, and a balance column
 * here would be a second source of truth about money.
 *
 * Owned by: M-13 Financial Ledger.
 */

export {
  FinancialLedgerError,
  LEG_KINDS,
  LEG_STATUSES,
  PLAN_STATUSES,
  PLAN_TRANSITIONS,
  WALLET_PURPOSES,
  WALLET_STATUSES,
  WALLET_TRANSITIONS,
} from './types.ts';
export type {
  FinancialLedgerErrorCode,
  LegKind,
  LegStatus,
  PlanCoverage,
  PlanStatus,
  ValueLeg,
  ValuePlan,
  ValueRate,
  Wallet,
  WalletPurpose,
  WalletStateRecord,
  WalletStatus,
} from './types.ts';

export {
  FOREIGN_FIELDS,
  IDENTIFIER_REFUSALS,
  assertAssetTypeId,
  assertLedgerIdentifier,
  assertLegKind,
  assertLegStatus,
  assertObligationKind,
  assertPlanStatus,
  assertWalletPurpose,
  assertWalletStatus,
} from './registry.ts';

export {
  isValueLegSealed,
  isValuePlanSealed,
  isWalletSealed,
  sealValueLeg,
  sealValueLegs,
  sealValuePlan,
  sealValuePlans,
  sealWallet,
  sealWalletState,
  sealWalletStates,
  sealWallets,
} from './immutable.ts';

export {
  STORED_ROW_NOTE,
  assertRate,
  validateValueLeg,
  validateValuePlan,
  validateWallet,
  validateWalletState,
} from './validate.ts';
export type { RecordSource } from './validate.ts';

export type {
  LedgerAccountRequest,
  LedgerAccountResult,
  LedgerPort,
  LedgerPostingEntry,
  LedgerPostingRequest,
  LedgerPostingResult,
} from './ledger-port.ts';
export { K10LedgerPort } from './providers/k10-ledger-port.ts';

export { InMemoryFinancialLedgerRepository } from './repository.ts';
export type { FinancialLedgerRepository, FinancialLedgerTransaction } from './repository.ts';

export {
  LEG_POSTED_ACTION,
  LEG_POSTED_EVENT,
  LEG_REVERSED_ACTION,
  LEG_REVERSED_EVENT,
  PLAN_ALLOCATED_ACTION,
  PLAN_ALLOCATED_EVENT,
  PLAN_CANCELLED_ACTION,
  PLAN_CANCELLED_EVENT,
  PLAN_COMMITTED_ACTION,
  PLAN_COMMITTED_EVENT,
  PLAN_SETTLED_ACTION,
  PLAN_SETTLED_EVENT,
  WALLET_OPENED_ACTION,
  WALLET_OPENED_EVENT,
  WALLET_STATUS_CHANGED_ACTION,
  WALLET_STATUS_CHANGED_EVENT,
} from './outbox.ts';

export { FinancialLedgerService, assertAllocationAddsUp, coverageOf } from './service.ts';
export type {
  AllocatePlanRequest,
  AllocatePlanResult,
  AllocationLeg,
  CancelPlanRequest,
  CancelPlanResult,
  CommitPlanRequest,
  CommitPlanResult,
  OpenWalletRequest,
  OpenWalletResult,
  Posting,
  Reversal,
  SetWalletStatusRequest,
  SetWalletStatusResult,
  SettleExternalLegRequest,
  SettleExternalLegResult,
} from './service.ts';

export {
  EnlistedFinancialLedgerRepository,
  FINANCIAL_LEDGER_SCHEMA,
  OUTBOX_TABLE,
  PostgresFinancialLedgerRepository,
  TIMESTAMP_COLUMNS,
  VALUE_LEG_TABLE,
  VALUE_PLAN_TABLE,
  WALLET_STATE_TABLE,
  WALLET_TABLE,
  enlistedClient,
  toValueLeg,
  toValuePlan,
  toWallet,
  toWalletState,
} from './postgres-repository.ts';
