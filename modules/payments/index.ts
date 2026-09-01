/**
 * M-12 Payments — public surface.
 *
 * Everything another unit may depend on is re-exported here. Anything not listed is internal and
 * may change without notice.
 *
 * M-12 owns payment orchestration: the lifecycle of a payment against an external settlement rail,
 * the append-only record of every provider call, refunds, and the webhook receipts that make a
 * provider's redeliveries harmless. It depends on the platform substrate and K-03 Accounts. It
 * imports no other business module — M-11 Orders is the same layer and reaches M-12 by event.
 *
 * **No gateway SDK is imported here or anywhere below.** A provider is reached through
 * `PaymentProvider`, and the adapter behind it is injected.
 *
 * **M-12 never settles internally issued JAYA value.** Rewards, cashback, merchant credit,
 * promotional credit and community credit are M-13's to allocate against the universal ledger; this
 * module orchestrates only the leg an external counterparty settles.
 *
 * Owned by: M-12 Payments.
 */

export {
  ATTEMPT_KINDS,
  ATTEMPT_OUTCOMES,
  FAILURE_CODES,
  INTERNAL_VALUE_CODES,
  PAYMENT_RAILS,
  PAYMENT_STATUSES,
  PAYMENT_TRANSITIONS,
  PaymentError,
} from './types.ts';
export type {
  AttemptKind,
  AttemptOutcome,
  FailureCode,
  InternalValueCode,
  Payment,
  PaymentAmount,
  PaymentAttempt,
  PaymentErrorCode,
  PaymentRail,
  PaymentStatus,
  Refund,
  WebhookReceipt,
} from './types.ts';

export {
  FOREIGN_FIELDS,
  IDENTIFIER_REFUSALS,
  assertAssetScale,
  assertAttemptKind,
  assertAttemptOutcome,
  assertOptionalFailureCode,
  assertPaymentIdentifier,
  assertPaymentRail,
  assertPaymentStatus,
  assertSettlementAsset,
} from './registry.ts';

export {
  isPaymentAttemptSealed,
  isPaymentSealed,
  isRefundSealed,
  isWebhookReceiptSealed,
  sealPayment,
  sealPaymentAttempt,
  sealPaymentAttempts,
  sealPayments,
  sealRefund,
  sealRefunds,
  sealWebhookReceipt,
  sealWebhookReceipts,
} from './immutable.ts';

export {
  STORED_ROW_NOTE,
  validatePayment,
  validatePaymentAttempt,
  validateRefund,
  validateWebhookReceipt,
} from './validate.ts';
export type { RecordSource } from './validate.ts';

export type {
  PaymentProvider,
  ProviderAuthoriseRequest,
  ProviderCancelRequest,
  ProviderCaptureRequest,
  ProviderRefundRequest,
  ProviderRequest,
  ProviderResult,
  ResolveProvider,
} from './provider.ts';

export { InMemoryPaymentRepository } from './repository.ts';
export type { PaymentGuard, PaymentRepository, PaymentTransaction } from './repository.ts';

export {
  PAYMENT_AUTHORISED_ACTION,
  PAYMENT_AUTHORISED_EVENT,
  PAYMENT_CANCELLED_ACTION,
  PAYMENT_CANCELLED_EVENT,
  PAYMENT_CAPTURED_ACTION,
  PAYMENT_CAPTURED_EVENT,
  PAYMENT_FAILED_ACTION,
  PAYMENT_FAILED_EVENT,
  PAYMENT_REFUNDED_ACTION,
  PAYMENT_REFUNDED_EVENT,
  PAYMENT_REQUESTED_ACTION,
  PAYMENT_REQUESTED_EVENT,
} from './outbox.ts';

export { INDETERMINATE_FAILURES, PaymentService } from './service.ts';
export type {
  AttemptRequest,
  AttemptResult,
  CaptureRequest,
  RecordWebhookRequest,
  RecordWebhookResult,
  RefundPaymentRequest,
  RefundPaymentResult,
  RequestPaymentRequest,
  RequestPaymentResult,
} from './service.ts';

export { MockPaymentProvider, resolveMockProvider } from './providers/mock-payment-provider.ts';
