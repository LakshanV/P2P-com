/**
 * Tenders and offers: the routes a buyer and a supplier actually meet on.
 *
 * The sourcing ladder tried everything and could not solve the Need. This is what happens next —
 * and it is the first place in this API where two different parties reach the same object and must
 * see different things.
 *
 * **Two parties, and the split matters more than the routes.**
 *
 *   * A **buyer** opens a tender, invites suppliers, sees every offer, ranks them, chooses one, and
 *     closes or cancels.
 *   * A **supplier** sees a tender they were invited to, offers against it, and withdraws their own
 *     offer. They see **nothing else**: not the other invitations, not the other offers, not the
 *     ranking.
 *
 * The second half is the part with a victim. A supplier who could list the invitations knows who
 * they are bidding against; one who could read the offers knows what to undercut. Both would turn a
 * sealed tender into an auction where one party sees everybody's cards, and neither is prevented by
 * "is this your tender?" — because for an invited supplier the honest answer is yes.
 *
 * So this file uses **three** checks, not one. K-04 says whether this kind of caller may do this
 * kind of thing. The `OWNERS` table says whether they may reach this object at all — which for a
 * tender includes its invited suppliers, deliberately. And the handlers below then ask the question
 * neither of those can: *which* party is this, for this object? `requireBuyer` is that question, and
 * it is the reason a supplier cannot invite their competitors or read their bids.
 *
 * **A caller never names themselves.** The buyer of a tender is the caller; the supplier of an
 * offer is the caller. Neither is a field, and sending one is refused rather than ignored.
 *
 * Owned by: apps/api.
 */

import type { QuoteService } from '../../../modules/quotes/index.ts';
import { buildSpecification, type RfqService } from '../../../modules/rfq/index.ts';
import type { RequestContext } from '../../../platform/http/context.ts';
import type { Route, Router } from '../../../platform/http/router.ts';
import { json, type HttpRequest, type HttpResponse } from '../../../platform/http/types.ts';

import { ApiError } from '../errors.ts';
import {
  readAmount,
  readInteger,
  readObject,
  readOptionalString,
  readString,
  readStringArray,
} from '../reading.ts';

export interface TenderRoutesOptions {
  readonly tenders: RfqService;
  readonly quotes: QuoteService;
  readonly contextFor: (request: HttpRequest) => RequestContext;
  /** The account the caller's session resolved to. Never read from the request body. */
  readonly accountFor: (request: HttpRequest) => string;
}

/**
 * Fields a caller may not send.
 *
 * `accountId` and `supplierAccountId` above all: a caller who could name the party would be opening
 * tenders in somebody else's name, or quoting as another supplier. The rest are the platform's own
 * bookkeeping — a status a caller set would be a lifecycle nobody drove, and a score a supplier sent
 * would be advertising rather than a comparison.
 */
const ASSERTED_FIELDS: readonly string[] = [
  'accountId',
  'account_id',
  'buyerAccountId',
  'supplierAccountId',
  'supplier_account_id',
  'status',
  'scorePerMille',
  'score',
  'rank',
  'recommended',
  'awardedQuoteId',
  'invited',
];

function assertDoesNotAssertParty(body: unknown): void {
  if (typeof body !== 'object' || body === null) return;
  for (const field of ASSERTED_FIELDS) {
    if (field in (body as Record<string, unknown>)) {
      throw new ApiError(
        400,
        'caller-asserted-tender-field',
        `"${field}" is not a field a caller may send. A tender belongs to whoever opened it and an ` +
          'offer to whoever made it; a status is reached by a transition somebody recorded, and a ' +
          'ranking is computed from the offers rather than stated by one of them.',
      );
    }
  }
}

export function tenderRoutes(options: TenderRoutesOptions): readonly Route[] {
  const { tenders, quotes, contextFor, accountFor } = options;

  /**
   * The tender, if this caller is its **buyer**.
   *
   * The check the guard cannot make. `OWNERS` lets an invited supplier reach a tender — that is the
   * point of inviting them — so every buyer-only action needs this on top: inviting, listing who
   * else was invited, reading the offers, ranking them, choosing, closing, cancelling.
   *
   * Answers 404 rather than 403 for a tender that is not the caller's, matching the guard: telling
   * a supplier that a tender exists but is not theirs to administer is still telling them it
   * exists.
   */
  async function requireBuyer(request: HttpRequest): Promise<{ rfqId: string; buyer: string }> {
    const rfqId = request.params.rfqId ?? '';
    const tender = await tenders.getRfq(rfqId);
    if (tender === null || tender.accountId !== accountFor(request)) {
      throw new ApiError(404, 'not-found', 'No such tender.');
    }
    return { rfqId, buyer: tender.accountId };
  }

  return [
    // -----------------------------------------------------------------------
    // The buyer's side
    // -----------------------------------------------------------------------

    {
      method: 'POST',
      path: '/v1/rfqs',
      summary: 'Ask the market, once the ladder could not answer.',
      handler: async (request: HttpRequest): Promise<HttpResponse> => {
        const context = contextFor(request);
        assertDoesNotAssertParty(request.body);

        // Built here rather than accepted whole, so the allowlist and the private-text guard both
        // run: a caller cannot post a specification with the customer's own sentence in it.
        const specification = buildSpecification({
          structured: readObject(request.body, 'structured'),
          itemDescription: readString(request.body, 'itemDescription'),
          substitutionPolicy: readString(request.body, 'substitutionPolicy') as Parameters<
            typeof buildSpecification
          >[0]['substitutionPolicy'],
          qualityRequirements: readStringArray(request.body, 'qualityRequirements'),
          attachmentReferences: readStringArray(request.body, 'attachmentReferences'),
        });

        const result = await tenders.openRfq({
          rfqId: context.derivedId('rfq', 'tender'),
          eventId: context.derivedId('rev', 'tender-opened'),
          requestId: readString(request.body, 'requestId'),
          // From the session. A tender is opened by whoever is asking.
          accountId: accountFor(request),
          matchRunId: readOptionalString(request.body, 'matchRunId'),
          visibility: readString(request.body, 'visibility'),
          specification,
          closesAt: readString(request.body, 'closesAt'),
          openedAt: context.now,
          correlationId: context.correlationId,
          idempotencyKey: context.idempotencyKey,
        });
        return json(result.replayed ? 200 : 201, result);
      },
    },

    {
      method: 'GET',
      path: '/v1/rfqs',
      summary: 'The tenders this account has opened, newest first.',
      handler: async (request: HttpRequest): Promise<HttpResponse> =>
        // Scoped by construction: there is no account parameter to get wrong.
        json(200, { rfqs: await tenders.listRfqsForAccount(accountFor(request)) }),
    },

    {
      method: 'GET',
      path: '/v1/rfqs/:rfqId',
      summary: 'One tender. Visible to its buyer and to the suppliers invited to quote.',
      handler: async (request: HttpRequest): Promise<HttpResponse> => {
        const tender = await tenders.getRfq(request.params.rfqId ?? '');
        if (tender === null) {
          throw new ApiError(404, 'not-found', 'No such tender.');
        }
        return json(200, { rfq: tender });
      },
    },

    {
      method: 'POST',
      path: '/v1/rfqs/:rfqId/invitations',
      summary: 'Ask a supplier to quote, and say why they were asked.',
      handler: async (request: HttpRequest): Promise<HttpResponse> => {
        const context = contextFor(request);
        assertDoesNotAssertParty(request.body);
        const { rfqId } = await requireBuyer(request);

        const result = await tenders.inviteSupplier({
          invitationId: context.derivedId('inv', 'invitation'),
          rfqId,
          // The one place a caller does name another party, and legitimately: inviting somebody is
          // naming them. `supplierAccountId` is refused above, so the field is spelled differently
          // to make the difference deliberate rather than accidental.
          supplierAccountId: readString(request.body, 'supplier'),
          sourceRung: readOptionalString(request.body, 'sourceRung'),
          reason: readString(request.body, 'reason'),
          scorePerMille:
            request.body !== null &&
            typeof request.body === 'object' &&
            'score' in (request.body as Record<string, unknown>)
              ? readInteger(request.body, 'score', 0, 1000)
              : null,
          invitedAt: context.now,
          correlationId: context.correlationId,
          idempotencyKey: context.idempotencyKey,
        });
        return json(result.replayed ? 200 : 201, result);
      },
    },

    {
      method: 'GET',
      path: '/v1/rfqs/:rfqId/invitations',
      summary: 'Who was asked, and why. The buyer only.',
      handler: async (request: HttpRequest): Promise<HttpResponse> => {
        // Buyer-only on purpose. A supplier who could read this knows exactly who they are bidding
        // against, which is not something a sealed tender tells anybody.
        const { rfqId } = await requireBuyer(request);
        return json(200, { invitations: await tenders.listInvitations(rfqId) });
      },
    },

    {
      method: 'GET',
      path: '/v1/rfqs/:rfqId/history',
      summary: 'How the tender reached its current state.',
      handler: async (request: HttpRequest): Promise<HttpResponse> => {
        const { rfqId } = await requireBuyer(request);
        return json(200, { history: await tenders.listHistory(rfqId) });
      },
    },

    {
      method: 'POST',
      path: '/v1/rfqs/:rfqId/closure',
      summary: 'End the quoting window. Offers already made stand.',
      handler: async (request: HttpRequest): Promise<HttpResponse> => {
        const context = contextFor(request);
        assertDoesNotAssertParty(request.body);
        const { rfqId } = await requireBuyer(request);

        const result = await tenders.closeRfq({
          rfqId,
          eventId: context.derivedId('rev', 'tender-closed'),
          reason: readString(request.body, 'reason'),
          occurredAt: context.now,
          correlationId: context.correlationId,
          idempotencyKey: context.idempotencyKey,
        });
        return json(200, result);
      },
    },

    {
      method: 'POST',
      path: '/v1/rfqs/:rfqId/award',
      summary: 'Name the winning offer. Terminal, and it names exactly one.',
      handler: async (request: HttpRequest): Promise<HttpResponse> => {
        const context = contextFor(request);
        assertDoesNotAssertParty(request.body);
        const { rfqId } = await requireBuyer(request);

        const result = await tenders.awardRfq({
          rfqId,
          eventId: context.derivedId('rev', 'tender-awarded'),
          quoteId: readString(request.body, 'quoteId'),
          reason: readString(request.body, 'reason'),
          occurredAt: context.now,
          correlationId: context.correlationId,
          idempotencyKey: context.idempotencyKey,
        });
        return json(200, result);
      },
    },

    {
      method: 'POST',
      path: '/v1/rfqs/:rfqId/cancellation',
      summary: 'Withdraw the tender. Distinct from closing, because a supplier is owed the reason.',
      handler: async (request: HttpRequest): Promise<HttpResponse> => {
        const context = contextFor(request);
        assertDoesNotAssertParty(request.body);
        const { rfqId } = await requireBuyer(request);

        const result = await tenders.cancelRfq({
          rfqId,
          eventId: context.derivedId('rev', 'tender-cancelled'),
          reason: readString(request.body, 'reason'),
          occurredAt: context.now,
          correlationId: context.correlationId,
          idempotencyKey: context.idempotencyKey,
        });
        return json(200, result);
      },
    },

    // -----------------------------------------------------------------------
    // The offers
    // -----------------------------------------------------------------------

    {
      method: 'POST',
      path: '/v1/rfqs/:rfqId/quotes',
      summary: 'Offer against a tender you were invited to.',
      handler: async (request: HttpRequest): Promise<HttpResponse> => {
        const context = contextFor(request);
        assertDoesNotAssertParty(request.body);

        const result = await quotes.submitQuote({
          quoteId: context.derivedId('quo', 'quote'),
          rfqId: request.params.rfqId ?? '',
          // From the session. M-10 then checks the invitation against M-09, so a supplier can
          // neither quote as somebody else nor assert that they were asked.
          supplierAccountId: accountFor(request),
          kind: readString(request.body, 'kind'),
          quantity: readAmount(request.body, 'quantity'),
          unitPriceMinor: readAmount(request.body, 'unitPriceMinor'),
          totalMinor: readAmount(request.body, 'totalMinor'),
          currency: readString(request.body, 'currency'),
          leadTimeDays: readInteger(request.body, 'leadTimeDays', 0, 3650),
          deliveryTerms: readString(request.body, 'deliveryTerms'),
          validUntil: readString(request.body, 'validUntil'),
          substitutionNote: readOptionalString(request.body, 'substitutionNote'),
          evidenceReferences: readStringArray(request.body, 'evidenceReferences'),
          submittedAt: context.now,
          correlationId: context.correlationId,
          idempotencyKey: context.idempotencyKey,
        });
        return json(result.replayed ? 200 : 201, result);
      },
    },

    {
      method: 'GET',
      path: '/v1/rfqs/:rfqId/quotes',
      summary: 'Every offer against this tender. The buyer only.',
      handler: async (request: HttpRequest): Promise<HttpResponse> => {
        // Buyer-only, and this is the important one. A supplier who could read the other offers
        // knows exactly what to undercut, which turns a sealed tender into an auction where one
        // party sees everybody's cards.
        const { rfqId } = await requireBuyer(request);
        return json(200, { quotes: await quotes.listQuotesForRfq(rfqId) });
      },
    },

    {
      method: 'GET',
      path: '/v1/rfqs/:rfqId/evaluation',
      summary: 'The offers, ranked, each with the reason it scored what it did. The buyer only.',
      handler: async (request: HttpRequest): Promise<HttpResponse> => {
        const context = contextFor(request);
        const { rfqId } = await requireBuyer(request);

        // Reliability is empty until something computes it from delivery history. M-10 scores an
        // absent record at 600 rather than 0 — a supplier with no record is not an unreliable one —
        // so an empty map is a defensible position rather than a placeholder that lies.
        return json(200, {
          evaluations: await quotes.evaluateQuotes({ rfqId, now: context.now }),
        });
      },
    },

    {
      method: 'GET',
      path: '/v1/quotes/:quoteId',
      summary: 'One offer. Visible to the supplier who made it and the buyer it answers.',
      handler: async (request: HttpRequest): Promise<HttpResponse> => {
        const quote = await quotes.getQuote(request.params.quoteId ?? '');
        if (quote === null) {
          throw new ApiError(404, 'not-found', 'No such offer.');
        }
        return json(200, { quote });
      },
    },

    {
      method: 'GET',
      path: '/v1/quotes',
      summary: 'The offers this supplier has made, newest first.',
      handler: async (request: HttpRequest): Promise<HttpResponse> =>
        json(200, { quotes: await quotes.listQuotesForSupplier(accountFor(request)) }),
    },

    {
      method: 'POST',
      path: '/v1/quotes/:quoteId/withdrawal',
      summary: 'Take your own offer back. Changing a price means withdrawing and offering again.',
      handler: async (request: HttpRequest): Promise<HttpResponse> => {
        const context = contextFor(request);
        assertDoesNotAssertParty(request.body);

        const result = await quotes.withdrawQuote({
          quoteId: request.params.quoteId ?? '',
          // M-10 refuses `not-your-quote` when this is not the supplier who offered. Checked there
          // rather than only here, because that is where whose offer it is is actually known.
          actingAccountId: accountFor(request),
          reason: readString(request.body, 'reason'),
          occurredAt: context.now,
          correlationId: context.correlationId,
          idempotencyKey: context.idempotencyKey,
        });
        return json(200, result);
      },
    },

    {
      method: 'POST',
      path: '/v1/quotes/:quoteId/acceptance',
      summary: 'Take this offer. The buyer of the tender only.',
      handler: async (request: HttpRequest): Promise<HttpResponse> => {
        const context = contextFor(request);
        assertDoesNotAssertParty(request.body);

        const result = await quotes.acceptQuote({
          quoteId: request.params.quoteId ?? '',
          // M-10 checks this against the *tender's* buyer, not against the offer: "is this your
          // quote?" answers yes for the supplier who wrote it, and a supplier who could accept
          // their own offer has awarded themselves the order.
          actingAccountId: accountFor(request),
          reason: readString(request.body, 'reason'),
          occurredAt: context.now,
          correlationId: context.correlationId,
          idempotencyKey: context.idempotencyKey,
        });
        return json(200, result);
      },
    },

    {
      method: 'POST',
      path: '/v1/quotes/:quoteId/rejection',
      summary: 'You took another. Distinct from expiry: a supplier is owed the difference.',
      handler: async (request: HttpRequest): Promise<HttpResponse> => {
        const context = contextFor(request);
        assertDoesNotAssertParty(request.body);

        const result = await quotes.rejectQuote({
          quoteId: request.params.quoteId ?? '',
          actingAccountId: accountFor(request),
          reason: readString(request.body, 'reason'),
          occurredAt: context.now,
          correlationId: context.correlationId,
          idempotencyKey: context.idempotencyKey,
        });
        return json(200, result);
      },
    },

    // -----------------------------------------------------------------------
    // The supplier's inbox
    // -----------------------------------------------------------------------

    {
      method: 'GET',
      path: '/v1/invitations',
      summary: 'The tenders you have been asked to quote for.',
      handler: async (request: HttpRequest): Promise<HttpResponse> =>
        // Scoped by construction. A supplier sees their own invitations and no others, so there is
        // no object to guard and nothing to get wrong.
        json(200, {
          invitations: await tenders.listInvitationsForSupplier(accountFor(request)),
        }),
    },
  ];
}

/** Register the tender and offer routes on a router. */
export function addTenderRoutes(router: Router, options: TenderRoutesOptions): Router {
  for (const route of tenderRoutes(options)) router.add(route);
  return router;
}
