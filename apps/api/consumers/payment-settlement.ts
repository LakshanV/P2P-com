/**
 * When a payment is captured, settle the external leg of the value plan it was paying.
 *
 * The single highest-value join in the repository, and until now it did not exist. M-12 could take
 * money and M-13 could route value across rewards, merchant credit and cash, and each was proven
 * against a real database — but nothing connected them. A captured payment left its plan sitting at
 * `committed` for ever, so the platform could charge somebody and never record that the obligation
 * had been met.
 *
 * **It lives in `apps/` because it must.** M-12 and M-13 are the same layer, and same-layer modules
 * communicate by event and never by import (MODULE_MAP §10.3). Neither may know the other exists.
 * The application is the only place above both, so the application is where the two facts meet.
 *
 * **It is a K-08 handler, not a call.** M-12 writes to its outbox in the same transaction as the
 * capture; the relay moves the row into the event log; K-08 fans it out to this subscription and
 * hands it here with an idempotency key that is stable across every redelivery and every replay.
 * That chain is what makes the settlement survive a crash between the two modules — the alternative,
 * M-12 calling M-13 directly after committing, loses the settlement whenever the process dies in
 * between, and loses it silently.
 *
 * Four judgements are worth reading before the code, because each is about money.
 *
 * **Ambiguity is refused, never guessed.** Two candidate plans, or two unposted external legs and no
 * way to tell which this payment settles: the handler throws. K-08 retries, backs off and eventually
 * dead-letters, which leaves a visible row an operator must look at. Settling the wrong leg would
 * leave no row at all and a wrong balance.
 *
 * The two-plan half of that is unreachable through M-13's public surface — an obligation may hold at
 * most one plan that has not been cancelled, and `tests/payment-settlement.test.ts` pins exactly
 * that. The branch stays regardless: the invariant belongs to M-13, this reads M-13 through a port,
 * and a consumer that would silently pick one of two plans becomes wrong the moment somebody relaxes
 * an invariant they had no reason to think anything depended on.
 *
 * **A capture that does not cover the leg is refused.** A partial capture is a legitimate state in
 * M-12, and settling a 3,000 leg against a 2,500 capture would post value the platform never
 * received. The plan stays committed and short, which is the truth.
 *
 * **Asset codes are not asset type ids.** M-12 speaks `LKR` and a scale; M-13 speaks a K-10 asset
 * type. They are different vocabularies that happen to describe the same thing, and the mapping
 * between them is a deployment fact. It is declared, and an undeclared pairing is refused rather
 * than assumed to match by string equality — which would work for `LKR` and quietly do the wrong
 * thing for everything else.
 *
 * **A payment with no plan is a no-op, and a reported one.** Not every purchase routes value: a
 * plain fiat sale has a payment and no plan, and dead-lettering those would bury the real failures
 * in noise. So it returns, and says so through `observe`, because a settlement that silently does
 * nothing is indistinguishable from one that silently fails.
 *
 * Owned by: apps/api.
 */

import type { HandlerContext } from '../../../kernel/event-infrastructure/index.ts';
import type { FinancialLedgerService, ValueLeg } from '../../../modules/financial-ledger/index.ts';
import { deriveId } from '../../../platform/http/context.ts';

/** The subscription this handler is registered under. Named for what it does, not for its producer. */
export const PAYMENT_SETTLEMENT_SUBSCRIPTION = 'financial-ledger-settles-captured-payments';

/**
 * The subscription K-08 must know about before a single delivery can be created.
 *
 * `owner` is the **application**, not M-13. M-13 does not subscribe to anything — it cannot, without
 * knowing M-12 exists. The application subscribes on its behalf, which is what "same-layer modules
 * communicate by event" means in practice.
 */
export const PAYMENT_SETTLEMENT_SUBSCRIPTION_DEFINITION = Object.freeze({
  subscription: PAYMENT_SETTLEMENT_SUBSCRIPTION,
  owner: 'apps/api',
  types: Object.freeze(['payment.captured']),
  description:
    'Settles the external leg of a value plan when the payment covering it is captured. Without ' +
    'it a captured payment leaves its plan committed for ever, so the platform charges somebody ' +
    'and never records that the obligation was met.',
});

/**
 * Which K-10 asset type a payment in a given asset settles into.
 *
 * A port rather than a lookup table here, so a deployment can hold the mapping in K-05
 * Configuration and change it without a release. Returning null means "not declared", which is a
 * refusal: a settlement that guessed the unit is a settlement that can post the wrong thing.
 */
export interface SettlementAssets {
  assetTypeFor(assetCode: string, assetScale: number): string | null;
}

/** A mapping from a plain object, keyed `CODE:scale`. */
export function settlementAssets(mapping: Readonly<Record<string, string>>): SettlementAssets {
  const held = new Map(Object.entries(mapping));
  return Object.freeze({
    assetTypeFor: (assetCode: string, assetScale: number): string | null =>
      held.get(`${assetCode}:${String(assetScale)}`) ?? null,
  });
}

/** What the handler did, for a log that can distinguish "nothing to do" from "nothing happened". */
export type SettlementOutcome =
  | {
      readonly kind: 'settled';
      readonly planId: string;
      readonly legId: string;
      readonly paymentId: string;
    }
  | { readonly kind: 'already-settled'; readonly planId: string; readonly legId: string }
  | { readonly kind: 'no-plan'; readonly orderId: string; readonly paymentId: string }
  | { readonly kind: 'no-external-leg'; readonly planId: string; readonly paymentId: string };

export interface PaymentSettlementOptions {
  readonly ledger: FinancialLedgerService;
  readonly assets: SettlementAssets;
  /**
   * Called with what happened, including the cases where nothing did.
   *
   * Not optional-by-omission in practice: `main.ts` wires the request log to it. A consumer that
   * quietly declines to act is the hardest kind of defect to find, because every gate is green and
   * the money is simply not where it should be.
   */
  readonly observe?: (outcome: SettlementOutcome) => void;
}

export class SettlementRefused extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'SettlementRefused';
    this.code = code;
  }
}

/**
 * Build the handler.
 *
 * Returns a plain `EventHandler`, so registering it is `events.register(SUBSCRIPTION, handler)` and
 * nothing about K-08 leaks into the settlement logic.
 */
export function paymentSettlementHandler(
  options: PaymentSettlementOptions,
): (context: HandlerContext) => Promise<void> {
  return async (context: HandlerContext): Promise<void> => {
    const payload = context.envelope.payload;
    const paymentId = readString(payload, 'payment_id');
    const orderId = readString(payload, 'order_id');
    const payerAccountId = readString(payload, 'payer_account_id');
    const payeeAccountId = readString(payload, 'payee_account_id');
    const assetCode = readString(payload, 'asset_code');
    const assetScale = Number(readString(payload, 'asset_scale'));
    const capturedMinor = readAmount(payload, 'captured_minor');

    const assetTypeId = options.assets.assetTypeFor(assetCode, assetScale);
    if (assetTypeId === null) {
      throw new SettlementRefused(
        'undeclared-settlement-asset',
        `no K-10 asset type is declared for payments in ${assetCode} at scale ` +
          `${String(assetScale)}. Refusing rather than assuming the code and the asset type id are ` +
          'the same string: that assumption happens to hold for LKR and quietly posts the wrong ' +
          'unit for everything else',
      );
    }

    const plan = await selectPlan(options.ledger, {
      orderId,
      payerAccountId,
      payeeAccountId,
      assetTypeId,
      paymentId,
    });
    if (plan === null) {
      options.observe?.({ kind: 'no-plan', orderId, paymentId });
      return;
    }

    const legs = await options.ledger.listLegs(plan.planId);
    const external = legs.filter((leg) => leg.kind === 'external');

    // Already done. Checked before the ambiguity rules below, so a redelivery of a payment that has
    // settled is quiet rather than a refusal — at-least-once delivery makes this the normal case,
    // not an exceptional one.
    const posted = external.find(
      (leg) => leg.status === 'posted' && leg.externalReference === paymentId,
    );
    if (posted !== undefined) {
      options.observe?.({ kind: 'already-settled', planId: plan.planId, legId: posted.legId });
      return;
    }

    const leg = selectLeg(external, paymentId);
    if (leg === null) {
      options.observe?.({ kind: 'no-external-leg', planId: plan.planId, paymentId });
      return;
    }

    if (capturedMinor < leg.amountMinor) {
      throw new SettlementRefused(
        'capture-does-not-cover-leg',
        `payment ${paymentId} has captured ${String(capturedMinor)} minor units and leg ` +
          `${leg.legId} is for ${String(leg.amountMinor)}. Settling would post value the platform ` +
          'has not received. The plan stays committed and short, which is the truth',
      );
    }

    // Every identifier derived from the delivery's idempotency key, which K-08 holds stable across
    // redeliveries and replay generations. So a redelivery produces the *same* transaction id and
    // the same event id, and M-13's own idempotency turns at-least-once delivery into exactly-once
    // effect — rather than two journal transactions for one capture.
    const key = context.idempotencyKey;
    await options.ledger.settleExternalLeg({
      planId: plan.planId,
      legId: leg.legId,
      ledgerTransactionId: deriveId('ltx', 'settle-external-leg', key),
      externalReference: paymentId,
      settledAt: context.envelope.occurredAt,
      correlationId: context.envelope.correlationId,
      idempotencyKey: deriveId('idem', 'settle-external-leg', key),
      eventId: deriveId('evt', 'settle-external-leg', key),
    });

    options.observe?.({ kind: 'settled', planId: plan.planId, legId: leg.legId, paymentId });
  };
}

interface PlanCriteria {
  readonly orderId: string;
  readonly payerAccountId: string;
  readonly payeeAccountId: string;
  readonly assetTypeId: string;
  readonly paymentId: string;
}

/**
 * The one plan this payment settles, or null when there is none.
 *
 * Matched on all four of order, payer, payee and settlement asset. Matching on the order alone
 * would be enough almost always and wrong occasionally — a split order has several plans against
 * one obligation — and "almost always" is not a standard for moving money.
 */
async function selectPlan(
  ledger: FinancialLedgerService,
  criteria: PlanCriteria,
): Promise<{ readonly planId: string } | null> {
  const plans = await ledger.listPlansForObligation(criteria.orderId);
  const candidates = plans.filter(
    (plan) =>
      plan.payerAccountId === criteria.payerAccountId &&
      plan.payeeAccountId === criteria.payeeAccountId &&
      plan.settlementAssetTypeId === criteria.assetTypeId &&
      (plan.status === 'committed' || plan.status === 'settled'),
  );

  if (candidates.length === 0) return null;
  if (candidates.length > 1) {
    throw new SettlementRefused(
      'ambiguous-plan',
      `${String(candidates.length)} value plans match order ${criteria.orderId} for payment ` +
        `${criteria.paymentId}. Refusing rather than picking one: the wrong choice posts real ` +
        'value against the wrong obligation and leaves no record that a choice was made',
    );
  }
  return candidates[0] ?? null;
}

/**
 * The external leg this payment settles.
 *
 * A leg that already names this payment wins outright. Failing that, exactly one unposted external
 * leg is unambiguous and is taken; more than one is not, and is refused.
 */
function selectLeg(external: readonly ValueLeg[], paymentId: string): ValueLeg | null {
  const named = external.find(
    (leg) => leg.externalReference === paymentId && leg.status !== 'posted',
  );
  if (named !== undefined) return named;

  const unposted = external.filter(
    (leg) => leg.status !== 'posted' && leg.status !== 'reversed' && leg.externalReference === null,
  );
  if (unposted.length === 0) return null;
  if (unposted.length > 1) {
    throw new SettlementRefused(
      'ambiguous-leg',
      `${String(unposted.length)} unposted external legs could be settled by payment ${paymentId}, ` +
        'and nothing distinguishes them. A leg carries the payment that settles it precisely so ' +
        'this is answerable; refusing leaves a dead-lettered row somebody must look at',
    );
  }
  return unposted[0] ?? null;
}

/** A required string from an event payload. Events are data, and a malformed one is a refusal. */
function readString(payload: unknown, field: string): string {
  const value = (payload as Record<string, unknown>)[field];
  if (typeof value !== 'string' || value === '') {
    throw new SettlementRefused(
      'malformed-event',
      `"${field}" is missing from the payment.captured payload, or is not a string`,
    );
  }
  return value;
}

/**
 * A required amount, as minor units.
 *
 * Read from a string, because that is how M-12 publishes it: a JSON number is a double, and a
 * double cannot hold 9007199254740993 minor units — which for a satoshi-scaled asset is not
 * hypothetical.
 */
function readAmount(payload: unknown, field: string): bigint {
  const value = readString(payload, field);
  if (!/^[0-9]+$/.test(value)) {
    throw new SettlementRefused(
      'malformed-event',
      `"${field}" is "${value}", which is not a non-negative integer in minor units`,
    );
  }
  return BigInt(value);
}
