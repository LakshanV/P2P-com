/**
 * Who may do what, on which object.
 *
 * Until this file existed every route was open: `GET /v1/accounts/{anyone}/money` returned anyone's
 * balances and `POST /v1/payments/{id}/capture` moved money for whoever could reach the port. K-04
 * Permissions was complete, integration tested, and called by nothing.
 *
 * There are **two** checks here, and leaving out either one leaves a hole.
 *
 * **K-04 answers "may this account do this action on this kind of thing".** It validates the
 * session before reading any storage, resolves the account from the subject rather than from the
 * request — a caller that could name its own account could authorise itself as anybody — and
 * refuses `cross-account-access` when the two disagree. Grants never span accounts, which is what
 * makes the account the isolation boundary.
 *
 * **This file answers "does that particular object belong to the caller's account".** K-04 cannot:
 * a grant for "every order in account A" is satisfied by *any* order id, because who owns order X
 * is M-11's fact and no permission component can know it. Without the second check, a grant that
 * legitimately says "you may read your orders" reads everybody's. That is the whole of IDOR, and it
 * is why the `OWNERS` table exists below.
 *
 * **The policy table is exhaustive and fails closed.** A route with no entry is refused, and a test
 * asserts that every registered route has one and that no entry names a route that has gone. Adding
 * a route without deciding who may call it is therefore a build failure rather than an open door.
 *
 * Owned by: apps/api.
 */

import type { CommerceRequestService } from '../../modules/commerce-request/index.ts';
import type { MatchingService } from '../../modules/matching/index.ts';
import type { QuoteService } from '../../modules/quotes/index.ts';
import type { RfqService } from '../../modules/rfq/index.ts';
import type { FinancialLedgerService } from '../../modules/financial-ledger/index.ts';
import type { OrderService } from '../../modules/orders/index.ts';
import type { PaymentService } from '../../modules/payments/index.ts';
import type {
  AccountLookup,
  PermissionService,
  SessionValidator,
} from '../../kernel/permissions/index.ts';
import { deriveId } from '../../platform/http/context.ts';
import type { HttpRequest } from '../../platform/http/types.ts';

import { ApiError } from './errors.ts';

/** What the caller turned out to be, after the session was validated and authority evaluated. */
export interface Principal {
  readonly subjectId: string;
  /** The K-03 account authority is scoped to. Resolved from the session, never from the request. */
  readonly accountId: string;
  readonly sessionId: string;
}

/**
 * The access rule for one route.
 *
 * A union rather than a struct with an `anonymous` flag, so an open route carries **no** action and
 * **no** resource type — there is nothing to be authorised, and a shape that still asked for one
 * would invite an entry that names a capability nobody ever checks. The `why` is required: a route
 * anybody may call needs a sentence saying why that is safe, written where the next person will
 * read it.
 */
export type RouteAccess = OpenRoute | GuardedRoute;

export interface OpenRoute {
  readonly anonymous: true;
  readonly why: string;
}

export interface GuardedRoute {
  readonly anonymous?: false;
  /** One of K-04's registered actions. An unregistered verb is refused by K-04, not silently allowed. */
  readonly action: string;
  readonly resourceType: string;
  /**
   * The object this request addresses, from the path. Null for a collection.
   *
   * When it is set and the resource type has an owner resolver, the guard additionally checks that
   * the object belongs to the caller's account. Who owns it is looked up by *resource type* rather
   * than declared per route, so two routes over the same kind of object cannot disagree about
   * ownership — which is exactly the sort of disagreement that becomes a hole in one of them.
   */
  readonly resourceId?: (request: HttpRequest) => string | null;
}

export interface OwnershipServices {
  readonly orders: OrderService;
  readonly payments: PaymentService;
  readonly ledger: FinancialLedgerService;
  readonly needs: CommerceRequestService;
  readonly tenders: RfqService;
  readonly quotes: QuoteService;
  readonly matching: MatchingService;
}

const param =
  (name: string) =>
  (request: HttpRequest): string | null =>
    request.params[name] ?? null;

/**
 * Who owns an order.
 *
 * Both parties. A seller must be able to read an order placed with them, and a buyer must be able
 * to read one they placed; either is refused everybody else's.
 */
async function orderOwners(
  services: OwnershipServices,
  orderId: string,
): Promise<readonly string[]> {
  const order = await services.orders.getOrder(orderId);
  if (order === null) return [];
  return [order.buyerAccountId, order.sellerAccountId];
}

async function paymentOwners(
  services: OwnershipServices,
  paymentId: string,
): Promise<readonly string[]> {
  try {
    const payment = await services.payments.getPayment(paymentId);
    return [payment.payerAccountId, payment.payeeAccountId];
  } catch {
    // M-12 refuses an unknown payment rather than returning null. Absent is absent.
    return [];
  }
}

/**
 * Which accounts may reach one object.
 *
 * A list, not a single owner, because an order legitimately has two parties. An **empty** list
 * means either that the object does not exist or that nobody owns it, and both are answered the
 * same way: an object nobody owns is not an object a stranger may read.
 */
export type OwnerResolver = (
  services: OwnershipServices,
  resourceId: string,
) => Promise<readonly string[]>;

/** The resolvers, keyed by the resource type the policy names. */
const OWNERS: Readonly<Record<string, OwnerResolver>> = Object.freeze({
  order: orderOwners,
  payment: paymentOwners,
  wallet: async (services, id) => {
    try {
      return [(await services.ledger.getWallet(id)).ownerAccountId];
    } catch {
      return [];
    }
  },
  'value-plan': async (services, id) => {
    try {
      const plan = await services.ledger.getPlan(id);
      return [plan.payerAccountId, plan.payeeAccountId];
    } catch {
      return [];
    }
  },
  /**
   * A Need has exactly one party: whoever asked.
   *
   * Unlike an order, where a buyer and a seller both legitimately reach the record, a Need is one
   * person saying what they want. Nobody else may read it — including a supplier, who sees a
   * sourcing request derived from it rather than the words themselves.
   */
  'commerce-request': async (services, id) => {
    const need = await services.needs.getNeed(id);
    return need === null ? [] : [need.accountId];
  },
  /**
   * A tender: its buyer, **and every supplier invited to quote for it**.
   *
   * The invited suppliers are the point. A tender they cannot read is a tender they cannot answer,
   * so object-level access has to include them — which means "may this caller reach this tender?"
   * and "is this caller the buyer?" are different questions. The routes ask the second one
   * themselves for everything only a buyer may do: inviting, listing who else was invited, reading
   * the offers, ranking them, choosing. This resolver deliberately does not answer that, and a
   * reader who assumed it did would open a sealed tender to the people bidding in it.
   */
  rfq: async (services, id) => {
    const tender = await services.tenders.getRfq(id);
    if (tender === null) return [];
    const invitations = await services.tenders.listInvitations(id);
    return [tender.accountId, ...invitations.map((one) => one.supplierAccountId)];
  },

  /**
   * An offer: the supplier who made it, and the buyer of the tender it answers.
   *
   * Both parties legitimately reach the record — but reaching it is not deciding it. M-10 checks
   * accepting and rejecting against the **tender's** buyer, because this list answers yes for the
   * supplier who wrote the offer, and a supplier who could accept their own has awarded themselves
   * the order.
   */
  quote: async (services, id) => {
    const quote = await services.quotes.getQuote(id);
    if (quote === null) return [];
    const tender = await services.tenders.getRfq(quote.rfqId);
    return tender === null
      ? [quote.supplierAccountId]
      : [quote.supplierAccountId, tender.accountId];
  },

  /**
   * A sourcing run belongs to whoever asked the Need it answers.
   *
   * Read from the run rather than from M-03, because M-07 copies the account onto the run precisely
   * so a run can be scoped without reading the Need back — and a resolver that went through M-03
   * would let a deleted Need make its runs unreachable rather than unowned.
   */
  'sourcing-run': async (services, id) => {
    const run = await services.matching.getRun(id);
    return run === null ? [] : [run.accountId];
  },

  /** An account addresses itself. The object *is* the account. */
  account: (_services, id) => Promise.resolve([id]),
});

/**
 * Every route, and who may call it.
 *
 * Keyed `METHOD /path` exactly as registered. Exhaustive by test: a route without an entry here
 * fails the suite, and an entry without a route fails it too, so this table cannot drift away from
 * what the API actually serves.
 */
export const ACCESS_POLICY: Readonly<Record<string, RouteAccess>> = Object.freeze({
  'GET /v1/health': {
    anonymous: true,
    why:
      'It touches no module and no database, and reveals nothing but that the process is running — ' +
      'which anything that can open a socket already knows. A load balancer has no session.',
  },
  // The route inventory describes the shape of the API, not anybody's data. It still needs a
  // session: an unauthenticated map of every endpoint is free reconnaissance.
  'GET /v1/routes': { action: 'read', resourceType: 'configuration' },

  // Orders.
  'POST /v1/orders': { action: 'create', resourceType: 'order' },
  'GET /v1/orders/:orderId': {
    action: 'read',
    resourceType: 'order',
    resourceId: param('orderId'),
  },
  'POST /v1/orders/:orderId/items': {
    action: 'update',
    resourceType: 'order',
    resourceId: param('orderId'),
  },
  'POST /v1/orders/:orderId/placement': {
    action: 'update',
    resourceType: 'order',
    resourceId: param('orderId'),
  },
  'POST /v1/orders/:orderId/confirmation': {
    action: 'update',
    resourceType: 'order',
    resourceId: param('orderId'),
  },
  'POST /v1/orders/:orderId/fulfilment': {
    action: 'update',
    resourceType: 'order',
    resourceId: param('orderId'),
  },
  'POST /v1/orders/:orderId/completion': {
    action: 'update',
    resourceType: 'order',
    resourceId: param('orderId'),
  },
  'POST /v1/orders/:orderId/cancellation': {
    action: 'update',
    resourceType: 'order',
    resourceId: param('orderId'),
  },
  'POST /v1/orders/:orderId/split': {
    action: 'update',
    resourceType: 'order',
    resourceId: param('orderId'),
  },
  'GET /v1/orders/:orderId/items': {
    action: 'read',
    resourceType: 'order',
    resourceId: param('orderId'),
  },
  'GET /v1/orders/:orderId/snapshot': {
    action: 'read',
    resourceType: 'order',
    resourceId: param('orderId'),
  },
  'GET /v1/orders/:orderId/history': {
    action: 'read',
    resourceType: 'order',
    resourceId: param('orderId'),
  },
  'GET /v1/orders/:orderId/fulfilment': {
    action: 'read',
    resourceType: 'order',
    resourceId: param('orderId'),
  },
  'GET /v1/orders/:orderId/payments': {
    action: 'read',
    resourceType: 'order',
    resourceId: param('orderId'),
  },

  // Payments.
  'POST /v1/payments': { action: 'create', resourceType: 'payment' },
  'POST /v1/payments/:paymentId/authorisation': {
    action: 'update',
    resourceType: 'payment',
    resourceId: param('paymentId'),
  },
  'POST /v1/payments/:paymentId/capture': {
    action: 'capture',
    resourceType: 'payment',
    resourceId: param('paymentId'),
  },
  'POST /v1/payments/:paymentId/cancellation': {
    action: 'update',
    resourceType: 'payment',
    resourceId: param('paymentId'),
  },
  'POST /v1/payments/:paymentId/refunds': {
    action: 'refund',
    resourceType: 'payment',
    resourceId: param('paymentId'),
  },
  'GET /v1/payments/:paymentId': {
    action: 'read',
    resourceType: 'payment',
    resourceId: param('paymentId'),
  },
  'GET /v1/payments/:paymentId/attempts': {
    action: 'read',
    resourceType: 'payment',
    resourceId: param('paymentId'),
  },
  'GET /v1/payments/:paymentId/refunds': {
    action: 'read',
    resourceType: 'payment',
    resourceId: param('paymentId'),
  },
  'GET /v1/payments/:paymentId/receipts': {
    action: 'read',
    resourceType: 'payment',
    resourceId: param('paymentId'),
  },
  /**
   * A provider delivery.
   *
   * Open to a *session*, because a payment gateway holds none and never will. It is not open to a
   * *stranger*: the handler verifies an HMAC signature over the exact bytes the provider sent,
   * against a secret only the two of them hold, within a short window so a captured delivery cannot
   * be replayed tomorrow. That signature is the authentication, and there is no path through this
   * route without it — the body may not claim the check has already happened.
   *
   * Requiring a session here instead would not have helped: it would have meant every authenticated
   * customer could post a delivery claiming any payment had been captured.
   */
  'POST /v1/payments/webhooks/:provider': {
    anonymous: true,
    why:
      'A payment gateway has no session. It authenticates with an HMAC signature over the raw body, ' +
      'verified in the handler against the per-provider secret; an unsigned or stale delivery is ' +
      'refused before M-12 sees it.',
  },

  // Ledger.
  'POST /v1/wallets': { action: 'create', resourceType: 'wallet' },
  'POST /v1/wallets/:walletId/status': {
    action: 'update',
    resourceType: 'wallet',
    resourceId: param('walletId'),
  },
  'GET /v1/wallets/:walletId': {
    action: 'read',
    resourceType: 'wallet',
    resourceId: param('walletId'),
  },
  'GET /v1/wallets/:walletId/history': {
    action: 'read',
    resourceType: 'wallet',
    resourceId: param('walletId'),
  },
  'GET /v1/accounts/:accountId/wallets': {
    action: 'read',
    resourceType: 'account',
    resourceId: param('accountId'),
  },
  'POST /v1/value-plans': { action: 'create', resourceType: 'value-plan' },
  'POST /v1/value-plans/:planId/commitment': {
    action: 'update',
    resourceType: 'value-plan',
    resourceId: param('planId'),
  },
  'POST /v1/value-plans/:planId/legs/:legId/settlement': {
    action: 'update',
    resourceType: 'value-plan',
    resourceId: param('planId'),
  },
  'POST /v1/value-plans/:planId/cancellation': {
    action: 'update',
    resourceType: 'value-plan',
    resourceId: param('planId'),
  },
  'GET /v1/value-plans/:planId': {
    action: 'read',
    resourceType: 'value-plan',
    resourceId: param('planId'),
  },
  'GET /v1/value-plans/:planId/coverage': {
    action: 'read',
    resourceType: 'value-plan',
    resourceId: param('planId'),
  },

  // Needs. The entry point of the product, and the first routes a customer uses as themselves.
  'POST /v1/needs': { action: 'create', resourceType: 'commerce-request' },
  // No resourceId: the handler scopes the list to the caller's own account by construction, so
  // there is no identifier to get wrong and nothing to check ownership against.
  'GET /v1/needs': { action: 'read', resourceType: 'commerce-request' },
  'GET /v1/needs/:requestId': {
    action: 'read',
    resourceType: 'commerce-request',
    resourceId: param('requestId'),
  },
  'POST /v1/needs/:requestId/interpretations': {
    action: 'update',
    resourceType: 'commerce-request',
    resourceId: param('requestId'),
  },
  'GET /v1/needs/:requestId/interpretations': {
    action: 'read',
    resourceType: 'commerce-request',
    resourceId: param('requestId'),
  },
  'POST /v1/needs/:requestId/media': {
    action: 'update',
    resourceType: 'commerce-request',
    resourceId: param('requestId'),
  },
  'GET /v1/needs/:requestId/media': {
    action: 'read',
    resourceType: 'commerce-request',
    resourceId: param('requestId'),
  },
  'POST /v1/needs/:requestId/readiness': {
    action: 'update',
    resourceType: 'commerce-request',
    resourceId: param('requestId'),
  },
  'POST /v1/needs/:requestId/cancellation': {
    action: 'update',
    resourceType: 'commerce-request',
    resourceId: param('requestId'),
  },
  'GET /v1/needs/:requestId/history': {
    action: 'read',
    resourceType: 'commerce-request',
    resourceId: param('requestId'),
  },

  // Sourcing. Running the ladder is an `update` on the Need — it changes its status and appends a
  // run to it — so the object-level check is the Need's own owner. Nobody else sources somebody
  // else's Need.
  'POST /v1/needs/:requestId/sourcing': {
    action: 'update',
    resourceType: 'commerce-request',
    resourceId: param('requestId'),
  },
  'GET /v1/needs/:requestId/sourcing': {
    action: 'read',
    resourceType: 'commerce-request',
    resourceId: param('requestId'),
  },
  'GET /v1/sourcing-runs/:runId': {
    action: 'read',
    resourceType: 'sourcing-run',
    resourceId: param('runId'),
  },
  'GET /v1/sourcing-runs/:runId/attempts': {
    action: 'read',
    resourceType: 'sourcing-run',
    resourceId: param('runId'),
  },
  'GET /v1/sourcing-runs/:runId/candidates': {
    action: 'read',
    resourceType: 'sourcing-run',
    resourceId: param('runId'),
  },

  // Tenders. `rfq` ownership includes the invited suppliers, deliberately: a tender they cannot
  // read is a tender they cannot answer. Everything only a buyer may do is checked again in the
  // handler, because for an invited supplier "is this your tender?" honestly answers yes.
  'POST /v1/rfqs': { action: 'create', resourceType: 'rfq' },
  'GET /v1/rfqs': { action: 'read', resourceType: 'rfq' },
  'GET /v1/rfqs/:rfqId': { action: 'read', resourceType: 'rfq', resourceId: param('rfqId') },
  'POST /v1/rfqs/:rfqId/invitations': {
    action: 'update',
    resourceType: 'rfq',
    resourceId: param('rfqId'),
  },
  'GET /v1/rfqs/:rfqId/invitations': {
    action: 'read',
    resourceType: 'rfq',
    resourceId: param('rfqId'),
  },
  'GET /v1/rfqs/:rfqId/history': {
    action: 'read',
    resourceType: 'rfq',
    resourceId: param('rfqId'),
  },
  'POST /v1/rfqs/:rfqId/closure': {
    action: 'update',
    resourceType: 'rfq',
    resourceId: param('rfqId'),
  },
  'POST /v1/rfqs/:rfqId/award': {
    action: 'update',
    resourceType: 'rfq',
    resourceId: param('rfqId'),
  },
  'POST /v1/rfqs/:rfqId/cancellation': {
    action: 'update',
    resourceType: 'rfq',
    resourceId: param('rfqId'),
  },
  'GET /v1/rfqs/:rfqId/quotes': {
    action: 'read',
    resourceType: 'rfq',
    resourceId: param('rfqId'),
  },
  'GET /v1/rfqs/:rfqId/evaluation': {
    action: 'read',
    resourceType: 'rfq',
    resourceId: param('rfqId'),
  },

  // Offers. Submitting is guarded against the **tender**, because the offer does not exist yet and
  // there is nothing else to check: M-10 then refuses a supplier who was not invited.
  'POST /v1/rfqs/:rfqId/quotes': {
    action: 'quote',
    resourceType: 'rfq',
    resourceId: param('rfqId'),
  },
  'GET /v1/quotes': { action: 'read', resourceType: 'quote' },
  'GET /v1/quotes/:quoteId': {
    action: 'read',
    resourceType: 'quote',
    resourceId: param('quoteId'),
  },
  'POST /v1/quotes/:quoteId/withdrawal': {
    action: 'withdraw',
    resourceType: 'quote',
    resourceId: param('quoteId'),
  },
  'POST /v1/quotes/:quoteId/acceptance': {
    action: 'decide',
    resourceType: 'quote',
    resourceId: param('quoteId'),
  },
  'POST /v1/quotes/:quoteId/rejection': {
    action: 'decide',
    resourceType: 'quote',
    resourceId: param('quoteId'),
  },

  // A supplier's own inbox. Scoped by construction: there is no object and no parameter.
  'GET /v1/invitations': { action: 'read', resourceType: 'rfq' },

  // Cockpit. Every one addresses an account, and the account is the object.
  'GET /v1/accounts/:accountId/money': {
    action: 'read',
    resourceType: 'account',
    resourceId: param('accountId'),
  },
  'GET /v1/accounts/:accountId/orders': {
    action: 'read',
    resourceType: 'account',
    resourceId: param('accountId'),
  },
  'GET /v1/cockpit/orders/:orderId': {
    action: 'read',
    resourceType: 'order',
    resourceId: param('orderId'),
  },
});

export interface GuardOptions {
  readonly permissions: PermissionService;
  /**
   * K-02's session validation and K-03's account lookup, as K-04 already defines them.
   *
   * The API needs the account before it can call `authorize`, and there is no honest way to get it
   * except from the session. These are the same two ports K-04 itself is constructed with, so the
   * API and the permission component agree on what a session means by construction rather than by
   * two implementations that have to be kept in step.
   */
  readonly sessions: SessionValidator;
  readonly accounts: AccountLookup;
  readonly services: OwnershipServices;
}

/**
 * The bearer token, or a refusal.
 *
 * `Bearer` only. A token in a query string ends up in access logs, browser history and referrer
 * headers, and a scheme that accepted one would be a scheme somebody used.
 */
export function bearerToken(request: HttpRequest): string {
  const header = request.headers.authorization;
  if (header === undefined || header === '') {
    throw new ApiError(
      401,
      'not-authenticated',
      'This route needs a session. Send "Authorization: Bearer <token>".',
    );
  }
  const match = /^Bearer (\S+)$/.exec(header);
  if (match === null || match[1] === undefined) {
    throw new ApiError(
      401,
      'malformed-authorization',
      'The Authorization header must be "Bearer <token>".',
    );
  }
  return match[1];
}

/** The policy for a route, by method and registered path. */
export function accessFor(method: string, routePath: string): RouteAccess | undefined {
  return ACCESS_POLICY[`${method} ${routePath}`];
}

/**
 * Decide whether this request may proceed, and say who is making it.
 *
 * Order matters and is deliberate: authenticate, then authorise the *kind* of thing, then check the
 * *particular* thing. Checking ownership first would answer "does this order exist?" for an
 * unauthenticated caller.
 */
export async function guard(
  options: GuardOptions,
  request: HttpRequest,
  access: GuardedRoute,
  correlationId: string,
): Promise<Principal> {
  const presentedToken = bearerToken(request);
  const resourceId = access.resourceId?.(request) ?? null;

  const session = await resolveSession(options, presentedToken);

  // Both identifiers are derived from the session that is making the request, and from the question
  // being asked. Deriving them from the correlation id **alone** would be a mistake: a client
  // supplies its own correlation id, so anybody who could guess one could record a decision under
  // the key a victim's request would use and have the victim's request refused as a fingerprint
  // mismatch. A session id is not guessable, and including it makes the key unforgeable by anyone
  // but the session holder.
  const key = `${session.sessionId}:${correlationId}:${request.method}:${access.action}:${access.resourceType}:${resourceId ?? '-'}`;

  // K-04 validates the session, resolves the account from the subject, and refuses the request if
  // the two disagree. `accountId` is passed as what the caller's session must resolve to — it is
  // checked, not trusted, and `authorize` throws `cross-account-access` if it is wrong.
  let decision;
  try {
    decision = await options.permissions.authorize({
      decisionId: deriveId('dec', 'authz-decision', key),
      presentedToken,
      // Resolved by K-04 from the session. Supplying the session's own account here is the only
      // value that can pass, which is the point.
      accountId: session.accountId,
      action: access.action,
      resourceType: access.resourceType,
      resourceId,
      idempotencyKey: deriveId('idem', 'authz-request', key),
    });
  } catch (error) {
    throw asAccessError(error);
  }

  if (decision.decision.effect !== 'allow') {
    throw new ApiError(
      403,
      'not-permitted',
      `No grant permits "${access.action}" on ${access.resourceType} for this account.`,
    );
  }

  const principal: Principal = {
    subjectId: decision.decision.subjectId,
    accountId: decision.decision.accountId,
    sessionId: decision.decision.sessionId,
  };

  // The second check. K-04 said the caller may read orders; this says whether *this* order is one
  // of theirs. Without it a legitimate grant reads everybody's.
  const resolve = resourceId === null ? undefined : OWNERS[access.resourceType];
  if (resourceId !== null && resolve !== undefined) {
    const permitted = await resolve(options.services, resourceId);
    if (!permitted.includes(principal.accountId)) {
      // Absent and forbidden are answered identically. Distinguishing them would tell a stranger
      // which identifiers exist, which is the enumeration problem in a different costume.
      throw new ApiError(404, 'not-found', 'No such resource.');
    }
  }

  return principal;
}

/**
 * The session and the account it resolves to.
 *
 * `authorize` requires the caller to *state* an account, and the only honest thing for an API to
 * state is what the session says — so it is resolved here rather than read from the request. A
 * caller that could name its own account could authorise itself as anybody.
 *
 * This resolution is a convenience, not the control. K-04 performs it again, independently, and
 * throws `cross-account-access` if the two disagree; that is the check that actually holds. If this
 * function were wrong or absent the request would be refused rather than admitted.
 */
async function resolveSession(
  options: GuardOptions,
  presentedToken: string,
): Promise<{ readonly sessionId: string; readonly accountId: string }> {
  let sessionId: string;
  let subjectId: string;
  try {
    const asserted = await options.sessions.validate(presentedToken);
    sessionId = asserted.sessionId;
    subjectId = asserted.subjectId;
  } catch {
    // Deliberately not inspected. A session error can carry a fragment of the presented secret in
    // its message, and repeating one in an HTTP response is how a secret ends up in a log.
    throw new ApiError(401, 'not-authenticated', 'That session is not valid.');
  }

  const account = await options.accounts.findAccountForSubject(subjectId);
  if (account === null) {
    throw new ApiError(
      403,
      'no-account',
      'That session belongs to a subject holding no universal account, so there is nothing to ' +
        'scope authority to.',
    );
  }
  return { sessionId, accountId: account.accountId };
}

/**
 * Turn a K-04 or K-02 refusal into an HTTP one.
 *
 * Every authentication failure is 401 and every authority failure is 403, with a message that says
 * nothing about which grant was missing or whose account was named. A refusal that explained itself
 * would be a way to map the platform's authority model from outside it.
 */
function asAccessError(error: unknown): unknown {
  if (error instanceof ApiError) return error;
  const code = (error as { code?: unknown }).code;

  if (
    code === 'session-expired' ||
    code === 'session-revoked' ||
    code === 'unknown-session' ||
    code === 'invalid-token'
  ) {
    return new ApiError(401, 'not-authenticated', 'That session is not valid.');
  }
  if (code === 'cross-account-access') {
    return new ApiError(403, 'not-permitted', 'That does not belong to this account.');
  }
  if (code === 'no-such-policy') {
    // No policy published means nothing is authorised. That is the correct answer and a
    // configuration failure at the same time, so it is loud rather than a quiet 403.
    return new ApiError(
      503,
      'no-policy',
      'No authorisation policy is published, so nothing can be authorised.',
    );
  }
  if (typeof code === 'string') {
    return new ApiError(403, 'not-permitted', 'Not permitted.');
  }
  return error;
}
