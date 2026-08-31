/**
 * M-12 Payments — domain types.
 *
 * Provider-neutral authorise, capture, cancel and refund. M-12 is the only unit permitted to hold
 * provider knowledge, and it holds it behind a port: no business module names a gateway, and no
 * gateway SDK is imported anywhere in this repository.
 *
 * **This module never stores an instrument.** No card number, no PAN, no CVV, no expiry, no bank
 * account, no IBAN, no cardholder name. It stores an opaque provider token and nothing else. A
 * payment record outlives the transaction it describes and is copied into every downstream
 * projection, so a PAN written into one is disclosed for as long as the platform exists and no
 * later deletion policy can recall it.
 *
 * Deterministic by construction: the caller supplies every identifier and every instant. Nothing
 * here reads a clock or generates randomness.
 *
 * Owned by: M-12 Payments.
 */

/** Lifecycle of a payment. */
export const PAYMENT_STATUSES = [
  'requires-authorisation',
  'authorised',
  'captured',
  'partially-refunded',
  'refunded',
  'failed',
  'cancelled',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** What a call to the provider was trying to do. */
export const ATTEMPT_KINDS = ['authorise', 'capture', 'cancel', 'refund'] as const;
export type AttemptKind = (typeof ATTEMPT_KINDS)[number];

export const ATTEMPT_OUTCOMES = ['succeeded', 'failed'] as const;
export type AttemptOutcome = (typeof ATTEMPT_OUTCOMES)[number];

/**
 * Why a provider refused, as a closed vocabulary.
 *
 * A provider's own message is prose in a language nobody chose, and a caller cannot branch on it.
 * The adapter maps whatever the provider said onto one of these, and an unrecognised reason becomes
 * `provider-error` rather than being passed through — an unmapped string in this column would
 * eventually be parsed by somebody.
 */
export const FAILURE_CODES = [
  'card-declined',
  'insufficient-funds',
  'expired-instrument',
  'invalid-token',
  'risk-rejected',
  'provider-timeout',
  'provider-unavailable',
  'provider-error',
] as const;
export type FailureCode = (typeof FAILURE_CODES)[number];

/**
 * The legal transitions. The state machine is a table, not scattered `if`s.
 *
 * `refunded`, `failed` and `cancelled` are terminal. `partially-refunded` maps to itself only
 * through `refunded`: a second partial refund does not change the status, so it records a `Refund`
 * row and no transition — a transition that does not change the status is not a transition.
 */
export const PAYMENT_TRANSITIONS: Readonly<Record<PaymentStatus, readonly PaymentStatus[]>> =
  Object.freeze({
    'requires-authorisation': ['authorised', 'failed', 'cancelled'],
    authorised: ['captured', 'failed', 'cancelled'],
    captured: ['partially-refunded', 'refunded'],
    'partially-refunded': ['refunded'],
    refunded: [],
    failed: [],
    cancelled: [],
  });

/**
 * One payment against one order.
 *
 * `orderId` is an opaque M-11 identifier and deliberately not a foreign key: M-11 is the same layer
 * as M-12, so the two communicate by event and neither joins to the other's tables.
 */
export interface Payment {
  /** Caller-supplied opaque and stable identifier. */
  readonly paymentId: string;
  /** The M-11 order being paid for. Not a foreign key. */
  readonly orderId: string;
  /** The K-03 account paying. */
  readonly payerAccountId: string;
  /** The K-03 account being paid. */
  readonly payeeAccountId: string;
  /** Current lifecycle status. */
  readonly status: PaymentStatus;
  /** Which provider adapter handles this payment, as a vocabulary word. */
  readonly provider: string;
  /**
   * The provider's opaque token for the instrument.
   *
   * **Never an instrument.** The provider holds the card; this is the handle it gave back.
   */
  readonly instrumentToken: string;
  /** ISO-4217 currency code, three uppercase letters. */
  readonly currency: string;
  /** The authorised amount in integer minor units. */
  readonly amountMinor: bigint;
  /** How much has been captured. Never exceeds `amountMinor`. */
  readonly capturedMinor: bigint;
  /** How much has been refunded. Never exceeds `capturedMinor`. */
  readonly refundedMinor: bigint;
  /** The provider's reference for the authorisation, or null before one exists. */
  readonly providerReference: string | null;
  readonly authorisedAt: string | null;
  readonly capturedAt: string | null;
  readonly failedAt: string | null;
  readonly cancelledAt: string | null;
  /** The vocabulary reason the payment failed, or null. */
  readonly failureCode: FailureCode | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
}

/**
 * One call to the provider, recorded whether it succeeded or not. Append-only.
 *
 * This is the reconciliation trail: what was asked, what came back, and when. A payment that
 * disagrees with the provider is settled by reading these rows, so a failed attempt is as important
 * to keep as a successful one.
 */
export interface PaymentAttempt {
  readonly attemptId: string;
  readonly paymentId: string;
  readonly kind: AttemptKind;
  readonly outcome: AttemptOutcome;
  /** The amount this attempt moved, in integer minor units. */
  readonly amountMinor: bigint;
  /** The provider's own handle for this operation, for reconciliation. Null when it failed early. */
  readonly providerReference: string | null;
  readonly failureCode: FailureCode | null;
  readonly attemptedAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
}

/** One refund against a captured payment. Append-only. */
export interface Refund {
  readonly refundId: string;
  readonly paymentId: string;
  readonly amountMinor: bigint;
  readonly reason: string;
  readonly providerReference: string | null;
  readonly refundedAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
}

/**
 * One webhook delivery, recorded before it is believed. Append-only.
 *
 * A webhook is untrusted input from outside the platform: an instruction from a stranger to move
 * money. It is recorded first, believed once, and refused outright when the caller has not verified
 * its signature.
 */
export interface WebhookReceipt {
  readonly receiptId: string;
  readonly provider: string;
  /**
   * The provider's own event id. `UNIQUE (provider, provider_event_id)` is what makes a webhook
   * delivered twice — which every provider does — take effect exactly once.
   */
  readonly providerEventId: string;
  /** The payment it names, or null when M-12 does not know that payment. */
  readonly paymentId: string | null;
  /** The provider's event kind, as it sent it. */
  readonly kind: string;
  /** Whether the caller verified the signature before handing it over. */
  readonly signatureVerified: boolean;
  /** What arrived, recorded verbatim so a dispute can be reconstructed. */
  readonly payload: Readonly<Record<string, unknown>>;
  readonly receivedAt: string;
  /** When M-12 acted on it, or null while it is still only recorded. */
  readonly processedAt: string | null;
  readonly correlationId: string;
  readonly idempotencyKey: string;
}

export type PaymentErrorCode =
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
  /** A payment id already exists with different content. */
  | 'duplicate-payment-id'
  /** An attempt id already exists with different content. */
  | 'duplicate-attempt-id'
  /** A refund id already exists with different content. */
  | 'duplicate-refund-id'
  /** This provider event has already been received. */
  | 'duplicate-webhook'
  /** The caller did not verify the webhook signature. */
  | 'unverified-webhook'
  /** The status is not one M-12 recognises. */
  | 'unknown-status'
  /** The attempt kind is not one M-12 recognises. */
  | 'unknown-attempt-kind'
  /** The failure code is not one M-12 recognises. */
  | 'unknown-failure-code'
  /** No adapter is registered for this provider. */
  | 'unknown-provider'
  /** The payment id is unknown. */
  | 'payment-not-found'
  /** The payment is in a terminal state and refuses further movement. */
  | 'payment-terminal'
  /** The requested transition is not in the state machine. */
  | 'illegal-transition'
  /** The capture would exceed the authorised amount. */
  | 'over-capture'
  /** The refund would exceed the captured amount. */
  | 'over-refund'
  /** Not three uppercase letters. */
  | 'malformed-currency'
  /** The instrument token is not an opaque handle. */
  | 'malformed-token'
  /** The reason text is empty, blank or too long. */
  | 'malformed-reason'
  /** An amount is negative, or not an exact integer. */
  | 'negative-amount'
  /** The provider refused. `failureCode` says why. */
  | 'provider-failed';

/** A refusal the caller must act on. */
export class PaymentError extends Error {
  readonly code: PaymentErrorCode;

  constructor(code: PaymentErrorCode, message: string) {
    super(message);
    this.name = 'PaymentError';
    this.code = code;
  }
}
