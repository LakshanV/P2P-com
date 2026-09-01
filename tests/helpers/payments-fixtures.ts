/**
 * Shared fixtures for the M-12 Payments suites.
 *
 * Every identifier and every instant is supplied here rather than read from a clock, so a replayed
 * request produces a byte-identical record. Money is `bigint` minor units throughout — a fixture
 * using a JavaScript number would quietly teach the suites a habit the financial zone refuses.
 *
 * Instrument tokens are opaque handles that name the outcome they want from the mock provider:
 * `TOKEN_OK` succeeds, `TOKEN_DECLINE` is refused, `TOKEN_CAPTURE_TIMEOUT` authorises cleanly and
 * then gives no answer at capture. None of them resembles an instrument, which is the point —
 * K-03's opacity rules refuse anything that does.
 */

import {
  InMemoryPaymentRepository,
  PaymentService,
  resolveMockProvider,
  type AttemptRequest,
  type CaptureRequest,
  type Payment,
  type PaymentAttempt,
  type RecordWebhookRequest,
  type Refund,
  type RefundPaymentRequest,
  type RequestPaymentRequest,
  type WebhookReceipt,
} from '../../modules/payments/index.ts';

export interface Harness {
  readonly service: PaymentService;
  readonly repository: InMemoryPaymentRepository;
}

export function build(): Harness {
  const repository = new InMemoryPaymentRepository();
  return { service: new PaymentService(repository, resolveMockProvider), repository };
}

let sequence = 0;

function seq(): string {
  sequence += 1;
  return String(sequence).padStart(4, '0');
}

export const PAYER = 'acct_01HR0P0payer01';
export const PAYEE = 'acct_01HR0P0payee01';
export const ORDER = 'ord_01HR0P0order1';

/** Succeeds at every step. */
export const TOKEN_OK = 'tok_01HR0PTgood01';
/** Refused outright: a definite answer, and the payment fails. */
export const TOKEN_DECLINE = 'tok_01HR0PTdecline';
/** No answer at all: the payment must stay where it was. */
export const TOKEN_TIMEOUT = 'tok_01HR0PTtimeout';
/** Authorises cleanly, then gives no answer at capture. */
export const TOKEN_CAPTURE_TIMEOUT = 'tok_01HRPTcapture-timeout';
/** Authorises and captures cleanly, then refuses the refund. */
export const TOKEN_REFUND_DECLINE = 'tok_01HRPTrefund-decline';

export function requestPayment(
  overrides: Partial<RequestPaymentRequest> = {},
): RequestPaymentRequest {
  const n = seq();
  return {
    paymentId: `pay_01HR0PR${n}`,
    orderId: ORDER,
    payerAccountId: PAYER,
    payeeAccountId: PAYEE,
    provider: 'mock',
    rail: 'card',
    instrumentToken: TOKEN_OK,
    assetCode: 'LKR',
    assetScale: 2,
    amountMinor: 1_000_000n,
    requestedAt: '2026-07-01T09:00:00Z',
    correlationId: `corr_01HR0PR${n}`,
    idempotencyKey: `idem_req_${n}`,
    ...overrides,
  };
}

export function authoriseRequest(
  paymentId: string,
  overrides: Partial<AttemptRequest> = {},
): AttemptRequest {
  const n = seq();
  return {
    paymentId,
    attemptId: `pat_01HR0PA${n}`,
    attemptedAt: '2026-07-01T09:05:00Z',
    correlationId: `corr_01HR0PA${n}`,
    idempotencyKey: `idem_auth_${n}`,
    ...overrides,
  };
}

export function captureRequest(
  paymentId: string,
  overrides: Partial<CaptureRequest> = {},
): CaptureRequest {
  const n = seq();
  return {
    paymentId,
    attemptId: `pat_01HR0PC${n}`,
    amountMinor: 1_000_000n,
    attemptedAt: '2026-07-01T09:10:00Z',
    correlationId: `corr_01HR0PC${n}`,
    idempotencyKey: `idem_cap_${n}`,
    ...overrides,
  };
}

export function cancelRequest(
  paymentId: string,
  overrides: Partial<AttemptRequest> = {},
): AttemptRequest {
  const n = seq();
  return {
    paymentId,
    attemptId: `pat_01HR0PX${n}`,
    attemptedAt: '2026-07-01T09:12:00Z',
    correlationId: `corr_01HR0PX${n}`,
    idempotencyKey: `idem_cancel_${n}`,
    ...overrides,
  };
}

export function refundRequest(
  paymentId: string,
  overrides: Partial<RefundPaymentRequest> = {},
): RefundPaymentRequest {
  const n = seq();
  return {
    paymentId,
    refundId: `ref_01HR0PF${n}`,
    attemptId: `pat_01HR0PF${n}`,
    amountMinor: 1_000_000n,
    reason: 'the buyer returned the goods',
    refundedAt: '2026-07-02T09:00:00Z',
    correlationId: `corr_01HR0PF${n}`,
    idempotencyKey: `idem_refund_${n}`,
    ...overrides,
  };
}

export function webhookRequest(
  overrides: Partial<RecordWebhookRequest> = {},
): RecordWebhookRequest {
  const n = seq();
  return {
    receiptId: `whk_01HR0PW${n}`,
    provider: 'mock',
    providerEventId: `evt_mock_${n}`,
    paymentId: null,
    kind: 'payment.updated',
    signatureVerified: true,
    assertedStatus: null,
    assertedAmountMinor: null,
    failureCode: null,
    payload: { source: 'mock', note: 'a provider delivery' },
    receivedAt: '2026-07-01T09:20:00Z',
    correlationId: `corr_01HR0PW${n}`,
    idempotencyKey: `idem_hook_${n}`,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Whole records, for the validators and the repository
// ---------------------------------------------------------------------------

export function paymentRecord(overrides: Partial<Payment> = {}): Payment {
  const n = seq();
  return {
    paymentId: `pay_01HR0PP${n}`,
    orderId: ORDER,
    payerAccountId: PAYER,
    payeeAccountId: PAYEE,
    status: 'requires-authorisation',
    provider: 'mock',
    rail: 'card',
    instrumentToken: TOKEN_OK,
    assetCode: 'LKR',
    assetScale: 2,
    amountMinor: 1_000_000n,
    capturedMinor: 0n,
    refundedMinor: 0n,
    providerReference: null,
    authorisedAt: null,
    capturedAt: null,
    failedAt: null,
    cancelledAt: null,
    failureCode: null,
    createdAt: '2026-07-01T09:00:00Z',
    updatedAt: '2026-07-01T09:00:00Z',
    correlationId: `corr_01HR0PP${n}`,
    idempotencyKey: `idem_prec_${n}`,
    ...overrides,
  };
}

export function attemptRecord(overrides: Partial<PaymentAttempt> = {}): PaymentAttempt {
  const n = seq();
  return {
    attemptId: `pat_01HR0PT${n}`,
    paymentId: `pay_01HR0PT${n}`,
    kind: 'authorise',
    outcome: 'succeeded',
    amountMinor: 1_000_000n,
    providerReference: `mockref_auth_idem_${n}`,
    failureCode: null,
    attemptedAt: '2026-07-01T09:05:00Z',
    correlationId: `corr_01HR0PT${n}`,
    idempotencyKey: `idem_arec_${n}`,
    ...overrides,
  };
}

export function refundRecord(overrides: Partial<Refund> = {}): Refund {
  const n = seq();
  return {
    refundId: `ref_01HR0PD${n}`,
    paymentId: `pay_01HR0PD${n}`,
    amountMinor: 250_000n,
    reason: 'a partial return',
    providerReference: `mockref_refund_idem_${n}`,
    refundedAt: '2026-07-02T09:00:00Z',
    correlationId: `corr_01HR0PD${n}`,
    idempotencyKey: `idem_frec_${n}`,
    ...overrides,
  };
}

export function receiptRecord(overrides: Partial<WebhookReceipt> = {}): WebhookReceipt {
  const n = seq();
  return {
    receiptId: `whk_01HR0PK${n}`,
    provider: 'mock',
    providerEventId: `evt_rec_${n}`,
    paymentId: null,
    kind: 'payment.updated',
    signatureVerified: true,
    payload: { note: 'a delivery' },
    receivedAt: '2026-07-01T09:20:00Z',
    processedAt: null,
    correlationId: `corr_01HR0PK${n}`,
    idempotencyKey: `idem_krec_${n}`,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Journeys the suites reuse
// ---------------------------------------------------------------------------

/** A payment that has been authorised and nothing more. */
export async function authorised(
  harness: Harness,
  overrides: Partial<RequestPaymentRequest> = {},
): Promise<string> {
  const request = requestPayment(overrides);
  await harness.service.requestPayment(request);
  await harness.service.authorisePayment(authoriseRequest(request.paymentId));
  return request.paymentId;
}

/** A payment authorised and captured in full. */
export async function captured(
  harness: Harness,
  overrides: Partial<RequestPaymentRequest> = {},
): Promise<string> {
  const paymentId = await authorised(harness, overrides);
  const payment = await harness.service.getPayment(paymentId);
  await harness.service.capturePayment(
    captureRequest(paymentId, { amountMinor: payment.amountMinor }),
  );
  return paymentId;
}

// ---------------------------------------------------------------------------
// Outbox readers
// ---------------------------------------------------------------------------

export function entriesOfKind(
  repository: InMemoryPaymentRepository,
  kind: 'event' | 'audit',
): readonly { readonly payload: unknown }[] {
  return repository
    .outbox()
    .entries()
    .filter((entry) => entry.kind === kind);
}

/** The `type` of every event entry, oldest first. */
export function eventTypes(repository: InMemoryPaymentRepository): readonly string[] {
  return entriesOfKind(repository, 'event').map(
    (entry) => (entry.payload as { type: string }).type,
  );
}

/** The business payload of the most recent event. */
export function lastEventPayload(repository: InMemoryPaymentRepository): Record<string, unknown> {
  const entry = entriesOfKind(repository, 'event').at(-1);
  return (entry?.payload as { payload: Record<string, unknown> }).payload;
}
