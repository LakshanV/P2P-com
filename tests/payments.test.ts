/**
 * M-12 Payments — service behaviour.
 *
 * A payment module is judged on what it does when things go wrong, so most of this suite is the
 * unhappy path: the duplicate request, the duplicate capture, the double refund, the provider that
 * never answers, the webhook delivered twice and the webhook delivered out of order.
 *
 * Four properties carry the module.
 *
 * **Every operation is idempotent by key.** A retried request, capture or refund reports what
 * already happened rather than doing it again. This is not a convenience: a crashed process that
 * retries is indistinguishable from a user pressing the button twice, and both must cost the payer
 * once.
 *
 * **A timeout is not a failure.** A decline is a definite answer and the payment fails; a timeout
 * says nothing about whether the money moved, so the payment stays where it was and the operation
 * can be retried under the same key.
 *
 * **The record survives the refusal.** When a provider call happened, its attempt row is written
 * even if the payment could not then be moved — otherwise money leaves with nothing written down.
 *
 * **No instrument is ever stored.** A request carrying a PAN, a CVV or an IBAN is refused by name.
 *
 * Live-PostgreSQL properties are in `tests/integration/payments.integration.ts`.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  FOREIGN_FIELDS,
  INDETERMINATE_FAILURES,
  INTERNAL_VALUE_CODES,
  PAYMENT_STATUSES,
  PAYMENT_TRANSITIONS,
  PaymentError,
  PaymentService,
  InMemoryPaymentRepository,
  type PaymentProvider,
  type ProviderRequest,
  type ProviderResult,
} from '../modules/payments/index.ts';

import {
  PAYER,
  TOKEN_CAPTURE_TIMEOUT,
  TOKEN_DECLINE,
  TOKEN_REFUND_DECLINE,
  TOKEN_TIMEOUT,
  authorised,
  authoriseRequest,
  cancelRequest,
  captureRequest,
  captured,
  entriesOfKind,
  eventTypes,
  lastEventPayload,
  refundRequest,
  requestPayment,
  webhookRequest,
  build,
} from './helpers/payments-fixtures.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODULE_DIR = path.join(REPO_ROOT, 'modules', 'payments');

/** The refusal code, or a rethrow when it is not one of M-12's. */
const codeOf = async (body: () => Promise<unknown>): Promise<string> => {
  try {
    await body();
  } catch (error) {
    if (error instanceof PaymentError) return error.code;
    throw error;
  }
  throw new Error('expected a refusal, and the call succeeded');
};

// ---------------------------------------------------------------------------
// The state machine
// ---------------------------------------------------------------------------

test('every status has a transition list, and three of them are terminal', () => {
  for (const status of PAYMENT_STATUSES) {
    assert.ok(
      Array.isArray(PAYMENT_TRANSITIONS[status]),
      `${status} has no declared transitions, so nothing can say whether a move from it is legal`,
    );
  }
  assert.deepEqual(PAYMENT_TRANSITIONS.refunded, []);
  assert.deepEqual(PAYMENT_TRANSITIONS.failed, []);
  assert.deepEqual(PAYMENT_TRANSITIONS.cancelled, []);
});

test('a payment starts requiring authorisation and holds nothing captured', async () => {
  const harness = build();
  const request = requestPayment();
  const { payment, replayed } = await harness.service.requestPayment(request);

  assert.equal(replayed, false);
  assert.equal(payment.status, 'requires-authorisation');
  assert.equal(payment.capturedMinor, 0n);
  assert.equal(payment.refundedMinor, 0n);
  assert.equal(payment.providerReference, null);
  assert.equal(payment.amountMinor, request.amountMinor);
});

test('authorise reserves value without taking it', async () => {
  const harness = build();
  const paymentId = await authorised(harness);
  const payment = await harness.service.getPayment(paymentId);

  assert.equal(payment.status, 'authorised');
  assert.equal(payment.capturedMinor, 0n, 'authorisation reserves; it does not capture');
  assert.notEqual(payment.providerReference, null, 'the reference is what reconciliation needs');
  assert.equal(payment.authorisedAt, '2026-07-01T09:05:00Z');
});

test('capture is where value actually moves', async () => {
  const harness = build();
  const paymentId = await captured(harness);
  const payment = await harness.service.getPayment(paymentId);

  assert.equal(payment.status, 'captured');
  assert.equal(payment.capturedMinor, 1_000_000n);
  assert.equal(payment.capturedAt, '2026-07-01T09:10:00Z');
});

test('a capture before authorisation is refused', async () => {
  const harness = build();
  const request = requestPayment();
  await harness.service.requestPayment(request);

  assert.equal(
    await codeOf(() => harness.service.capturePayment(captureRequest(request.paymentId))),
    'illegal-transition',
  );
});

test('an authorise on an already authorised payment is refused', async () => {
  const harness = build();
  const paymentId = await authorised(harness);

  assert.equal(
    await codeOf(() => harness.service.authorisePayment(authoriseRequest(paymentId))),
    'illegal-transition',
  );
});

test('a terminal payment refuses every further movement', async () => {
  const harness = build();
  const paymentId = await authorised(harness);
  await harness.service.cancelPayment(cancelRequest(paymentId));

  assert.equal(
    await codeOf(() => harness.service.capturePayment(captureRequest(paymentId))),
    'payment-terminal',
  );
});

// ---------------------------------------------------------------------------
// Idempotency: the same operation twice
// ---------------------------------------------------------------------------

test('a duplicate payment request returns the first payment and creates nothing', async () => {
  const harness = build();
  const request = requestPayment();

  const first = await harness.service.requestPayment(request);
  const second = await harness.service.requestPayment(request);

  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.equal(second.payment.paymentId, first.payment.paymentId);
  assert.equal(harness.repository.payments().length, 1);
  assert.equal(
    entriesOfKind(harness.repository, 'event').length,
    1,
    'a replay must not publish a second payment.requested; a consumer would act on it twice',
  );
});

test('a different request under a used key is refused rather than quietly replayed', async () => {
  const harness = build();
  const request = requestPayment();
  await harness.service.requestPayment(request);

  assert.equal(
    await codeOf(() =>
      harness.service.requestPayment({
        ...request,
        paymentId: 'pay_01HR0PRother1',
        amountMinor: 5_000_000n,
      }),
    ),
    'idempotency-key-reuse',
    'returning the earlier payment would tell the caller their new amount had been accepted',
  );
});

test('a duplicate capture takes the money once', async () => {
  const harness = build();
  const paymentId = await authorised(harness);
  const request = captureRequest(paymentId);

  const first = await harness.service.capturePayment(request);
  const second = await harness.service.capturePayment(request);

  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.equal(second.attempt.attemptId, first.attempt.attemptId);

  const payment = await harness.service.getPayment(paymentId);
  assert.equal(payment.capturedMinor, 1_000_000n, 'the second capture must not add to the total');
  const attempts = await harness.service.listAttempts(paymentId);
  assert.equal(attempts.filter((attempt) => attempt.kind === 'capture').length, 1);
});

test('a key used for a capture cannot then be used for a refund', async () => {
  const harness = build();
  const paymentId = await authorised(harness);
  const capture = captureRequest(paymentId);
  await harness.service.capturePayment(capture);

  assert.equal(
    await codeOf(() =>
      harness.service.refundPayment(
        refundRequest(paymentId, { idempotencyKey: capture.idempotencyKey }),
      ),
    ),
    'idempotency-key-reuse',
  );
});

test('a restarted process replays rather than repeats', async () => {
  // A crash between the provider call and the caller receiving the answer is indistinguishable
  // from a user pressing the button twice. Both retry, and both must cost the payer once.
  const harness = build();
  const paymentId = await authorised(harness);
  const capture = captureRequest(paymentId);
  await harness.service.capturePayment(capture);

  // The "restarted" process holds the same repository and reissues the identical request.
  const restarted = new PaymentService(
    harness.repository,
    (await import('../modules/payments/index.ts')).resolveMockProvider,
  );
  const replay = await restarted.capturePayment(capture);

  assert.equal(replay.replayed, true);
  assert.equal((await harness.service.getPayment(paymentId)).capturedMinor, 1_000_000n);
});

// ---------------------------------------------------------------------------
// Refunds
// ---------------------------------------------------------------------------

test('a full refund closes the payment', async () => {
  const harness = build();
  const paymentId = await captured(harness);
  const { payment, refund } = await harness.service.refundPayment(refundRequest(paymentId));

  assert.equal(payment.status, 'refunded');
  assert.equal(payment.refundedMinor, 1_000_000n);
  assert.equal(refund.amountMinor, 1_000_000n);
});

test('a partial refund leaves the payment partially refunded', async () => {
  const harness = build();
  const paymentId = await captured(harness);
  const { payment } = await harness.service.refundPayment(
    refundRequest(paymentId, { amountMinor: 400_000n }),
  );

  assert.equal(payment.status, 'partially-refunded');
  assert.equal(payment.refundedMinor, 400_000n);
});

test('a second partial refund adds up, and the last one closes the payment', async () => {
  const harness = build();
  const paymentId = await captured(harness);
  await harness.service.refundPayment(refundRequest(paymentId, { amountMinor: 400_000n }));
  const second = await harness.service.refundPayment(
    refundRequest(paymentId, { amountMinor: 250_000n }),
  );
  assert.equal(second.payment.status, 'partially-refunded');
  assert.equal(second.payment.refundedMinor, 650_000n);

  const third = await harness.service.refundPayment(
    refundRequest(paymentId, { amountMinor: 350_000n }),
  );
  assert.equal(third.payment.status, 'refunded');
  assert.equal(third.payment.refundedMinor, 1_000_000n);
  assert.equal((await harness.service.listRefunds(paymentId)).length, 3);
});

test('the same refund submitted twice returns the money once', async () => {
  const harness = build();
  const paymentId = await captured(harness);
  const request = refundRequest(paymentId, { amountMinor: 400_000n });

  const first = await harness.service.refundPayment(request);
  const second = await harness.service.refundPayment(request);

  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.equal(second.refund.refundId, first.refund.refundId);
  assert.equal((await harness.service.getPayment(paymentId)).refundedMinor, 400_000n);
  assert.equal((await harness.service.listRefunds(paymentId)).length, 1);
});

test('a refund beyond what was captured is refused', async () => {
  const harness = build();
  const paymentId = await captured(harness);

  assert.equal(
    await codeOf(() =>
      harness.service.refundPayment(refundRequest(paymentId, { amountMinor: 1_000_001n })),
    ),
    'over-refund',
  );
});

test('partial refunds cannot creep past the captured total', async () => {
  const harness = build();
  const paymentId = await captured(harness);
  await harness.service.refundPayment(refundRequest(paymentId, { amountMinor: 900_000n }));

  assert.equal(
    await codeOf(() =>
      harness.service.refundPayment(refundRequest(paymentId, { amountMinor: 200_000n })),
    ),
    'over-refund',
    'the check is against the stored total, not against this request alone',
  );
});

test('an uncaptured payment cannot be refunded', async () => {
  const harness = build();
  const paymentId = await authorised(harness);

  assert.equal(
    await codeOf(() => harness.service.refundPayment(refundRequest(paymentId))),
    'illegal-transition',
  );
});

test('a refund the provider refuses writes the attempt and no refund row', async () => {
  const harness = build();
  const paymentId = await captured(harness, { instrumentToken: TOKEN_REFUND_DECLINE });

  assert.equal(
    await codeOf(() => harness.service.refundPayment(refundRequest(paymentId))),
    'provider-failed',
  );

  assert.deepEqual(
    await harness.service.listRefunds(paymentId),
    [],
    'no value came back, so nothing may be recorded as returned',
  );
  const attempts = await harness.service.listAttempts(paymentId);
  const refundAttempt = attempts.find((attempt) => attempt.kind === 'refund');
  assert.ok(refundAttempt, 'the call happened, so reconciliation must be able to see it');
  assert.equal(refundAttempt.outcome, 'failed');
  assert.equal((await harness.service.getPayment(paymentId)).refundedMinor, 0n);
});

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

test('an authorised payment can be cancelled', async () => {
  const harness = build();
  const paymentId = await authorised(harness);
  const { payment } = await harness.service.cancelPayment(cancelRequest(paymentId));

  assert.equal(payment.status, 'cancelled');
  assert.equal(payment.cancelledAt, '2026-07-01T09:12:00Z');
});

test('a captured payment is refunded, never cancelled', async () => {
  const harness = build();
  const paymentId = await captured(harness);

  assert.equal(
    await codeOf(() => harness.service.cancelPayment(cancelRequest(paymentId))),
    'illegal-transition',
    'the money has left the payer; the way back is a refund, which leaves a record of the return',
  );
});

// ---------------------------------------------------------------------------
// Amounts
// ---------------------------------------------------------------------------

test('a capture beyond the authorised amount is refused', async () => {
  const harness = build();
  const paymentId = await authorised(harness);

  assert.equal(
    await codeOf(() =>
      harness.service.capturePayment(captureRequest(paymentId, { amountMinor: 1_000_001n })),
    ),
    'over-capture',
  );
});

test('a capture of zero is refused', async () => {
  const harness = build();
  const paymentId = await authorised(harness);

  assert.equal(
    await codeOf(() =>
      harness.service.capturePayment(captureRequest(paymentId, { amountMinor: 0n })),
    ),
    'negative-amount',
  );
});

test('a payment of zero is refused', async () => {
  const harness = build();
  assert.equal(
    await codeOf(() => harness.service.requestPayment(requestPayment({ amountMinor: 0n }))),
    'negative-amount',
  );
});

test('amounts survive beyond the safe-integer range', async () => {
  const harness = build();
  const huge = 9_007_199_254_740_993n; // 2^53 + 1: a double cannot hold this
  const request = requestPayment({ amountMinor: huge });
  const { payment } = await harness.service.requestPayment(request);

  assert.equal(payment.amountMinor, huge);
  assert.equal(
    lastEventPayload(harness.repository).amount_minor,
    '9007199254740993',
    'the event carries the amount as a string; a consumer parsing a number would lose the last digit',
  );
});

// ---------------------------------------------------------------------------
// Providers: failure, timeout, and the difference between them
// ---------------------------------------------------------------------------

test('a declined authorisation fails the payment', async () => {
  const harness = build();
  const request = requestPayment({ instrumentToken: TOKEN_DECLINE });
  await harness.service.requestPayment(request);

  assert.equal(
    await codeOf(() => harness.service.authorisePayment(authoriseRequest(request.paymentId))),
    'provider-failed',
  );

  const payment = await harness.service.getPayment(request.paymentId);
  assert.equal(payment.status, 'failed');
  assert.equal(payment.failureCode, 'card-declined');
  assert.equal(payment.failedAt, '2026-07-01T09:05:00Z');
});

test('a timed-out authorisation leaves the payment exactly where it was', async () => {
  const harness = build();
  const request = requestPayment({ instrumentToken: TOKEN_TIMEOUT });
  await harness.service.requestPayment(request);

  assert.equal(
    await codeOf(() => harness.service.authorisePayment(authoriseRequest(request.paymentId))),
    'provider-failed',
  );

  const payment = await harness.service.getPayment(request.paymentId);
  assert.equal(
    payment.status,
    'requires-authorisation',
    'a timeout says nothing about whether the money moved; failing the payment here is how a ' +
      'platform charges somebody twice on the retry',
  );
  assert.equal(payment.failureCode, null);

  const attempts = await harness.service.listAttempts(request.paymentId);
  assert.equal(attempts.length, 1, 'the call happened and must be recorded');
  assert.equal(attempts[0]?.failureCode, 'provider-timeout');
});

test('a timed-out capture leaves the payment authorised and retryable', async () => {
  const harness = build();
  const paymentId = await authorised(harness, { instrumentToken: TOKEN_CAPTURE_TIMEOUT });

  assert.equal(
    await codeOf(() => harness.service.capturePayment(captureRequest(paymentId))),
    'provider-failed',
  );

  const payment = await harness.service.getPayment(paymentId);
  assert.equal(payment.status, 'authorised');
  assert.equal(payment.capturedMinor, 0n);
});

test('a capture retried after a timeout succeeds and captures once', async () => {
  // The sequence a real gateway produces: the first capture times out, the money may or may not
  // have moved, and the retry — which the provider recognises by idempotency key — comes back
  // successful. The payment must end up captured exactly once.
  let captures = 0;
  const flaky: PaymentProvider = {
    name: 'flaky',
    supportedRails: ['card'],
    supportedAssets: ['LKR'],
    authorise: (request: ProviderRequest): Promise<ProviderResult> =>
      Promise.resolve({
        outcome: 'succeeded',
        providerReference: `flaky_auth_${request.idempotencyKey}`,
        failureCode: null,
      }),
    capture: (request: ProviderRequest): Promise<ProviderResult> => {
      captures += 1;
      if (captures === 1) {
        return Promise.resolve({
          outcome: 'failed',
          providerReference: null,
          failureCode: 'provider-timeout',
        });
      }
      return Promise.resolve({
        outcome: 'succeeded',
        providerReference: `flaky_capture_${request.idempotencyKey}`,
        failureCode: null,
      });
    },
    cancel: (): Promise<ProviderResult> =>
      Promise.resolve({
        outcome: 'succeeded',
        providerReference: 'flaky_cancel',
        failureCode: null,
      }),
    refund: (): Promise<ProviderResult> =>
      Promise.resolve({
        outcome: 'succeeded',
        providerReference: 'flaky_refund',
        failureCode: null,
      }),
  };

  const repository = new InMemoryPaymentRepository();
  const service = new PaymentService(repository, () => flaky);
  const request = requestPayment({ provider: 'flaky' });
  await service.requestPayment(request);
  await service.authorisePayment(authoriseRequest(request.paymentId));

  assert.equal(
    await codeOf(() => service.capturePayment(captureRequest(request.paymentId))),
    'provider-failed',
  );
  const retried = await service.capturePayment(captureRequest(request.paymentId));

  assert.equal(retried.payment.status, 'captured');
  assert.equal(retried.payment.capturedMinor, 1_000_000n);
  assert.equal(captures, 2);
  assert.equal(
    (await service.listAttempts(request.paymentId)).filter((a) => a.kind === 'capture').length,
    2,
    'both calls are recorded: the timeout is exactly the row reconciliation needs',
  );
});

test('an adapter that throws is read as indeterminate, not as a decline', async () => {
  const exploding: PaymentProvider = {
    name: 'exploding',
    supportedRails: ['card'],
    supportedAssets: ['LKR'],
    authorise: () => Promise.reject(new Error('socket hang up')),
    capture: () => Promise.reject(new Error('socket hang up')),
    cancel: () => Promise.reject(new Error('socket hang up')),
    refund: () => Promise.reject(new Error('socket hang up')),
  };
  const repository = new InMemoryPaymentRepository();
  const service = new PaymentService(repository, () => exploding);
  const request = requestPayment({ provider: 'exploding' });
  await service.requestPayment(request);

  assert.equal(
    await codeOf(() => service.authorisePayment(authoriseRequest(request.paymentId))),
    'provider-failed',
  );
  const payment = await service.getPayment(request.paymentId);
  assert.equal(
    payment.status,
    'requires-authorisation',
    'a thrown adapter error tells M-12 nothing about whether the money moved',
  );
});

test('the indeterminate set is exactly the failures that say nothing about the money', () => {
  assert.deepEqual([...INDETERMINATE_FAILURES], ['provider-timeout', 'provider-unavailable']);
});

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

test('two concurrent captures capture once, and both calls are recorded', async () => {
  const harness = build();
  const paymentId = await authorised(harness);

  const outcomes = await Promise.allSettled([
    harness.service.capturePayment(captureRequest(paymentId)),
    harness.service.capturePayment(captureRequest(paymentId)),
  ]);

  const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
  assert.equal(fulfilled.length, 1, 'exactly one capture may move the payment');

  const payment = await harness.service.getPayment(paymentId);
  assert.equal(payment.capturedMinor, 1_000_000n);
  assert.equal(
    (await harness.service.listAttempts(paymentId)).filter((a) => a.kind === 'capture').length,
    2,
    'the loser called the provider too. Losing the attempt row would leave a possible movement ' +
      'with nothing written down',
  );
});

test('two concurrent partial refunds cannot both take effect', async () => {
  const harness = build();
  const paymentId = await captured(harness);
  await harness.service.refundPayment(refundRequest(paymentId, { amountMinor: 400_000n }));

  // Both read `partially-refunded` with 400,000 returned. The status alone is unchanged by either,
  // so only a guard that covers the running total can refuse the second.
  const outcomes = await Promise.allSettled([
    harness.service.refundPayment(refundRequest(paymentId, { amountMinor: 300_000n })),
    harness.service.refundPayment(refundRequest(paymentId, { amountMinor: 300_000n })),
  ]);

  assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
  assert.equal((await harness.service.getPayment(paymentId)).refundedMinor, 700_000n);
});

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

test('an unverified webhook is refused outright', async () => {
  const harness = build();
  assert.equal(
    await codeOf(() => harness.service.recordWebhook(webhookRequest({ signatureVerified: false }))),
    'unverified-webhook',
  );
  assert.deepEqual(harness.repository.receipts(), []);
});

test('a webhook can move a payment forward', async () => {
  const harness = build();
  const paymentId = await authorised(harness);

  const result = await harness.service.recordWebhook(
    webhookRequest({ paymentId, assertedStatus: 'captured', kind: 'charge.captured' }),
  );

  assert.equal(result.applied, true);
  assert.equal(result.payment?.status, 'captured');
  assert.equal(result.payment?.capturedMinor, 1_000_000n);
  assert.equal(result.receipt.processedAt, '2026-07-01T09:20:00Z');
});

test('the same provider event delivered twice takes effect once', async () => {
  const harness = build();
  const paymentId = await authorised(harness);
  const request = webhookRequest({ paymentId, assertedStatus: 'captured' });

  const first = await harness.service.recordWebhook(request);
  const second = await harness.service.recordWebhook({
    ...request,
    receiptId: 'whk_01HR0PWother',
    idempotencyKey: 'idem_hook_other',
  });

  assert.equal(first.applied, true);
  assert.equal(second.replayed, true);
  assert.equal(second.applied, false);
  assert.equal(second.receipt.receiptId, first.receipt.receiptId);
  assert.equal(harness.repository.receipts().length, 1);
});

test('an out-of-order webhook is recorded and ignored, not refused', async () => {
  const harness = build();
  const request = requestPayment();
  await harness.service.requestPayment(request);

  // `captured` before `authorised`: providers deliver out of order routinely.
  const result = await harness.service.recordWebhook(
    webhookRequest({ paymentId: request.paymentId, assertedStatus: 'captured' }),
  );

  assert.equal(result.applied, false);
  assert.equal(result.ignoredBecause, 'stale');
  assert.equal(result.payment?.status, 'requires-authorisation');
  assert.equal(
    result.receipt.processedAt,
    '2026-07-01T09:20:00Z',
    'it was dealt with, so the provider must not be left retrying it',
  );
});

test('a webhook describing the past leaves a refunded payment alone', async () => {
  const harness = build();
  const paymentId = await captured(harness);
  await harness.service.refundPayment(refundRequest(paymentId));

  const result = await harness.service.recordWebhook(
    webhookRequest({ paymentId, assertedStatus: 'captured' }),
  );

  assert.equal(result.applied, false);
  assert.equal(result.ignoredBecause, 'stale');
  assert.equal((await harness.service.getPayment(paymentId)).status, 'refunded');
});

test('a webhook for a payment M-12 does not know is kept as evidence', async () => {
  const harness = build();
  const result = await harness.service.recordWebhook(
    webhookRequest({ paymentId: 'pay_01HR0PWunknown', assertedStatus: 'captured' }),
  );

  assert.equal(result.applied, false);
  assert.equal(result.ignoredBecause, 'unknown-payment');
  assert.equal(harness.repository.receipts().length, 1);
});

test('a webhook payload is frozen all the way down', async () => {
  const harness = build();
  const result = await harness.service.recordWebhook(
    webhookRequest({ payload: { outer: { inner: 'value' } } }),
  );

  assert.ok(Object.isFrozen(result.receipt.payload));
  assert.ok(
    Object.isFrozen(result.receipt.payload.outer),
    'the payload is the evidence a dispute is reconstructed from; an editable copy could rewrite ' +
      'what the provider said',
  );
});

test('a webhook cannot assert more than the payment was authorised for', async () => {
  const harness = build();
  const paymentId = await authorised(harness);
  const result = await harness.service.recordWebhook(
    webhookRequest({ paymentId, assertedStatus: 'captured', assertedAmountMinor: 9_000_000n }),
  );

  assert.equal(result.payment?.capturedMinor, 1_000_000n);
});

// ---------------------------------------------------------------------------
// The multi-value guardrail
// ---------------------------------------------------------------------------

test('internally issued JAYA value can never be sent to a provider', async () => {
  const harness = build();
  for (const code of INTERNAL_VALUE_CODES) {
    assert.equal(
      await codeOf(() => harness.service.requestPayment(requestPayment({ assetCode: code }))),
      'internal-value-not-settleable',
      `${code} reached a provider adapter. No external counterparty settles it, and treating it ` +
        'as cash would convert a restricted credit into money',
    );
  }
});

test('a settlement asset need not be a three-letter fiat code', async () => {
  const harness = build();
  const request = requestPayment({
    assetCode: 'USDC',
    assetScale: 6,
    rail: 'digital-asset',
    amountMinor: 100_000_000n,
  });
  const { payment } = await harness.service.requestPayment(request);

  assert.equal(payment.assetCode, 'USDC');
  assert.equal(payment.assetScale, 6);
  assert.equal(
    lastEventPayload(harness.repository).asset_scale,
    '6',
    'the scale travels with the amount so a reader can render it without a registry lookup',
  );
});

test('a provider is refused a rail or asset it has not declared', async () => {
  const harness = build();

  assert.equal(
    await codeOf(() => harness.service.requestPayment(requestPayment({ assetCode: 'EUR' }))),
    'unsupported-settlement',
  );

  const narrow: PaymentProvider = {
    name: 'cards-only',
    supportedRails: ['card'],
    supportedAssets: ['LKR'],
    authorise: () =>
      Promise.resolve({ outcome: 'succeeded', providerReference: 'r', failureCode: null }),
    capture: () =>
      Promise.resolve({ outcome: 'succeeded', providerReference: 'r', failureCode: null }),
    cancel: () =>
      Promise.resolve({ outcome: 'succeeded', providerReference: 'r', failureCode: null }),
    refund: () =>
      Promise.resolve({ outcome: 'succeeded', providerReference: 'r', failureCode: null }),
  };
  const service = new PaymentService(new InMemoryPaymentRepository(), () => narrow);
  assert.equal(
    await codeOf(() =>
      service.requestPayment(requestPayment({ provider: 'cards-only', rail: 'bank-transfer' })),
    ),
    'unsupported-settlement',
  );
});

test('an unregistered provider is refused before anything is written', async () => {
  const harness = build();
  assert.equal(
    await codeOf(() => harness.service.requestPayment(requestPayment({ provider: 'stripe' }))),
    'unknown-provider',
  );
  assert.deepEqual(harness.repository.payments(), []);
});

// ---------------------------------------------------------------------------
// The instrument boundary
// ---------------------------------------------------------------------------

test('a request carrying an instrument is refused by name', async () => {
  const harness = build();
  const instruments = ['cardNumber', 'pan', 'cvv', 'expiryMonth', 'iban', 'cardholderName'];

  for (const field of instruments) {
    assert.ok(FOREIGN_FIELDS[field], `${field} is not named in the foreign-field table`);
    const carrying = { ...requestPayment(), [field]: '4111111111111111' };
    assert.equal(
      await codeOf(() => harness.service.requestPayment(carrying)),
      'foreign-concern',
      `${field} was accepted. A payment record outlives the transaction and is copied into every ` +
        'projection built from it',
    );
  }
});

test('an instrument token that looks like an instrument is refused', async () => {
  const harness = build();
  assert.equal(
    await codeOf(() =>
      harness.service.requestPayment(requestPayment({ instrumentToken: '4111111111111111' })),
    ),
    'malformed-token',
  );
  assert.equal(
    await codeOf(() =>
      harness.service.requestPayment(requestPayment({ instrumentToken: 'payer@example.com' })),
    ),
    'malformed-token',
  );
});

test('no source file mentions an instrument field', () => {
  const forbidden = ['cardNumber', 'cvv', 'expiryYear', 'cardholderName'];
  const offenders: string[] = [];
  for (const file of sourceFiles()) {
    const source = readFileSync(file.path, 'utf8');
    // The registry names them precisely in order to refuse them; everywhere else is a leak.
    if (file.name === 'registry.ts') continue;
    for (const field of forbidden) {
      if (source.includes(`${field}:`)) offenders.push(`${file.name}:${field}`);
    }
  }
  assert.deepEqual(offenders, []);
});

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

test('a full lifecycle publishes one event per fact, in order', async () => {
  const harness = build();
  const paymentId = await captured(harness);
  await harness.service.refundPayment(refundRequest(paymentId, { amountMinor: 400_000n }));

  assert.deepEqual(eventTypes(harness.repository), [
    'payment.requested',
    'payment.authorised',
    'payment.captured',
    'payment.refunded',
  ]);
});

test('outbox ids are unique across a full lifecycle', async () => {
  const harness = build();
  const paymentId = await captured(harness);
  await harness.service.refundPayment(refundRequest(paymentId, { amountMinor: 400_000n }));
  await harness.service.refundPayment(refundRequest(paymentId, { amountMinor: 600_000n }));

  const ids = harness.repository
    .outbox()
    .entries()
    .map((entry) => entry.outboxId);
  assert.equal(
    new Set(ids).size,
    ids.length,
    'two entries share an id, so the second would be refused by outbox_pkey. Ids derive from the ' +
      'attempt or refund, never from the payment id alone',
  );
});

test('every event carries the asset beside the amount', async () => {
  const harness = build();
  await captured(harness);

  for (const entry of entriesOfKind(harness.repository, 'event')) {
    const payload = (entry.payload as { payload: Record<string, unknown> }).payload;
    assert.equal(typeof payload.amount_minor, 'string');
    assert.equal(typeof payload.asset_code, 'string');
    assert.equal(
      typeof payload.asset_scale,
      'string',
      'an amount without its asset is a quantity with no unit, and the multi-value model cannot ' +
        'afford that',
    );
  }
});

test('a failed payment publishes why', async () => {
  const harness = build();
  const request = requestPayment({ instrumentToken: TOKEN_DECLINE });
  await harness.service.requestPayment(request);
  await assert.rejects(() => harness.service.authorisePayment(authoriseRequest(request.paymentId)));

  assert.equal(lastEventPayload(harness.repository).failure_code, 'card-declined');
});

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

test('payments can be found by order and by payer', async () => {
  const harness = build();
  const first = requestPayment();
  const second = requestPayment();
  await harness.service.requestPayment(first);
  await harness.service.requestPayment(second);

  assert.equal((await harness.service.listPaymentsForOrder(first.orderId)).length, 2);
  assert.equal((await harness.service.listPaymentsForPayer(PAYER)).length, 2);
});

test('an unknown payment is refused rather than reported as absent', async () => {
  const harness = build();
  assert.equal(
    await codeOf(() => harness.service.getPayment('pay_01HR0PZmissing')),
    'payment-not-found',
  );
});

// ---------------------------------------------------------------------------
// Atomicity, layering and determinism
// ---------------------------------------------------------------------------

test('a refused operation leaves no row and no outbox entry', async () => {
  const harness = build();
  await assert.rejects(() =>
    harness.service.requestPayment(requestPayment({ assetCode: 'JAYA_REWARD' })),
  );

  assert.deepEqual(harness.repository.payments(), []);
  assert.deepEqual(harness.repository.outbox().entries(), []);
});

test('M-12 imports no same-layer module and cannot reach the AI gateway', () => {
  const forbidden = [
    'modules/orders',
    'modules/financial-ledger',
    'modules/commission-rules',
    'modules/settlements',
    'modules/seller-payouts',
    'kernel/ai-gateway',
  ];
  for (const file of sourceFiles()) {
    const source = readFileSync(file.path, 'utf8');
    for (const target of forbidden) {
      assert.ok(
        !source.includes(`from '../../${target}`) && !source.includes(`from '../../../${target}`),
        `${file.name} imports ${target}. Same-layer modules communicate by event ` +
          '(MODULE_MAP §10.3), and a payment module that could reach the AI gateway would put AI ' +
          'in the financial authority path (MODULE_MAP §11, rule F-1) — a P0 defect',
      );
    }
  }
});

test('no gateway SDK is imported anywhere in the module', () => {
  const sdks = ['stripe', 'braintree', 'adyen', 'paypal', 'razorpay', 'payhere'];
  const offenders: string[] = [];
  for (const file of sourceFiles()) {
    const source = readFileSync(file.path, 'utf8').toLowerCase();
    for (const sdk of sdks) {
      if (source.includes(`from '${sdk}`) || source.includes(`require('${sdk}`)) {
        offenders.push(`${file.name}:${sdk}`);
      }
    }
  }
  assert.deepEqual(offenders, [], 'a gateway is reached through the port, never imported');
});

test('the module reads no clock and generates no randomness', () => {
  const offenders: string[] = [];
  for (const file of sourceFiles()) {
    const source = readFileSync(file.path, 'utf8');
    if (/\bDate\.now\b|\bnew Date\b|\bMath\.random\b|\bcrypto\.randomUUID\b/.test(source)) {
      offenders.push(file.name);
    }
  }
  assert.deepEqual(offenders, [], 'the caller supplies every identifier and every instant');
});

/** Every TypeScript file in the module, including the provider adapters. */
function sourceFiles(): readonly { readonly name: string; readonly path: string }[] {
  const files: { name: string; path: string }[] = [];
  for (const entry of readdirSync(MODULE_DIR, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const directory = path.join(MODULE_DIR, entry.name);
      for (const nested of readdirSync(directory).filter((name) => name.endsWith('.ts'))) {
        files.push({ name: `${entry.name}/${nested}`, path: path.join(directory, nested) });
      }
      continue;
    }
    if (entry.name.endsWith('.ts')) {
      files.push({ name: entry.name, path: path.join(MODULE_DIR, entry.name) });
    }
  }
  return files;
}
