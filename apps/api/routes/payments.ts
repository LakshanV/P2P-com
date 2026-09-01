/**
 * The payment routes.
 *
 * Two of these are worth reading closely.
 *
 * **The webhook route is the only one that accepts an instruction from outside the platform**, and
 * it is the only one where `signatureVerified` matters. This layer does not verify the signature —
 * the transport in front of it holds the signing secret — but it passes the caller's answer through
 * honestly, and M-12 refuses to act on a delivery nobody verified. A route that hardcoded `true`
 * would be the single worst line in this repository.
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
import {
  readAmount,
  readBoolean,
  readInteger,
  readObject,
  readOptionalString,
  readString,
} from '../reading.ts';

export interface PaymentRoutesOptions {
  readonly payments: PaymentService;
  readonly contextFor: (request: HttpRequest) => RequestContext;
}

export function paymentRoutes(options: PaymentRoutesOptions): readonly Route[] {
  const { payments, contextFor } = options;

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
        const result = await payments.recordWebhook({
          receiptId: context.derivedId('whk', 'receipt'),
          provider: request.params.provider ?? '',
          providerEventId: readString(request.body, 'providerEventId'),
          paymentId: readOptionalString(request.body, 'paymentId'),
          kind: readString(request.body, 'kind'),
          // Passed through from the transport that actually holds the signing secret. Hardcoding
          // this to true would make every webhook route an unauthenticated way to move money.
          signatureVerified: readBoolean(request.body, 'signatureVerified'),
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

export function addPaymentRoutes(router: Router, options: PaymentRoutesOptions): Router {
  for (const route of paymentRoutes(options)) router.add(route);
  return router;
}
