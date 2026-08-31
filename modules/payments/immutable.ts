/**
 * M-12 Payments — immutability boundary.
 *
 * Every record that crosses a service or repository boundary is deep-frozen and cloned, so a caller
 * cannot edit what was stored. Attempts, refunds and webhook receipts are append-only; only the
 * payment header moves, and only through the service's operations.
 *
 * The webhook payload is frozen recursively rather than shallowly, because it is arbitrary JSON
 * from outside the platform and is the evidence a dispute is reconstructed from. A caller that
 * could edit it after the fact could rewrite what the provider said.
 *
 * Owned by: M-12 Payments.
 */

import type { Payment, PaymentAttempt, Refund, WebhookReceipt } from './types.ts';

function sealRecord(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return Object.freeze(value.map(sealRecord));
  const copy: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    copy[key] = sealRecord(entry);
  }
  return Object.freeze(copy);
}

/** A frozen copy of a payment. */
export function sealPayment(payment: Payment): Payment {
  return Object.freeze({ ...payment });
}

/** A frozen copy of a provider attempt. */
export function sealPaymentAttempt(attempt: PaymentAttempt): PaymentAttempt {
  return Object.freeze({ ...attempt });
}

/** A frozen copy of a refund. */
export function sealRefund(refund: Refund): Refund {
  return Object.freeze({ ...refund });
}

/** A frozen copy of a webhook receipt, payload included, all the way down. */
export function sealWebhookReceipt(receipt: WebhookReceipt): WebhookReceipt {
  return Object.freeze({
    receiptId: receipt.receiptId,
    provider: receipt.provider,
    providerEventId: receipt.providerEventId,
    paymentId: receipt.paymentId,
    kind: receipt.kind,
    signatureVerified: receipt.signatureVerified,
    payload: sealRecord(receipt.payload) as Readonly<Record<string, unknown>>,
    receivedAt: receipt.receivedAt,
    processedAt: receipt.processedAt,
    correlationId: receipt.correlationId,
    idempotencyKey: receipt.idempotencyKey,
  });
}

/** Frozen copies of a list of payments. */
export function sealPayments(payments: readonly Payment[]): readonly Payment[] {
  return Object.freeze(payments.map(sealPayment));
}

/** Frozen copies of a list of attempts. */
export function sealPaymentAttempts(
  attempts: readonly PaymentAttempt[],
): readonly PaymentAttempt[] {
  return Object.freeze(attempts.map(sealPaymentAttempt));
}

/** Frozen copies of a list of refunds. */
export function sealRefunds(refunds: readonly Refund[]): readonly Refund[] {
  return Object.freeze(refunds.map(sealRefund));
}

/** Frozen copies of a list of webhook receipts. */
export function sealWebhookReceipts(
  receipts: readonly WebhookReceipt[],
): readonly WebhookReceipt[] {
  return Object.freeze(receipts.map(sealWebhookReceipt));
}
