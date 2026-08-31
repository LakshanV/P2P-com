/**
 * M-12 Payments — validation of complete records, wherever they came from.
 *
 * One function per record type, called by the service on the way in and by the PostgreSQL decoder
 * on the way out. There is no second list of rules to keep in step.
 *
 * Money is validated in three accepted forms — a `bigint`, a non-negative **safe** integer, or a
 * digits-only string — the same three K-10 accepts, and for the same reasons: the string form is
 * what PostgreSQL returns for a `bigint`, and the safe-integer check is what stops a value that has
 * already lost precision from being stored as though it had not.
 *
 * Owned by: M-12 Payments.
 */

import { formatInstant, InvalidInstantError, parseInstant } from '../../platform/time/instant.ts';

import {
  assertAssetScale,
  assertAttemptKind,
  assertAttemptOutcome,
  assertOptionalFailureCode,
  assertPaymentIdentifier,
  assertPaymentRail,
  assertPaymentStatus,
  assertSettlementAsset,
} from './registry.ts';
import {
  PaymentError,
  type Payment,
  type PaymentAttempt,
  type Refund,
  type WebhookReceipt,
} from './types.ts';

/** Where the record came from. Only affects the wording of a refusal. */
export type RecordSource = 'request' | 'stored row';

export const STORED_ROW_NOTE =
  'A stored row that fails this was not written by this component — refusing it rather than ' +
  'presenting it as a real record';

// ---------------------------------------------------------------------------
// Payment
// ---------------------------------------------------------------------------

const PAYMENT_FIELDS: readonly string[] = [
  'paymentId',
  'orderId',
  'payerAccountId',
  'payeeAccountId',
  'status',
  'provider',
  'instrumentToken',
  'rail',
  'assetCode',
  'assetScale',
  'amountMinor',
  'capturedMinor',
  'refundedMinor',
  'providerReference',
  'authorisedAt',
  'capturedAt',
  'failedAt',
  'cancelledAt',
  'failureCode',
  'createdAt',
  'updatedAt',
  'correlationId',
  'idempotencyKey',
];

export function validatePayment(candidate: unknown, source: RecordSource): Payment {
  try {
    return checkPayment(candidate, source);
  } catch (error) {
    if (source === 'request' || !(error instanceof PaymentError)) throw error;
    throw new PaymentError(error.code, `${error.message}. ${STORED_ROW_NOTE}`);
  }
}

function checkPayment(candidate: unknown, source: RecordSource): Payment {
  const fields = asObject(candidate, 'a payment', PAYMENT_FIELDS);

  const amountMinor = assertNonNegativeBigint(fields.amountMinor, 'amountMinor');
  const capturedMinor = assertNonNegativeBigint(fields.capturedMinor, 'capturedMinor');
  const refundedMinor = assertNonNegativeBigint(fields.refundedMinor, 'refundedMinor');

  // The two invariants that keep a payment honest, checked here and again as database CHECKs.
  // Without them a refund can quietly exceed what was taken, and the difference is money the
  // platform never held.
  if (capturedMinor > amountMinor) {
    throw new PaymentError(
      'over-capture',
      `capturedMinor ${String(capturedMinor)} exceeds the authorised ${String(amountMinor)}`,
    );
  }
  if (refundedMinor > capturedMinor) {
    throw new PaymentError(
      'over-refund',
      `refundedMinor ${String(refundedMinor)} exceeds the captured ${String(capturedMinor)}`,
    );
  }

  return {
    paymentId: assertPaymentIdentifier(fields.paymentId, 'paymentId'),
    orderId: assertPaymentIdentifier(fields.orderId, 'orderId'),
    payerAccountId: assertPaymentIdentifier(fields.payerAccountId, 'payerAccountId'),
    payeeAccountId: assertPaymentIdentifier(fields.payeeAccountId, 'payeeAccountId'),
    status: assertPaymentStatus(fields.status, 'status'),
    provider: assertVocabularyWord(fields.provider, 'provider'),
    instrumentToken: assertInstrumentToken(fields.instrumentToken, 'instrumentToken'),
    rail: assertPaymentRail(fields.rail, 'rail'),
    assetCode: assertSettlementAsset(fields.assetCode, 'assetCode'),
    assetScale: assertAssetScale(fields.assetScale, 'assetScale'),
    amountMinor,
    capturedMinor,
    refundedMinor,
    providerReference: assertOptionalReference(fields.providerReference, 'providerReference'),
    authorisedAt: assertOptionalInstant(fields.authorisedAt, 'authorisedAt', source),
    capturedAt: assertOptionalInstant(fields.capturedAt, 'capturedAt', source),
    failedAt: assertOptionalInstant(fields.failedAt, 'failedAt', source),
    cancelledAt: assertOptionalInstant(fields.cancelledAt, 'cancelledAt', source),
    failureCode: assertOptionalFailureCode(fields.failureCode, 'failureCode'),
    createdAt: checkInstant(fields.createdAt, 'createdAt', source),
    updatedAt: checkInstant(fields.updatedAt, 'updatedAt', source),
    correlationId: assertPaymentIdentifier(fields.correlationId, 'correlationId'),
    idempotencyKey: assertPaymentIdentifier(fields.idempotencyKey, 'idempotencyKey'),
  };
}

// ---------------------------------------------------------------------------
// Attempt
// ---------------------------------------------------------------------------

const ATTEMPT_FIELDS: readonly string[] = [
  'attemptId',
  'paymentId',
  'kind',
  'outcome',
  'amountMinor',
  'providerReference',
  'failureCode',
  'attemptedAt',
  'correlationId',
  'idempotencyKey',
];

export function validatePaymentAttempt(candidate: unknown, source: RecordSource): PaymentAttempt {
  try {
    return checkAttempt(candidate, source);
  } catch (error) {
    if (source === 'request' || !(error instanceof PaymentError)) throw error;
    throw new PaymentError(error.code, `${error.message}. ${STORED_ROW_NOTE}`);
  }
}

function checkAttempt(candidate: unknown, source: RecordSource): PaymentAttempt {
  const fields = asObject(candidate, 'a payment attempt', ATTEMPT_FIELDS);
  const outcome = assertAttemptOutcome(fields.outcome, 'outcome');
  const failureCode = assertOptionalFailureCode(fields.failureCode, 'failureCode');

  // A failed attempt says why, and a successful one does not claim to have failed. Either half of
  // this being wrong makes the reconciliation trail unreadable.
  if (outcome === 'failed' && failureCode === null) {
    throw new PaymentError(
      'malformed-record',
      'a failed attempt must carry a failureCode; a failure nobody can attribute is a support ticket',
    );
  }
  if (outcome === 'succeeded' && failureCode !== null) {
    throw new PaymentError(
      'malformed-record',
      `a succeeded attempt carries failureCode "${failureCode}"`,
    );
  }

  return {
    attemptId: assertPaymentIdentifier(fields.attemptId, 'attemptId'),
    paymentId: assertPaymentIdentifier(fields.paymentId, 'paymentId'),
    kind: assertAttemptKind(fields.kind, 'kind'),
    outcome,
    amountMinor: assertNonNegativeBigint(fields.amountMinor, 'amountMinor'),
    providerReference: assertOptionalReference(fields.providerReference, 'providerReference'),
    failureCode,
    attemptedAt: checkInstant(fields.attemptedAt, 'attemptedAt', source),
    correlationId: assertPaymentIdentifier(fields.correlationId, 'correlationId'),
    idempotencyKey: assertPaymentIdentifier(fields.idempotencyKey, 'idempotencyKey'),
  };
}

// ---------------------------------------------------------------------------
// Refund
// ---------------------------------------------------------------------------

const REFUND_FIELDS: readonly string[] = [
  'refundId',
  'paymentId',
  'amountMinor',
  'reason',
  'providerReference',
  'refundedAt',
  'correlationId',
  'idempotencyKey',
];

export function validateRefund(candidate: unknown, source: RecordSource): Refund {
  try {
    return checkRefund(candidate, source);
  } catch (error) {
    if (source === 'request' || !(error instanceof PaymentError)) throw error;
    throw new PaymentError(error.code, `${error.message}. ${STORED_ROW_NOTE}`);
  }
}

function checkRefund(candidate: unknown, source: RecordSource): Refund {
  const fields = asObject(candidate, 'a refund', REFUND_FIELDS);
  const amountMinor = assertNonNegativeBigint(fields.amountMinor, 'amountMinor');
  if (amountMinor === 0n) {
    throw new PaymentError('negative-amount', 'a refund of zero is not a refund');
  }

  return {
    refundId: assertPaymentIdentifier(fields.refundId, 'refundId'),
    paymentId: assertPaymentIdentifier(fields.paymentId, 'paymentId'),
    amountMinor,
    reason: assertBoundedText(fields.reason, 'reason', 1, 500, 'malformed-reason'),
    providerReference: assertOptionalReference(fields.providerReference, 'providerReference'),
    refundedAt: checkInstant(fields.refundedAt, 'refundedAt', source),
    correlationId: assertPaymentIdentifier(fields.correlationId, 'correlationId'),
    idempotencyKey: assertPaymentIdentifier(fields.idempotencyKey, 'idempotencyKey'),
  };
}

// ---------------------------------------------------------------------------
// Webhook receipt
// ---------------------------------------------------------------------------

const RECEIPT_FIELDS: readonly string[] = [
  'receiptId',
  'provider',
  'providerEventId',
  'paymentId',
  'kind',
  'signatureVerified',
  'payload',
  'receivedAt',
  'processedAt',
  'correlationId',
  'idempotencyKey',
];

export function validateWebhookReceipt(candidate: unknown, source: RecordSource): WebhookReceipt {
  try {
    return checkReceipt(candidate, source);
  } catch (error) {
    if (source === 'request' || !(error instanceof PaymentError)) throw error;
    throw new PaymentError(error.code, `${error.message}. ${STORED_ROW_NOTE}`);
  }
}

function checkReceipt(candidate: unknown, source: RecordSource): WebhookReceipt {
  const fields = asObject(candidate, 'a webhook receipt', RECEIPT_FIELDS);
  if (typeof fields.signatureVerified !== 'boolean') {
    throw new PaymentError(
      'malformed-record',
      `signatureVerified is ${typeof fields.signatureVerified}; expected a boolean`,
    );
  }

  return {
    receiptId: assertPaymentIdentifier(fields.receiptId, 'receiptId'),
    provider: assertVocabularyWord(fields.provider, 'provider'),
    // Not an opaque-identifier check: this is the provider's own id, and its shape is the
    // provider's business. It is bounded and non-empty so it can be a unique key, and nothing more
    // is claimed about it.
    providerEventId: assertBoundedText(
      fields.providerEventId,
      'providerEventId',
      1,
      200,
      'malformed-record',
    ),
    paymentId:
      fields.paymentId === null || fields.paymentId === undefined
        ? null
        : assertPaymentIdentifier(fields.paymentId, 'paymentId'),
    kind: assertBoundedText(fields.kind, 'kind', 1, 100, 'malformed-record'),
    signatureVerified: fields.signatureVerified,
    payload: assertJsonObject(fields.payload, 'payload'),
    receivedAt: checkInstant(fields.receivedAt, 'receivedAt', source),
    processedAt: assertOptionalInstant(fields.processedAt, 'processedAt', source),
    correlationId: assertPaymentIdentifier(fields.correlationId, 'correlationId'),
    idempotencyKey: assertPaymentIdentifier(fields.idempotencyKey, 'idempotencyKey'),
  };
}

// ---------------------------------------------------------------------------
// Shared assertions
// ---------------------------------------------------------------------------

function asObject(
  candidate: unknown,
  what: string,
  permitted: readonly string[],
): Record<string, unknown> {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new PaymentError(
      'malformed-record',
      `${what} must be an object, got ${candidate === null ? 'null' : typeof candidate}`,
    );
  }
  for (const key of Object.keys(candidate)) {
    if (!permitted.includes(key)) {
      throw new PaymentError(
        'malformed-record',
        `${what} carried the unrecognised field "${key}"; the permitted fields are ` +
          permitted.join(', '),
      );
    }
  }
  return candidate as Record<string, unknown>;
}

/**
 * The instrument token, held to the same opacity rule as every identifier.
 *
 * This is the check that keeps the instrument on the provider's side of the boundary. A card
 * number is a long digit run, an IBAN has its own shape, an email has an `@` — and K-03's rule set
 * refuses all of them. A "token" with any of those shapes is not a token.
 */
function assertInstrumentToken(value: unknown, field: string): string {
  try {
    return assertPaymentIdentifier(value, field);
  } catch (error) {
    if (!(error instanceof PaymentError)) throw error;
    throw new PaymentError(
      'malformed-token',
      `${error.message}. An instrument token is an opaque handle the provider gave back; the ` +
        'instrument itself must never reach this module',
    );
  }
}

/** A provider's own reference, bounded and non-empty but otherwise the provider's business. */
function assertOptionalReference(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  return assertBoundedText(value, field, 1, 200, 'malformed-record');
}

/** A closed-vocabulary word: lowercase, starts with a letter, kebab or underscore separated. */
function assertVocabularyWord(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(value)) {
    throw new PaymentError(
      'malformed-record',
      `${field} is "${String(value)}"; expected a lowercase word of 1-64 characters starting with ` +
        'a letter',
    );
  }
  return value;
}

function assertBoundedText(
  value: unknown,
  field: string,
  min: number,
  max: number,
  code: 'malformed-reason' | 'malformed-record',
): string {
  if (typeof value !== 'string') {
    throw new PaymentError(
      code,
      `${field} is ${value === null ? 'null' : typeof value}; expected text`,
    );
  }
  // Trimmed, so whitespace cannot pass for content — the database says `length(btrim(...)) > 0`
  // and a validator that disagreed would let TypeScript accept what PostgreSQL refuses.
  if (value.trim().length < min || value.length > max) {
    throw new PaymentError(
      code,
      `${field} is ${value.length} characters; expected ${min}-${max}, not blank`,
    );
  }
  return value;
}

function assertJsonObject(value: unknown, field: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new PaymentError(
      'malformed-record',
      `${field} must be a JSON object, got ${value === null ? 'null' : typeof value}`,
    );
  }
  return value as Record<string, unknown>;
}

/** Money, in the three forms K-10 accepts. */
function assertNonNegativeBigint(value: unknown, field: string): bigint {
  if (typeof value === 'bigint') {
    if (value < 0n) {
      throw new PaymentError('negative-amount', `${field} is ${String(value)}; expected >= 0`);
    }
    return value;
  }
  if (typeof value === 'string') {
    if (!/^\d+$/.test(value)) {
      throw new PaymentError(
        'negative-amount',
        `${field} "${value}" is not a non-negative integer string`,
      );
    }
    return BigInt(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new PaymentError(
        'negative-amount',
        `${field} is ${String(value)}; expected a non-negative safe integer`,
      );
    }
    return BigInt(value);
  }
  throw new PaymentError(
    'negative-amount',
    `${field} is ${value === null ? 'null' : typeof value}; expected an integer minor-unit amount`,
  );
}

/** The exact form `to_char(...)` emits for a timestamptz. */
const STORED_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/;

function checkInstant(value: unknown, field: string, source: RecordSource): string {
  if (source === 'stored row') {
    if (typeof value !== 'string') {
      throw new PaymentError(
        'malformed-record',
        `${field} came back as ${value instanceof Date ? 'a Date' : typeof value} rather than ` +
          'text. Timestamps are projected through to_char precisely so the driver never parses them',
      );
    }
    if (STORED_INSTANT.exec(value) === null) {
      throw new PaymentError(
        'malformed-record',
        `${field} holds "${value}", which is not a finite UTC timestamp in the projected form ` +
          'YYYY-MM-DDTHH:MM:SS.ffffffZ',
      );
    }
    try {
      return formatInstant(parseInstant(value).epochMicros);
    } catch (error) {
      if (error instanceof InvalidInstantError) {
        throw new PaymentError('malformed-record', `${field}: ${error.message}`);
      }
      throw error;
    }
  }

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

function assertOptionalInstant(value: unknown, field: string, source: RecordSource): string | null {
  if (value === null || value === undefined) return null;
  return checkInstant(value, field, source);
}
