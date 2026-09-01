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
 * **Adding a line establishes its stock reservation; it does not accept one.** The route used to read
 * `reservationId` out of the request body, so a client could send any string and M-11 would record
 * it — an order line claiming stock that nothing was holding, then placed, paid for and fulfilled
 * against inventory never set aside. The reservation is now made here against M-04, under an
 * identifier derived from the request context, and a body that still carries the field is refused by
 * name. See `reservation.ts`.
 *
 * Whether a line needs a reservation at all comes from the pinned version's `inventoryMode`, not
 * from the request: a service, a made-to-order part, a supplier-direct machine and a digital
 * entitlement hold no JAYA stock, and demanding a reservation for them would make the platform
 * unable to sell them.
 *
 * Owned by: apps/api.
 */

import type { OrderService } from '../../../modules/orders/index.ts';
import type { UniversalListingService } from '../../../modules/universal-listing/index.ts';
import type { RequestContext } from '../../../platform/http/context.ts';
import type { Route, Router } from '../../../platform/http/router.ts';
import { json, type HttpRequest, type HttpResponse } from '../../../platform/http/types.ts';

import { readAmount, readArray, readOptionalString, readString } from '../reading.ts';
import { assertDoesNotAssertReservation, reserveForLine } from '../reservation.ts';

export interface OrderRoutesOptions {
  readonly orders: OrderService;
  /**
   * M-04, for establishing the stock reservation a line needs.
   *
   * Required. An optional inventory service would be an inventory service somebody leaves out, and
   * leaving it out reopens exactly the hole this closes.
   */
  readonly listings: UniversalListingService;
  /** Built once per request by the pipeline, from the correlation and idempotency headers. */
  readonly contextFor: (request: HttpRequest) => RequestContext;
  /**
   * The account the caller's session resolved to.
   *
   * Read from the guarded principal, never from the request. A reservation is scoped to whoever
   * holds it, and a caller that could name its own account could attach anybody's.
   */
  readonly accountFor: (request: HttpRequest) => string;
}

export function orderRoutes(options: OrderRoutesOptions): readonly Route[] {
  const { orders, listings, contextFor, accountFor } = options;

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

        // Refused before anything else is read. A caller supplying this is asserting the outcome of
        // the check this route exists to perform, and accepting it "because it was probably ours"
        // is precisely how the hole worked.
        assertDoesNotAssertReservation(request.body);

        const listingId = readString(request.body, 'listingId');
        const versionId = readString(request.body, 'versionId');
        const quantity = readAmount(request.body, 'quantity');

        // Establishes the reservation against M-04, or determines that this offer holds no JAYA
        // stock. Throws rather than returning a flag: there is no path past it that leaves the
        // caller in charge of the answer.
        const reservation = await reserveForLine({
          listings,
          orders,
          accountId: accountFor(request),
          listingId,
          versionId,
          quantity,
          // Derived from the request context, so a retry converges on the same reservation rather
          // than holding the stock twice.
          reservationId: context.derivedId('rsv', 'reservation'),
          movementId: context.derivedId('mov', 'reservation-movement'),
          now: context.now,
          correlationId: context.correlationId,
          idempotencyKey: context.idempotencyKey,
        });

        const result = await orders.addItem({
          itemId: context.derivedId('oit', 'item'),
          orderId: request.params.orderId ?? '',
          listingId,
          versionId,
          commerceUnitTypeId: readString(request.body, 'commerceUnitTypeId'),
          quantity,
          unitPriceMinor: readAmount(request.body, 'unitPriceMinor'),
          lineTotalMinor: readAmount(request.body, 'lineTotalMinor'),
          currency: readString(request.body, 'currency'),
          // Established above, or null because the offer holds no stock. Never from the body.
          reservationId: reservation.reservationId,
          addedAt: context.now,
          correlationId: context.correlationId,
          idempotencyKey: context.idempotencyKey,
        });
        return json(result.replayed ? 200 : 201, {
          ...result,
          // Said out loud, because "no reservation" and "reservation forgotten" look identical to a
          // client otherwise, and the difference is whether the stock is there on delivery day.
          inventoryMode: reservation.version.inventoryMode,
        });
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
