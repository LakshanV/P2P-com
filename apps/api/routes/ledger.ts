/**
 * The financial ledger routes.
 *
 * The allocation route is the interesting one, because it is where a client says how a purchase is
 * being paid for: several kinds of value at once, each in its own unit, each with what it is worth
 * against the obligation. Every amount in it — the target and every leg — arrives as a **string**,
 * for the reason set out in `reading.ts`: a JSON number is a double, and a double cannot hold an
 * exact number of satoshis.
 *
 * The K-10 transaction ids for a commit are derived from the caller's idempotency key rather than
 * taken from the request. A client has no business choosing a journal transaction id, and deriving
 * them is what makes a retried commit post to the same journal rows instead of new ones.
 *
 * Owned by: apps/api.
 */

import type {
  AllocationLeg,
  FinancialLedgerService,
} from '../../../modules/financial-ledger/index.ts';
import type { RequestContext } from '../../../platform/http/context.ts';
import type { Route, Router } from '../../../platform/http/router.ts';
import { json, type HttpRequest, type HttpResponse } from '../../../platform/http/types.ts';

import { ApiError } from '../errors.ts';
import { readAmount, readOptionalString, readString } from '../reading.ts';

export interface LedgerRoutesOptions {
  readonly ledger: FinancialLedgerService;
  readonly contextFor: (request: HttpRequest) => RequestContext;
}

export function ledgerRoutes(options: LedgerRoutesOptions): readonly Route[] {
  const { ledger, contextFor } = options;

  return [
    {
      method: 'POST',
      path: '/v1/wallets',
      summary: 'Open a named position over a K-10 ledger account.',
      handler: async (request: HttpRequest): Promise<HttpResponse> => {
        const context = contextFor(request);
        const normalBalance = readString(request.body, 'normalBalance');
        if (normalBalance !== 'debit' && normalBalance !== 'credit') {
          throw new ApiError(
            400,
            'malformed-field',
            '"normalBalance" must be "debit" or "credit". A holder\'s wallet is a liability of the ' +
              'platform and so credit-normal; a platform issuance position is debit-normal.',
          );
        }

        const result = await ledger.openWallet({
          walletId: context.derivedId('wal', 'wallet'),
          ownerAccountId: readString(request.body, 'ownerAccountId'),
          assetTypeId: readString(request.body, 'assetTypeId'),
          purpose: readString(request.body, 'purpose'),
          ledgerAccountId: context.derivedId('lac', 'ledger-account'),
          normalBalance,
          openedAt: context.now,
          correlationId: context.correlationId,
          idempotencyKey: context.idempotencyKey,
        });
        return json(result.replayed ? 200 : 201, result);
      },
    },

    {
      method: 'POST',
      path: '/v1/wallets/:walletId/status',
      summary: 'Freeze, unfreeze or close a wallet.',
      handler: async (request: HttpRequest): Promise<HttpResponse> => {
        const context = contextFor(request);
        const result = await ledger.setWalletStatus({
          walletId: request.params.walletId ?? '',
          stateId: context.derivedId('wst', 'wallet-state'),
          toStatus: readString(request.body, 'toStatus'),
          reason: readString(request.body, 'reason'),
          occurredAt: context.now,
          correlationId: context.correlationId,
          idempotencyKey: context.idempotencyKey,
        });
        return json(200, result);
      },
    },

    {
      method: 'GET',
      path: '/v1/accounts/:accountId/wallets',
      summary: 'List the wallets an account holds.',
      handler: async (request: HttpRequest): Promise<HttpResponse> =>
        json(200, { wallets: await ledger.listWallets(request.params.accountId ?? '') }),
    },

    {
      method: 'GET',
      path: '/v1/wallets/:walletId',
      summary: 'Read one wallet.',
      handler: async (request: HttpRequest): Promise<HttpResponse> =>
        json(200, { wallet: await ledger.getWallet(request.params.walletId ?? '') }),
    },

    {
      method: 'GET',
      path: '/v1/wallets/:walletId/history',
      summary: 'List every status change of a wallet.',
      handler: async (request: HttpRequest): Promise<HttpResponse> =>
        json(200, { history: await ledger.getWalletHistory(request.params.walletId ?? '') }),
    },

    {
      method: 'POST',
      path: '/v1/value-plans',
      summary: 'Allocate one obligation across several kinds of value. Nothing moves.',
      handler: async (request: HttpRequest): Promise<HttpResponse> => {
        const context = contextFor(request);
        const legs = readLegs(request.body, context);

        const result = await ledger.allocatePlan({
          planId: context.derivedId('pln', 'plan'),
          obligationId: readString(request.body, 'obligationId'),
          obligationKind: readString(request.body, 'obligationKind'),
          payerAccountId: readString(request.body, 'payerAccountId'),
          payeeAccountId: readString(request.body, 'payeeAccountId'),
          settlementAssetTypeId: readString(request.body, 'settlementAssetTypeId'),
          targetAmountMinor: readAmount(request.body, 'targetAmountMinor'),
          legs,
          allocatedAt: context.now,
          correlationId: context.correlationId,
          idempotencyKey: context.idempotencyKey,
          eventId: context.derivedId('fev', 'allocated'),
        });
        return json(result.replayed ? 200 : 201, result);
      },
    },

    {
      method: 'POST',
      path: '/v1/value-plans/:planId/commitment',
      summary: 'Post every internal leg, and move the plan on.',
      handler: async (request: HttpRequest): Promise<HttpResponse> => {
        const context = contextFor(request);
        const planId = request.params.planId ?? '';
        const legs = await ledger.listLegs(planId);

        // A client has no business choosing a journal transaction id, and deriving them is what
        // makes a retried commit post to the same rows rather than new ones.
        const postings = legs
          .filter((leg) => leg.kind === 'internal' && leg.status === 'planned')
          .map((leg) => ({
            legId: leg.legId,
            ledgerTransactionId: context.derivedId('ltx', `post:${leg.legId}`),
          }));

        const result = await ledger.commitPlan({
          planId,
          postings,
          committedAt: context.now,
          correlationId: context.correlationId,
          idempotencyKey: context.idempotencyKey,
          eventId: context.derivedId('fev', 'committed'),
        });
        return json(200, result);
      },
    },

    {
      method: 'POST',
      path: '/v1/value-plans/:planId/legs/:legId/settlement',
      summary: 'Record that the external leg’s money arrived, and settle the plan.',
      handler: async (request: HttpRequest): Promise<HttpResponse> => {
        const context = contextFor(request);
        const legId = request.params.legId ?? '';
        const result = await ledger.settleExternalLeg({
          planId: request.params.planId ?? '',
          legId,
          ledgerTransactionId: context.derivedId('ltx', `settle:${legId}`),
          // The M-12 payment that settled it. Opaque: M-12 is the same layer and is never joined to.
          externalReference: readString(request.body, 'externalReference'),
          settledAt: context.now,
          correlationId: context.correlationId,
          idempotencyKey: context.idempotencyKey,
          eventId: context.derivedId('fev', 'settled'),
        });
        return json(200, result);
      },
    },

    {
      method: 'POST',
      path: '/v1/value-plans/:planId/cancellation',
      summary: 'Cancel a plan, reversing every leg that posted.',
      handler: async (request: HttpRequest): Promise<HttpResponse> => {
        const context = contextFor(request);
        const planId = request.params.planId ?? '';
        const legs = await ledger.listLegs(planId);

        const reversals = legs
          .filter((leg) => leg.status === 'posted')
          .map((leg) => ({
            legId: leg.legId,
            reversalTransactionId: context.derivedId('ltx', `reverse:${leg.legId}`),
          }));

        const result = await ledger.cancelPlan({
          planId,
          reversals,
          reason: readString(request.body, 'reason'),
          cancelledAt: context.now,
          correlationId: context.correlationId,
          idempotencyKey: context.idempotencyKey,
          eventId: context.derivedId('fev', 'cancelled'),
        });
        return json(200, result);
      },
    },

    {
      method: 'GET',
      path: '/v1/value-plans/:planId',
      summary: 'Read one plan.',
      handler: async (request: HttpRequest): Promise<HttpResponse> =>
        json(200, { plan: await ledger.getPlan(request.params.planId ?? '') }),
    },

    {
      method: 'GET',
      path: '/v1/value-plans/:planId/coverage',
      summary: 'What a plan is covered by, summed from its legs.',
      handler: async (request: HttpRequest): Promise<HttpResponse> =>
        json(200, { coverage: await ledger.getCoverage(request.params.planId ?? '') }),
    },
  ];
}

/** The legs of an allocation, each with its own asset, amount and rate. */
function readLegs(body: unknown, context: RequestContext): readonly AllocationLeg[] {
  const value = (body as Record<string, unknown> | null)?.legs;
  if (!Array.isArray(value)) {
    throw new ApiError(400, 'malformed-field', '"legs" must be an array of value legs.');
  }

  return value.map((element, index) => {
    const kind = readString(element, 'kind');
    if (kind !== 'internal' && kind !== 'external') {
      throw new ApiError(
        400,
        'malformed-field',
        `"legs[${String(index)}].kind" must be "internal" or "external".`,
      );
    }
    return {
      legId: context.derivedId('leg', `leg:${String(index)}`),
      kind,
      assetTypeId: readString(element, 'assetTypeId'),
      // Null for an external leg: that value comes from outside the platform.
      sourceWalletId: readOptionalString(element, 'sourceWalletId'),
      destinationWalletId: readString(element, 'destinationWalletId'),
      amountMinor: readAmount(element, 'amountMinor'),
      rate: {
        numerator: readAmount(element, 'rateNumerator'),
        denominator: readAmount(element, 'rateDenominator'),
      },
      settlementEquivalentMinor: readAmount(element, 'settlementEquivalentMinor'),
      idempotencyKey: `${context.idempotencyKey}:leg:${String(index)}`,
    };
  });
}

export function addLedgerRoutes(router: Router, options: LedgerRoutesOptions): Router {
  for (const route of ledgerRoutes(options)) router.add(route);
  return router;
}
