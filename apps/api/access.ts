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
import type { DirectoryService } from '../../modules/supplier-directory/index.ts';
import type { OrganisationService } from '../../modules/organisations/index.ts';
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
  /**
   * The business this request is being made for, when it is being made for one.
   *
   * Null for somebody acting as themselves. Present, the account below is the **organisation's**,
   * which is what every ownership check then compares against — so a member of one business reaches
   * that business's records and nobody else's, by the same rule that has always applied.
   */
  readonly actingForOrganisationId: string | null;
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
  /**
   * This route acts on **another party's** object, deliberately.
   *
   * Almost nothing does, and the default is the opposite: an object that is not yours is answered
   * 404. A few acts are inherently about somebody else — admitting a business to the market is the
   * first — and for those the ownership check is not a safety net but a contradiction, because the
   * whole point of the verb is that the object belongs to the party being decided about.
   *
   * Setting it does **not** loosen authority; it moves where the authority comes from:
   *
   *   * The action must be one no trading role holds, so K-04 refuses an ordinary caller by verb.
   *   * The caller must declare a **purpose** (`x-access-purpose`), because a role that reaches
   *     another party's records is a staff role, and K-04 refuses a staff grant whose purpose the
   *     caller did not declare (v3 §5.3). The declared purpose is recorded on the decision, so
   *     "why did somebody look at this" has an answer afterwards.
   *   * The handler still refuses the caller's **own** object, which is the case K-04 cannot see: a
   *     legitimate holder of the verb deciding about themselves.
   *
   * `why` is required, and is read by the next person wondering whether this should be here.
   */
  readonly actsOnAnotherParty?: { readonly why: string };
}

export interface OwnershipServices {
  readonly orders: OrderService;
  readonly payments: PaymentService;
  readonly ledger: FinancialLedgerService;
  readonly needs: CommerceRequestService;
  readonly tenders: RfqService;
  readonly quotes: QuoteService;
  readonly matching: MatchingService;
  readonly directory: DirectoryService;
  /** M-49: which business a person may act for, read live on every request that says it is. */
  readonly organisations: OrganisationService;
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

  /**
   * A directory entry belongs to the one account that trades under it.
   *
   * One account, one entry — M-48 says so with a UNIQUE — so this is a single owner rather than a
   * pair. An operator reaching it holds `admit`, which is a different verb and is not an ownership
   * claim: the guard answers 'not yours', and the handler answers 'not your decision'.
   */
  'supplier-directory-entry': async (services, id) => {
    const entry = await services.directory.getSupplier(id);
    return entry === null ? [] : [entry.accountId];
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

  // Joining, and signing in. Both are necessarily anonymous — a route that required a session in
  // order to acquire one would close the platform to everybody who is not already inside it.
  'POST /v1/participants': {
    anonymous: true,
    why:
      'Somebody who has not joined has no session, so requiring one would mean nobody could ever ' +
      'join. It creates only the caller’s own subject, account and password, collects no personal ' +
      'data at all, and grants only what the published policy gives CUSTOMER. What stops abuse is ' +
      'the rate limiter in front of it, not a session it is impossible to have.',
  },
  'POST /v1/sessions': {
    anonymous: true,
    why:
      'This is where a session comes from. K-02 answers every failure identically — unknown ' +
      'reference and wrong password are one refusal, hashed against a decoy either way — so it ' +
      'tells an unauthenticated caller nothing they did not already supply.',
  },

  'GET /v1/participants/me': { action: 'read', resourceType: 'account' },
  // Taking on a role changes what the caller's own account may do, which is an update to the
  // account. There is no identifier: it is always the caller's, and the handler refuses every role
  // that is not self-assumable.
  'POST /v1/participants/me/roles': { action: 'update', resourceType: 'account' },

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

  // The directory. Everything that names an entry resolves to the one account that trades under
  // it, so a party reaches their own and no other; the handlers check ownership a second time,
  // because for a route that may also be reached by an operator "is this yours?" and "may you do
  // this?" are different questions.
  //
  // `POST /v1/suppliers/:supplierId/status` is `admit` rather than `update`, and that one word is
  // what stops a supplier admitting themselves: no trading role holds it.
  'POST /v1/suppliers': { action: 'create', resourceType: 'supplier-directory-entry' },
  'GET /v1/suppliers': { action: 'read', resourceType: 'supplier-directory-entry' },
  'GET /v1/suppliers/me': { action: 'read', resourceType: 'supplier-directory-entry' },
  'GET /v1/suppliers/:supplierId': {
    action: 'read',
    resourceType: 'supplier-directory-entry',
    resourceId: param('supplierId'),
  },
  'PUT /v1/suppliers/:supplierId/availability': {
    action: 'update',
    resourceType: 'supplier-directory-entry',
    resourceId: param('supplierId'),
  },
  'GET /v1/suppliers/:supplierId/facets': {
    action: 'read',
    resourceType: 'supplier-directory-entry',
    resourceId: param('supplierId'),
  },
  'POST /v1/suppliers/:supplierId/facets': {
    action: 'update',
    resourceType: 'supplier-directory-entry',
    resourceId: param('supplierId'),
  },
  'DELETE /v1/suppliers/:supplierId/facets/:facetKind/:value': {
    action: 'update',
    resourceType: 'supplier-directory-entry',
    resourceId: param('supplierId'),
  },
  'GET /v1/suppliers/:supplierId/locations': {
    action: 'read',
    resourceType: 'supplier-directory-entry',
    resourceId: param('supplierId'),
  },
  'POST /v1/suppliers/:supplierId/locations': {
    action: 'update',
    resourceType: 'supplier-directory-entry',
    resourceId: param('supplierId'),
  },
  'DELETE /v1/suppliers/:supplierId/locations/:locationId': {
    action: 'update',
    resourceType: 'supplier-directory-entry',
    resourceId: param('supplierId'),
  },
  'GET /v1/suppliers/:supplierId/history': {
    action: 'read',
    resourceType: 'supplier-directory-entry',
    resourceId: param('supplierId'),
  },
  'POST /v1/suppliers/:supplierId/status': {
    action: 'admit',
    resourceType: 'supplier-directory-entry',
    resourceId: param('supplierId'),
    actsOnAnotherParty: {
      why:
        'Admitting a business to the market is a decision *about* somebody else, so the ownership ' +
        'check would refuse exactly the act this route exists for. `admit` is held by no trading ' +
        'role, the caller must declare a purpose K-04 records on the decision, and the handler ' +
        'refuses an operator deciding their own entry.',
    },
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

/**
 * Which business this request is being made for, if any.
 *
 * Returns null when the caller sent no `x-acting-for` header, which is the ordinary case: somebody
 * acting as themselves. When they did send one, **three** things must hold, and each refusal is the
 * same answer so that a stranger cannot use this to discover which organisations exist:
 *
 *   1. the organisation exists,
 *   2. the caller holds a membership in it,
 *   3. that membership is in a status that can act — so a suspended member stops on their next
 *      request rather than when their session happens to expire.
 *
 * What this function does **not** do is authorise anything. It only decides which account the
 * request is being made in; K-04 then evaluates whether the caller may do this action there, and
 * refuses an account they hold no grant in. Two independent checks, and the second is the one that
 * would still hold if this one were wrong.
 */
async function resolveActingFor(
  options: GuardOptions,
  request: HttpRequest,
  subjectId: string,
): Promise<{ readonly organisationId: string; readonly accountId: string } | null> {
  const header = request.headers['x-acting-for'];
  if (header === undefined || header.trim() === '') return null;
  const organisationId = header.trim();

  function refuse(): never {
    throw new ApiError(
      403,
      'not-acting-for',
      'You are not acting for that business. Either it does not exist, or you hold no place in ' +
        'it, or the place you hold is suspended — answered identically, because which of the ' +
        'three it is would tell a stranger about a company that did not ask them to know.',
    );
  }

  const membership = await options.services.organisations
    .findActingMembership(organisationId, subjectId)
    .catch(() => null);
  if (membership === null) refuse();

  const organisation = await options.services.organisations.getOrganisation(organisationId);
  if (organisation === null) refuse();

  return { organisationId, accountId: organisation.accountId };
}

/**
 * The purpose a staff caller declares, from `x-access-purpose`.
 *
 * Required on the few routes that act on another party. K-04 checks it against the vocabulary and
 * against the grant, so this only has to insist that one was sent: a staff request with no stated
 * reason is exactly the unpurposed staff access v3 §5.3 forbids, and defaulting one here would be
 * this file inventing somebody's reason for them.
 */
function declaredPurpose(request: HttpRequest): string {
  const value = request.headers['x-access-purpose'];
  if (value === undefined || value.trim() === '') {
    throw new ApiError(
      400,
      'purpose-required',
      'This route acts on another party’s record, so it needs a declared purpose. Send ' +
        '"x-access-purpose". Staff access is role-based, purpose-based and audited, and a request ' +
        'with no stated reason is one nobody can review afterwards.',
    );
  }
  return value.trim();
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
  const purpose = access.actsOnAnotherParty === undefined ? null : declaredPurpose(request);

  const session = await resolveSession(options, presentedToken);

  // **Acting for a business** (D-053, D-054).
  //
  // Explicit, never inferred. A request that meant "as myself" must not silently become "as the
  // company" because the caller happens to work somewhere — the two produce different records, and
  // an order placed in a business's name by somebody who thought they were buying a kettle is a
  // mistake nobody can see afterwards.
  //
  // The membership is what confers this, and it is read live: a suspended or revoked member stops
  // acting on the next request rather than when a token expires.
  const acting = await resolveActingFor(options, request, session.subjectId);
  const accountId = acting?.accountId ?? session.accountId;

  // Both identifiers are derived from the session that is making the request, and from the question
  // being asked. Deriving them from the correlation id **alone** would be a mistake: a client
  // supplies its own correlation id, so anybody who could guess one could record a decision under
  // the key a victim's request would use and have the victim's request refused as a fingerprint
  // mismatch. A session id is not guessable, and including it makes the key unforgeable by anyone
  // but the session holder.
  const key = `${session.sessionId}:${accountId}:${correlationId}:${request.method}:${access.action}:${access.resourceType}:${resourceId ?? '-'}`;

  // K-04 validates the session, resolves the account from the subject, and refuses the request if
  // the two disagree. `accountId` is passed as what the caller's session must resolve to — it is
  // checked, not trusted, and `authorize` throws `cross-account-access` if it is wrong.
  let decision;
  try {
    decision = await options.permissions.authorize({
      decisionId: deriveId('dec', 'authz-decision', key),
      presentedToken,
      // The session's own account, or the business the caller declared they are acting for and
      // holds an active membership in. K-04 checks the second case again, independently: it
      // refuses an account the subject holds no grant in, so a membership without grants — or a
      // membership this file misread — authorises nothing.
      accountId,
      action: access.action,
      resourceType: access.resourceType,
      resourceId,
      // Null for every ordinary route. K-04 refuses a purpose on a non-staff grant, so sending one
      // everywhere would deny every trading caller.
      ...(purpose === null ? {} : { purpose }),
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
    actingForOrganisationId: acting?.organisationId ?? null,
    accountId: decision.decision.accountId,
    sessionId: decision.decision.sessionId,
  };

  // The second check. K-04 said the caller may read orders; this says whether *this* order is one
  // of theirs. Without it a legitimate grant reads everybody's.
  //
  // Skipped only where the route says in so many words that it acts on another party — and there
  // the authority is a purposed staff grant K-04 has just evaluated and recorded, and the handler
  // refuses the caller's own object. Applying it there would refuse the act the route exists for.
  const resolve =
    resourceId === null || access.actsOnAnotherParty !== undefined
      ? undefined
      : OWNERS[access.resourceType];
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
): Promise<{ readonly sessionId: string; readonly subjectId: string; readonly accountId: string }> {
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
  return { sessionId, subjectId, accountId: account.accountId };
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
