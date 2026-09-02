/**
 * Sourcing: the route where JAYA tries to solve a Need instead of publishing it.
 *
 * This is the differentiated path made reachable. A customer states a Need; this runs the ladder —
 * catalogue, then the buyer's own suppliers, then the verified network, then external discovery —
 * and stops at the first rung that answers well enough. Only when all of them fail does it
 * *recommend* a tender.
 *
 * **The route runs a ladder; it does not open a tender.** M-07's contract is explicit that a
 * matching engine which could open tenders would be two modules wearing one name, and the same
 * reasoning applies here: a customer whose Need escalated should be shown what was tried and asked,
 * rather than discovering a tender went out in their name. Opening one is a separate, deliberate
 * call to `POST /v1/rfqs`.
 *
 * **The reading, not the words.** The ladder is given M-03's structured interpretation, and a rung
 * that talks to an external directory must never receive a sentence that may hold the customer's
 * telephone number. If the Need has no interpretation yet, the run is refused rather than run
 * against nothing: a ladder searching an empty reading would find nothing and report an absence of
 * supply that nobody established.
 *
 * **Only the person who asked may source their own Need.** The route is guarded as an `update` on
 * `commerce-request`, so the object-level check compares the caller against the Need's owner. There
 * is no account parameter to get wrong.
 *
 * Owned by: apps/api.
 */

import type { CommerceRequestService } from '../../../modules/commerce-request/index.ts';
import type { MatchingService } from '../../../modules/matching/index.ts';
import type { RequestContext } from '../../../platform/http/context.ts';
import type { Route, Router } from '../../../platform/http/router.ts';
import { json, type HttpRequest, type HttpResponse } from '../../../platform/http/types.ts';

import { ApiError } from '../errors.ts';
import { readInteger } from '../reading.ts';

export interface SourcingRoutesOptions {
  readonly matching: MatchingService;
  readonly needs: CommerceRequestService;
  readonly contextFor: (request: HttpRequest) => RequestContext;
}

/**
 * Fields a caller may not send when asking for a Need to be sourced.
 *
 * A caller who could supply the reading would be sourcing against a description they wrote rather
 * than against what the platform understood — and a caller who could name the outcome would be
 * recording a search nobody ran.
 */
const ASSERTED_SOURCING_FIELDS: readonly string[] = [
  'structured',
  'interpretation',
  'accountId',
  'account_id',
  'outcome',
  'candidates',
  'attempts',
  'rung',
];

function assertDoesNotAssertTheSearch(body: unknown): void {
  if (typeof body !== 'object' || body === null) return;
  for (const field of ASSERTED_SOURCING_FIELDS) {
    if (field in (body as Record<string, unknown>)) {
      throw new ApiError(
        400,
        'caller-asserted-sourcing-field',
        `"${field}" is not a field a caller may send. A sourcing run reads the platform's own ` +
          'interpretation of the Need and records what each rung actually found; a caller who ' +
          'supplied either would be describing a search that never happened.',
      );
    }
  }
}

export function sourcingRoutes(options: SourcingRoutesOptions): readonly Route[] {
  const { matching, needs, contextFor } = options;

  return [
    {
      method: 'POST',
      path: '/v1/needs/:requestId/sourcing',
      summary: 'Try to solve this Need: catalogue, then suppliers, then a tender only if needed.',
      handler: async (request: HttpRequest): Promise<HttpResponse> => {
        const context = contextFor(request);
        assertDoesNotAssertTheSearch(request.body);

        const requestId = request.params.requestId ?? '';
        const need = await needs.getNeed(requestId);
        if (need === null) {
          throw new ApiError(404, 'not-found', 'No such Need.');
        }

        // The platform's own reading, and the latest one. A ladder run against no interpretation
        // would search an empty structure, find nothing, and record an absence of supply that
        // nobody established.
        const interpretations = await needs.listInterpretations(requestId);
        const current = interpretations.at(-1);
        if (current === undefined) {
          throw new ApiError(
            409,
            'need-not-interpreted',
            'This Need has not been interpreted yet, so there is nothing structured to search ' +
              'with. Record an interpretation first: sourcing against an empty reading would find ' +
              'nothing and report it as an absence of supply.',
          );
        }

        const result = await matching.runLadder({
          runId: context.derivedId('mrun', 'sourcing'),
          requestId,
          // From the Need, which the ownership check has already tied to the caller.
          accountId: need.accountId,
          interpretationId: current.interpretationId,
          structured: current.structured,
          confidencePerMille: current.confidencePerMille,
          startedAt: context.now,
          completedAt: context.now,
          correlationId: context.correlationId,
          idempotencyKey: context.idempotencyKey,
          ...(request.body !== null &&
          typeof request.body === 'object' &&
          'sufficiencyPerMille' in (request.body as Record<string, unknown>)
            ? { sufficiencyPerMille: readInteger(request.body, 'sufficiencyPerMille', 1, 1000) }
            : {}),
        });

        return json(result.replayed ? 200 : 201, result);
      },
    },

    {
      method: 'GET',
      path: '/v1/needs/:requestId/sourcing',
      summary: 'Every sourcing run for this Need, and what each rung found.',
      handler: async (request: HttpRequest): Promise<HttpResponse> =>
        json(200, { runs: await matching.listRunsForRequest(request.params.requestId ?? '') }),
    },

    {
      method: 'GET',
      path: '/v1/sourcing-runs/:runId',
      summary: 'One run: every rung attempted, why each answered as it did, and the candidates.',
      handler: async (request: HttpRequest): Promise<HttpResponse> => {
        const runId = request.params.runId ?? '';
        const run = await matching.getRun(runId);
        if (run === null) {
          throw new ApiError(404, 'not-found', 'No such sourcing run.');
        }

        // The account is checked by the guard through the run's own Need, so nothing here needs to
        // compare it: `sourcing-run` resolves its owner through M-03.
        return json(200, {
          run,
          attempts: await matching.listAttempts(runId),
          candidates: await matching.listCandidates(runId),
        });
      },
    },

    {
      method: 'GET',
      path: '/v1/sourcing-runs/:runId/attempts',
      summary: 'What every rung did, including the ones that found nothing and the ones skipped.',
      handler: async (request: HttpRequest): Promise<HttpResponse> =>
        json(200, { attempts: await matching.listAttempts(request.params.runId ?? '') }),
    },

    {
      method: 'GET',
      path: '/v1/sourcing-runs/:runId/candidates',
      summary: 'What the run found, best first, each with the reason it scored what it did.',
      handler: async (request: HttpRequest): Promise<HttpResponse> =>
        json(200, { candidates: await matching.listCandidates(request.params.runId ?? '') }),
    },
  ];
}

/** Register the sourcing routes on a router. */
export function addSourcingRoutes(router: Router, options: SourcingRoutesOptions): Router {
  for (const route of sourcingRoutes(options)) router.add(route);
  return router;
}
