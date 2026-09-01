/**
 * M-13 Financial Ledger — constants, identifier rules and the foreign-field table.
 *
 * Identifier rules are delegated to K-03 Accounts, so an id refused at account creation is refused
 * here too, in M-13's vocabulary.
 *
 * The foreign-field table is the boundary of M-13, and it carries an unusual amount of weight
 * because so many neighbouring units deal in money. The rule it encodes: **M-13 records where value
 * is; it does not decide what value is owed, what it costs, or who is allowed to move it.**
 *
 * Owned by: M-13 Financial Ledger.
 */

import { AccountError, assertAccountIdentifier } from '../../kernel/accounts/index.ts';

import {
  FinancialLedgerError,
  LEG_KINDS,
  LEG_STATUSES,
  PLAN_STATUSES,
  WALLET_PURPOSES,
  WALLET_STATUSES,
  type FinancialLedgerErrorCode,
  type LegKind,
  type LegStatus,
  type PlanStatus,
  type WalletPurpose,
  type WalletStatus,
} from './types.ts';

export type {
  FinancialLedgerErrorCode,
  LegKind,
  LegStatus,
  PlanStatus,
  WalletPurpose,
  WalletStatus,
} from './types.ts';

/** K-03's identifier refusals, in this module's vocabulary. Total over what K-03 can raise. */
export const IDENTIFIER_REFUSALS: Readonly<Record<string, FinancialLedgerErrorCode>> =
  Object.freeze({
    'malformed-identifier': 'malformed-identifier',
    'natural-identifier': 'natural-identifier',
    'secret-bearing-input': 'secret-bearing-input',
  });

/** Refuse an identifier that is malformed, natural, or a credential. */
export function assertLedgerIdentifier(value: unknown, field: string): string {
  try {
    return assertAccountIdentifier(value, field);
  } catch (error) {
    if (!(error instanceof AccountError)) throw error;
    const code = IDENTIFIER_REFUSALS[error.code];
    if (code === undefined) throw error;
    throw new FinancialLedgerError(code, error.message);
  }
}

/**
 * Refuse an asset type id K-10 would not accept.
 *
 * Checked here rather than left to K-10 so a malformed id is refused before a wallet row is built
 * around it. The rule is K-10's, quoted: lower_snake_case starting with a letter.
 */
export function assertAssetTypeId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(value)) {
    throw new FinancialLedgerError(
      'malformed-record',
      `${field} is "${typeof value === 'string' ? value : typeof value}"; a K-10 asset type id is ` +
        'lower_snake_case, starts with a letter, and is at most 64 characters',
    );
  }
  return value;
}

/** Refuse a purpose M-13 does not recognise. */
export function assertWalletPurpose(value: unknown, field: string): WalletPurpose {
  if (typeof value !== 'string' || !(WALLET_PURPOSES as readonly string[]).includes(value)) {
    throw new FinancialLedgerError(
      'unknown-purpose',
      `${field} is "${typeof value === 'string' ? value : typeof value}"; expected one of ` +
        WALLET_PURPOSES.join(', '),
    );
  }
  return value as WalletPurpose;
}

/** Refuse a wallet status M-13 does not recognise. */
export function assertWalletStatus(value: unknown, field: string): WalletStatus {
  if (typeof value !== 'string' || !(WALLET_STATUSES as readonly string[]).includes(value)) {
    throw new FinancialLedgerError(
      'unknown-status',
      `${field} is "${typeof value === 'string' ? value : typeof value}"; expected one of ` +
        WALLET_STATUSES.join(', '),
    );
  }
  return value as WalletStatus;
}

/** Refuse a plan status M-13 does not recognise. */
export function assertPlanStatus(value: unknown, field: string): PlanStatus {
  if (typeof value !== 'string' || !(PLAN_STATUSES as readonly string[]).includes(value)) {
    throw new FinancialLedgerError(
      'unknown-status',
      `${field} is "${typeof value === 'string' ? value : typeof value}"; expected one of ` +
        PLAN_STATUSES.join(', '),
    );
  }
  return value as PlanStatus;
}

/** Refuse a leg kind M-13 does not recognise. */
export function assertLegKind(value: unknown, field: string): LegKind {
  if (typeof value !== 'string' || !(LEG_KINDS as readonly string[]).includes(value)) {
    throw new FinancialLedgerError(
      'unknown-status',
      `${field} is "${typeof value === 'string' ? value : typeof value}"; expected one of ` +
        LEG_KINDS.join(', '),
    );
  }
  return value as LegKind;
}

/** Refuse a leg status M-13 does not recognise. */
export function assertLegStatus(value: unknown, field: string): LegStatus {
  if (typeof value !== 'string' || !(LEG_STATUSES as readonly string[]).includes(value)) {
    throw new FinancialLedgerError(
      'unknown-status',
      `${field} is "${typeof value === 'string' ? value : typeof value}"; expected one of ` +
        LEG_STATUSES.join(', '),
    );
  }
  return value as LegStatus;
}

/**
 * Refuse an obligation kind that is not a vocabulary word.
 *
 * Deliberately open: an obligation may be an order today and a subscription, a fee or a fine later,
 * and closing the list would mean a migration for every new kind of thing somebody can owe for.
 * What is closed is the *shape*, so the column can be grouped on.
 */
export function assertObligationKind(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(value)) {
    throw new FinancialLedgerError(
      'malformed-record',
      `${field} is "${typeof value === 'string' ? value : typeof value}"; expected a lowercase ` +
        'kebab-case word of 1-64 characters starting with a letter',
    );
  }
  return value;
}

/**
 * Fields that belong to another unit, with the unit named.
 *
 * The first block is the one that matters most: **M-13 does not price anything.** It is told what
 * is owed and records how it was covered. A module that let a caller pass a price, a commission
 * rate or a fee would be quietly taking over the pricing decision from the units that own it, and
 * the resulting number would have no policy version behind it.
 */
export const FOREIGN_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  // Pricing and the units that own it. M-13 is told the total; it does not compute one.
  unitPrice: 'M-04 Universal Listing owns the price; M-13 is told what is owed, not what it costs',
  price: 'M-04 Universal Listing owns the price',
  commissionRate: 'M-14 Commission Rules owns commission, and is the same layer',
  commissionMinor: 'M-14 Commission Rules owns commission, and is the same layer',
  feeMinor: 'M-14 Commission Rules owns fees',
  taxMinor: 'M-14 Commission Rules owns tax treatment',
  discountMinor: 'M-05 Pricing owns discounts',
  policyVersionId:
    'K-06 Policy Engine owns policy versions; the obligation that pins one is the caller’s record',

  // K-10 is the journal. M-13 names positions in it and never keeps its own balance.
  balance: 'K-10 Ledger Foundation is the authority on every balance; M-13 stores none',
  availableMinor: 'K-10 derives every position by summing entries',
  pendingMinor: 'K-10 derives every position by summing entries',
  lockedMinor: 'K-10 derives every position by summing entries',
  debitTotal: 'K-10 derives this',
  creditTotal: 'K-10 derives this',
  entries: 'K-10 owns journal entries; M-13 asks it to post and records the transaction id',
  normalBalance: 'K-10 owns the account’s normal balance side',
  assetClass: 'K-10 Ledger Foundation owns the asset type and its class',
  precision: 'K-10 owns the asset type’s precision',
  issuer: 'K-10 owns the asset type’s issuer',

  // Same-layer modules, reached by event only (MODULE_MAP §10.3).
  orderStatus:
    'M-11 Orders owns the order lifecycle; M-11 is the same layer and reaches M-13 by event',
  orderTotal: 'M-11 Orders owns the order total; M-13 is told an obligation amount',
  paymentStatus: 'M-12 Payments owns the payment lifecycle, and is the same layer',
  instrumentToken: 'M-12 Payments holds the provider token; M-13 never sees one',
  provider: 'M-12 Payments owns the gateway relationship',
  rail: 'M-12 Payments owns how value crosses the platform boundary',
  settlementId: 'M-15 Settlements owns settlement, and is the same layer',
  payoutId: 'M-16 Seller Payouts owns payouts, and is the same layer',

  // Identity, authentication and authority.
  subjectId: 'K-01 Identity owns the subject; a wallet references an account by id',
  sessionId: 'K-02 Authentication owns sessions',
  password: 'K-02 Authentication owns credentials',
  role: 'K-04 Permissions owns roles and grants',
  permissions: 'K-04 Permissions owns permission evaluation',

  // Profile and contact.
  email: 'email belongs to the account profile core, not to a wallet',
  phone: 'phone belongs to the account profile core, not to a wallet',

  // Fields M-13 derives from its own records rather than accepting.
  allocatedMinor:
    'M-13 sums this from the legs; a stored copy would drift the first time one moves',
  postedMinor: 'M-13 sums this from the legs',
  outstandingMinor: 'M-13 sums this from the legs',
  ledgerTransactionId: 'M-13 records this when the posting succeeds; a caller may not state it',
  status: 'M-13 owns the wallet, plan and leg lifecycles; this field is refused on a request',
});
