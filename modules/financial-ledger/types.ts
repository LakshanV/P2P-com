/**
 * M-13 Financial Ledger — domain types.
 *
 * K-10 Ledger Foundation is the journal: it holds asset types, accounts, balanced transactions and
 * the three positions every account carries. M-13 is what sits on top of it and answers the two
 * questions the journal deliberately does not:
 *
 * **Where is a party's money?** A ledger account is an anonymous position in one asset type. A
 * `Wallet` names it: this account, in this asset type, held by this party, *for this purpose*.
 *
 * **How is one obligation paid from several kinds of value at once?** A `ValuePlan` is the answer,
 * and it is the reason this module exists. LKR 10,000 paid as 1,500 reward points + 500 merchant
 * credit + 8,000 on a card is **three movements in three different units**, and K-10 refuses to put
 * them in one transaction — correctly, because a journal line denominated in two units is not a
 * journal line. So each leg posts as its own balanced transaction in its own asset type, and the
 * plan is what proves the three of them add up to what was owed.
 *
 * **Earnings is a purpose, not an asset class.** A seller's earnings and a buyer's spending money
 * may both be LKR; what differs is what the platform will let each be used for. Making earnings an
 * asset class would produce a second kind of rupee that cannot be added to the first, and every
 * report would have to know which one it was looking at.
 *
 * **No balance is stored here.** K-10 derives every balance by summing entries, and a balance column
 * in this module would be a second source of truth about money — the one that is wrong.
 *
 * Deterministic by construction: the caller supplies every identifier and every instant. Nothing
 * here reads a clock or generates randomness.
 *
 * Owned by: M-13 Financial Ledger.
 */

/**
 * What a wallet is *for*.
 *
 * Two wallets in the same asset type, held by the same party, are not interchangeable if their
 * purposes differ: a seller's earnings are subject to payout rules and holding periods that their
 * spending balance is not. The purpose is what a policy is written against.
 */
export const WALLET_PURPOSES = [
  /** What the holder may pay with today. */
  'spending',
  /** What the holder has earned and not yet been paid out. */
  'earnings',
  /** Value held by the platform against a specific obligation between two parties. */
  'escrow',
  /** Value the holder has deliberately set aside towards a goal. */
  'savings',
  /** The platform's own receiving position: where value lands when an obligation is paid. */
  'settlement',
  /** The platform's own issuing position: where internally issued value is created from. */
  'issuance',
] as const;
export type WalletPurpose = (typeof WALLET_PURPOSES)[number];

/**
 * A wallet's lifecycle.
 *
 * `frozen` is the state a fraud hold or a legal order produces: the wallet still exists and its
 * balance is still readable, but nothing may be moved out of it. `closed` is terminal and requires
 * an empty balance — closing a wallet that still holds value would strand it somewhere nobody
 * looks.
 */
export const WALLET_STATUSES = ['open', 'frozen', 'closed'] as const;
export type WalletStatus = (typeof WALLET_STATUSES)[number];

export const WALLET_TRANSITIONS: Readonly<Record<WalletStatus, readonly WalletStatus[]>> =
  Object.freeze({
    open: ['frozen', 'closed'],
    frozen: ['open', 'closed'],
    closed: [],
  });

/**
 * How a leg of a plan is settled.
 *
 * `internal` value already exists inside the platform and moves by journal entry alone. `external`
 * value has to cross the platform boundary, which M-12 Payments orchestrates — M-13 records that a
 * leg is external and waits to be told it landed. **M-13 never calls a payment provider**, and
 * M-12 is the same layer, so the two communicate by event.
 */
export const LEG_KINDS = ['internal', 'external'] as const;
export type LegKind = (typeof LEG_KINDS)[number];

/**
 * A leg's lifecycle.
 *
 * `planned` means the allocation has been decided and nothing has moved. `posted` means a K-10
 * transaction exists for it and the value really has moved. `reversed` means a compensating
 * transaction has been posted — **never** that the original was deleted, because a journal that can
 * forget is not a journal.
 */
export const LEG_STATUSES = ['planned', 'posted', 'reversed'] as const;
export type LegStatus = (typeof LEG_STATUSES)[number];

/**
 * A plan's lifecycle.
 *
 * `draft` holds an allocation nothing has acted on. `committed` means every internal leg has
 * posted and the external leg, if there is one, is awaiting settlement. `settled` means every leg
 * has posted. `cancelled` means every posted leg has been reversed.
 */
export const PLAN_STATUSES = ['draft', 'committed', 'settled', 'cancelled'] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export const PLAN_TRANSITIONS: Readonly<Record<PlanStatus, readonly PlanStatus[]>> = Object.freeze({
  draft: ['committed', 'cancelled'],
  committed: ['settled', 'cancelled'],
  settled: [],
  cancelled: [],
});

/**
 * A named position: one party's holding of one asset type, for one purpose.
 *
 * `ledgerAccountId` is the K-10 account this wallet names. It is the only place the two modules are
 * joined, and it is a value M-13 stores rather than derives, so a reader can go from a wallet to a
 * balance without guessing at a naming convention.
 */
export interface Wallet {
  readonly walletId: string;
  /** The K-03 account that holds this wallet, or a platform account for `settlement`/`issuance`. */
  readonly ownerAccountId: string;
  /** The K-10 asset type this wallet is denominated in. */
  readonly assetTypeId: string;
  readonly purpose: WalletPurpose;
  /** The K-10 ledger account this wallet names. */
  readonly ledgerAccountId: string;
  readonly status: WalletStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
}

/** One change of a wallet's status. Append-only. */
export interface WalletStateRecord {
  readonly stateId: string;
  readonly walletId: string;
  readonly fromStatus: WalletStatus | null;
  readonly toStatus: WalletStatus;
  readonly reason: string;
  readonly occurredAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
}

/**
 * How much of the settlement asset one minor unit of a leg's asset is worth.
 *
 * A rate is a **pair of integers**, never a decimal. `1500` reward points settling `1500` LKR cents
 * is `1/1`; a scheme where a point is worth two cents is `2/1`. There is no floating point anywhere
 * in this module, and there is no division either: the check is the cross-multiplication
 *
 *     amountMinor × numerator === settlementEquivalentMinor × denominator
 *
 * which is exact for every representable pair. A rate that would require rounding does not divide
 * evenly, and the allocation is refused rather than silently absorbing the remainder — a fraction
 * of a cent lost per leg is a fraction of a cent somebody eventually audits.
 */
export interface ValueRate {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

/**
 * One source of value against one obligation.
 *
 * Each leg is denominated in its **own** asset type and carries what that amount is worth in the
 * obligation's settlement asset. The two are held separately on purpose: the journal must record
 * what actually moved, and the plan must record what it counted for.
 */
export interface ValueLeg {
  readonly legId: string;
  readonly planId: string;
  readonly kind: LegKind;
  readonly status: LegStatus;
  /** The K-10 asset type this leg moves. */
  readonly assetTypeId: string;
  /** The wallet value leaves. Null for an external leg: the money comes from outside. */
  readonly sourceWalletId: string | null;
  /** The wallet value arrives in. */
  readonly destinationWalletId: string;
  /** How much moves, in minor units of `assetTypeId`. */
  readonly amountMinor: bigint;
  readonly rate: ValueRate;
  /** What this leg is worth against the obligation, in minor units of the settlement asset. */
  readonly settlementEquivalentMinor: bigint;
  /** The K-10 transaction that moved it, or null while the leg is only planned. */
  readonly ledgerTransactionId: string | null;
  /** The K-10 transaction that reversed it, or null. */
  readonly reversalTransactionId: string | null;
  /**
   * For an external leg, the M-12 payment that settles it. Opaque, and not a foreign key: M-12 is
   * the same layer, so the two never join.
   */
  readonly externalReference: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
}

/**
 * One obligation, and the several kinds of value paying it.
 *
 * `obligationId` is opaque — usually an M-11 order — and deliberately not a foreign key. The plan's
 * central invariant is that the legs' settlement equivalents sum **exactly** to
 * `targetAmountMinor`: not approximately, and not with a remainder absorbed somewhere. An
 * allocation that does not add up is refused, because a plan that under-covers its obligation is a
 * short payment nobody noticed and one that over-covers is value taken for nothing.
 */
export interface ValuePlan {
  readonly planId: string;
  /** What is being paid for. Opaque; usually an M-11 order id. */
  readonly obligationId: string;
  /** What kind of thing that is, as a vocabulary word: `order`, `subscription`, `fee`. */
  readonly obligationKind: string;
  /** The party that owes. */
  readonly payerAccountId: string;
  /** The party owed. */
  readonly payeeAccountId: string;
  readonly status: PlanStatus;
  /**
   * The asset the obligation is denominated in — an M-13 asset type id, so an obligation may be
   * denominated in anything K-10 knows about rather than only in fiat.
   */
  readonly settlementAssetTypeId: string;
  /** The whole obligation, in minor units of the settlement asset. */
  readonly targetAmountMinor: bigint;
  readonly committedAt: string | null;
  readonly settledAt: string | null;
  readonly cancelledAt: string | null;
  readonly cancellationReason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
}

/**
 * What a plan is actually covered by, derived from its legs.
 *
 * Every figure is summed from leg rows at read time. Nothing here is stored, because a stored
 * coverage figure drifts the moment a leg moves and nobody recomputes it — the same reason M-11's
 * fulfilment summary is derived rather than kept.
 */
export interface PlanCoverage {
  readonly planId: string;
  readonly targetAmountMinor: bigint;
  /** The settlement equivalent of every leg, whatever its status. */
  readonly allocatedMinor: bigint;
  /** The settlement equivalent of the legs that have actually posted. */
  readonly postedMinor: bigint;
  /** The settlement equivalent of the legs still to post. */
  readonly outstandingMinor: bigint;
  /** The settlement equivalent of the legs that have been reversed. */
  readonly reversedMinor: bigint;
  /** How much of the target came from value JAYA issued itself. */
  readonly internalMinor: bigint;
  /** How much of the target crossed the platform boundary. */
  readonly externalMinor: bigint;
  readonly legs: readonly ValueLeg[];
  /** True when the allocation adds up to the target exactly. */
  readonly fullyAllocated: boolean;
  /** True when every leg has posted. */
  readonly fullySettled: boolean;
}

export type FinancialLedgerErrorCode =
  /** An identifier is not well formed. */
  | 'malformed-identifier'
  /** An identifier looks like a natural key. */
  | 'natural-identifier'
  /** An identifier names or looks like a credential. */
  | 'secret-bearing-input'
  /** The instant is not a real UTC instant. */
  | 'malformed-instant'
  /** A request carried a field belonging to another component. */
  | 'foreign-concern'
  /** A stored row, or a candidate record, is not what this component writes. */
  | 'malformed-record'
  /** The idempotency key was already used for a different record. */
  | 'idempotency-key-reuse'
  /** An enlisted write tried to issue transaction control. */
  | 'nested-transaction'
  /** The purpose is not one M-13 recognises. */
  | 'unknown-purpose'
  /** The status is not one M-13 recognises. */
  | 'unknown-status'
  /** A wallet id already exists with different content. */
  | 'duplicate-wallet-id'
  /** The wallet id is unknown. */
  | 'wallet-not-found'
  /** One party may hold only one wallet per asset type and purpose. */
  | 'wallet-exists'
  /** The wallet is frozen and value may not leave it. */
  | 'wallet-frozen'
  /** The wallet is closed. */
  | 'wallet-closed'
  /** A wallet holding value may not be closed. */
  | 'wallet-not-empty'
  /** A plan id already exists with different content. */
  | 'duplicate-plan-id'
  /** The plan id is unknown. */
  | 'plan-not-found'
  /** A leg id already exists with different content. */
  | 'duplicate-leg-id'
  /** The leg id is unknown. */
  | 'leg-not-found'
  /** The requested transition is not in the state machine. */
  | 'illegal-transition'
  /** The plan is in a terminal state. */
  | 'plan-terminal'
  /** The legs do not sum to the obligation. */
  | 'allocation-mismatch'
  /** A leg's amount and its settlement equivalent disagree at its stated rate. */
  | 'rate-mismatch'
  /** A rate has a zero or negative term. */
  | 'malformed-rate'
  /** A plan carries no legs. */
  | 'empty-allocation'
  /** A plan carries more than one external leg. */
  | 'multiple-external-legs'
  /** An external leg is not denominated in the settlement asset. */
  | 'external-leg-mismatch'
  /** A leg names a wallet in a different asset type. */
  | 'leg-asset-mismatch'
  /** A leg names the same wallet as source and destination. */
  | 'leg-self-transfer'
  /** An amount is negative, zero where it may not be, or not an exact integer. */
  | 'invalid-amount'
  /** The reason text is empty, blank or too long. */
  | 'malformed-reason'
  /** K-10 refused the posting. Its own code is carried in the message. */
  | 'ledger-refused';

/** A refusal the caller must act on. */
export class FinancialLedgerError extends Error {
  readonly code: FinancialLedgerErrorCode;

  constructor(code: FinancialLedgerErrorCode, message: string) {
    super(message);
    this.name = 'FinancialLedgerError';
    this.code = code;
  }
}
