/**
 * M-13 Financial Ledger — service.
 *
 * The value router. Its whole purpose is one operation a single-currency platform never needs:
 * paying **one obligation from several kinds of value at once**, and proving afterwards that the
 * pieces added up.
 *
 * LKR 10,000 paid as 1,500 reward points + 500 merchant credit + 8,000 on a card is three
 * movements in three different units. K-10 refuses to put them in one journal transaction, and it
 * is right to: a line denominated in two units is not a line. So each leg becomes its own balanced
 * transaction in its own asset type, and the plan is what ties them together and asserts the
 * arithmetic.
 *
 * Four rules shape the code below.
 *
 * **The allocation must be exact.** Legs' settlement equivalents sum to the obligation, checked with
 * integer arithmetic and no tolerance. A plan that under-covers is a short payment nobody noticed;
 * one that over-covers is value taken for nothing.
 *
 * **A rate never rounds.** Rates are integer pairs and are checked by cross-multiplication. An
 * allocation that would need rounding is refused, rather than absorbing the remainder into whichever
 * leg is processed last.
 *
 * **Post to the journal first, record second.** K-10 opens its own transaction, so the two stores
 * commit separately. Doing it in this order makes the failure mode the recoverable one: money moved
 * and the leg still `planned`, which a retry under the same key converges. The other order would
 * produce a leg claiming a posting that never happened.
 *
 * **Nothing is deleted.** A cancelled plan is reversed by compensating transactions. A journal that
 * can forget is not a journal.
 *
 * Deterministic by construction: the caller supplies every identifier and every instant. Nothing
 * here reads a clock or generates randomness.
 *
 * Owned by: M-13 Financial Ledger.
 */

import { InvalidInstantError, parseInstant } from '../../platform/time/instant.ts';

import {
  sealValueLeg,
  sealValueLegs,
  sealValuePlan,
  sealValuePlans,
  sealWallet,
  sealWalletStates,
  sealWallets,
} from './immutable.ts';
import type { LedgerPort } from './ledger-port.ts';
import {
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
  makeLegEntries,
  makePlanEntries,
  makeWalletOpenedEntries,
  makeWalletStatusEntries,
} from './outbox.ts';
import { FOREIGN_FIELDS, assertLedgerIdentifier, assertWalletPurpose } from './registry.ts';
import type { FinancialLedgerRepository, FinancialLedgerTransaction } from './repository.ts';
import {
  validateValueLeg,
  validateValuePlan,
  validateWallet,
  validateWalletState,
} from './validate.ts';
import {
  FinancialLedgerError,
  PLAN_TRANSITIONS,
  WALLET_TRANSITIONS,
  type LegKind,
  type PlanCoverage,
  type PlanStatus,
  type ValueLeg,
  type ValuePlan,
  type ValueRate,
  type Wallet,
  type WalletStateRecord,
} from './types.ts';

// ---------------------------------------------------------------------------
// Requests and results
// ---------------------------------------------------------------------------

export interface OpenWalletRequest {
  readonly walletId: string;
  readonly ownerAccountId: string;
  readonly assetTypeId: string;
  readonly purpose: string;
  /** The K-10 account to open for this wallet. */
  readonly ledgerAccountId: string;
  /**
   * Which way the underlying K-10 account moves.
   *
   * A holder's wallet is a liability of the platform and so credit-normal; a platform issuance
   * position is debit-normal. Stated by the caller because the sign of every balance depends on it
   * and guessing would be worse than asking.
   */
  readonly normalBalance: 'debit' | 'credit';
  readonly openedAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
}

export interface OpenWalletResult {
  readonly wallet: Wallet;
  readonly replayed: boolean;
}

export interface SetWalletStatusRequest {
  readonly walletId: string;
  readonly stateId: string;
  readonly toStatus: string;
  readonly reason: string;
  readonly occurredAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
}

export interface SetWalletStatusResult {
  readonly wallet: Wallet;
  readonly record: WalletStateRecord;
  readonly replayed: boolean;
}

/** One source of value, as the caller proposes it. */
export interface AllocationLeg {
  readonly legId: string;
  readonly kind: LegKind;
  readonly assetTypeId: string;
  /** Null only for the external leg: that value comes from outside the platform. */
  readonly sourceWalletId: string | null;
  readonly destinationWalletId: string;
  readonly amountMinor: bigint;
  readonly rate: ValueRate;
  readonly settlementEquivalentMinor: bigint;
  readonly idempotencyKey: string;
}

export interface AllocatePlanRequest {
  readonly planId: string;
  readonly obligationId: string;
  readonly obligationKind: string;
  readonly payerAccountId: string;
  readonly payeeAccountId: string;
  readonly settlementAssetTypeId: string;
  readonly targetAmountMinor: bigint;
  readonly legs: readonly AllocationLeg[];
  readonly allocatedAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  /** Opaque id for the allocation fact; the outbox entries derive from it. */
  readonly eventId: string;
}

export interface AllocatePlanResult {
  readonly plan: ValuePlan;
  readonly legs: readonly ValueLeg[];
  readonly replayed: boolean;
}

/** One leg to post, and the K-10 transaction id that will carry it. */
export interface Posting {
  readonly legId: string;
  readonly ledgerTransactionId: string;
}

export interface CommitPlanRequest {
  readonly planId: string;
  readonly postings: readonly Posting[];
  readonly committedAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly eventId: string;
}

export interface CommitPlanResult {
  readonly plan: ValuePlan;
  readonly legs: readonly ValueLeg[];
  readonly replayed: boolean;
}

export interface SettleExternalLegRequest {
  readonly planId: string;
  readonly legId: string;
  readonly ledgerTransactionId: string;
  /** The M-12 payment that settled it. Opaque; M-12 is the same layer and never joined to. */
  readonly externalReference: string;
  readonly settledAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly eventId: string;
}

export interface SettleExternalLegResult {
  readonly plan: ValuePlan;
  readonly leg: ValueLeg;
  readonly replayed: boolean;
}

/** One posted leg to reverse, and the compensating K-10 transaction id. */
export interface Reversal {
  readonly legId: string;
  readonly reversalTransactionId: string;
}

export interface CancelPlanRequest {
  readonly planId: string;
  readonly reversals: readonly Reversal[];
  readonly reason: string;
  readonly cancelledAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly eventId: string;
}

export interface CancelPlanResult {
  readonly plan: ValuePlan;
  readonly legs: readonly ValueLeg[];
  readonly replayed: boolean;
}

const OPEN_WALLET_KEYS: readonly string[] = [
  'walletId',
  'ownerAccountId',
  'assetTypeId',
  'purpose',
  'ledgerAccountId',
  'normalBalance',
  'openedAt',
  'correlationId',
  'idempotencyKey',
];

const SET_WALLET_STATUS_KEYS: readonly string[] = [
  'walletId',
  'stateId',
  'toStatus',
  'reason',
  'occurredAt',
  'correlationId',
  'idempotencyKey',
];

const ALLOCATE_KEYS: readonly string[] = [
  'planId',
  'obligationId',
  'obligationKind',
  'payerAccountId',
  'payeeAccountId',
  'settlementAssetTypeId',
  'targetAmountMinor',
  'legs',
  'allocatedAt',
  'correlationId',
  'idempotencyKey',
  'eventId',
];

const COMMIT_KEYS: readonly string[] = [
  'planId',
  'postings',
  'committedAt',
  'correlationId',
  'idempotencyKey',
  'eventId',
];

const SETTLE_KEYS: readonly string[] = [
  'planId',
  'legId',
  'ledgerTransactionId',
  'externalReference',
  'settledAt',
  'correlationId',
  'idempotencyKey',
  'eventId',
];

const CANCEL_KEYS: readonly string[] = [
  'planId',
  'reversals',
  'reason',
  'cancelledAt',
  'correlationId',
  'idempotencyKey',
  'eventId',
];

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class FinancialLedgerService {
  readonly #repository: FinancialLedgerRepository;
  readonly #ledger: LedgerPort;

  constructor(repository: FinancialLedgerRepository, ledger: LedgerPort) {
    this.#repository = repository;
    this.#ledger = ledger;
  }

  /**
   * Open a named position over a K-10 account.
   *
   * The K-10 account is created **first**. An account nobody names is harmless and a retry adopts
   * it; a wallet naming an account that does not exist would be a dangling reference every balance
   * read would trip over.
   */
  async openWallet(request: OpenWalletRequest): Promise<OpenWalletResult> {
    assertNoForeignConcerns(request, OPEN_WALLET_KEYS, 'openWallet');
    assertLedgerIdentifier(request.walletId, 'walletId');
    assertLedgerIdentifier(request.ledgerAccountId, 'ledgerAccountId');
    const purpose = assertWalletPurpose(request.purpose, 'purpose');
    const openedAt = parseAndCheckInstant(request.openedAt, 'openedAt');
    if (request.normalBalance !== 'debit' && request.normalBalance !== 'credit') {
      throw new FinancialLedgerError(
        'malformed-record',
        `normalBalance is "${String(request.normalBalance)}"; expected debit or credit`,
      );
    }

    const wallet = sealWallet(
      validateWallet(
        {
          walletId: request.walletId,
          ownerAccountId: request.ownerAccountId,
          assetTypeId: request.assetTypeId,
          purpose,
          ledgerAccountId: request.ledgerAccountId,
          status: 'open',
          createdAt: openedAt,
          updatedAt: openedAt,
          correlationId: request.correlationId,
          idempotencyKey: request.idempotencyKey,
        },
        'request',
      ),
    );

    const existing = await this.#repository.withTransaction((tx) =>
      tx.findWalletByIdempotencyKey(wallet.idempotencyKey),
    );
    if (existing !== null) {
      if (!walletEquals(existing, wallet)) {
        throw new FinancialLedgerError(
          'idempotency-key-reuse',
          `idempotency key "${wallet.idempotencyKey}" has already been used for a different wallet`,
        );
      }
      return { wallet: sealWallet(existing), replayed: true };
    }

    await this.#ledger.createAccount({
      ledgerAccountId: wallet.ledgerAccountId,
      assetTypeId: wallet.assetTypeId,
      ownerId: wallet.ownerAccountId,
      normalBalance: request.normalBalance,
      createdAt: openedAt,
      idempotencyKey: `M-13:wallet:${wallet.walletId}`,
    });

    try {
      return await this.#repository.withTransaction(async (tx) => {
        await tx.insertWallet(wallet);
        for (const entry of makeWalletOpenedEntries(wallet)) await tx.insertOutbox(entry);
        return { wallet, replayed: false };
      });
    } catch (error) {
      // Two identical requests racing: the loser re-reads and reports the winner, because the
      // caller asked for a wallet to exist and one does.
      const conflicted =
        error instanceof FinancialLedgerError &&
        (error.code === 'duplicate-wallet-id' ||
          error.code === 'idempotency-key-reuse' ||
          error.code === 'wallet-exists');
      if (!conflicted) throw error;

      const winner = await this.#repository.withTransaction((tx) =>
        tx.findWalletByIdempotencyKey(wallet.idempotencyKey),
      );
      if (winner === null || !walletEquals(winner, wallet)) throw error;
      return { wallet: sealWallet(winner), replayed: true };
    }
  }

  /** Freeze, unfreeze or close a wallet. Every change is recorded, and the record is append-only. */
  async setWalletStatus(request: SetWalletStatusRequest): Promise<SetWalletStatusResult> {
    assertNoForeignConcerns(request, SET_WALLET_STATUS_KEYS, 'setWalletStatus');
    assertLedgerIdentifier(request.stateId, 'stateId');
    const occurredAt = parseAndCheckInstant(request.occurredAt, 'occurredAt');

    return this.#repository.withTransaction(async (tx) => {
      const replay = await tx.findWalletStateByIdempotencyKey(request.idempotencyKey);
      if (replay !== null) {
        const wallet = await requireWallet(tx, replay.walletId);
        return { wallet: sealWallet(wallet), record: replay, replayed: true };
      }

      const before = await requireWallet(tx, request.walletId);
      const record = validateWalletState(
        {
          stateId: request.stateId,
          walletId: before.walletId,
          fromStatus: before.status,
          toStatus: request.toStatus,
          reason: request.reason,
          occurredAt,
          correlationId: request.correlationId,
          idempotencyKey: request.idempotencyKey,
        },
        'request',
      );

      if (!WALLET_TRANSITIONS[before.status].includes(record.toStatus)) {
        throw new FinancialLedgerError(
          'illegal-transition',
          `wallet ${before.walletId} cannot go from ${before.status} to ${record.toStatus}; the ` +
            `permitted moves are ${WALLET_TRANSITIONS[before.status].join(', ') || 'none, as it is closed'}`,
        );
      }

      const after = sealWallet(
        validateWallet({ ...before, status: record.toStatus, updatedAt: occurredAt }, 'request'),
      );

      const moved = await tx.updateWalletIfStatus(after, before.status);
      if (!moved) {
        throw new FinancialLedgerError(
          'illegal-transition',
          `wallet ${before.walletId} was moved by another transaction while this one was open`,
        );
      }
      await tx.insertWalletState(record);
      for (const entry of makeWalletStatusEntries(after, record)) await tx.insertOutbox(entry);

      return { wallet: after, record, replayed: false };
    });
  }

  /**
   * Allocate one obligation across several kinds of value. Nothing moves.
   *
   * This is where the arithmetic is decided and where a bad allocation is refused, before any value
   * has been touched. Committing an allocation that does not add up would be far harder to undo
   * than refusing it here.
   */
  async allocatePlan(request: AllocatePlanRequest): Promise<AllocatePlanResult> {
    assertNoForeignConcerns(request, ALLOCATE_KEYS, 'allocatePlan');
    assertLedgerIdentifier(request.planId, 'planId');
    assertLedgerIdentifier(request.eventId, 'eventId');
    const allocatedAt = parseAndCheckInstant(request.allocatedAt, 'allocatedAt');

    const proposed = assertAllocationLegs(request.legs);

    const plan = sealValuePlan(
      validateValuePlan(
        {
          planId: request.planId,
          obligationId: request.obligationId,
          obligationKind: request.obligationKind,
          payerAccountId: request.payerAccountId,
          payeeAccountId: request.payeeAccountId,
          status: 'draft',
          settlementAssetTypeId: request.settlementAssetTypeId,
          targetAmountMinor: request.targetAmountMinor,
          committedAt: null,
          settledAt: null,
          cancelledAt: null,
          cancellationReason: null,
          createdAt: allocatedAt,
          updatedAt: allocatedAt,
          correlationId: request.correlationId,
          idempotencyKey: request.idempotencyKey,
        },
        'request',
      ),
    );

    const legs = proposed.map((leg) =>
      sealValueLeg(
        validateValueLeg(
          {
            legId: leg.legId,
            planId: plan.planId,
            kind: leg.kind,
            status: 'planned',
            assetTypeId: leg.assetTypeId,
            sourceWalletId: leg.sourceWalletId,
            destinationWalletId: leg.destinationWalletId,
            amountMinor: leg.amountMinor,
            rate: leg.rate,
            settlementEquivalentMinor: leg.settlementEquivalentMinor,
            ledgerTransactionId: null,
            reversalTransactionId: null,
            externalReference: null,
            createdAt: allocatedAt,
            updatedAt: allocatedAt,
            correlationId: request.correlationId,
            idempotencyKey: leg.idempotencyKey,
          },
          'request',
        ),
      ),
    );

    assertAllocationAddsUp(plan, legs);

    const external = legs.filter((leg) => leg.kind === 'external');
    if (external.length > 1) {
      throw new FinancialLedgerError(
        'multiple-external-legs',
        `the plan carries ${String(external.length)} external legs. One obligation crosses the ` +
          'platform boundary at most once; two would be two payments, and M-12 orchestrates each ' +
          'payment separately',
      );
    }
    for (const leg of external) {
      if (leg.assetTypeId !== plan.settlementAssetTypeId) {
        throw new FinancialLedgerError(
          'external-leg-mismatch',
          `the external leg settles ${leg.assetTypeId} against an obligation in ` +
            `${plan.settlementAssetTypeId}. Converting one external asset into another is a ` +
            'treasury operation, not something to hide inside a payment',
        );
      }
      if (leg.rate.numerator !== leg.rate.denominator) {
        throw new FinancialLedgerError(
          'external-leg-mismatch',
          'the external leg carries a rate other than 1:1 against its own asset, which would mean ' +
            'the money that arrived is worth something other than itself',
        );
      }
    }

    const seen = new Set<string>();
    for (const leg of legs) {
      if (seen.has(leg.legId)) {
        throw new FinancialLedgerError(
          'duplicate-leg-id',
          `the allocation names leg ${leg.legId} twice`,
        );
      }
      seen.add(leg.legId);
    }

    try {
      return await this.#repository.withTransaction(async (tx) => {
        const byKey = await tx.findPlanByIdempotencyKey(plan.idempotencyKey);
        if (byKey !== null) {
          if (!planEquals(byKey, plan)) {
            throw new FinancialLedgerError(
              'idempotency-key-reuse',
              `idempotency key "${plan.idempotencyKey}" has already been used for a different plan`,
            );
          }
          return {
            plan: sealValuePlan(byKey),
            legs: await tx.findLegsByPlanId(byKey.planId),
            replayed: true,
          };
        }

        // Every wallet a leg names must exist, be open, and be denominated in the leg's asset.
        for (const leg of legs) {
          await this.#requireUsableWallet(tx, leg.destinationWalletId, leg.assetTypeId, 'into');
          if (leg.sourceWalletId !== null) {
            await this.#requireUsableWallet(tx, leg.sourceWalletId, leg.assetTypeId, 'out of');
          }
        }

        await tx.insertPlan(plan);
        for (const leg of legs) await tx.insertLeg(leg);
        for (const entry of makePlanEntries(
          plan,
          legs,
          PLAN_ALLOCATED_EVENT,
          PLAN_ALLOCATED_ACTION,
          request.eventId,
          allocatedAt,
        )) {
          await tx.insertOutbox(entry);
        }
        return { plan, legs: sealValueLegs(legs), replayed: false };
      });
    } catch (error) {
      const conflicted =
        error instanceof FinancialLedgerError &&
        (error.code === 'duplicate-plan-id' || error.code === 'idempotency-key-reuse');
      if (!conflicted) throw error;
      const winner = await this.#repository.withTransaction((tx) =>
        tx.findPlanByIdempotencyKey(plan.idempotencyKey),
      );
      if (winner === null || !planEquals(winner, plan)) throw error;
      const held = await this.#repository.withTransaction((tx) =>
        tx.findLegsByPlanId(winner.planId),
      );
      return { plan: sealValuePlan(winner), legs: held, replayed: true };
    }
  }

  /**
   * Post every internal leg, and move the plan on.
   *
   * A plan with no external leg goes straight to `settled`: everything it needed has moved. One
   * with an external leg stops at `committed` and waits for M-12's money to arrive.
   */
  async commitPlan(request: CommitPlanRequest): Promise<CommitPlanResult> {
    assertNoForeignConcerns(request, COMMIT_KEYS, 'commitPlan');
    assertLedgerIdentifier(request.eventId, 'eventId');
    const committedAt = parseAndCheckInstant(request.committedAt, 'committedAt');

    const before = await this.#repository.withTransaction((tx) => requirePlan(tx, request.planId));
    if (before.status === 'committed' || before.status === 'settled') {
      const legs = await this.#repository.withTransaction((tx) =>
        tx.findLegsByPlanId(before.planId),
      );
      return { plan: sealValuePlan(before), legs, replayed: true };
    }
    assertPlanTransition(before, 'committed');

    const planned = await this.#repository.withTransaction((tx) =>
      tx.findLegsByPlanId(before.planId),
    );
    const internal = planned.filter((leg) => leg.kind === 'internal' && leg.status === 'planned');

    const byLeg = new Map(request.postings.map((posting) => [posting.legId, posting]));
    for (const leg of internal) {
      const posting = byLeg.get(leg.legId);
      if (posting === undefined) {
        throw new FinancialLedgerError(
          'malformed-record',
          `commitPlan named no transaction id for leg ${leg.legId}. Every leg that posts needs its ` +
            'own K-10 transaction, and the caller supplies every identifier',
        );
      }
      assertLedgerIdentifier(posting.ledgerTransactionId, 'postings[].ledgerTransactionId');
    }

    for (const leg of internal) {
      const posting = byLeg.get(leg.legId);
      if (posting === undefined) continue;
      await this.#postLeg(leg, posting.ledgerTransactionId, committedAt);
    }

    const hasExternal = planned.some((leg) => leg.kind === 'external' && leg.status !== 'reversed');
    const nextStatus: PlanStatus = hasExternal ? 'committed' : 'settled';

    return this.#repository.withTransaction(async (tx) => {
      const current = await requirePlan(tx, before.planId);
      const after = sealValuePlan(
        validateValuePlan(
          {
            ...current,
            status: nextStatus,
            committedAt,
            settledAt: nextStatus === 'settled' ? committedAt : null,
            updatedAt: committedAt,
          },
          'request',
        ),
      );

      const moved = await tx.updatePlanIfStatus(after, current.status);
      if (!moved) {
        throw new FinancialLedgerError(
          'illegal-transition',
          `plan ${before.planId} was moved by another transaction while this one was open`,
        );
      }

      const legs = await tx.findLegsByPlanId(after.planId);
      const definitions =
        nextStatus === 'settled'
          ? ([PLAN_SETTLED_EVENT, PLAN_SETTLED_ACTION] as const)
          : ([PLAN_COMMITTED_EVENT, PLAN_COMMITTED_ACTION] as const);
      for (const entry of makePlanEntries(
        after,
        legs,
        definitions[0],
        definitions[1],
        request.eventId,
        committedAt,
      )) {
        await tx.insertOutbox(entry);
      }
      return { plan: after, legs, replayed: false };
    });
  }

  /**
   * Record that the external leg's money arrived, and settle the plan.
   *
   * The caller is the unit that consumed M-12's `payment.captured`. M-13 never asks M-12 anything:
   * they are the same layer, so what M-13 has is a fact it was told.
   */
  async settleExternalLeg(request: SettleExternalLegRequest): Promise<SettleExternalLegResult> {
    assertNoForeignConcerns(request, SETTLE_KEYS, 'settleExternalLeg');
    assertLedgerIdentifier(request.eventId, 'eventId');
    assertLedgerIdentifier(request.externalReference, 'externalReference');
    const settledAt = parseAndCheckInstant(request.settledAt, 'settledAt');

    const before = await this.#repository.withTransaction((tx) => requirePlan(tx, request.planId));
    const leg = await this.#repository.withTransaction((tx) => requireLeg(tx, request.legId));

    if (leg.planId !== before.planId) {
      throw new FinancialLedgerError(
        'leg-not-found',
        `leg ${leg.legId} belongs to plan ${leg.planId}, not ${before.planId}`,
      );
    }
    if (leg.kind !== 'external') {
      throw new FinancialLedgerError(
        'illegal-transition',
        `leg ${leg.legId} is internal; internal value posts at commit, not on settlement`,
      );
    }
    if (leg.status === 'posted') {
      return { plan: sealValuePlan(before), leg: sealValueLeg(leg), replayed: true };
    }
    if (before.status !== 'committed') {
      throw new FinancialLedgerError(
        'illegal-transition',
        `plan ${before.planId} is ${before.status}; an external leg settles against a committed plan`,
      );
    }

    await this.#postLeg(leg, request.ledgerTransactionId, settledAt, request.externalReference);

    return this.#repository.withTransaction(async (tx) => {
      const current = await requirePlan(tx, before.planId);
      const after = sealValuePlan(
        validateValuePlan(
          { ...current, status: 'settled', settledAt, updatedAt: settledAt },
          'request',
        ),
      );
      const moved = await tx.updatePlanIfStatus(after, 'committed');
      if (!moved) {
        throw new FinancialLedgerError(
          'illegal-transition',
          `plan ${before.planId} was moved by another transaction while this one was open`,
        );
      }
      const legs = await tx.findLegsByPlanId(after.planId);
      for (const entry of makePlanEntries(
        after,
        legs,
        PLAN_SETTLED_EVENT,
        PLAN_SETTLED_ACTION,
        request.eventId,
        settledAt,
      )) {
        await tx.insertOutbox(entry);
      }
      const settled = await requireLeg(tx, leg.legId);
      return { plan: after, leg: sealValueLeg(settled), replayed: false };
    });
  }

  /**
   * Cancel a plan, reversing every leg that posted.
   *
   * Reversal is a compensating transaction, never a deletion. The original posting stays in the
   * journal because it happened, and a ledger that can be edited to say otherwise is not evidence
   * of anything.
   */
  async cancelPlan(request: CancelPlanRequest): Promise<CancelPlanResult> {
    assertNoForeignConcerns(request, CANCEL_KEYS, 'cancelPlan');
    assertLedgerIdentifier(request.eventId, 'eventId');
    const cancelledAt = parseAndCheckInstant(request.cancelledAt, 'cancelledAt');

    const before = await this.#repository.withTransaction((tx) => requirePlan(tx, request.planId));
    if (before.status === 'cancelled') {
      const legs = await this.#repository.withTransaction((tx) =>
        tx.findLegsByPlanId(before.planId),
      );
      return { plan: sealValuePlan(before), legs, replayed: true };
    }
    assertPlanTransition(before, 'cancelled');

    const legs = await this.#repository.withTransaction((tx) => tx.findLegsByPlanId(before.planId));
    const posted = legs.filter((leg) => leg.status === 'posted');
    const byLeg = new Map(request.reversals.map((reversal) => [reversal.legId, reversal]));

    for (const leg of posted) {
      const reversal = byLeg.get(leg.legId);
      if (reversal === undefined) {
        throw new FinancialLedgerError(
          'malformed-record',
          `cancelPlan named no reversal for leg ${leg.legId}, which has posted. Cancelling a plan ` +
            'while leaving its value moved would strand the money with nobody accountable for it',
        );
      }
      assertLedgerIdentifier(reversal.reversalTransactionId, 'reversals[].reversalTransactionId');
    }

    for (const leg of posted) {
      const reversal = byLeg.get(leg.legId);
      if (reversal === undefined) continue;
      await this.#reverseLeg(leg, reversal.reversalTransactionId, cancelledAt);
    }

    return this.#repository.withTransaction(async (tx) => {
      const current = await requirePlan(tx, before.planId);
      const after = sealValuePlan(
        validateValuePlan(
          {
            ...current,
            status: 'cancelled',
            cancelledAt,
            cancellationReason: request.reason,
            updatedAt: cancelledAt,
          },
          'request',
        ),
      );
      const moved = await tx.updatePlanIfStatus(after, current.status);
      if (!moved) {
        throw new FinancialLedgerError(
          'illegal-transition',
          `plan ${before.planId} was moved by another transaction while this one was open`,
        );
      }
      const final = await tx.findLegsByPlanId(after.planId);
      for (const entry of makePlanEntries(
        after,
        final,
        PLAN_CANCELLED_EVENT,
        PLAN_CANCELLED_ACTION,
        request.eventId,
        cancelledAt,
        { reason: request.reason },
      )) {
        await tx.insertOutbox(entry);
      }
      return { plan: after, legs: final, replayed: false };
    });
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  async getWallet(walletId: string): Promise<Wallet> {
    assertLedgerIdentifier(walletId, 'walletId');
    return this.#repository.withTransaction(async (tx) =>
      sealWallet(await requireWallet(tx, walletId)),
    );
  }

  async listWallets(ownerAccountId: string): Promise<readonly Wallet[]> {
    assertLedgerIdentifier(ownerAccountId, 'ownerAccountId');
    return this.#repository.withTransaction(async (tx) =>
      sealWallets(await tx.findWalletsByOwner(ownerAccountId)),
    );
  }

  async getWalletHistory(walletId: string): Promise<readonly WalletStateRecord[]> {
    assertLedgerIdentifier(walletId, 'walletId');
    return this.#repository.withTransaction(async (tx) =>
      sealWalletStates(await tx.findWalletStatesByWalletId(walletId)),
    );
  }

  async getPlan(planId: string): Promise<ValuePlan> {
    assertLedgerIdentifier(planId, 'planId');
    return this.#repository.withTransaction(async (tx) =>
      sealValuePlan(await requirePlan(tx, planId)),
    );
  }

  async listPlansForObligation(obligationId: string): Promise<readonly ValuePlan[]> {
    assertLedgerIdentifier(obligationId, 'obligationId');
    return this.#repository.withTransaction(async (tx) =>
      sealValuePlans(await tx.findPlansByObligation(obligationId)),
    );
  }

  async listPlansForPayer(payerAccountId: string): Promise<readonly ValuePlan[]> {
    assertLedgerIdentifier(payerAccountId, 'payerAccountId');
    return this.#repository.withTransaction(async (tx) =>
      sealValuePlans(await tx.findPlansByPayer(payerAccountId)),
    );
  }

  async listLegs(planId: string): Promise<readonly ValueLeg[]> {
    assertLedgerIdentifier(planId, 'planId');
    return this.#repository.withTransaction(async (tx) => tx.findLegsByPlanId(planId));
  }

  /**
   * What a plan is covered by, summed from its legs at read time.
   *
   * Nothing here is stored. A coverage figure kept in a column drifts the moment a leg moves and
   * nobody recomputes it, which is exactly the class of bug M-11's fulfilment summary avoids the
   * same way.
   */
  async getCoverage(planId: string): Promise<PlanCoverage> {
    assertLedgerIdentifier(planId, 'planId');
    return this.#repository.withTransaction(async (tx) => {
      const plan = await requirePlan(tx, planId);
      const legs = await tx.findLegsByPlanId(planId);
      return coverageOf(plan, legs);
    });
  }

  // -------------------------------------------------------------------------
  // Posting
  // -------------------------------------------------------------------------

  /**
   * Post one leg to the journal, then record it.
   *
   * That order is deliberate and is the whole of the crash story. K-10 opens its own transaction,
   * so the two stores commit separately; posting first means a process that dies in between leaves
   * the money moved and the leg still `planned`, which a retry under the same key converges — K-10
   * answers `deduplicated` and the leg is marked. The other order would leave a leg claiming a
   * posting that never happened, and no retry could tell.
   */
  async #postLeg(
    leg: ValueLeg,
    ledgerTransactionId: string,
    at: string,
    externalReference: string | null = null,
  ): Promise<void> {
    const entries =
      leg.sourceWalletId === null
        ? // An external leg: the value came from outside, so it is credited into the destination
          // against the platform's own settlement position, which the caller opened as the
          // destination's counterpart. A single-sided posting would not balance, so the source of
          // an external leg is the destination wallet's own `pending` counterpart — see CONTRACT.md.
          await this.#externalEntries(leg)
        : await this.#internalEntries(leg);

    await this.#ledger.post({
      transactionId: ledgerTransactionId,
      assetTypeId: leg.assetTypeId,
      postedAt: at,
      idempotencyKey: `M-13:leg:${leg.legId}`,
      entries,
    });

    await this.#repository.withTransaction(async (tx) => {
      const current = await requireLeg(tx, leg.legId);
      if (current.status === 'posted') return;
      const after = sealValueLeg(
        validateValueLeg(
          {
            ...current,
            status: 'posted',
            ledgerTransactionId,
            externalReference: externalReference ?? current.externalReference,
            updatedAt: at,
          },
          'request',
        ),
      );
      const moved = await tx.updateLegIfStatus(after, 'planned');
      if (!moved) {
        throw new FinancialLedgerError(
          'illegal-transition',
          `leg ${leg.legId} was posted by another transaction while this one was open. The journal ` +
            'holds one transaction for it; this one must not add a second',
        );
      }
      for (const entry of makeLegEntries(after, LEG_POSTED_EVENT, LEG_POSTED_ACTION, at)) {
        await tx.insertOutbox(entry);
      }
    });
  }

  /** Debit the source, credit the destination. Both are in the leg's own asset type. */
  async #internalEntries(
    leg: ValueLeg,
  ): Promise<
    readonly { ledgerAccountId: string; side: 'debit' | 'credit'; amountMinor: bigint }[]
  > {
    const source = leg.sourceWalletId;
    if (source === null) {
      throw new FinancialLedgerError('malformed-record', `internal leg ${leg.legId} has no source`);
    }
    const [from, to] = await this.#repository.withTransaction(async (tx) => [
      await requireWallet(tx, source),
      await requireWallet(tx, leg.destinationWalletId),
    ]);
    if (from.status !== 'open') {
      throw new FinancialLedgerError(
        from.status === 'frozen' ? 'wallet-frozen' : 'wallet-closed',
        `wallet ${from.walletId} is ${from.status}; value may not leave it`,
      );
    }
    return [
      { ledgerAccountId: from.ledgerAccountId, side: 'debit', amountMinor: leg.amountMinor },
      { ledgerAccountId: to.ledgerAccountId, side: 'credit', amountMinor: leg.amountMinor },
    ];
  }

  /**
   * An external leg's posting.
   *
   * Value that arrives from outside still has to balance: the platform now holds an asset (the money
   * at the gateway) and owes it to somebody. The debit is the platform's settlement wallet in the
   * same asset type — supplied by the caller as the plan's counterpart — and the credit is the
   * destination. M-13 finds that wallet by purpose rather than being told it twice.
   */
  async #externalEntries(
    leg: ValueLeg,
  ): Promise<
    readonly { ledgerAccountId: string; side: 'debit' | 'credit'; amountMinor: bigint }[]
  > {
    return this.#repository.withTransaction(async (tx) => {
      const destination = await requireWallet(tx, leg.destinationWalletId);
      const plan = await requirePlan(tx, leg.planId);
      const settlement = await tx.findWalletByPosition(
        plan.payerAccountId,
        leg.assetTypeId,
        'settlement',
      );
      if (settlement === null) {
        throw new FinancialLedgerError(
          'wallet-not-found',
          `no settlement wallet exists for ${plan.payerAccountId} in ${leg.assetTypeId}. External ` +
            'value has to arrive somewhere before it can be paid onward, and a single-sided ' +
            'posting is not a posting',
        );
      }
      return [
        {
          ledgerAccountId: settlement.ledgerAccountId,
          side: 'debit' as const,
          amountMinor: leg.amountMinor,
        },
        {
          ledgerAccountId: destination.ledgerAccountId,
          side: 'credit' as const,
          amountMinor: leg.amountMinor,
        },
      ];
    });
  }

  /** Post the compensating transaction, then record the leg as reversed. */
  async #reverseLeg(leg: ValueLeg, reversalTransactionId: string, at: string): Promise<void> {
    const original =
      leg.sourceWalletId === null
        ? await this.#externalEntries(leg)
        : await this.#internalEntries(leg);

    // The same lines with the sides swapped. Constructing it from the original rather than
    // recomputing it means a reversal cannot disagree with what it reverses.
    const entries = original.map((entry) => ({
      ledgerAccountId: entry.ledgerAccountId,
      side: entry.side === 'debit' ? ('credit' as const) : ('debit' as const),
      amountMinor: entry.amountMinor,
    }));

    await this.#ledger.post({
      transactionId: reversalTransactionId,
      assetTypeId: leg.assetTypeId,
      postedAt: at,
      idempotencyKey: `M-13:reversal:${leg.legId}`,
      entries,
    });

    await this.#repository.withTransaction(async (tx) => {
      const current = await requireLeg(tx, leg.legId);
      if (current.status === 'reversed') return;
      const after = sealValueLeg(
        validateValueLeg(
          { ...current, status: 'reversed', reversalTransactionId, updatedAt: at },
          'request',
        ),
      );
      const moved = await tx.updateLegIfStatus(after, 'posted');
      if (!moved) {
        throw new FinancialLedgerError(
          'illegal-transition',
          `leg ${leg.legId} was moved by another transaction while this one was open`,
        );
      }
      for (const entry of makeLegEntries(after, LEG_REVERSED_EVENT, LEG_REVERSED_ACTION, at, {
        reversal_transaction_id: reversalTransactionId,
      })) {
        await tx.insertOutbox(entry);
      }
    });
  }

  /** A wallet that exists, is open, and is denominated in the asset the leg moves. */
  async #requireUsableWallet(
    tx: FinancialLedgerTransaction,
    walletId: string,
    assetTypeId: string,
    direction: 'into' | 'out of',
  ): Promise<Wallet> {
    const wallet = await requireWallet(tx, walletId);
    if (wallet.assetTypeId !== assetTypeId) {
      throw new FinancialLedgerError(
        'leg-asset-mismatch',
        `a leg moves ${assetTypeId} ${direction} wallet ${walletId}, which holds ` +
          `${wallet.assetTypeId}. A journal line denominated in two units is not a line`,
      );
    }
    if (wallet.status === 'closed') {
      throw new FinancialLedgerError(
        'wallet-closed',
        `wallet ${walletId} is closed and cannot take part in a plan`,
      );
    }
    if (wallet.status === 'frozen' && direction === 'out of') {
      throw new FinancialLedgerError(
        'wallet-frozen',
        `wallet ${walletId} is frozen; value may not leave it`,
      );
    }
    return wallet;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The plan's central invariant.
 *
 * Exact integer equality, and no tolerance of any kind. A plan that under-covers is a short payment
 * nobody noticed; one that over-covers is value taken for nothing. Both are worse than a refusal.
 */
export function assertAllocationAddsUp(plan: ValuePlan, legs: readonly ValueLeg[]): void {
  const allocated = legs.reduce((total, leg) => total + leg.settlementEquivalentMinor, 0n);
  if (allocated !== plan.targetAmountMinor) {
    const shortfall = plan.targetAmountMinor - allocated;
    throw new FinancialLedgerError(
      'allocation-mismatch',
      `the legs are worth ${String(allocated)} against an obligation of ` +
        `${String(plan.targetAmountMinor)}, ` +
        (shortfall > 0n
          ? `${String(shortfall)} short. A committed plan that under-covers is a short payment ` +
            'nobody noticed'
          : `${String(-shortfall)} over. A committed plan that over-covers takes value for nothing`),
    );
  }
}

/** Coverage, summed from legs. */
export function coverageOf(plan: ValuePlan, legs: readonly ValueLeg[]): PlanCoverage {
  const sum = (predicate: (leg: ValueLeg) => boolean): bigint =>
    legs.filter(predicate).reduce((total, leg) => total + leg.settlementEquivalentMinor, 0n);

  const allocated = sum((leg) => leg.status !== 'reversed');
  const posted = sum((leg) => leg.status === 'posted');

  return Object.freeze({
    planId: plan.planId,
    targetAmountMinor: plan.targetAmountMinor,
    allocatedMinor: allocated,
    postedMinor: posted,
    outstandingMinor: sum((leg) => leg.status === 'planned'),
    reversedMinor: sum((leg) => leg.status === 'reversed'),
    internalMinor: sum((leg) => leg.kind === 'internal' && leg.status !== 'reversed'),
    externalMinor: sum((leg) => leg.kind === 'external' && leg.status !== 'reversed'),
    legs: sealValueLegs(legs),
    fullyAllocated: allocated === plan.targetAmountMinor,
    fullySettled: legs.length > 0 && posted === plan.targetAmountMinor,
  }) satisfies PlanCoverage;
}

function assertPlanTransition(plan: ValuePlan, to: PlanStatus): void {
  if (PLAN_TRANSITIONS[plan.status].length === 0) {
    throw new FinancialLedgerError(
      'plan-terminal',
      `plan ${plan.planId} is ${plan.status}, which is terminal`,
    );
  }
  if (!PLAN_TRANSITIONS[plan.status].includes(to)) {
    throw new FinancialLedgerError(
      'illegal-transition',
      `plan ${plan.planId} cannot go from ${plan.status} to ${to}; the permitted moves are ` +
        PLAN_TRANSITIONS[plan.status].join(', '),
    );
  }
}

/**
 * Whether two records describe the same request.
 *
 * **Neither the instant nor the correlation id is compared.** Idempotency is about *what* the caller
 * asked for. A retry arrives later than the original by definition, and it carries a fresh
 * correlation id unless the client happened to reuse one — so comparing either would make every real
 * retry a conflict and the whole mechanism useless. Both used to be compared, and only a live test
 * with a real clock caught it: the unit suites pin the clock and the id generator, so the two
 * attempts agreed and the divergence was invisible.
 *
 * What is compared is the business content. A retry that changes an amount, a party or an asset is
 * not a retry, and `idempotency-key-reuse` is the right answer for it.
 */
function walletEquals(left: Wallet, right: Wallet): boolean {
  return (
    left.walletId === right.walletId &&
    left.ownerAccountId === right.ownerAccountId &&
    left.assetTypeId === right.assetTypeId &&
    left.purpose === right.purpose &&
    left.ledgerAccountId === right.ledgerAccountId &&
    left.idempotencyKey === right.idempotencyKey
  );
}

function planEquals(left: ValuePlan, right: ValuePlan): boolean {
  return (
    left.planId === right.planId &&
    left.obligationId === right.obligationId &&
    left.obligationKind === right.obligationKind &&
    left.payerAccountId === right.payerAccountId &&
    left.payeeAccountId === right.payeeAccountId &&
    left.settlementAssetTypeId === right.settlementAssetTypeId &&
    left.targetAmountMinor === right.targetAmountMinor &&
    left.idempotencyKey === right.idempotencyKey
  );
}

async function requireWallet(tx: FinancialLedgerTransaction, walletId: string): Promise<Wallet> {
  const wallet = await tx.findWalletById(walletId);
  if (wallet === null) {
    throw new FinancialLedgerError('wallet-not-found', `wallet ${walletId} does not exist`);
  }
  return wallet;
}

async function requirePlan(tx: FinancialLedgerTransaction, planId: string): Promise<ValuePlan> {
  const plan = await tx.findPlanById(planId);
  if (plan === null) {
    throw new FinancialLedgerError('plan-not-found', `plan ${planId} does not exist`);
  }
  return plan;
}

async function requireLeg(tx: FinancialLedgerTransaction, legId: string): Promise<ValueLeg> {
  const leg = await tx.findLegById(legId);
  if (leg === null) {
    throw new FinancialLedgerError('leg-not-found', `leg ${legId} does not exist`);
  }
  return leg;
}

function assertNoForeignConcerns(
  request: object,
  permitted: readonly string[],
  operation: string,
): void {
  if (request === null || typeof request !== 'object') {
    throw new FinancialLedgerError(
      'malformed-record',
      `${operation} needs a request object, got ${request === null ? 'null' : typeof request}`,
    );
  }

  for (const key of Object.keys(request)) {
    if (permitted.includes(key)) continue;

    const owner = FOREIGN_FIELDS[key];
    if (owner !== undefined) {
      throw new FinancialLedgerError(
        'foreign-concern',
        `${operation} carried "${key}", but ${owner}. M-13 records where value is; it does not ` +
          'decide what is owed',
      );
    }
    throw new FinancialLedgerError(
      'foreign-concern',
      `${operation} carried the unrecognised field "${key}". The permitted fields are ` +
        `${permitted.join(', ')}; anything else would be accepted and silently dropped`,
    );
  }
}

function parseAndCheckInstant(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new FinancialLedgerError(
      'malformed-instant',
      `${field} is ${value === null ? 'null' : typeof value}; expected a UTC instant string`,
    );
  }
  try {
    return parseInstant(value).source;
  } catch (error) {
    if (error instanceof InvalidInstantError) {
      throw new FinancialLedgerError('malformed-instant', `${field}: ${error.message}`);
    }
    throw error;
  }
}

/**
 * The proposed legs, as a typed list.
 *
 * `Array.isArray` widens a `readonly T[]` to `any[]`, so the check and the type have to be put back
 * together explicitly. Keeping that in one function means the assertion is made once, next to the
 * runtime check that justifies it, rather than at every field access downstream.
 */
function assertAllocationLegs(value: unknown): readonly AllocationLeg[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new FinancialLedgerError(
      'empty-allocation',
      'a plan with no legs covers nothing, and committing one would report an unpaid obligation ' +
        'as paid',
    );
  }
  return value as readonly AllocationLeg[];
}
