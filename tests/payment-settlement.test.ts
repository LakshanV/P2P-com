/**
 * Joining the two halves of the transaction spine: a captured payment settles its value plan.
 *
 * Until this consumer existed, M-12 could take money and M-13 could route value across rewards,
 * merchant credit and cash, each proven against a real database, and **nothing connected them**. A
 * captured payment left its plan at `committed` for ever, so the platform could charge somebody and
 * never record that the obligation had been met. That is the single most valuable join in the
 * repository and it was missing, which is why this suite is weighted towards the ways it could go
 * wrong rather than the way it goes right.
 *
 * Nothing here fabricates an event payload. Every test drives a **real M-12 capture** and then lifts
 * the `payment.captured` row out of M-12's **own outbox**, exactly where the relay would find it, so
 * the fields the handler reads are the fields M-12 actually publishes. A consumer tested against a
 * hand-written payload agrees with the test author rather than with the producer, and the first live
 * event is where that gets discovered.
 *
 * The cases that matter are the refusals. Settling the wrong leg leaves no record that a choice was
 * made and a wrong balance that reconciles to nothing; a dead-lettered delivery leaves a row an
 * operator must look at. Between those two, the second is always correct.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  FinancialLedgerService,
  InMemoryFinancialLedgerRepository,
  K10LedgerPort,
  type AllocationLeg,
} from '../modules/financial-ledger/index.ts';
import { InMemoryLedgerRepository, LedgerService } from '../kernel/ledger-foundation/index.ts';
import {
  InMemoryPaymentRepository,
  PAYMENT_CAPTURED_EVENT,
  PaymentService,
  resolveMockProvider,
} from '../modules/payments/index.ts';
import type { HandlerContext } from '../kernel/event-infrastructure/index.ts';
import {
  PAYMENT_SETTLEMENT_SUBSCRIPTION,
  PAYMENT_SETTLEMENT_SUBSCRIPTION_DEFINITION,
  paymentSettlementHandler,
  settlementAssets,
  SettlementRefused,
  type SettlementOutcome,
} from '../apps/api/consumers/payment-settlement.ts';

const BUYER = 'acct_01HR0SETbuyer01';
const SELLER = 'acct_01HR0SETsellr01';
const ORDER = 'ord_01HR0SETorder01';
const NOW = '2026-07-01T09:00:00.000000Z';

/** The K-10 asset type LKR settles into. A deployment fact, declared rather than guessed. */
const ASSETS = settlementAssets({ 'LKR:2': 'lkr_cash' });

interface Harness {
  readonly ledger: FinancialLedgerService;
  readonly payments: PaymentService;
  readonly paymentRepository: InMemoryPaymentRepository;
  readonly journal: LedgerService;
  readonly wallets: Record<string, string>;
  readonly outcomes: SettlementOutcome[];
  readonly handle: (context: HandlerContext) => Promise<void>;
}

async function build(): Promise<Harness> {
  const journal = new LedgerService(new InMemoryLedgerRepository());
  for (const [assetTypeId, symbol] of [
    ['lkr_cash', 'LKR'],
    ['jaya_reward', 'JAYAREWARD'],
  ] as const) {
    await journal.registerAssetType({
      assetTypeId,
      assetClass: assetTypeId === 'lkr_cash' ? 'fiat' : 'reward',
      symbol,
      precision: assetTypeId === 'lkr_cash' ? 2 : 0,
      transferability: assetTypeId === 'lkr_cash',
      withdrawability: assetTypeId === 'lkr_cash',
      valuationSource: 'fixed',
      issuer: 'iss_01HR0SETjayaplt',
      unit: assetTypeId === 'lkr_cash' ? 'rupee' : 'point',
      redeemable: true,
      convertible: false,
      expiryDays: null,
      restrictions: {},
      custodyProvider: null,
      jurisdiction: 'LK',
    });
  }

  const ledger = new FinancialLedgerService(
    new InMemoryFinancialLedgerRepository(),
    new K10LedgerPort(journal),
  );

  const wallets: Record<string, string> = {};
  const specs = [
    // The payer's settlement position, and M-13 refuses to post an external leg without it: value
    // arriving from outside has to land somewhere before it can be paid onward, and a posting with
    // only one side is not a posting.
    ['buyerSettlement', BUYER, 'lkr_cash', 'settlement'],
    ['sellerCash', SELLER, 'lkr_cash', 'earnings'],
    ['buyerRewards', BUYER, 'jaya_reward', 'spending'],
    ['sellerRewards', SELLER, 'jaya_reward', 'earnings'],
  ] as const;
  let index = 0;
  for (const [name, owner, assetTypeId, purpose] of specs) {
    index += 1;
    const opened = await ledger.openWallet({
      walletId: `wal_01HR0SET${String(index).padStart(6, '0')}`,
      ownerAccountId: owner,
      assetTypeId,
      purpose,
      ledgerAccountId: `lac_01HR0SET${String(index).padStart(6, '0')}`,
      normalBalance: 'credit',
      openedAt: NOW,
      correlationId: 'corr_01HR0SETsetup01',
      idempotencyKey: `idem_01HR0SETw${String(index).padStart(5, '0')}`,
    });
    wallets[name] = opened.wallet.walletId;
  }

  const paymentRepository = new InMemoryPaymentRepository();
  const payments = new PaymentService(paymentRepository, resolveMockProvider);
  const outcomes: SettlementOutcome[] = [];
  return {
    ledger,
    journal,
    payments,
    paymentRepository,
    wallets,
    outcomes,
    handle: paymentSettlementHandler({
      ledger,
      assets: ASSETS,
      observe: (outcome) => outcomes.push(outcome),
    }),
  };
}

/** A plan against the order, with one external leg for cash and optionally an internal reward leg. */
async function aPlan(
  harness: Harness,
  options: {
    readonly planId: string;
    readonly targetMinor: string;
    readonly externalMinor: string;
    readonly internalMinor?: string;
    readonly obligationId?: string;
  },
): Promise<{ planId: string; externalLegId: string }> {
  const tag = options.planId.slice(4);
  const externalLegId = `leg_${tag}ext`;
  const internalLegId = `leg_${tag}int`;

  const legs: AllocationLeg[] = [
    {
      legId: externalLegId,
      kind: 'external',
      assetTypeId: 'lkr_cash',
      // Null because the value comes from outside the platform. That is the whole difference
      // between an external leg and an internal one.
      sourceWalletId: null,
      destinationWalletId: harness.wallets.sellerCash ?? '',
      amountMinor: BigInt(options.externalMinor),
      rate: { numerator: 1n, denominator: 1n },
      settlementEquivalentMinor: BigInt(options.externalMinor),
      idempotencyKey: `idem_${tag}extleg`,
    },
  ];
  if (options.internalMinor !== undefined) {
    legs.push({
      legId: internalLegId,
      kind: 'internal',
      assetTypeId: 'jaya_reward',
      sourceWalletId: harness.wallets.buyerRewards ?? '',
      destinationWalletId: harness.wallets.sellerRewards ?? '',
      amountMinor: BigInt(options.internalMinor),
      rate: { numerator: 1n, denominator: 1n },
      settlementEquivalentMinor: BigInt(options.internalMinor),
      idempotencyKey: `idem_${tag}intleg`,
    });
  }

  const allocated = await harness.ledger.allocatePlan({
    planId: options.planId,
    obligationId: options.obligationId ?? ORDER,
    obligationKind: 'order',
    payerAccountId: BUYER,
    payeeAccountId: SELLER,
    settlementAssetTypeId: 'lkr_cash',
    targetAmountMinor: BigInt(options.targetMinor),
    legs,
    allocatedAt: NOW,
    correlationId: 'corr_01HR0SETplan001',
    idempotencyKey: `idem_${tag}alloc`,
    eventId: `evt_${tag}alloc`,
  });

  // Only the internal legs post at commit. The external one is precisely what this suite is about:
  // it waits for money that has not arrived yet.
  await harness.ledger.commitPlan({
    planId: options.planId,
    postings:
      options.internalMinor === undefined
        ? []
        : [{ legId: internalLegId, ledgerTransactionId: `ltx_${tag}int` }],
    committedAt: NOW,
    correlationId: 'corr_01HR0SETplan001',
    idempotencyKey: `idem_${tag}commit`,
    eventId: `evt_${tag}commit`,
  });

  return { planId: allocated.plan.planId, externalLegId };
}

/**
 * Capture a real payment and hand back the delivery context K-08 would produce for it.
 *
 * The payload is lifted out of **M-12's own outbox**, exactly as the relay would find it. Nothing
 * here writes the payload by hand: a consumer tested against a hand-written payload agrees with the
 * test author rather than with the producer, and the first live event is where that gets discovered.
 */
async function aCapture(
  harness: Harness,
  options: {
    readonly paymentId: string;
    readonly amountMinor: string;
    readonly captureMinor?: string;
    readonly orderId?: string;
    readonly idempotencyKey?: string;
  },
): Promise<HandlerContext> {
  const suffix = options.paymentId.slice(4);
  await harness.payments.requestPayment({
    paymentId: options.paymentId,
    orderId: options.orderId ?? ORDER,
    payerAccountId: BUYER,
    payeeAccountId: SELLER,
    provider: 'mock',
    rail: 'card',
    instrumentToken: 'tok_01HR0SETgood01',
    assetCode: 'LKR',
    assetScale: 2,
    amountMinor: BigInt(options.amountMinor),
    requestedAt: NOW,
    correlationId: 'corr_01HR0SETpay0001',
    idempotencyKey: `idem_${suffix}req`,
  });

  await harness.payments.authorisePayment({
    paymentId: options.paymentId,
    attemptId: `pat_${suffix}auth`,
    attemptedAt: NOW,
    correlationId: 'corr_01HR0SETpay0001',
    idempotencyKey: `idem_${suffix}auth`,
  });

  await harness.payments.capturePayment({
    paymentId: options.paymentId,
    attemptId: `pat_${suffix}cap`,
    amountMinor: BigInt(options.captureMinor ?? options.amountMinor),
    attemptedAt: NOW,
    correlationId: 'corr_01HR0SETpay0001',
    idempotencyKey: `idem_${suffix}cap`,
  });

  return deliveryOf(harness, options.paymentId, options.idempotencyKey);
}

/**
 * The `payment.captured` row M-12 wrote to its own outbox, dressed as a K-08 delivery.
 *
 * This is what the relay picks up and what K-08 fans out, so what the handler is handed here is
 * byte-for-byte what it will be handed in production.
 */
function deliveryOf(harness: Harness, paymentId: string, idempotencyKey?: string): HandlerContext {
  const suffix = paymentId.slice(4);

  // M-12 writes a K-08 publish request into its outbox, so the business fields sit one level down
  // under `payload.payload`. Reaching for them here rather than reconstructing them is the point:
  // if M-12 renames a field, this breaks, which is exactly what should happen.
  const published = harness.paymentRepository
    .outbox()
    .entries()
    .map((candidate) => candidate.payload as PublishedEvent)
    .find(
      (candidate) =>
        candidate.type === PAYMENT_CAPTURED_EVENT.type &&
        candidate.payload.payment_id === paymentId,
    );
  assert.ok(
    published !== undefined,
    `M-12 published no ${PAYMENT_CAPTURED_EVENT.type} for ${paymentId}`,
  );

  return {
    envelope: {
      eventId: published.eventId,
      type: published.type,
      schemaVersion: published.schemaVersion,
      occurredAt: published.occurredAt,
      recordedAt: published.recordedAt,
      producer: published.producer,
      correlationId: published.correlationId,
      causationId: null,
      payload: published.payload,
      payloadFingerprint: 'a'.repeat(64),
      idempotencyKey: published.idempotencyKey,
      origin: 'system',
    },
    subscription: PAYMENT_SETTLEMENT_SUBSCRIPTION,
    deliveryId: `del_${suffix}cap`,
    attempt: 1,
    idempotencyKey: idempotencyKey ?? `idem_delivery_${suffix}`,
  };
}

/** The publish request M-12 puts in its outbox, as much of it as this suite reads. */
interface PublishedEvent {
  readonly eventId: string;
  readonly type: string;
  readonly schemaVersion: number;
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly producer: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly payload: Record<string, string>;
}

// ---------------------------------------------------------------------------
// The join itself
// ---------------------------------------------------------------------------

test('a captured payment settles the external leg of its plan', async () => {
  const harness = await build();
  const { planId, externalLegId } = await aPlan(harness, {
    planId: 'pln_01HR0SETplan001',
    targetMinor: '250000',
    externalMinor: '250000',
  });

  const before = await harness.ledger.getPlan(planId);
  assert.equal(before.status, 'committed', 'a plan with an unsettled external leg waits');

  await harness.handle(
    await aCapture(harness, { paymentId: 'pay_01HR0SETpay0001', amountMinor: '250000' }),
  );

  const after = await harness.ledger.getPlan(planId);
  assert.equal(after.status, 'settled', 'the obligation is met once the money actually arrived');

  const leg = (await harness.ledger.listLegs(planId)).find((one) => one.legId === externalLegId);
  assert.equal(leg?.status, 'posted');
  assert.equal(
    leg?.externalReference,
    'pay_01HR0SETpay0001',
    'the leg names the payment that settled it, so the two can be reconciled without a join',
  );
  assert.ok(leg?.ledgerTransactionId !== null, 'and a K-10 transaction actually moved the value');

  assert.deepEqual(harness.outcomes, [
    {
      kind: 'settled',
      planId,
      legId: externalLegId,
      paymentId: 'pay_01HR0SETpay0001',
    },
  ]);
});

test('a mixed-value purchase settles its cash leg without disturbing the rewards it already posted', async () => {
  // The case the whole multi-value model exists for: rewards move at commit, cash moves when the
  // gateway says so, and the obligation is met only when both have.
  const harness = await build();
  const { planId } = await aPlan(harness, {
    planId: 'pln_01HR0SETplan002',
    targetMinor: '250000',
    externalMinor: '150000',
    internalMinor: '100000',
  });

  const midway = await harness.ledger.getCoverage(planId);
  assert.equal(String(midway.postedMinor), '100000', 'the rewards posted at commit');
  assert.equal(midway.fullySettled, false);

  await harness.handle(
    await aCapture(harness, { paymentId: 'pay_01HR0SETpay0002', amountMinor: '150000' }),
  );

  const coverage = await harness.ledger.getCoverage(planId);
  assert.equal(String(coverage.postedMinor), '250000');
  assert.equal(coverage.fullySettled, true);
  assert.equal((await harness.ledger.getPlan(planId)).status, 'settled');
});

test('a redelivered capture settles once, not twice', async () => {
  // At-least-once delivery is the contract, so this is the normal case rather than an exotic one.
  // K-08 holds the idempotency key stable across redeliveries, every identifier is derived from it,
  // and M-13's own idempotency turns the repeat into a replay rather than a second transaction.
  const harness = await build();
  const { planId } = await aPlan(harness, {
    planId: 'pln_01HR0SETplan003',
    targetMinor: '250000',
    externalMinor: '250000',
  });

  const context = await aCapture(harness, {
    paymentId: 'pay_01HR0SETpay0003',
    amountMinor: '250000',
  });

  await harness.handle(context);
  await harness.handle(context);
  await harness.handle(context);

  const posted = (await harness.ledger.listLegs(planId)).filter((leg) => leg.status === 'posted');
  assert.equal(posted.length, 1);

  const coverage = await harness.ledger.getCoverage(planId);
  assert.equal(
    String(coverage.postedMinor),
    '250000',
    'three deliveries of one capture must not post three times the value',
  );

  assert.deepEqual(
    harness.outcomes.map((outcome) => outcome.kind),
    ['settled', 'already-settled', 'already-settled'],
    'and the repeats are reported as repeats rather than as fresh settlements',
  );
});

// ---------------------------------------------------------------------------
// The refusals
// ---------------------------------------------------------------------------

test('a partial capture does not settle a leg it does not cover', async () => {
  // M-12 permits a partial capture, and settling a 250,000 leg against a 150,000 capture would post
  // value the platform never received. Refusing leaves the plan committed and short, which is true.
  const harness = await build();
  await aPlan(harness, {
    planId: 'pln_01HR0SETplan004',
    targetMinor: '250000',
    externalMinor: '250000',
  });

  const context = await aCapture(harness, {
    paymentId: 'pay_01HR0SETpay0004',
    amountMinor: '250000',
    captureMinor: '150000',
  });

  await assert.rejects(harness.handle(context), (error: unknown) => {
    assert.ok(error instanceof SettlementRefused);
    assert.equal(error.code, 'capture-does-not-cover-leg');
    return true;
  });

  const plan = await harness.ledger.getPlan('pln_01HR0SETplan004');
  assert.equal(plan.status, 'committed', 'the obligation is still outstanding, and says so');
});

test('the consumer is never asked to choose between plans, because M-13 refuses to create the second', async () => {
  // The consumer refuses rather than guesses when two plans match an order. That branch turns out
  // to be unreachable through M-13's public surface, and this test is why: an obligation may hold
  // at most one plan that has not been cancelled, so the choice cannot arise.
  //
  // The guard stays. `FinancialLedgerService` is reached through a port, the invariant belongs to
  // M-13 rather than to the consumer, and a consumer that would silently pick one of two plans is
  // a consumer that becomes wrong the moment that invariant is relaxed. Documenting where the
  // invariant actually lives is worth more than deleting the branch.
  const harness = await build();
  await aPlan(harness, {
    planId: 'pln_01HR0SETplan005',
    targetMinor: '250000',
    externalMinor: '250000',
    obligationId: 'ord_01HR0SETsplit01',
  });

  await assert.rejects(
    aPlan(harness, {
      planId: 'pln_01HR0SETplan006',
      targetMinor: '250000',
      externalMinor: '250000',
      obligationId: 'ord_01HR0SETsplit01',
    }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'duplicate-plan-id');
      return true;
    },
  );

  // And the one plan that does exist settles, so the invariant is not achieved by refusing
  // everything.
  await harness.handle(
    await aCapture(harness, {
      paymentId: 'pay_01HR0SETpay0006',
      amountMinor: '250000',
      orderId: 'ord_01HR0SETsplit01',
    }),
  );
  assert.equal((await harness.ledger.getPlan('pln_01HR0SETplan005')).status, 'settled');
});

test('a payment in an asset with no declared K-10 type is refused, not string-matched', async () => {
  // `LKR` and `lkr_cash` are different vocabularies that happen to describe the same thing. A
  // consumer that assumed the payment's asset code *is* the asset type id would work for exactly
  // the cases somebody tested and post the wrong unit for the rest.
  const harness = await build();
  await aPlan(harness, {
    planId: 'pln_01HR0SETplan007',
    targetMinor: '250000',
    externalMinor: '250000',
  });

  const handle = paymentSettlementHandler({
    ledger: harness.ledger,
    assets: settlementAssets({}),
  });

  await assert.rejects(
    handle(await aCapture(harness, { paymentId: 'pay_01HR0SETpay0007', amountMinor: '250000' })),
    (error: unknown) => {
      assert.ok(error instanceof SettlementRefused);
      assert.equal(error.code, 'undeclared-settlement-asset');
      return true;
    },
  );
});

test('a capture for an order with no value plan is a reported no-op, not a dead letter', async () => {
  // A plain fiat sale has a payment and no plan. Dead-lettering those would bury the real failures
  // in noise — but returning silently would make a settlement that does nothing indistinguishable
  // from one that failed, so it is reported.
  const harness = await build();

  await harness.handle(
    await aCapture(harness, {
      paymentId: 'pay_01HR0SETpay0008',
      amountMinor: '250000',
      orderId: 'ord_01HR0SETnoplan1',
    }),
  );

  assert.deepEqual(harness.outcomes, [
    { kind: 'no-plan', orderId: 'ord_01HR0SETnoplan1', paymentId: 'pay_01HR0SETpay0008' },
  ]);
});

test('a malformed payload is refused with the field named', async () => {
  const harness = await build();
  const context = await aCapture(harness, {
    paymentId: 'pay_01HR0SETpay0009',
    amountMinor: '250000',
  });

  const broken = {
    ...context,
    envelope: {
      ...context.envelope,
      payload: { ...context.envelope.payload, captured_minor: '2,500.00' },
    },
  } as HandlerContext;

  await assert.rejects(harness.handle(broken), (error: unknown) => {
    assert.ok(error instanceof SettlementRefused);
    assert.equal(error.code, 'malformed-event');
    assert.match(error.message, /captured_minor/);
    return true;
  });
});

test('the payload the handler reads is the payload M-12 writes', () => {
  // The point of building every fixture through `makeAttemptEvent`: a consumer tested against a
  // hand-written payload agrees with the test author rather than with the producer, and the first
  // live event is where that gets discovered.
  const fields = [
    'payment_id',
    'order_id',
    'payer_account_id',
    'payee_account_id',
    'asset_code',
    'asset_scale',
    'captured_minor',
  ];
  const source = readFileSync(new URL('../modules/payments/outbox.ts', import.meta.url), 'utf8');
  for (const field of fields) {
    assert.ok(
      source.includes(`${field}:`),
      `${field} is read by the settlement consumer and is not published by M-12`,
    );
  }
});

test('the subscription is declared against the event M-12 actually publishes', () => {
  // K-08 refuses a subscription to an unregistered type, so this would fail loudly at startup rather
  // than quietly at runtime. It is asserted here anyway because the failure mode if it ever stopped
  // being true — a consumer subscribed to an event nobody sends — looks exactly like a system with
  // no payments in it.
  assert.deepEqual(
    [...PAYMENT_SETTLEMENT_SUBSCRIPTION_DEFINITION.types],
    [PAYMENT_CAPTURED_EVENT.type],
  );
  assert.equal(
    PAYMENT_SETTLEMENT_SUBSCRIPTION_DEFINITION.subscription,
    PAYMENT_SETTLEMENT_SUBSCRIPTION,
  );
  assert.equal(
    PAYMENT_SETTLEMENT_SUBSCRIPTION_DEFINITION.owner,
    'apps/api',
    'M-13 does not subscribe to anything: it cannot, without knowing M-12 exists. The application ' +
      'subscribes on its behalf, and that is what keeps the two modules apart',
  );
});
