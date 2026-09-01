/**
 * The payment routes.
 *
 * Two of these are worth reading closely.
 *
 * **The webhook route is the only one that accepts an instruction from outside the platform**, and
 * it is the only one that authenticates with a signature rather than a session. It verifies that
 * signature **here**, over the raw bytes, against a secret only the provider shares — see
 * `webhook-signature.ts`.
 *
 * It did not always. An earlier revision read `signatureVerified` out of the request body and passed
 * it to M-12, which meant anybody who could reach the port could post
 * `{"signatureVerified": true, "assertedStatus": "captured"}` and move a payment. M-12 was doing its
 * part — it refuses `unverified-webhook` outright — but the layer above was letting the attacker
 * supply the answer. A body that still claims the field is now refused by name, for the same reason
 * K-04 refuses a caller who says `allowed: true`: whoever asserts the check has not done it.
 *
 * **No route accepts an instrument.** There is no field for a card number here, and M-12 refuses one
 * by name if a client invents it. What a client sends is a provider token, and the opacity rule
 * refuses anything that looks like the instrument itself.
 *
 * Owned by: apps/api.
 */

import {
  FAILURE_CODES,
  type FailureCode,
  type PaymentService,
} from '../../../modules/payments/index.ts';
import type { RequestContext } from '../../../platform/http/context.ts';
import type { Route, Router } from '../../../platform/http/router.ts';
import { json, type HttpRequest, type HttpResponse } from '../../../platform/http/types.ts';

import { ApiError } from '../errors.ts';
import { readAmount, readInteger, readObject, readOptionalString, readString } from '../reading.ts';
import { verifyWebhookSignature, type WebhookSecrets } from '../webhook-signature.ts';

export interface PaymentRoutesOptions {
  readonly payments: PaymentService;
  readonly contextFor: (request: HttpRequest) => RequestContext;
  /** Per-provider signing secrets. A deployment that configures none accepts no webhook at all. */
  readonly webhookSecrets: WebhookSecrets;
}

export function paymentRoutes(options: PaymentRoutesOptions): readonly Route[] {
  const { payments, contextFor, webhookSecrets } = options;

  return [
    {
      method: 'POST',
      path: '/v1/payments',
      summary: 'Record the intent to pay. No provider is called and no value moves.',
      handler: async (request: HttpRequest): Promise<HttpResponse> => {
        const context = contextFor(request);
        const result = await payments.requestPayment({
          paymentId: context.derivedId('pay', 'payment'),
          orderId: readString(request.body, 'orderId'),
          payerAccountId: readString(request.body, 'payerAccountId'),
          payeeAccountId: readString(request.body, 'payeeAccountId'),
          provider: readString(request.body, 'provider'),
          rail: readString(request.body, 'rail'),
          // The provider's opaque handle. Never an instrument: M-12 refuses a card number here.
          instrumentToken: readString(request.body, 'instrumentToken'),
          assetCode: readString(request.body, 'assetCode'),
          assetScale: readInteger(request.body, 'assetScale', 0, 18),
          amountMinor: readAmount(request.body, 'amountMinor'),
          requestedAt: context.now,
          correlationId: context.correlationId,
          idempotencyKey: context.idempotencyKey,
        });
        return json(result.replayed ? 200 : 201, result);
      },
    },

    {
      method: 'POST',
      path: '/v1/payments/:paymentId/authorisation',
      summary: 'Ask the provider to authorise. Value is reserved, not taken.',
      handler: async (request: HttpRequest): Promise<HttpResponse> => {
        const context = contextFor(request);
        const result = await payments.authorisePayment({
          paymentId: request.params.paymentId ?? '',
          attemptId: context.derivedId('pat', 'authorise'),
          attemptedAt: context.now,
          correlationId: context.correlationId,
          idempotencyKey: context.idempotencyKey,
        });
        return json(200, result);
      },
    },

    {
      method: 'POST',
      path: '/v1/payments/:paymentId/capture',
      summary: 'Ask the provider to capture. This is where value moves.',
      handler: async (request: HttpRequest): Promise<HttpResponse> => {
        const context = contextFor(request);
        const result = await payments.capturePayment({
          paymentId: request.params.paymentId ?? '',
          attemptId: context.derivedId('pat', 'capture'),
          amountMinor: readAmount(request.body, 'amountMinor'),
          attemptedAt: context.now,
          correlationId: context.correlationId,
          idempotencyKey: context.idempotencyKey,
        });
        return json(200, result);
      },
    },

    {
      method: 'POST',
      path: '/v1/payments/:paymentId/cancellation',
      summary: 'Cancel before capture. A captured payment is refunded, not cancelled.',
      handler: async (request: HttpRequest): Promise<HttpResponse> => {
        const context = contextFor(request);
        const result = await payments.cancelPayment({
          paymentId: request.params.paymentId ?? '',
          attemptId: context.derivedId('pat', 'cancel'),
          attemptedAt: context.now,
          correlationId: context.correlationId,
          idempotencyKey: context.idempotencyKey,
        });
        return json(200, result);
      },
    },

    {
      method: 'POST',
      path: '/v1/payments/:paymentId/refunds',
      summary: 'Return captured value, in part or in full.',
      handler: async (request: HttpRequest): Promise<HttpResponse> => {
        const context = contextFor(request);
        const result = await payments.refundPayment({
          paymentId: request.params.paymentId ?? '',
          refundId: context.derivedId('ref', 'refund'),
          attemptId: context.derivedId('pat', 'refund'),
          amountMinor: readAmount(request.body, 'amountMinor'),
          reason: readString(request.body, 'reason'),
          refundedAt: context.now,
          correlationId: context.correlationId,
          idempotencyKey: context.idempotencyKey,
        });
        return json(result.replayed ? 200 : 201, result);
      },
    },

    {
      method: 'POST',
      path: '/v1/payments/webhooks/:provider',
      summary: 'Record a provider delivery, and apply it if it is still relevant.',
      handler: async (request: HttpRequest): Promise<HttpResponse> => {
        const context = contextFor(request);
        const provider = request.params.provider ?? '';

        // Refused by name, before anything else is read. A caller that supplies this field is
        // asserting the outcome of the very check this route exists to perform, and accepting it
        // "because it was probably the gateway" is how the earlier hole worked.
        assertDoesNotAssertVerification(request.body);

        // Throws on anything but a good signature over the exact bytes received, inside the
        // replay window. There is no path past it: the value below is a constant precisely because
        // reaching that line means the check passed.
        verifyWebhookSignature({
          provider,
          rawBody: request.rawBody,
          headers: request.headers,
          secrets: webhookSecrets,
          now: context.now,
        });

        const result = await payments.recordWebhook({
          receiptId: context.derivedId('whk', 'receipt'),
          provider,
          providerEventId: readString(request.body, 'providerEventId'),
          paymentId: readOptionalString(request.body, 'paymentId'),
          kind: readString(request.body, 'kind'),
          // True because `verifyWebhookSignature` did not throw, and for no other reason. This is
          // the one place in the repository where that flag may be set, and it is set from a
          // computation rather than from input.
          signatureVerified: true,
          assertedStatus: readOptionalString(request.body, 'assertedStatus'),
          assertedAmountMinor:
            readOptionalString(request.body, 'assertedAmountMinor') === null
              ? null
              : readAmount(request.body, 'assertedAmountMinor'),
          failureCode: readFailureCode(request.body),
          payload: readObject(request.body, 'payload'),
          receivedAt: context.now,
          correlationId: context.correlationId,
          idempotencyKey: context.idempotencyKey,
        });
        // 202 rather than 200: the delivery was accepted and dealt with, and whether it moved the
        // payment is in the body. A provider retrying on anything but 2xx would retry for ever on a
        // stale event, which is exactly the delivery that should stop.
        return json(202, result);
      },
    },

    {
      method: 'GET',
      path: '/v1/payments/:paymentId',
      summary: 'Read one payment.',
      handler: async (request: HttpRequest): Promise<HttpResponse> =>
        json(200, { payment: await payments.getPayment(request.params.paymentId ?? '') }),
    },

    {
      method: 'GET',
      path: '/v1/payments/:paymentId/attempts',
      summary: 'List every provider call made for a payment. The reconciliation trail.',
      handler: async (request: HttpRequest): Promise<HttpResponse> =>
        json(200, { attempts: await payments.listAttempts(request.params.paymentId ?? '') }),
    },

    {
      method: 'GET',
      path: '/v1/payments/:paymentId/refunds',
      summary: 'List the refunds against a payment.',
      handler: async (request: HttpRequest): Promise<HttpResponse> =>
        json(200, { refunds: await payments.listRefunds(request.params.paymentId ?? '') }),
    },

    {
      method: 'GET',
      path: '/v1/payments/:paymentId/receipts',
      summary: 'List the provider deliveries recorded against a payment.',
      handler: async (request: HttpRequest): Promise<HttpResponse> =>
        json(200, { receipts: await payments.listReceipts(request.params.paymentId ?? '') }),
    },

    {
      method: 'GET',
      path: '/v1/orders/:orderId/payments',
      summary: 'List the payments against an order.',
      handler: async (request: HttpRequest): Promise<HttpResponse> =>
        json(200, {
          payments: await payments.listPaymentsForOrder(request.params.orderId ?? ''),
        }),
    },
  ];
}

/**
 * The provider's failure code, checked against M-12's vocabulary here rather than cast into it.
 *
 * A cast would compile and then hand M-12 a string it does not recognise, which it would refuse
 * with a message about its own internals. Checking here means the client is told what the accepted
 * values are, by an error that knows it is talking to a client.
 */
function readFailureCode(body: unknown): FailureCode | null {
  const value = readOptionalString(body, 'failureCode');
  if (value === null) return null;
  if (!(FAILURE_CODES as readonly string[]).includes(value)) {
    throw new ApiError(
      400,
      'unknown-failure-code',
      `"failureCode" was "${value}". The accepted values are ${FAILURE_CODES.join(', ')}.`,
    );
  }
  return value as FailureCode;
}

/**
 * Refuse a body that claims the signature has already been checked.
 *
 * The same principle K-04 applies to `allowed: true`: a field that states the outcome of a check is
 * a field the checker must not read. Refused by name and with the reason, so a client that inherited
 * the old shape is told what changed rather than left guessing why its delivery stopped working.
 */
function assertDoesNotAssertVerification(body: unknown): void {
  if (typeof body !== 'object' || body === null) return;
  for (const field of ['signatureVerified', 'signature_verified', 'verified', 'trusted']) {
    if (field in (body as Record<string, unknown>)) {
      throw new ApiError(
        400,
        'caller-asserted-verification',
        `"${field}" is not a field a caller may send. Whether a delivery is genuine is computed ` +
          'here, from the signature over the bytes you sent; a sender who could assert it would be ' +
          'a sender who never had to sign anything.',
      );
    }
  }
}

export function addPaymentRoutes(router: Router, options: PaymentRoutesOptions): Router {
  for (const route of paymentRoutes(options)) router.add(route);
  return router;
}
