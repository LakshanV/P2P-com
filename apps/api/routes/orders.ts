/**
 * The order routes.
 *
 * Every handler does the same four things: read what the client sent, take the identifiers and the
 * instant from the request context, call M-11, and return what it said. The context is doing real
 * work here — M-11 refuses to invent an id or read a clock, so *somebody* has to, and it is the
 * request rather than the module.
 *
 * The identifiers a retry must reuse are **derived** from the caller's `Idempotency-Key`. That is
 * what makes `POST /orders` safe to retry: the same key produces the same order id, so the second
 * attempt converges on the record the first created instead of opening a second order.
 *
 * Owned by: apps/api.
 */

import type { OrderService } from '../../../modules/orders/index.ts';
import type { RequestContext } from '../../../platform/http/context.ts';
import type { Route, Router } from '../../../platform/http/router.ts';
import { json, type HttpRequest, type HttpResponse } from '../../../platform/http/types.ts';

import { readAmount, readArray, readOptionalString, readString } from '../reading.ts';

export interface OrderRoutesOptions {
  readonly orders: OrderService;
  /** Built once per request by the pipeline, from the correlation and idempotency headers. */
  readonly contextFor: (request: HttpRequest) => RequestContext;
}

export function orderRoutes(options: OrderRoutesOptions): readonly Route[] {
  const { orders, contextFor } = options;

  return [
    {
      method: 'POST',
      path: '/v1/orders',
      summary: 'Open a draft order.',
      handler: async (request: HttpRequest): Promise<HttpResponse> => {
        const context = contextFor(request);
        const result = await orders.createOrder({
          // Derived, not minted: a retry under the same key must address this order, not a new one.
          orderId: context.derivedId('ord', 'order'),
          buyerAccountId: readString(request.body, 'buyerAccountId'),
          sellerAccountId: readString(request.body, 'sellerAccountId'),
          currency: readString(request.body, 'currency'),
          createdAt: context.now,
          updatedAt: context.now,
          correlationId: context.correlationId,
          idempotencyKey: context.idempotencyKey,
          eventId: context.derivedId('oev', 'created'),
          reason: readString(request.body, 'reason'),
        });
        // 200 rather than 201 on a replay: nothing was created this time, and telling the client
        // otherwise would make a retry indistinguishable from a first attempt.
        return json(result.replayed ? 200 : 201, result);
      },
    },

    {
      method: 'POST',
      path: '/v1/orders/:orderId/items',
      summary: 'Add a line to a draft order.',
      handler: async (request: HttpRequest): Promise<HttpResponse> => {
        const context = contextFor(request);
        const result = await orders.addItem({
          itemId: context.derivedId('oit', 'item'),
          orderId: request.params.orderId ?? '',
          listingId: readString(request.body, 'listingId'),
          versionId: readString(request.body, 'versionId'),
          commerceUnitTypeId: readString(request.body, 'commerceUnitTypeId'),
          quantity: readAmount(request.body, 'quantity'),
          unitPriceMinor: readAmount(request.body, 'unitPriceMinor'),
          lineTotalMinor: readAmount(request.body, 'lineTotalMinor'),
          currency: readString(request.body, 'currency'),
          reservationId: readOptionalString(request.body, 'reservationId'),
          addedAt: context.now,
          correlationId: context.correlationId,
          idempotencyKey: context.idempotencyKey,
        });
        return json(result.replayed ? 200 : 201, result);
      },
    },

    {
      method: 'POST',
      path: '/v1/orders/:orderId/placement',
      summary: 'Place a draft order, capturing the commercial snapshot.',
      handler: async (request: HttpRequest): Promise<HttpResponse> => {
        const context = contextFor(request);
        const result = await orders.placeOrder({
          orderId: request.params.orderId ?? '',
          snapshotId: context.derivedId('osn', 'snapshot'),
          expectedTotalMinor: readAmount(request.body, 'expectedTotalMinor'),
          policyVersionId: readOptionalString(request.body, 'policyVersionId'),
          placedAt: context.now,
          updatedAt: context.now,
          correlationId: context.correlationId,
          idempotencyKey: context.idempotencyKey,
          eventId: context.derivedId('oev', 'placed'),
          reason: readString(request.body, 'reason'),
        });
        return json(200, result);
      },
    },

    {
      method: 'POST',
      path: '/v1/orders/:orderId/confirmation',
      summary: 'Confirm a placed order.',
      handler: async (request: HttpRequest): Promise<HttpResponse> => {
        const context = contextFor(request);
        const result = await orders.confirmOrder({
          orderId: request.params.orderId ?? '',
          confirmedAt: context.now,
          updatedAt: context.now,
          correlationId: context.correlationId,
          idempotencyKey: context.idempotencyKey,
          eventId: context.derivedId('oev', 'confirmed'),
          reason: readString(request.body, 'reason'),
        });
        return json(200, result);
      },
    },

    {
      method: 'POST',
      path: '/v1/orders/:orderId/fulfilment',
      summary: 'Start fulfilling a confirmed order.',
      handler: async (request: HttpRequest): Promise<HttpResponse> => {
        const context = contextFor(request);
        const result = await orders.startFulfilment({
          orderId: request.params.orderId ?? '',
          fulfillingAt: context.now,
          updatedAt: context.now,
          correlationId: context.correlationId,
          idempotencyKey: context.idempotencyKey,
          eventId: context.derivedId('oev', 'fulfilling'),
          reason: readString(request.body, 'reason'),
        });
        return json(200, result);
      },
    },

    {
      method: 'POST',
      path: '/v1/orders/:orderId/completion',
      summary: 'Complete a fulfilling order.',
      handler: async (request: HttpRequest): Promise<HttpResponse> => {
        const context = contextFor(request);
        const result = await orders.completeOrder({
          orderId: request.params.orderId ?? '',
          completedAt: context.now,
          updatedAt: context.now,
          correlationId: context.correlationId,
          idempotencyKey: context.idempotencyKey,
          eventId: context.derivedId('oev', 'completed'),
          reason: readString(request.body, 'reason'),
        });
        return json(200, result);
      },
    },

    {
      method: 'POST',
      path: '/v1/orders/:orderId/cancellation',
      summary: 'Cancel an order, cascading to its children.',
      handler: async (request: HttpRequest): Promise<HttpResponse> => {
        const context = contextFor(request);
        const result = await orders.cancelOrder({
          orderId: request.params.orderId ?? '',
          cancellationReason: readString(request.body, 'cancellationReason'),
          cancelledAt: context.now,
          updatedAt: context.now,
          correlationId: context.correlationId,
          idempotencyKey: context.idempotencyKey,
          eventId: context.derivedId('oev', 'cancelled'),
          reason: readString(request.body, 'reason'),
        });
        return json(200, result);
      },
    },

    {
      method: 'POST',
      path: '/v1/orders/:orderId/split',
      summary: 'Split a placed order across several suppliers.',
      handler: async (request: HttpRequest): Promise<HttpResponse> => {
        const context = contextFor(request);
        const result = await orders.splitOrder({
          parentOrderId: request.params.orderId ?? '',
          allocations: readArray(request.body, 'allocations', (element, index) => ({
            // One derived id per allocation, discriminated by position: a retry has to produce the
            // same child orders, and two allocations must not collide with each other.
            orderId: context.derivedId('ord', `child:${String(index)}`),
            sellerAccountId: readString(element, 'sellerAccountId'),
            idempotencyKey: `${context.idempotencyKey}:child:${String(index)}`,
            eventId: context.derivedId('oev', `child-created:${String(index)}`),
            items: readArray(element, 'items', (line, lineIndex) => ({
              itemId: context.derivedId('oit', `child:${String(index)}:${String(lineIndex)}`),
              listingId: readString(line, 'listingId'),
              versionId: readString(line, 'versionId'),
              commerceUnitTypeId: readString(line, 'commerceUnitTypeId'),
              quantity: readAmount(line, 'quantity'),
              unitPriceMinor: readAmount(line, 'unitPriceMinor'),
              lineTotalMinor: readAmount(line, 'lineTotalMinor'),
              currency: readString(line, 'currency'),
              reservationId: readOptionalString(line, 'reservationId'),
            })),
          })),
          occurredAt: context.now,
          updatedAt: context.now,
          correlationId: context.correlationId,
          idempotencyKey: context.idempotencyKey,
          eventId: context.derivedId('oev', 'split'),
          reason: readString(request.body, 'reason'),
        });
        return json(200, result);
      },
    },

    {
      method: 'GET',
      path: '/v1/orders/:orderId',
      summary: 'Read one order.',
      handler: async (request: HttpRequest): Promise<HttpResponse> => {
        const order = await orders.getOrder(request.params.orderId ?? '');
        if (order === null) return notFound(request.params.orderId ?? '');
        return json(200, { order });
      },
    },

    {
      method: 'GET',
      path: '/v1/orders/:orderId/items',
      summary: 'List the lines of an order.',
      handler: async (request: HttpRequest): Promise<HttpResponse> =>
        json(200, { items: await orders.listItems(request.params.orderId ?? '') }),
    },

    {
      method: 'GET',
      path: '/v1/orders/:orderId/snapshot',
      summary: 'Read the commercial snapshot captured at placement.',
      handler: async (request: HttpRequest): Promise<HttpResponse> => {
        const snapshot = await orders.getSnapshot(request.params.orderId ?? '');
        if (snapshot === null) return notFound(request.params.orderId ?? '');
        return json(200, { snapshot });
      },
    },

    {
      method: 'GET',
      path: '/v1/orders/:orderId/history',
      summary: 'List every transition of an order.',
      handler: async (request: HttpRequest): Promise<HttpResponse> =>
        json(200, { events: await orders.getHistory(request.params.orderId ?? '') }),
    },

    {
      method: 'GET',
      path: '/v1/orders/:orderId/fulfilment',
      summary: 'Read the derived fulfilment summary of a split order.',
      handler: async (request: HttpRequest): Promise<HttpResponse> =>
        json(200, { fulfilment: await orders.getFulfilmentSummary(request.params.orderId ?? '') }),
    },
  ];
}

/** Register the order routes on a router. */
export function addOrderRoutes(router: Router, options: OrderRoutesOptions): Router {
  for (const route of orderRoutes(options)) router.add(route);
  return router;
}

/**
 * A 404 raised by a read that legitimately found nothing.
 *
 * Thrown as a problem-shaped response rather than an exception, because "there is no such order" is
 * an answer rather than a failure.
 */
function notFound(orderId: string): HttpResponse {
  return {
    status: 404,
    headers: { 'content-type': 'application/problem+json' },
    body: {
      type: 'https://jaya.lk/problems/order-not-found',
      title: 'Not Found',
      status: 404,
      detail: `There is no order ${orderId}.`,
      code: 'order-not-found',
      correlationId: '',
    },
  };
}
