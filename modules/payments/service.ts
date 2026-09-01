/**
 * M-12 Payments — service.
 *
 * The state machine, and the only place in the platform that speaks to a payment gateway.
 *
 * Three rules shape almost everything below.
 *
 * **A provider call happens outside a transaction.** Holding a database transaction open across a
 * network call to a gateway means a slow gateway holds locks on payment rows, and a gateway that
 * never answers holds them for ever. So each operation reads in one transaction, calls the provider
 * with no transaction open, and records the result in a second one.
 *
 * **The attempt is recorded even when the payment cannot move.** If the provider took the money and
 * the guarded update then finds the payment already changed underneath, throwing and rolling back
 * would leave money moved and nothing written down. The attempt row is committed first and the
 * refusal is raised after the commit, so the reconciliation trail always contains the call.
 *
 * **A timeout is not a failure.** A declined card is a definite answer: the money did not move, and
 * the payment fails. A timeout is the absence of an answer — the gateway may well have taken the
 * money — so the payment stays where it was and the operation can be retried under the same
 * idempotency key, which the provider recognises as the same operation rather than a second one.
 * Treating a timeout as a decline is how a platform charges somebody twice.
 *
 * Deterministic by construction: the caller supplies every identifier and every instant. Nothing
 * here reads a clock or generates randomness.
 *
 * Owned by: M-12 Payments.
 */

import { InvalidInstantError, parseInstant } from '../../platform/time/instant.ts';

import {
  sealPayment,
  sealPaymentAttempt,
  sealPaymentAttempts,
  sealPayments,
  sealRefund,
  sealRefunds,
  sealWebhookReceipt,
  sealWebhookReceipts,
} from './immutable.ts';
import {
  makeAttemptAction,
  makeAttemptEvent,
  makePaymentRequestedAction,
  makePaymentRequestedEvent,
  makeReceiptAction,
  makeReceiptEvent,
  makeRefundAction,
  makeRefundEvent,
  PAYMENT_AUTHORISED_ACTION,
  PAYMENT_AUTHORISED_EVENT,
  PAYMENT_CANCELLED_ACTION,
  PAYMENT_CANCELLED_EVENT,
  PAYMENT_CAPTURED_ACTION,
  PAYMENT_CAPTURED_EVENT,
  PAYMENT_FAILED_ACTION,
  PAYMENT_FAILED_EVENT,
} from './outbox.ts';
import type { PaymentProvider, ProviderResult, ResolveProvider } from './provider.ts';
import { FOREIGN_FIELDS, assertPaymentIdentifier, assertPaymentStatus } from './registry.ts';
import type { PaymentGuard, PaymentRepository, PaymentTransaction } from './repository.ts';
import {
  validatePayment,
  validatePaymentAttempt,
  validateRefund,
  validateWebhookReceipt,
} from './validate.ts';
import {
  PAYMENT_TRANSITIONS,
  PaymentError,
  type AttemptKind,
  type FailureCode,
  type Payment,
  type PaymentAttempt,
  type PaymentStatus,
  type Refund,
  type WebhookReceipt,
} from './types.ts';

/**
 * Failures that say nothing about whether the money moved.
 *
 * The distinction is the single most consequential one in this module. A gateway that timed out may
 * have completed the operation, so the payment must stay where it was and the caller must be able
 * to retry — under the same idempotency key, which is what stops the retry becoming a second
 * charge. Every other failure code is a definite refusal and the payment fails.
 */
export const INDETERMINATE_FAILURES: readonly FailureCode[] = Object.freeze([
  'provider-timeout',
  'provider-unavailable',
]);

const isIndeterminate = (code: FailureCode | null): boolean =>
  code !== null && INDETERMINATE_FAILURES.includes(code);

// ---------------------------------------------------------------------------
// Requests and results
// ---------------------------------------------------------------------------

export interface RequestPaymentRequest {
  readonly paymentId: string;
  readonly orderId: string;
  readonly payerAccountId: string;
  readonly payeeAccountId: string;
  readonly provider: string;
  readonly rail: string;
  /** The provider's opaque handle for the instrument. Never an instrument. */
  readonly instrumentToken: string;
  readonly assetCode: string;
  readonly assetScale: number;
  readonly amountMinor: bigint;
  readonly requestedAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
}

export interface RequestPaymentResult {
  readonly payment: Payment;
  /** True when this exact request had already been recorded and nothing new happened. */
  readonly replayed: boolean;
}

/** Every provider-facing operation takes the same shape. */
export interface AttemptRequest {
  readonly paymentId: string;
  readonly attemptId: string;
  readonly attemptedAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
}

export interface CaptureRequest extends AttemptRequest {
  /** How much to capture. A partial capture is legitimate; more than authorised is not. */
  readonly amountMinor: bigint;
}

export interface AttemptResult {
  readonly payment: Payment;
  readonly attempt: PaymentAttempt;
  readonly replayed: boolean;
}

export interface RefundPaymentRequest {
  readonly paymentId: string;
  readonly refundId: string;
  readonly attemptId: string;
  readonly amountMinor: bigint;
  readonly reason: string;
  readonly refundedAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
}

export interface RefundPaymentResult {
  readonly payment: Payment;
  readonly refund: Refund;
  readonly attempt: PaymentAttempt;
  readonly replayed: boolean;
}

export interface RecordWebhookRequest {
  readonly receiptId: string;
  readonly provider: string;
  /** The provider's own event id. Uniqueness on this is what makes a redelivery harmless. */
  readonly providerEventId: string;
  readonly paymentId: string | null;
  readonly kind: string;
  /**
   * Whether the caller verified the provider's signature.
   *
   * M-12 does not verify it — the transport layer holds the signing secret — but it refuses to act
   * on a delivery nobody verified, because an unverified webhook is an instruction from a stranger
   * to move money.
   */
  readonly signatureVerified: boolean;
  /** The status the provider asserts, or null for a delivery that only needs recording. */
  readonly assertedStatus: string | null;
  /** The amount the provider says moved, or null to mean the whole authorised amount. */
  readonly assertedAmountMinor: bigint | null;
  readonly failureCode: FailureCode | null;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly receivedAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
}

export interface RecordWebhookResult {
  readonly receipt: WebhookReceipt;
  /** The payment after the webhook, or null when it named no payment M-12 knows. */
  readonly payment: Payment | null;
  /** True when the webhook actually moved the payment. */
  readonly applied: boolean;
  /** Why it was not applied, for a caller that wants to log rather than guess. */
  readonly ignoredBecause: 'none' | 'unknown-payment' | 'stale' | 'no-assertion';
  /** True when this provider event had already been received. */
  readonly replayed: boolean;
}

const REQUEST_PAYMENT_KEYS: readonly string[] = [
  'paymentId',
  'orderId',
  'payerAccountId',
  'payeeAccountId',
  'provider',
  'rail',
  'instrumentToken',
  'assetCode',
  'assetScale',
  'amountMinor',
  'requestedAt',
  'correlationId',
  'idempotencyKey',
];

const ATTEMPT_KEYS: readonly string[] = [
  'paymentId',
  'attemptId',
  'attemptedAt',
  'correlationId',
  'idempotencyKey',
];

const CAPTURE_KEYS: readonly string[] = [...ATTEMPT_KEYS, 'amountMinor'];

const REFUND_KEYS: readonly string[] = [
  'paymentId',
  'refundId',
  'attemptId',
  'amountMinor',
  'reason',
  'refundedAt',
  'correlationId',
  'idempotencyKey',
];

const WEBHOOK_KEYS: readonly string[] = [
  'receiptId',
  'provider',
  'providerEventId',
  'paymentId',
  'kind',
  'signatureVerified',
  'assertedStatus',
  'assertedAmountMinor',
  'failureCode',
  'payload',
  'receivedAt',
  'correlationId',
  'idempotencyKey',
];

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class PaymentService {
  readonly #repository: PaymentRepository;
  readonly #resolveProvider: ResolveProvider;

  constructor(repository: PaymentRepository, resolveProvider: ResolveProvider) {
    this.#repository = repository;
    this.#resolveProvider = resolveProvider;
  }

  /**
   * Record the intent to pay. No provider is called and no value moves.
   *
   * Idempotent by key: the same request twice returns the first payment and `replayed: true`. A
   * different request under a used key is `idempotency-key-reuse`, because silently returning the
   * earlier payment would tell the caller their new amount had been accepted.
   */
  async requestPayment(request: RequestPaymentRequest): Promise<RequestPaymentResult> {
    assertNoForeignConcerns(request, REQUEST_PAYMENT_KEYS, 'requestPayment');
    const requestedAt = parseAndCheckInstant(request.requestedAt, 'requestedAt');

    const payment = sealPayment(
      validatePayment(
        {
          paymentId: request.paymentId,
          orderId: request.orderId,
          payerAccountId: request.payerAccountId,
          payeeAccountId: request.payeeAccountId,
          status: 'requires-authorisation',
          provider: request.provider,
          rail: request.rail,
          instrumentToken: request.instrumentToken,
          assetCode: request.assetCode,
          assetScale: request.assetScale,
          amountMinor: request.amountMinor,
          capturedMinor: 0n,
          refundedMinor: 0n,
          providerReference: null,
          authorisedAt: null,
          capturedAt: null,
          failedAt: null,
          cancelledAt: null,
          failureCode: null,
          createdAt: requestedAt,
          updatedAt: requestedAt,
          correlationId: request.correlationId,
          idempotencyKey: request.idempotencyKey,
        },
        'request',
      ),
    );

    if (payment.amountMinor === 0n) {
      throw new PaymentError('negative-amount', 'a payment of zero is not a payment');
    }
    // Checked here rather than at the gateway: asking a card processor for a bank transfer, or a
    // fiat processor for BTC, is a wiring mistake, and finding it locally beats reading it back as
    // a provider error in a vocabulary nobody chose.
    this.#requireSettlementSupport(payment);

    try {
      return await this.#repository.withTransaction(async (tx) => {
        const byKey = await tx.findPaymentByIdempotencyKey(payment.idempotencyKey);
        if (byKey !== null) {
          if (!paymentEquals(byKey, payment)) {
            throw new PaymentError(
              'idempotency-key-reuse',
              `idempotency key "${payment.idempotencyKey}" has already been used for a different ` +
                'payment. Returning the earlier one would report this request as accepted',
            );
          }
          return { payment: sealPayment(byKey), replayed: true };
        }

        const byId = await tx.findPaymentById(payment.paymentId);
        if (byId !== null) {
          if (!paymentEquals(byId, payment)) {
            throw new PaymentError(
              'duplicate-payment-id',
              `payment ${payment.paymentId} already exists with different content`,
            );
          }
          return { payment: sealPayment(byId), replayed: true };
        }

        await tx.insertPayment(payment);
        await tx.insertOutbox(makePaymentRequestedEvent(payment));
        await tx.insertOutbox(makePaymentRequestedAction(payment));
        return { payment, replayed: false };
      });
    } catch (error) {
      // Two concurrent identical requests: one inserts, the other loses at commit. The loser
      // re-reads and reports the winner, because the caller asked for a payment to exist and one
      // does.
      const conflicted =
        error instanceof PaymentError &&
        (error.code === 'duplicate-payment-id' || error.code === 'idempotency-key-reuse');
      if (!conflicted) throw error;

      const winner = await this.#repository.withTransaction((tx) =>
        tx.findPaymentByIdempotencyKey(payment.idempotencyKey),
      );
      if (winner === null || !paymentEquals(winner, payment)) throw error;
      return { payment: sealPayment(winner), replayed: true };
    }
  }

  /**
   * Ask the provider to authorise. Money is reserved, not taken.
   *
   * A definite refusal fails the payment. A timeout leaves it in `requires-authorisation` so the
   * caller can retry under the same key.
   */
  async authorisePayment(request: AttemptRequest): Promise<AttemptResult> {
    assertNoForeignConcerns(request, ATTEMPT_KEYS, 'authorisePayment');
    return this.#runAttempt(request, 'authorise', null);
  }

  /**
   * Ask the provider to capture. This is where value actually moves.
   *
   * Refuses `over-capture` before calling out, and the guarded update refuses a second capture that
   * raced the first.
   */
  async capturePayment(request: CaptureRequest): Promise<AttemptResult> {
    assertNoForeignConcerns(request, CAPTURE_KEYS, 'capturePayment');
    return this.#runAttempt(request, 'capture', request.amountMinor);
  }

  /** Cancel before capture. Refuses once anything has been captured. */
  async cancelPayment(request: AttemptRequest): Promise<AttemptResult> {
    assertNoForeignConcerns(request, ATTEMPT_KEYS, 'cancelPayment');
    return this.#runAttempt(request, 'cancel', null);
  }

  /**
   * Return captured value, in part or in full.
   *
   * Refuses `over-refund` when this refund plus everything already refunded would exceed what was
   * captured — checked against the stored total rather than the caller's arithmetic, and enforced
   * again by the guarded update so two concurrent partial refunds cannot both succeed.
   */
  async refundPayment(request: RefundPaymentRequest): Promise<RefundPaymentResult> {
    assertNoForeignConcerns(request, REFUND_KEYS, 'refundPayment');
    assertPaymentIdentifier(request.refundId, 'refundId');
    assertPaymentIdentifier(request.attemptId, 'attemptId');
    const refundedAt = parseAndCheckInstant(request.refundedAt, 'refundedAt');

    const replay = await this.#repository.withTransaction(async (tx) => {
      const existing = await tx.findRefundByIdempotencyKey(request.idempotencyKey);
      if (existing === null) return null;
      const payment = await requirePayment(tx, existing.paymentId);
      const attempt = await tx.findAttemptByIdempotencyKey(request.idempotencyKey);
      return { payment, refund: existing, attempt };
    });
    if (replay !== null) {
      if (replay.refund.amountMinor !== request.amountMinor) {
        throw new PaymentError(
          'idempotency-key-reuse',
          `idempotency key "${request.idempotencyKey}" already refunded ` +
            `${String(replay.refund.amountMinor)}; this request asks for ` +
            `${String(request.amountMinor)}`,
        );
      }
      if (replay.attempt === null) {
        throw new PaymentError(
          'malformed-record',
          `refund ${replay.refund.refundId} exists with no matching attempt`,
        );
      }
      return {
        payment: sealPayment(replay.payment),
        refund: sealRefund(replay.refund),
        attempt: sealPaymentAttempt(replay.attempt),
        replayed: true,
      };
    }

    const before = await this.#repository.withTransaction((tx) =>
      requirePayment(tx, request.paymentId),
    );

    if (before.status !== 'captured' && before.status !== 'partially-refunded') {
      throw new PaymentError(
        'illegal-transition',
        `payment ${before.paymentId} is ${before.status}; only a captured payment can be refunded`,
      );
    }
    if (request.amountMinor <= 0n) {
      throw new PaymentError('negative-amount', 'a refund of zero or less is not a refund');
    }
    const refundedTotal = before.refundedMinor + request.amountMinor;
    if (refundedTotal > before.capturedMinor) {
      throw new PaymentError(
        'over-refund',
        `refunding ${String(request.amountMinor)} on top of ${String(before.refundedMinor)} ` +
          `already refunded would exceed the ${String(before.capturedMinor)} captured`,
      );
    }

    const result = await this.#callProvider(before, 'refund', request.amountMinor, {
      idempotencyKey: request.idempotencyKey,
      providerReference: before.providerReference,
    });

    const attempt = sealPaymentAttempt(
      validatePaymentAttempt(
        {
          attemptId: request.attemptId,
          paymentId: before.paymentId,
          kind: 'refund',
          outcome: result.outcome,
          amountMinor: request.amountMinor,
          providerReference: result.providerReference,
          failureCode: result.failureCode,
          attemptedAt: refundedAt,
          correlationId: request.correlationId,
          idempotencyKey: request.idempotencyKey,
        },
        'request',
      ),
    );

    if (result.outcome === 'failed') {
      // No refund row: no value came back, so there is nothing to record as returned. The attempt
      // is written, because the call happened and reconciliation needs to see it.
      await this.#repository.withTransaction(async (tx) => {
        await tx.insertAttempt(attempt);
      });
      throw new PaymentError(
        'provider-failed',
        `the provider refused the refund: ${String(result.failureCode)}`,
      );
    }

    const refund = sealRefund(
      validateRefund(
        {
          refundId: request.refundId,
          paymentId: before.paymentId,
          amountMinor: request.amountMinor,
          reason: request.reason,
          providerReference: result.providerReference,
          refundedAt,
          correlationId: request.correlationId,
          idempotencyKey: request.idempotencyKey,
        },
        'request',
      ),
    );

    // Fully refunded becomes `refunded`; anything less becomes `partially-refunded`. A second
    // partial refund therefore records a row and leaves the status alone — which is why the guard
    // covers `refundedMinor` and not only the status.
    const nextStatus: PaymentStatus =
      refundedTotal === before.capturedMinor ? 'refunded' : 'partially-refunded';
    if (nextStatus !== before.status) {
      assertTransitionPermitted(before.status, nextStatus, before.paymentId);
    }

    const after = sealPayment(
      validatePayment(
        {
          ...before,
          status: nextStatus,
          refundedMinor: refundedTotal,
          updatedAt: refundedAt,
        },
        'request',
      ),
    );

    const outcome = await this.#repository.withTransaction(async (tx) => {
      await tx.insertAttempt(attempt);
      await tx.insertRefund(refund);
      const moved = await tx.updatePaymentIfUnchanged(after, guardOf(before));
      if (!moved) return { moved: false as const };
      await tx.insertOutbox(makeRefundEvent(after, refund));
      await tx.insertOutbox(makeRefundAction(after, refund));
      return { moved: true as const };
    });

    if (!outcome.moved) {
      throw new PaymentError(
        'illegal-transition',
        `payment ${before.paymentId} changed while the refund was with the provider. The refund ` +
          `and attempt are recorded under ${refund.refundId} and need reconciling`,
      );
    }

    return { payment: after, refund, attempt, replayed: false };
  }

  /**
   * Record a webhook, then apply it if it is still relevant.
   *
   * Recorded before it is believed, refused outright when unverified, and applied at most once —
   * `(provider, providerEventId)` is unique, so the redelivery every provider eventually sends is a
   * replay rather than a second movement.
   *
   * A webhook asserting a status that is not a legal transition from where the payment now stands
   * is **stale, not an error**: providers deliver out of order routinely, and a `captured` notice
   * arriving after the refund has already been processed describes the past. It is recorded, marked
   * processed, and does not move the payment.
   */
  async recordWebhook(request: RecordWebhookRequest): Promise<RecordWebhookResult> {
    assertNoForeignConcerns(request, WEBHOOK_KEYS, 'recordWebhook');
    if (!request.signatureVerified) {
      throw new PaymentError(
        'unverified-webhook',
        'the webhook signature was not verified. A webhook is an instruction from outside the ' +
          'platform to move money, and an unverified one is an instruction from a stranger',
      );
    }
    const receivedAt = parseAndCheckInstant(request.receivedAt, 'receivedAt');
    const assertedStatus =
      request.assertedStatus === null
        ? null
        : assertPaymentStatus(request.assertedStatus, 'assertedStatus');

    const receipt = sealWebhookReceipt(
      validateWebhookReceipt(
        {
          receiptId: request.receiptId,
          provider: request.provider,
          providerEventId: request.providerEventId,
          paymentId: request.paymentId,
          kind: request.kind,
          signatureVerified: true,
          payload: request.payload,
          receivedAt,
          processedAt: null,
          correlationId: request.correlationId,
          idempotencyKey: request.idempotencyKey,
        },
        'request',
      ),
    );

    try {
      return await this.#repository.withTransaction(async (tx) => {
        const seen = await tx.findReceiptByProviderEvent(receipt.provider, receipt.providerEventId);
        if (seen !== null) {
          const payment = seen.paymentId === null ? null : await tx.findPaymentById(seen.paymentId);
          return {
            receipt: sealWebhookReceipt(seen),
            payment: payment === null ? null : sealPayment(payment),
            applied: false,
            ignoredBecause: 'none' as const,
            replayed: true,
          };
        }

        await tx.insertReceipt(receipt);
        const processed = sealWebhookReceipt({ ...receipt, processedAt: receivedAt });

        // Recorded rather than refused. A webhook for a payment M-12 does not know is worth
        // keeping — it is evidence in a dispute — and refusing it would make the provider retry
        // for ever.
        const before =
          receipt.paymentId === null ? null : await tx.findPaymentById(receipt.paymentId);
        if (before === null) {
          await tx.markReceiptProcessed(receipt.receiptId, receivedAt);
          return {
            receipt: processed,
            payment: null,
            applied: false,
            ignoredBecause: 'unknown-payment' as const,
            replayed: false,
          };
        }

        if (assertedStatus === null) {
          await tx.markReceiptProcessed(receipt.receiptId, receivedAt);
          return {
            receipt: processed,
            payment: sealPayment(before),
            applied: false,
            ignoredBecause: 'no-assertion' as const,
            replayed: false,
          };
        }

        if (!PAYMENT_TRANSITIONS[before.status].includes(assertedStatus)) {
          await tx.markReceiptProcessed(receipt.receiptId, receivedAt);
          return {
            receipt: processed,
            payment: sealPayment(before),
            applied: false,
            ignoredBecause: 'stale' as const,
            replayed: false,
          };
        }

        const after = sealPayment(
          validatePayment(
            applyWebhookStatus(before, assertedStatus, request, receivedAt),
            'request',
          ),
        );

        const moved = await tx.updatePaymentIfUnchanged(after, guardOf(before));
        await tx.markReceiptProcessed(receipt.receiptId, receivedAt);
        if (!moved) {
          return {
            receipt: processed,
            payment: sealPayment(before),
            applied: false,
            ignoredBecause: 'stale' as const,
            replayed: false,
          };
        }

        const definitions = STATUS_FACTS[assertedStatus];
        if (definitions !== undefined) {
          await tx.insertOutbox(
            makeReceiptEvent(after, processed, definitions.event, after.failureCode),
          );
          await tx.insertOutbox(
            makeReceiptAction(after, processed, definitions.action, after.failureCode),
          );
        }
        return {
          receipt: processed,
          payment: after,
          applied: true,
          ignoredBecause: 'none' as const,
          replayed: false,
        };
      });
    } catch (error) {
      // Two deliveries of the same event racing: the loser reports the winner's receipt rather
      // than an error, because from the provider's side both are the same delivery.
      if (!(error instanceof PaymentError) || error.code !== 'duplicate-webhook') throw error;
      return this.#repository.withTransaction(async (tx) => {
        const seen = await tx.findReceiptByProviderEvent(receipt.provider, receipt.providerEventId);
        if (seen === null) throw error;
        const payment = seen.paymentId === null ? null : await tx.findPaymentById(seen.paymentId);
        return {
          receipt: sealWebhookReceipt(seen),
          payment: payment === null ? null : sealPayment(payment),
          applied: false,
          ignoredBecause: 'none' as const,
          replayed: true,
        };
      });
    }
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  async getPayment(paymentId: string): Promise<Payment> {
    assertPaymentIdentifier(paymentId, 'paymentId');
    return this.#repository.withTransaction(async (tx) =>
      sealPayment(await requirePayment(tx, paymentId)),
    );
  }

  async listPaymentsForOrder(orderId: string): Promise<readonly Payment[]> {
    assertPaymentIdentifier(orderId, 'orderId');
    return this.#repository.withTransaction(async (tx) =>
      sealPayments(await tx.findPaymentsByOrderId(orderId)),
    );
  }

  async listPaymentsForPayer(payerAccountId: string): Promise<readonly Payment[]> {
    assertPaymentIdentifier(payerAccountId, 'payerAccountId');
    return this.#repository.withTransaction(async (tx) =>
      sealPayments(await tx.findPaymentsByPayerAccountId(payerAccountId)),
    );
  }

  async listAttempts(paymentId: string): Promise<readonly PaymentAttempt[]> {
    assertPaymentIdentifier(paymentId, 'paymentId');
    return this.#repository.withTransaction(async (tx) =>
      sealPaymentAttempts(await tx.findAttemptsByPaymentId(paymentId)),
    );
  }

  async listRefunds(paymentId: string): Promise<readonly Refund[]> {
    assertPaymentIdentifier(paymentId, 'paymentId');
    return this.#repository.withTransaction(async (tx) =>
      sealRefunds(await tx.findRefundsByPaymentId(paymentId)),
    );
  }

  async listReceipts(paymentId: string): Promise<readonly WebhookReceipt[]> {
    assertPaymentIdentifier(paymentId, 'paymentId');
    return this.#repository.withTransaction(async (tx) =>
      sealWebhookReceipts(await tx.findReceiptsByPaymentId(paymentId)),
    );
  }

  // -------------------------------------------------------------------------
  // The shared attempt path
  // -------------------------------------------------------------------------

  /**
   * Authorise, capture and cancel differ only in what they ask the provider and where they leave
   * the payment. The read, the replay check, the call, the recording and the guard are one path,
   * because three copies of this logic would eventually disagree about which of them is idempotent.
   */
  async #runAttempt(
    request: AttemptRequest,
    kind: Exclude<AttemptKind, 'refund'>,
    captureAmount: bigint | null,
  ): Promise<AttemptResult> {
    assertPaymentIdentifier(request.attemptId, 'attemptId');
    const attemptedAt = parseAndCheckInstant(request.attemptedAt, 'attemptedAt');

    // The replay check comes before the provider call, which is what makes a duplicate capture
    // harmless: the second one recognises the first attempt and reports it instead of calling out.
    const replay = await this.#repository.withTransaction(async (tx) => {
      const existing = await tx.findAttemptByIdempotencyKey(request.idempotencyKey);
      if (existing === null) return null;
      const payment = await requirePayment(tx, existing.paymentId);
      return { payment, attempt: existing };
    });
    if (replay !== null) {
      if (replay.attempt.kind !== kind) {
        throw new PaymentError(
          'idempotency-key-reuse',
          `idempotency key "${request.idempotencyKey}" was used for a ${replay.attempt.kind} ` +
            `attempt; this request is a ${kind}`,
        );
      }
      return {
        payment: sealPayment(replay.payment),
        attempt: sealPaymentAttempt(replay.attempt),
        replayed: true,
      };
    }

    const before = await this.#repository.withTransaction((tx) =>
      requirePayment(tx, request.paymentId),
    );

    const amount = this.#amountFor(before, kind, captureAmount);
    this.#requireAttemptPermitted(before, kind);

    const result = await this.#callProvider(before, kind, amount, {
      idempotencyKey: request.idempotencyKey,
      providerReference: before.providerReference,
    });

    const attempt = sealPaymentAttempt(
      validatePaymentAttempt(
        {
          attemptId: request.attemptId,
          paymentId: before.paymentId,
          kind,
          outcome: result.outcome,
          amountMinor: amount,
          providerReference: result.providerReference,
          failureCode: result.failureCode,
          attemptedAt,
          correlationId: request.correlationId,
          idempotencyKey: request.idempotencyKey,
        },
        'request',
      ),
    );

    const after = nextPayment(before, kind, amount, result, attemptedAt);

    // No status change: a timeout, which says nothing about whether the money moved. The attempt is
    // recorded so a retry — or a human — can see the call happened, and the payment stays where it
    // was so the retry is legitimate.
    if (after === null) {
      await this.#repository.withTransaction(async (tx) => {
        await tx.insertAttempt(attempt);
      });
      throw new PaymentError(
        'provider-failed',
        `the provider gave no definite answer to the ${kind}: ${String(result.failureCode)}. The ` +
          `payment stays ${before.status} and the operation may be retried under the same ` +
          'idempotency key',
      );
    }

    const outcome = await this.#repository.withTransaction(async (tx) => {
      await tx.insertAttempt(attempt);
      const moved = await tx.updatePaymentIfUnchanged(after, guardOf(before));
      if (!moved) return { moved: false as const };
      const definitions = STATUS_FACTS[after.status];
      if (definitions !== undefined) {
        await tx.insertOutbox(makeAttemptEvent(after, attempt, definitions.event));
        await tx.insertOutbox(makeAttemptAction(after, attempt, definitions.action));
      }
      return { moved: true as const };
    });

    if (!outcome.moved) {
      throw new PaymentError(
        'illegal-transition',
        `payment ${before.paymentId} changed while the ${kind} was with the provider. Attempt ` +
          `${attempt.attemptId} is recorded and needs reconciling`,
      );
    }

    if (result.outcome === 'failed') {
      throw new PaymentError(
        'provider-failed',
        `the provider refused the ${kind}: ${String(result.failureCode)}`,
      );
    }

    return { payment: after, attempt, replayed: false };
  }

  #amountFor(
    payment: Payment,
    kind: Exclude<AttemptKind, 'refund'>,
    captureAmount: bigint | null,
  ): bigint {
    if (kind !== 'capture') return payment.amountMinor;
    if (captureAmount === null || captureAmount <= 0n) {
      throw new PaymentError('negative-amount', 'a capture of zero or less is not a capture');
    }
    if (payment.capturedMinor + captureAmount > payment.amountMinor) {
      throw new PaymentError(
        'over-capture',
        `capturing ${String(captureAmount)} on top of ${String(payment.capturedMinor)} already ` +
          `captured would exceed the ${String(payment.amountMinor)} authorised`,
      );
    }
    return captureAmount;
  }

  #requireAttemptPermitted(payment: Payment, kind: Exclude<AttemptKind, 'refund'>): void {
    if (PAYMENT_TRANSITIONS[payment.status].length === 0) {
      throw new PaymentError(
        'payment-terminal',
        `payment ${payment.paymentId} is ${payment.status}, which is terminal`,
      );
    }
    if (kind === 'cancel') {
      // Cancellable while nothing has been taken. After a capture the money has left the payer, and
      // the way back is a refund — which leaves a record of the return rather than pretending the
      // payment never happened.
      if (payment.status !== 'requires-authorisation' && payment.status !== 'authorised') {
        throw new PaymentError(
          'illegal-transition',
          `payment ${payment.paymentId} is ${payment.status}; a captured payment is refunded, ` +
            'not cancelled',
        );
      }
      return;
    }
    const required: PaymentStatus = kind === 'capture' ? 'authorised' : 'requires-authorisation';
    if (payment.status !== required) {
      throw new PaymentError(
        'illegal-transition',
        `payment ${payment.paymentId} is ${payment.status}; a ${kind} needs ${required}`,
      );
    }
  }

  /** Resolve the adapter and refuse a pairing it has declared it cannot settle. */
  #requireSettlementSupport(payment: Payment): PaymentProvider {
    let adapter: PaymentProvider;
    try {
      adapter = this.#resolveProvider(payment.provider);
    } catch (error) {
      throw new PaymentError(
        'unknown-provider',
        `no adapter is registered for provider "${payment.provider}": ${String(error)}`,
      );
    }
    if (!adapter.supportedRails.includes(payment.rail)) {
      throw new PaymentError(
        'unsupported-settlement',
        `provider "${adapter.name}" settles ${adapter.supportedRails.join(', ')}, not ` +
          `"${payment.rail}"`,
      );
    }
    if (!adapter.supportedAssets.includes(payment.assetCode)) {
      throw new PaymentError(
        'unsupported-settlement',
        `provider "${adapter.name}" settles ${adapter.supportedAssets.join(', ')}, not ` +
          `"${payment.assetCode}"`,
      );
    }
    return adapter;
  }

  /**
   * Call the provider, and turn a thrown adapter error into an indeterminate failure.
   *
   * An adapter that throws has told M-12 nothing about whether the money moved, which is exactly
   * the indeterminate case: treating it as a decline would let a retry become a second charge.
   */
  async #callProvider(
    payment: Payment,
    kind: AttemptKind,
    amountMinor: bigint,
    keys: { readonly idempotencyKey: string; readonly providerReference: string | null },
  ): Promise<ProviderResult> {
    const adapter = this.#requireSettlementSupport(payment);
    const providerRequest = {
      instrumentToken: payment.instrumentToken,
      amountMinor,
      assetCode: payment.assetCode,
      assetScale: payment.assetScale,
      rail: payment.rail,
      idempotencyKey: keys.idempotencyKey,
      providerReference: keys.providerReference,
    };
    try {
      switch (kind) {
        case 'authorise':
          return await adapter.authorise(providerRequest);
        case 'capture':
          return await adapter.capture(providerRequest);
        case 'cancel':
          return await adapter.cancel(providerRequest);
        case 'refund':
          return await adapter.refund(providerRequest);
      }
    } catch {
      return { outcome: 'failed', providerReference: null, failureCode: 'provider-unavailable' };
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface StatusFacts {
  readonly event: typeof PAYMENT_AUTHORISED_EVENT;
  readonly action: typeof PAYMENT_AUTHORISED_ACTION;
}

/** The event and audit definitions each status publishes, when it publishes any. */
const STATUS_FACTS: Partial<Record<PaymentStatus, StatusFacts>> = {
  authorised: { event: PAYMENT_AUTHORISED_EVENT, action: PAYMENT_AUTHORISED_ACTION },
  captured: { event: PAYMENT_CAPTURED_EVENT, action: PAYMENT_CAPTURED_ACTION },
  failed: { event: PAYMENT_FAILED_EVENT, action: PAYMENT_FAILED_ACTION },
  cancelled: { event: PAYMENT_CANCELLED_EVENT, action: PAYMENT_CANCELLED_ACTION },
};

const guardOf = (payment: Payment): PaymentGuard => ({
  status: payment.status,
  capturedMinor: payment.capturedMinor,
  refundedMinor: payment.refundedMinor,
});

/**
 * Where an attempt leaves the payment, or null when it leaves it exactly where it was.
 *
 * Null is the indeterminate case and only the indeterminate case.
 */
function nextPayment(
  before: Payment,
  kind: Exclude<AttemptKind, 'refund'>,
  amountMinor: bigint,
  result: ProviderResult,
  at: string,
): Payment | null {
  if (result.outcome === 'failed') {
    if (isIndeterminate(result.failureCode)) return null;
    assertTransitionPermitted(before.status, 'failed', before.paymentId);
    return sealPayment(
      validatePayment(
        {
          ...before,
          status: 'failed',
          failedAt: at,
          failureCode: result.failureCode,
          updatedAt: at,
        },
        'request',
      ),
    );
  }

  switch (kind) {
    case 'authorise': {
      assertTransitionPermitted(before.status, 'authorised', before.paymentId);
      return sealPayment(
        validatePayment(
          {
            ...before,
            status: 'authorised',
            providerReference: result.providerReference,
            authorisedAt: at,
            updatedAt: at,
          },
          'request',
        ),
      );
    }
    case 'capture': {
      assertTransitionPermitted(before.status, 'captured', before.paymentId);
      return sealPayment(
        validatePayment(
          {
            ...before,
            status: 'captured',
            capturedMinor: before.capturedMinor + amountMinor,
            capturedAt: at,
            updatedAt: at,
          },
          'request',
        ),
      );
    }
    case 'cancel': {
      assertTransitionPermitted(before.status, 'cancelled', before.paymentId);
      return sealPayment(
        validatePayment(
          { ...before, status: 'cancelled', cancelledAt: at, updatedAt: at },
          'request',
        ),
      );
    }
  }
}

/** The payment a webhook's assertion produces. */
function applyWebhookStatus(
  before: Payment,
  status: PaymentStatus,
  request: RecordWebhookRequest,
  at: string,
): Record<string, unknown> {
  const asserted = request.assertedAmountMinor ?? before.amountMinor;
  switch (status) {
    case 'authorised':
      return { ...before, status, authorisedAt: at, updatedAt: at };
    case 'captured':
      return {
        ...before,
        status,
        // Clamped at the authorised amount: a provider asserting more than it was authorised for
        // is a discrepancy to reconcile, not a licence to record an over-capture.
        capturedMinor: asserted > before.amountMinor ? before.amountMinor : asserted,
        capturedAt: at,
        updatedAt: at,
      };
    case 'failed':
      return {
        ...before,
        status,
        failedAt: at,
        failureCode: request.failureCode ?? 'provider-error',
        updatedAt: at,
      };
    case 'cancelled':
      return { ...before, status, cancelledAt: at, updatedAt: at };
    case 'refunded':
      return { ...before, status, refundedMinor: before.capturedMinor, updatedAt: at };
    case 'partially-refunded':
      return {
        ...before,
        status,
        refundedMinor: asserted > before.capturedMinor ? before.capturedMinor : asserted,
        updatedAt: at,
      };
    case 'requires-authorisation':
      return { ...before, updatedAt: at };
  }
}

function assertTransitionPermitted(
  from: PaymentStatus,
  to: PaymentStatus,
  paymentId: string,
): void {
  if (!PAYMENT_TRANSITIONS[from].includes(to)) {
    throw new PaymentError(
      'illegal-transition',
      `payment ${paymentId} cannot go from ${from} to ${to}; the permitted moves are ` +
        `${PAYMENT_TRANSITIONS[from].join(', ') || 'none, as it is terminal'}`,
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
function paymentEquals(left: Payment, right: Payment): boolean {
  return (
    left.paymentId === right.paymentId &&
    left.orderId === right.orderId &&
    left.payerAccountId === right.payerAccountId &&
    left.payeeAccountId === right.payeeAccountId &&
    left.provider === right.provider &&
    left.rail === right.rail &&
    left.instrumentToken === right.instrumentToken &&
    left.assetCode === right.assetCode &&
    left.assetScale === right.assetScale &&
    left.amountMinor === right.amountMinor &&
    left.idempotencyKey === right.idempotencyKey
  );
}

async function requirePayment(tx: PaymentTransaction, paymentId: string): Promise<Payment> {
  const payment = await tx.findPaymentById(paymentId);
  if (payment === null) {
    throw new PaymentError('payment-not-found', `payment ${paymentId} does not exist`);
  }
  return payment;
}

function assertNoForeignConcerns(
  request: object,
  permitted: readonly string[],
  operation: string,
): void {
  if (request === null || typeof request !== 'object') {
    throw new PaymentError(
      'malformed-record',
      `${operation} needs a request object, got ${request === null ? 'null' : typeof request}`,
    );
  }

  for (const key of Object.keys(request)) {
    if (permitted.includes(key)) continue;

    const owner = FOREIGN_FIELDS[key];
    if (owner !== undefined) {
      throw new PaymentError(
        'foreign-concern',
        `${operation} carried "${key}", but ${owner}. A payment record carries only what M-12 owns`,
      );
    }
    throw new PaymentError(
      'foreign-concern',
      `${operation} carried the unrecognised field "${key}". The permitted fields are ` +
        `${permitted.join(', ')}; anything else would be accepted and silently dropped`,
    );
  }
}

function parseAndCheckInstant(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new PaymentError(
      'malformed-instant',
      `${field} is ${value === null ? 'null' : typeof value}; expected a UTC instant string`,
    );
  }
  try {
    return parseInstant(value).source;
  } catch (error) {
    if (error instanceof InvalidInstantError) {
      throw new PaymentError('malformed-instant', `${field}: ${error.message}`);
    }
    throw error;
  }
}
