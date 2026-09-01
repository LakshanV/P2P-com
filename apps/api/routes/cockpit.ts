/**
 * The buyer's own cockpit routes.
 *
 * Reads only. M-36 owns no data and writes nothing, so there is no POST here and there never will
 * be: a cockpit that could change something would be a second place where money moves.
 *
 * Every response carries `asOf`, because every figure in it was derived at that instant and none of
 * it is stored. A client that caches one of these views is caching a snapshot, and the timestamp is
 * how it knows how old the snapshot is.
 *
 * Owned by: apps/api.
 */

import type { UserCockpitService } from '../../../modules/user-cockpit/index.ts';
import type { RequestContext } from '../../../platform/http/context.ts';
import type { Route, Router } from '../../../platform/http/router.ts';
import { json, type HttpRequest, type HttpResponse } from '../../../platform/http/types.ts';

export interface CockpitRoutesOptions {
  readonly cockpit: UserCockpitService;
  readonly contextFor: (request: HttpRequest) => RequestContext;
}

export function cockpitRoutes(options: CockpitRoutesOptions): readonly Route[] {
  const { cockpit, contextFor } = options;

  return [
    {
      method: 'GET',
      path: '/v1/accounts/:accountId/money',
      summary: 'MY MONEY: every position this holder has, grouped by asset type. Never one total.',
      handler: async (request: HttpRequest): Promise<HttpResponse> =>
        json(200, await cockpit.myMoney(request.params.accountId ?? '', contextFor(request).now)),
    },

    {
      method: 'GET',
      path: '/v1/accounts/:accountId/orders',
      summary: 'MY ORDERS: what this buyer has bought.',
      handler: async (request: HttpRequest): Promise<HttpResponse> =>
        json(200, await cockpit.myOrders(request.params.accountId ?? '', contextFor(request).now)),
    },

    {
      method: 'GET',
      path: '/v1/cockpit/orders/:orderId',
      summary: 'One order, with what has been paid and how the obligation was covered.',
      handler: async (request: HttpRequest): Promise<HttpResponse> =>
        json(200, await cockpit.orderDetail(request.params.orderId ?? '', contextFor(request).now)),
    },
  ];
}

export function addCockpitRoutes(router: Router, options: CockpitRoutesOptions): Router {
  for (const route of cockpitRoutes(options)) router.add(route);
  return router;
}
