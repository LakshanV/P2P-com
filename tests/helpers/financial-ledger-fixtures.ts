/**
 * Shared fixtures for the M-13 Financial Ledger suites.
 *
 * The harness wires a real K-10 Ledger Foundation behind M-13's journal port, not a stub. M-13's
 * whole job is to get balanced postings into that journal, and a stub would accept postings K-10
 * would refuse — which is the one class of bug these suites exist to catch.
 *
 * Every identifier and every instant is supplied here rather than read from a clock. Money is
 * `bigint` minor units throughout.
 */

import {
  InMemoryLedgerRepository,
  LedgerService,
  type RegisterAssetTypeRequest,
} from '../../kernel/ledger-foundation/index.ts';
import {
  FinancialLedgerService,
  InMemoryFinancialLedgerRepository,
  K10LedgerPort,
  type AllocatePlanRequest,
  type AllocationLeg,
  type OpenWalletRequest,
  type ValueRate,
} from '../../modules/financial-ledger/index.ts';

export interface Harness {
  readonly service: FinancialLedgerService;
  readonly repository: InMemoryFinancialLedgerRepository;
  readonly ledger: LedgerService;
  readonly ledgerRepository: InMemoryLedgerRepository;
}

let sequence = 0;

function seq(): string {
  sequence += 1;
  return String(sequence).padStart(4, '0');
}

export const BUYER = 'acct_01HR0F0buyer01';
export const SELLER = 'acct_01HR0F0seller1';
export const PLATFORM = 'acct_01HR0F0platfrm';

/** The asset types the suites use, registered into K-10 by `build`. */
export const LKR = 'lkr';
export const JAYA_REWARD = 'jaya_reward';
export const MERCHANT_CREDIT = 'merchant_credit';

/** One-to-one: one minor unit of the leg's asset is worth one minor unit of the settlement asset. */
export const PARITY: ValueRate = Object.freeze({ numerator: 1n, denominator: 1n });

function assetRequest(
  assetTypeId: string,
  overrides: Partial<RegisterAssetTypeRequest> = {},
): RegisterAssetTypeRequest {
  return {
    assetTypeId,
    assetClass: 'fiat',
    symbol: assetTypeId.toUpperCase(),
    precision: 2,
    transferability: true,
    withdrawability: true,
    valuationSource: 'fixed',
    issuer: 'iss_01HR0F0centrl1',
    unit: 'cent',
    redeemable: true,
    convertible: true,
    expiryDays: null,
    restrictions: {},
    custodyProvider: null,
    jurisdiction: 'LK',
    ...overrides,
  };
}

/**
 * A harness with the three asset types registered.
 *
 * The two internal ones are declared as K-10 sees them: non-transferable, non-withdrawable value
 * the platform issues and stands behind. That is the whole difference between a reward point and a
 * rupee, and stating it here means the suites are exercising the real distinction.
 */
export async function build(): Promise<Harness> {
  const ledgerRepository = new InMemoryLedgerRepository();
  const ledger = new LedgerService(ledgerRepository);
  const repository = new InMemoryFinancialLedgerRepository();
  const service = new FinancialLedgerService(repository, new K10LedgerPort(ledger));

  await ledger.registerAssetType(assetRequest(LKR));
  await ledger.registerAssetType(
    assetRequest(JAYA_REWARD, {
      assetClass: 'reward',
      symbol: 'JAYAREWARD',
      precision: 0,
      unit: 'point',
      transferability: false,
      withdrawability: false,
      convertible: false,
      issuer: 'iss_01HR0F0jayaplt',
      jurisdiction: 'GLOBAL',
    }),
  );
  await ledger.registerAssetType(
    assetRequest(MERCHANT_CREDIT, {
      assetClass: 'reward',
      symbol: 'MERCHANTCR',
      precision: 2,
      transferability: false,
      withdrawability: false,
      convertible: false,
      issuer: 'iss_01HR0F0merchnt',
      jurisdiction: 'LK',
    }),
  );

  return { service, repository, ledger, ledgerRepository };
}

export function openWalletRequest(overrides: Partial<OpenWalletRequest> = {}): OpenWalletRequest {
  const n = seq();
  return {
    walletId: `wal_01HR0FW${n}`,
    ownerAccountId: BUYER,
    assetTypeId: LKR,
    purpose: 'spending',
    ledgerAccountId: `lac_01HR0FW${n}`,
    normalBalance: 'credit',
    openedAt: '2026-07-01T09:00:00Z',
    correlationId: `corr_01HR0FW${n}`,
    idempotencyKey: `idem_wallet_${n}`,
    ...overrides,
  };
}

/** Open one wallet and return its id. */
export async function openWallet(
  harness: Harness,
  overrides: Partial<OpenWalletRequest> = {},
): Promise<string> {
  const request = openWalletRequest(overrides);
  await harness.service.openWallet(request);
  return request.walletId;
}

export function legRequest(overrides: Partial<AllocationLeg> = {}): AllocationLeg {
  const n = seq();
  return {
    legId: `leg_01HR0FL${n}`,
    kind: 'internal',
    assetTypeId: LKR,
    sourceWalletId: `wal_01HR0FL${n}`,
    destinationWalletId: `wal_01HR0FM${n}`,
    amountMinor: 1_000n,
    rate: PARITY,
    settlementEquivalentMinor: 1_000n,
    idempotencyKey: `idem_leg_${n}`,
    ...overrides,
  };
}

export function allocateRequest(
  legs: readonly AllocationLeg[],
  overrides: Partial<AllocatePlanRequest> = {},
): AllocatePlanRequest {
  const n = seq();
  const target = legs.reduce((total, leg) => total + leg.settlementEquivalentMinor, 0n);
  return {
    planId: `pln_01HR0FP${n}`,
    obligationId: `ord_01HR0FP${n}`,
    obligationKind: 'order',
    payerAccountId: BUYER,
    payeeAccountId: SELLER,
    settlementAssetTypeId: LKR,
    targetAmountMinor: target,
    legs,
    allocatedAt: '2026-07-01T10:00:00Z',
    correlationId: `corr_01HR0FP${n}`,
    idempotencyKey: `idem_plan_${n}`,
    eventId: `fev_01HR0FP${n}`,
    ...overrides,
  };
}

/** A fresh K-10 transaction id, for a posting or a reversal. */
export function transactionId(): string {
  return `ltx_01HR0FT${seq()}`;
}

/** A fresh opaque id with the given prefix, for a fact or a state record. */
export function idFor(prefix: string): string {
  return `${prefix}_01HR0FX${seq()}`;
}

// ---------------------------------------------------------------------------
// Outbox readers
// ---------------------------------------------------------------------------

export function entriesOfKind(
  repository: InMemoryFinancialLedgerRepository,
  kind: 'event' | 'audit',
): readonly { readonly payload: unknown }[] {
  return repository
    .outbox()
    .entries()
    .filter((entry) => entry.kind === kind);
}

/** The `type` of every event entry, oldest first. */
export function eventTypes(repository: InMemoryFinancialLedgerRepository): readonly string[] {
  return entriesOfKind(repository, 'event').map(
    (entry) => (entry.payload as { type: string }).type,
  );
}

/** The business payload of the most recent event of a given type. */
export function lastEventPayload(
  repository: InMemoryFinancialLedgerRepository,
  type: string,
): Record<string, unknown> {
  const entry = entriesOfKind(repository, 'event')
    .filter((candidate) => (candidate.payload as { type: string }).type === type)
    .at(-1);
  if (entry === undefined) throw new Error(`no ${type} event was published`);
  return (entry.payload as { payload: Record<string, unknown> }).payload;
}
