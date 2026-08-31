/**
 * A deterministic payment provider for tests and local development.
 *
 * BL-05 records that no payment sandbox exists, and decision D-006 says every external dependency
 * gets a port and a mock before any live adapter. This is that mock.
 *
 * **Its behaviour is a pure function of the request.** Nothing here reads a clock, generates a
 * random value, or keeps state between calls. That is not a shortcut — a mock whose behaviour
 * cannot be predicted produces tests that cannot be trusted, and a payment suite that passes
 * intermittently is worse than none, because it teaches everyone to re-run it.
 *
 * The outcome is chosen by what the instrument token contains, so a test asks for the case it wants
 * by naming it:
 *
 *     ...decline...       → failed, card-declined
 *     ...insufficient...  → failed, insufficient-funds
 *     ...timeout...       → failed, provider-timeout
 *     ...expired...       → failed, expired-instrument
 *     ...unavailable...   → failed, provider-unavailable
 *     anything else       → succeeded
 *
 * A successful reference is derived from the idempotency key, so retrying one logical operation
 * returns the same reference — which is what lets the reconciliation trail line up after a timeout.
 *
 * Owned by: M-12 Payments.
 */

import type {
  PaymentProvider,
  ProviderAuthoriseRequest,
  ProviderCancelRequest,
  ProviderCaptureRequest,
  ProviderRefundRequest,
  ProviderResult,
} from '../provider.ts';
import type { FailureCode } from '../types.ts';

/** Token substrings that select a failure, in the order they are checked. */
const FAILURE_TRIGGERS: readonly (readonly [string, FailureCode])[] = [
  ['decline', 'card-declined'],
  ['insufficient', 'insufficient-funds'],
  ['timeout', 'provider-timeout'],
  ['expired', 'expired-instrument'],
  ['unavailable', 'provider-unavailable'],
  ['invalid', 'invalid-token'],
  ['risk', 'risk-rejected'],
];

/** The failure this token asks for, or null when it asks for success. */
function failureFor(instrumentToken: string): FailureCode | null {
  const token = instrumentToken.toLowerCase();
  for (const [needle, code] of FAILURE_TRIGGERS) {
    if (token.includes(needle)) return code;
  }
  return null;
}

/**
 * A provider reference derived from the operation, not invented.
 *
 * Deterministic so that a retry of the same logical operation — same idempotency key — yields the
 * same reference, exactly as a real gateway's idempotency support would.
 */
function referenceFor(kind: string, idempotencyKey: string): string {
  return `mockref_${kind}_${idempotencyKey}`;
}

function settle(
  kind: string,
  request: { instrumentToken: string; idempotencyKey: string },
): ProviderResult {
  const failureCode = failureFor(request.instrumentToken);
  if (failureCode !== null) {
    // A declined authorisation has no provider reference: nothing was created to refer to.
    return Object.freeze({ outcome: 'failed' as const, providerReference: null, failureCode });
  }
  return Object.freeze({
    outcome: 'succeeded' as const,
    providerReference: referenceFor(kind, request.idempotencyKey),
    failureCode: null,
  });
}

export class MockPaymentProvider implements PaymentProvider {
  readonly name = 'mock';

  authorise(request: ProviderAuthoriseRequest): Promise<ProviderResult> {
    return Promise.resolve(settle('auth', request));
  }

  capture(request: ProviderCaptureRequest): Promise<ProviderResult> {
    return Promise.resolve(settle('capture', request));
  }

  cancel(request: ProviderCancelRequest): Promise<ProviderResult> {
    return Promise.resolve(settle('cancel', request));
  }

  refund(request: ProviderRefundRequest): Promise<ProviderResult> {
    return Promise.resolve(settle('refund', request));
  }
}

/** Resolve the mock by name, for tests and local development. */
export function resolveMockProvider(provider: string): PaymentProvider {
  if (provider === 'mock') return new MockPaymentProvider();
  throw new Error(`no adapter is registered for provider "${provider}"`);
}
