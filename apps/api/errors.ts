/**
 * Refusal codes, and what each one means over HTTP.
 *
 * Every module in this platform refuses with a machine-readable code. This file is where those
 * codes acquire a status, and it is written as a **table rather than a heuristic** — no prefix
 * matching, no "if it contains `not-found`". A heuristic is right until a module adds a code it did
 * not anticipate, and then it is silently wrong for that one.
 *
 * The distinction the table keeps returning to:
 *
 *   * **400** — the request is malformed. The client sent something that is not a request.
 *   * **409** — the request is well formed and conflicts with what already exists. A retry with the
 *     same content will keep conflicting; the client has to look at what is there.
 *   * **422** — the request is well formed and describes something the domain will not do. A
 *     capture larger than the authorisation, a transition the state machine does not have. Nothing
 *     about it is a syntax problem, and nothing about it is a race.
 *   * **502** — an upstream said no. The failure is not the client's and not ours.
 *
 * A code this file does not list produces a 500 and reaches the observer intact, which is correct:
 * an unclassified refusal is a gap in this table, and a gap should be loud.
 *
 * Owned by: apps/api.
 */

import { FinancialLedgerError } from '../../modules/financial-ledger/index.ts';
import { OrderError } from '../../modules/orders/index.ts';
import { PaymentError } from '../../modules/payments/index.ts';
import type { DescribeError } from '../../platform/http/pipeline.ts';

/** Codes shared by every module, because they come from the same K-03 identifier rules. */
const SHARED: Readonly<Record<string, number>> = Object.freeze({
  'malformed-identifier': 400,
  'natural-identifier': 400,
  'secret-bearing-input': 400,
  'malformed-instant': 400,
  'malformed-record': 400,
  'malformed-reason': 400,
  'foreign-concern': 400,
  'unknown-status': 400,
  'idempotency-key-reuse': 409,
  // A nested transaction is a wiring mistake in this repository, not something a client did.
  'nested-transaction': 500,
});

const ORDERS: Readonly<Record<string, number>> = Object.freeze({
  ...SHARED,
  'order-not-found': 404,
  'duplicate-order-id': 409,
  'duplicate-item-id': 409,
  'duplicate-snapshot-id': 409,
  'duplicate-event-id': 409,
  'snapshot-exists': 409,
  'already-split': 409,
  'illegal-transition': 422,
  'order-not-placed': 422,
  'nested-split': 422,
  'empty-allocation': 422,
  'allocation-mismatch': 422,
  'allocation-currency-mismatch': 422,
  'children-outstanding': 422,
  'nothing-fulfilled': 422,
  'unknown-cancellation-reason': 400,
  'total-mismatch': 422,
  'currency-mismatch': 422,
  'no-items': 422,
  'negative-amount': 400,
});

const PAYMENTS: Readonly<Record<string, number>> = Object.freeze({
  ...SHARED,
  'payment-not-found': 404,
  'duplicate-payment-id': 409,
  'duplicate-attempt-id': 409,
  'duplicate-refund-id': 409,
  // A redelivered webhook is not an error the caller should act on, but if it surfaces it is a
  // conflict rather than a failure: the event exists and was handled.
  'duplicate-webhook': 409,
  // The caller did not verify the provider's signature, so the request is unauthenticated.
  'unverified-webhook': 401,
  'illegal-transition': 422,
  'payment-terminal': 422,
  'over-capture': 422,
  'over-refund': 422,
  'internal-value-not-settleable': 422,
  'unsupported-settlement': 422,
  'unknown-provider': 422,
  'unknown-rail': 400,
  'unknown-attempt-kind': 400,
  'unknown-failure-code': 400,
  'malformed-asset-code': 400,
  'malformed-asset-scale': 400,
  'malformed-token': 400,
  'negative-amount': 400,
  // The gateway refused or did not answer. Not the client's fault and not ours.
  'provider-failed': 502,
});

const LEDGER: Readonly<Record<string, number>> = Object.freeze({
  ...SHARED,
  'wallet-not-found': 404,
  'plan-not-found': 404,
  'leg-not-found': 404,
  'duplicate-wallet-id': 409,
  'duplicate-plan-id': 409,
  'duplicate-leg-id': 409,
  'wallet-exists': 409,
  'wallet-frozen': 409,
  'wallet-closed': 409,
  'wallet-not-empty': 409,
  'illegal-transition': 422,
  'plan-terminal': 422,
  'allocation-mismatch': 422,
  'rate-mismatch': 422,
  'malformed-rate': 400,
  'empty-allocation': 422,
  'multiple-external-legs': 422,
  'external-leg-mismatch': 422,
  'leg-asset-mismatch': 422,
  'leg-self-transfer': 422,
  'invalid-amount': 400,
  'unknown-purpose': 400,
  // K-10 refused a posting M-13 built. That is a defect here, not a client mistake.
  'ledger-refused': 500,
});

/**
 * Classify a refusal.
 *
 * Returns null for anything unrecognised, which the pipeline turns into a 500 and hands to the
 * observer whole. That is deliberate: a module code missing from the tables above is a gap, and a
 * gap that quietly became a 400 would stay missing.
 */
export const describeError: DescribeError = (error) => {
  const table =
    error instanceof OrderError
      ? ORDERS
      : error instanceof PaymentError
        ? PAYMENTS
        : error instanceof FinancialLedgerError
          ? LEDGER
          : null;

  if (table === null) return null;

  const code = (error as { code: string }).code;
  const status = table[code];
  if (status === undefined) return null;

  return { status, code, detail: (error as Error).message };
};

/** Every code this API knows how to answer, for the test that checks none is missing. */
export const CLASSIFIED_CODES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  orders: Object.freeze(Object.keys(ORDERS)),
  payments: Object.freeze(Object.keys(PAYMENTS)),
  'financial-ledger': Object.freeze(Object.keys(LEDGER)),
});

/**
 * A refusal raised by the API itself rather than by a module.
 *
 * Used for the things a module never sees because the request never got that far: a missing field,
 * an unparseable number, an absent header.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/** Classify an `ApiError`, or defer to the module tables. */
export const describeApiError: DescribeError = (error) => {
  if (error instanceof ApiError) {
    return { status: error.status, code: error.code, detail: error.message };
  }
  return describeError(error);
};
