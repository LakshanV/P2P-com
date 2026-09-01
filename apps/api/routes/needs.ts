/**
 * The Need routes: where a real person says what they want.
 *
 * The first route in this API that a customer would actually use as themselves. Everything else so
 * far serves an order, a payment or a ledger position that somebody else created; this is the entry
 * point of the product.
 *
 * Three things it does that the other route files do not.
 *
 * **The account comes from the session, never from the body.** A Need is asked for *by* somebody,
 * and unlike an order — where a buyer and a seller are both named and either may legitimately be a
 * third party — there is exactly one party here and it is the caller. So there is no
 * `accountId` field; sending one is refused. That also means the ownership check has something to
 * check against without reading anything back first.
 *
 * **The raw text is passed through untouched.** No trim, no normalisation, no length "helpfully"
 * capped by the reader. `readString` would refuse an empty string, which is the same rule M-03
 * applies, and everything else about the words is M-03's business.
 *
 * **The interpretation route is not a way to assert an interpretation.** A client cannot post a
 * reading with `origin: 'human'` for somebody else's Need, and cannot claim a K-13 run it did not
 * make: M-03 refuses a `human` reading carrying an `aiRunId`, and the ownership check refuses a Need
 * that is not the caller's. What a customer *can* do is correct a reading of their own Need, which
 * is the whole point of the field existing.
 *
 * Owned by: apps/api.
 */

import type { CommerceRequestService } from '../../../modules/commerce-request/index.ts';
import type { RequestContext } from '../../../platform/http/context.ts';
import type { Route, Router } from '../../../platform/http/router.ts';
import { json, type HttpRequest, type HttpResponse } from '../../../platform/http/types.ts';

import { ApiError } from '../errors.ts';
import { readInteger, readObject, readOptionalString, readString } from '../reading.ts';

export interface NeedRoutesOptions {
  readonly needs: CommerceRequestService;
  readonly contextFor: (request: HttpRequest) => RequestContext;
  /** The account the caller's session resolved to. Never read from the request body. */
  readonly accountFor: (request: HttpRequest) => string;
}

/**
 * Fields a caller may not send when stating a Need.
 *
 * `accountId` above all: a Need is asked for by whoever is asking, and a caller that could name the
 * account would be stating Needs in somebody else's name. The rest are M-03's own bookkeeping — a
 * status a caller set would be a lifecycle nobody drove, and an interpretation supplied with the
 * Need would be the platform's guess arriving before the platform had guessed.
 */
const ASSERTED_NEED_FIELDS: readonly string[] = [
  'accountId',
  'account_id',
  'status',
  'currentInterpretationId',
  'interpretation',
  'structured',
];

function assertDoesNotAssertOwnershipOrState(body: unknown): void {
  if (typeof body !== 'object' || body === null) return;
  for (const field of ASSERTED_NEED_FIELDS) {
    if (field in (body as Record<string, unknown>)) {
      throw new ApiError(
        400,
        'caller-asserted-need-field',
        `"${field}" is not a field a caller may send. A Need belongs to whoever is asking, and its ` +
          'status is reached by a transition somebody recorded rather than by being declared.',
      );
    }
  }
}

export function needRoutes(options: NeedRoutesOptions): readonly Route[] {
  const { needs, contextFor, accountFor } = options;

  return [
    {
      method: 'POST',
      path: '/v1/needs',
      summary: 'State what you want, in your own words.',
      handler: async (request: HttpRequest): Promise<HttpResponse> => {
        const context = contextFor(request);
        assertDoesNotAssertOwnershipOrState(request.body);

        const result = await needs.captureNeed({
          requestId: context.derivedId('req', 'need'),
          // From the session. This is the field that makes the whole route safe.
          accountId: accountFor(request),
          channel: readString(request.body, 'channel'),
          // Untouched. `readString` refuses an empty string and nothing else touches the words.
          rawText: readString(request.body, 'rawText'),
          conversationId: readOptionalString(request.body, 'conversationId'),
          neededBy: readOptionalString(request.body, 'neededBy'),
          capturedAt: context.now,
          correlationId: context.correlationId,
          idempotencyKey: context.idempotencyKey,
        });
        return json(result.replayed ? 200 : 201, result);
      },
    },

    {
      method: 'GET',
      path: '/v1/needs/:requestId',
      summary: 'One Need, exactly as it was stated.',
      handler: async (request: HttpRequest): Promise<HttpResponse> => {
        const need = await needs.getNeed(request.params.requestId ?? '');
        if (need === null) {
          throw new ApiError(404, 'not-found', 'No such Need.');
        }
        return json(200, { need });
      },
    },

    {
      method: 'GET',
      path: '/v1/needs',
      summary: 'The Needs this account has stated, newest first.',
      handler: async (request: HttpRequest): Promise<HttpResponse> =>
        // Scoped to the caller by construction: there is no account parameter to get wrong.
        json(200, { needs: await needs.listNeedsForAccount(accountFor(request)) }),
    },

    {
      method: 'POST',
      path: '/v1/needs/:requestId/interpretations',
      summary: 'Record a reading of a Need. Appends; never overwrites the words.',
      handler: async (request: HttpRequest): Promise<HttpResponse> => {
        const context = contextFor(request);
        const result = await needs.interpret({
          requestId: request.params.requestId ?? '',
          interpretationId: context.derivedId('int', 'interpretation'),
          origin: readString(request.body, 'origin'),
          // An integer per-mille. A client sending 0.82 is refused by `readInteger`, which is the
          // right answer: this platform holds no floating-point value anywhere.
          confidencePerMille: readInteger(request.body, 'confidencePerMille', 0, 1000),
          structured: readObject(request.body, 'structured'),
          aiRunId: readOptionalString(request.body, 'aiRunId'),
          rationale: readString(request.body, 'rationale'),
          interpretedAt: context.now,
          correlationId: context.correlationId,
          idempotencyKey: context.idempotencyKey,
          eventId: context.derivedId('nev', 'interpretation-transition'),
        });
        return json(result.replayed ? 200 : 201, result);
      },
    },

    {
      method: 'GET',
      path: '/v1/needs/:requestId/interpretations',
      summary: 'Every reading of a Need, oldest first, including the ones that were wrong.',
      handler: async (request: HttpRequest): Promise<HttpResponse> =>
        json(200, {
          interpretations: await needs.listInterpretations(request.params.requestId ?? ''),
        }),
    },

    {
      method: 'POST',
      path: '/v1/needs/:requestId/media',
      summary: 'Attach an artefact by opaque reference. The artefact itself lives elsewhere.',
      handler: async (request: HttpRequest): Promise<HttpResponse> => {
        const context = contextFor(request);
        const result = await needs.attachMedia({
          mediaId: context.derivedId('med', 'media'),
          requestId: request.params.requestId ?? '',
          kind: readString(request.body, 'kind'),
          reference: readString(request.body, 'reference'),
          position: readInteger(request.body, 'position', 0, 999),
          caption: readOptionalString(request.body, 'caption') ?? '',
          addedAt: context.now,
          correlationId: context.correlationId,
          idempotencyKey: context.idempotencyKey,
        });
        return json(result.replayed ? 200 : 201, result);
      },
    },

    {
      method: 'GET',
      path: '/v1/needs/:requestId/media',
      summary: 'The artefacts attached to a Need.',
      handler: async (request: HttpRequest): Promise<HttpResponse> =>
        json(200, { media: await needs.listMedia(request.params.requestId ?? '') }),
    },

    {
      method: 'POST',
      path: '/v1/needs/:requestId/readiness',
      summary: 'Accept the current understanding as good enough to source against.',
      handler: async (request: HttpRequest): Promise<HttpResponse> => {
        const context = contextFor(request);
        const result = await needs.markReady(transition(request, context));
        return json(200, result);
      },
    },

    {
      method: 'POST',
      path: '/v1/needs/:requestId/cancellation',
      summary: 'Withdraw a Need. Permitted from every live state, because minds change.',
      handler: async (request: HttpRequest): Promise<HttpResponse> => {
        const context = contextFor(request);
        const result = await needs.cancelNeed(transition(request, context));
        return json(200, result);
      },
    },

    {
      method: 'GET',
      path: '/v1/needs/:requestId/history',
      summary: 'How a Need reached its current state.',
      handler: async (request: HttpRequest): Promise<HttpResponse> =>
        json(200, { history: await needs.listHistory(request.params.requestId ?? '') }),
    },
  ];
}

/** The shape every transition route sends. Spelled once so the four cannot drift apart. */
function transition(
  request: HttpRequest,
  context: RequestContext,
): {
  requestId: string;
  reason: string;
  occurredAt: string;
  correlationId: string;
  idempotencyKey: string;
  eventId: string;
} {
  return {
    requestId: request.params.requestId ?? '',
    reason: readString(request.body, 'reason'),
    occurredAt: context.now,
    correlationId: context.correlationId,
    idempotencyKey: context.idempotencyKey,
    eventId: context.derivedId('nev', 'transition'),
  };
}

export function addNeedRoutes(router: Router, options: NeedRoutesOptions): Router {
  for (const route of needRoutes(options)) router.add(route);
  return router;
}
