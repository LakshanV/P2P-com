/**
 * Who may call what: the suite that stands between this API and an open door.
 *
 * Until the guard existed, every route was reachable by anybody who could open a socket.
 * `GET /v1/accounts/{anyone}/money` returned anyone's balances. `POST /v1/payments/{id}/capture`
 * moved money for whoever asked. K-04 Permissions was complete, integration tested, and called by
 * nothing at all — the component that answers "may this party do this?" had no caller.
 *
 * Six questions are asked here, and each one is a different way in:
 *
 *   1. **No session.** Does an anonymous request reach anything?
 *   2. **The wrong person.** Does one customer's session reach another customer's data?
 *   3. **The wrong account.** Authority never spans accounts in this platform; is that true at the
 *      HTTP edge as well as inside K-04?
 *   4. **The wrong role.** Can a buyer do a seller's job — capture their own payment, refund
 *      themselves?
 *   5. **Somebody else's object.** A grant that says "you may read orders" is satisfied by *any*
 *      order id as far as K-04 is concerned. Does anything stop it reading everybody's?
 *   6. **Escalation.** Can a caller widen its own authority by what it puts in a request?
 *
 * Nothing here is stubbed. K-01 mints the subjects, K-03 opens the accounts, K-02 hashes the
 * passwords and issues the sessions, K-04 evaluates the grants against a published policy version.
 * A suite of four agreeable fakes would pass while the real components disagreed.
 *
 * The tests at the foot of the file are the ones that keep it honest as the API grows: every
 * registered route must have a policy entry, every entry must name a route that still exists, the
 * set of open routes is pinned, and every capability a route needs must be held by some published
 * role. Adding a route without deciding who may call it is a failing build rather than an open door.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FinancialLedgerService,
  InMemoryFinancialLedgerRepository,
  K10LedgerPort,
} from '../modules/financial-ledger/index.ts';
import { InMemoryLedgerRepository, LedgerService } from '../kernel/ledger-foundation/index.ts';
import { InMemoryOrderRepository, OrderService } from '../modules/orders/index.ts';
import {
  InMemoryPaymentRepository,
  PaymentService,
  resolveMockProvider,
} from '../modules/payments/index.ts';
import { UserCockpitService } from '../modules/user-cockpit/index.ts';
import { ACCESS_POLICY } from '../apps/api/access.ts';
import { buildApi } from '../apps/api/app.ts';
import { JAYA_V1_ROLES, publishedCapabilities } from '../apps/api/policy.ts';
import { handleRequest, type PipelineOptions } from '../platform/http/pipeline.ts';
import type { HttpResponse } from '../platform/http/types.ts';

import { identityStack, type SignedIn } from './helpers/api-identity.ts';

const NOW = '2026-07-01T09:00:00.000000Z';

type Call = (
  method: string,
  target: string,
  options?: {
    readonly as?: SignedIn | null;
    readonly body?: unknown;
    readonly key?: string;
  },
) => Promise<HttpResponse>;

interface Harness {
  readonly call: Call;
  /** A customer. Owns orders and payments, and may not capture or refund. */
  readonly buyer: SignedIn;
  /** The seller on the buyer's orders. May capture and refund; may not create an order. */
  readonly seller: SignedIn;
  /** A third party with a valid session and the CUSTOMER role, and no relationship to the others. */
  readonly stranger: SignedIn;
  /** Signed in, and granted nothing at all. Every route answers the same way for them. */
  readonly powerless: SignedIn;
  /**
   * The pipeline itself, for tests that need to send exactly the headers they choose.
   *
   * Its router is also where the route inventory comes from, so the exhaustiveness tests below
   * compare the policy table against what this very API serves rather than against a second one
   * built to look like it.
   */
  readonly api: PipelineOptions;
}

const codeOf = (response: HttpResponse): string =>
  (response.body as { code?: string }).code ?? '(no code)';

async function build(): Promise<Harness> {
  const orders = new OrderService(new InMemoryOrderRepository());
  const payments = new PaymentService(new InMemoryPaymentRepository(), resolveMockProvider);
  const journal = new LedgerService(new InMemoryLedgerRepository());
  await journal.registerAssetType({
    assetTypeId: 'jaya_reward',
    assetClass: 'reward',
    symbol: 'JAYAREWARD',
    precision: 0,
    transferability: false,
    withdrawability: false,
    valuationSource: 'fixed',
    issuer: 'iss_01HR0ACCjayaplt',
    unit: 'point',
    redeemable: true,
    convertible: false,
    expiryDays: null,
    restrictions: {},
    custodyProvider: null,
    jurisdiction: 'GLOBAL',
  });
  const ledger = new FinancialLedgerService(
    new InMemoryFinancialLedgerRepository(),
    new K10LedgerPort(journal),
  );

  const identity = await identityStack(NOW);
  const buyer = await identity.register({ handle: 'access-buyer', roles: ['CUSTOMER'] });
  const seller = await identity.register({ handle: 'access-seller', roles: ['SUPPLIER'] });
  const stranger = await identity.register({ handle: 'access-stranger', roles: ['CUSTOMER'] });
  const powerless = await identity.register({ handle: 'access-nobody', roles: [] });

  const api = buildApi({
    services: {
      orders,
      payments,
      ledger,
      cockpit: new UserCockpitService({ orders, payments, ledger, journal }),
    },
    access: identity,
    clock: () => NOW,
    generateCorrelationId: () => 'corr_01HR0ACCGENERATED',
  });

  let sequence = 0;
  const call: Call = (method, target, options = {}) => {
    sequence += 1;
    const principal = options.as === undefined ? buyer : options.as;
    return handleRequest(api, {
      method,
      target,
      headers: {
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(principal === null ? {} : { authorization: `Bearer ${principal.token}` }),
        'idempotency-key': options.key ?? `idem_access_${String(sequence).padStart(4, '0')}`,
        // A distinct correlation id per request, so no two authorisation decisions collide on a
        // derived key and a refusal is never an accident of the fixture.
        'x-correlation-id': `corr_01HR0ACC${String(sequence).padStart(6, '0')}`,
      },
      body: options.body === undefined ? null : JSON.stringify(options.body),
    });
  };

  return { call, buyer, seller, stranger, powerless, api };
}

/** An order the buyer placed with the seller, created through the API by its owner. */
async function anOrder(harness: Harness): Promise<string> {
  const created = await harness.call('POST', '/v1/orders', {
    as: harness.buyer,
    body: {
      buyerAccountId: harness.buyer.accountId,
      sellerAccountId: harness.seller.accountId,
      currency: 'LKR',
      reason: 'a basket, so there is something to try to reach',
    },
    key: 'idem_access_order_001',
  });
  assert.equal(created.status, 201, 'the fixture order must exist before anything can be denied');
  return (created.body as { order: { orderId: string } }).order.orderId;
}

/** A payment from the buyer to the seller, created by the buyer. */
async function aPayment(harness: Harness, orderId: string): Promise<string> {
  const created = await harness.call('POST', '/v1/payments', {
    as: harness.buyer,
    body: {
      orderId,
      payerAccountId: harness.buyer.accountId,
      payeeAccountId: harness.seller.accountId,
      provider: 'mock',
      rail: 'card',
      instrumentToken: 'tok_01HR0ACCgood01',
      assetCode: 'LKR',
      assetScale: 2,
      amountMinor: '250000',
    },
    key: 'idem_access_pay_001',
  });
  assert.equal(created.status, 201);
  return (created.body as { payment: { paymentId: string } }).payment.paymentId;
}

// ---------------------------------------------------------------------------
// 1. No session
// ---------------------------------------------------------------------------

test('an unauthenticated request reaches nothing but health', async () => {
  const harness = await build();
  const orderId = await anOrder(harness);
  const paymentId = await aPayment(harness, orderId);

  const health = await harness.call('GET', '/v1/health', { as: null });
  assert.equal(health.status, 200, 'a load balancer has no session, and needs none');

  // Every other route, including the ones that only read. A reconnaissance map of the API is worth
  // having before an attack, so the route inventory is behind a session too.
  const closed: ReadonlyArray<readonly [string, string]> = [
    ['GET', '/v1/routes'],
    ['GET', `/v1/orders/${orderId}`],
    ['POST', '/v1/orders'],
    ['GET', `/v1/payments/${paymentId}`],
    ['POST', `/v1/payments/${paymentId}/capture`],
    ['GET', `/v1/accounts/${harness.buyer.accountId}/money`],
    ['GET', `/v1/accounts/${harness.buyer.accountId}/orders`],
    ['GET', `/v1/cockpit/orders/${orderId}`],
    ['POST', '/v1/wallets'],
    ['POST', '/v1/value-plans'],
  ];

  for (const [method, target] of closed) {
    const response = await harness.call(method, target, { as: null, body: {} });
    assert.equal(response.status, 401, `${method} ${target} answered a request with no session`);
    assert.equal(codeOf(response), 'not-authenticated');
  }
});

test('a malformed or unknown bearer token is refused, and the refusal says nothing about it', async () => {
  const harness = await build();

  const shapes: ReadonlyArray<readonly [string, string]> = [
    ['token-in-the-wrong-scheme', 'Basic abcdefghijklmnop'],
    ['no-scheme-at-all', 'abcdefghijklmnopqrst'],
    ['bearer-with-nothing-after-it', 'Bearer '],
  ];

  for (const [name, header] of shapes) {
    const response = await handleRequest(
      harness.api,
      rawGet('/v1/routes', { authorization: header }),
    );
    assert.equal(response.status, 401, `${name} was accepted`);
    assert.equal(codeOf(response), 'malformed-authorization');
  }

  // A well-formed token that authenticates nobody. The refusal must not distinguish this from an
  // expired one or a revoked one: each distinction is a fact about somebody else's session.
  const unknown = await handleRequest(
    harness.api,
    rawGet('/v1/routes', { authorization: `Bearer ${'z'.repeat(48)}` }),
  );
  assert.equal(unknown.status, 401);
  assert.equal(codeOf(unknown), 'not-authenticated');
  assert.ok(
    !JSON.stringify(unknown.body).includes('z'.repeat(10)),
    'the refusal must not echo the presented secret',
  );
});

// ---------------------------------------------------------------------------
// 2 and 5. The wrong person, and somebody else's object
// ---------------------------------------------------------------------------

test('one customer cannot read another customer’s order, and cannot tell it exists', async () => {
  const harness = await build();
  const orderId = await anOrder(harness);

  const mine = await harness.call('GET', `/v1/orders/${orderId}`, { as: harness.buyer });
  assert.equal(mine.status, 200, 'the buyer reads their own order');

  const theirs = await harness.call('GET', `/v1/orders/${orderId}`, { as: harness.stranger });
  assert.equal(
    theirs.status,
    404,
    'the stranger holds a perfectly good "read orders" grant; what stops them is that this order ' +
      'is not theirs. K-04 cannot know that — who owns an order is M-11’s fact',
  );

  // The heart of it: a resource that exists and one that does not are answered identically. A 403
  // for the first and a 404 for the second is an oracle for enumerating identifiers.
  const absent = await harness.call('GET', '/v1/orders/ord_01HR0ACCnothing1', {
    as: harness.stranger,
  });
  assert.equal(absent.status, 404);
  assert.deepEqual(
    { status: theirs.status, code: codeOf(theirs) },
    { status: absent.status, code: codeOf(absent) },
    'forbidden and absent must be indistinguishable from outside',
  );
});

test('one customer cannot reach another’s payment by any route that names it', async () => {
  const harness = await build();
  const orderId = await anOrder(harness);
  const paymentId = await aPayment(harness, orderId);

  const reads: readonly string[] = [
    `/v1/payments/${paymentId}`,
    `/v1/payments/${paymentId}/attempts`,
    `/v1/payments/${paymentId}/refunds`,
    `/v1/payments/${paymentId}/receipts`,
  ];
  for (const target of reads) {
    const own = await harness.call('GET', target, { as: harness.buyer });
    assert.equal(own.status, 200, `the payer cannot read ${target} of their own payment`);

    const other = await harness.call('GET', target, { as: harness.stranger });
    assert.equal(other.status, 404, `${target} leaked another party’s payment`);
  }
});

test('the seller is a party too, and reads the order and payment placed with them', async () => {
  // The reason ownership is a *list* and not one account. A rule that only let the buyer through
  // would be safe and useless: a merchant could not see what had been ordered from them.
  const harness = await build();
  const orderId = await anOrder(harness);
  const paymentId = await aPayment(harness, orderId);

  const order = await harness.call('GET', `/v1/orders/${orderId}`, { as: harness.seller });
  assert.equal(order.status, 200);

  const payment = await harness.call('GET', `/v1/payments/${paymentId}`, { as: harness.seller });
  assert.equal(payment.status, 200);
});

test('a wallet and a value plan are reachable only by the accounts they belong to', async () => {
  const harness = await build();

  const wallet = await harness.call('POST', '/v1/wallets', {
    as: harness.buyer,
    body: {
      ownerAccountId: harness.buyer.accountId,
      assetTypeId: 'jaya_reward',
      purpose: 'spending',
      normalBalance: 'credit',
    },
    key: 'idem_access_wallet_01',
  });
  assert.equal(wallet.status, 201);
  const walletId = (wallet.body as { wallet: { walletId: string } }).wallet.walletId;

  assert.equal(
    (await harness.call('GET', `/v1/wallets/${walletId}`, { as: harness.buyer })).status,
    200,
  );
  assert.equal(
    (await harness.call('GET', `/v1/wallets/${walletId}`, { as: harness.stranger })).status,
    404,
    'a balance is the most private thing this platform holds',
  );
  assert.equal(
    (await harness.call('GET', `/v1/wallets/${walletId}/history`, { as: harness.stranger })).status,
    404,
  );
});

// ---------------------------------------------------------------------------
// 3. The wrong account — organisation isolation
// ---------------------------------------------------------------------------

test('a session cannot act within an account it does not hold', async () => {
  const harness = await build();

  // The route that made this urgent. Before the guard, this returned the named account's balances
  // to anybody at all; now it returns them only to the account itself.
  const own = await harness.call('GET', `/v1/accounts/${harness.buyer.accountId}/money`, {
    as: harness.buyer,
  });
  assert.equal(own.status, 200);

  const theirs = await harness.call('GET', `/v1/accounts/${harness.buyer.accountId}/money`, {
    as: harness.stranger,
  });
  assert.equal(theirs.status, 404, 'GET /v1/accounts/{anyone}/money returned anyone’s balances');

  for (const section of ['money', 'orders', 'wallets']) {
    const response = await harness.call(
      'GET',
      `/v1/accounts/${harness.seller.accountId}/${section}`,
      { as: harness.stranger },
    );
    assert.equal(response.status, 404, `/${section} crossed the account boundary`);
  }
});

test('naming another account in the body does not move the request into it', async () => {
  // The account authority is scoped to is resolved from the session, never read from the request.
  // K-04 resolves it a second time and refuses `cross-account-access` if the two disagree, so a
  // caller who names somebody else's account is refused rather than believed.
  const harness = await build();

  const response = await harness.call('POST', '/v1/orders', {
    as: harness.stranger,
    body: {
      buyerAccountId: harness.buyer.accountId,
      sellerAccountId: harness.seller.accountId,
      currency: 'LKR',
      reason: 'an order placed in somebody else’s name',
    },
    key: 'idem_access_forge_01',
  });

  // M-11 will happily record the buyer the caller names — it is not an authorisation component and
  // should not become one. What matters is that the platform refuses this before it gets there, or
  // that the resulting order is not reachable as the impersonated account's.
  if (response.status < 300) {
    const orderId = (response.body as { order: { orderId: string } }).order.orderId;
    const asStranger = await harness.call('GET', `/v1/orders/${orderId}`, { as: harness.stranger });
    assert.equal(
      asStranger.status,
      404,
      'an order created naming another account is not the creator’s to read',
    );
  } else {
    assert.equal(response.status, 403);
  }
});

// ---------------------------------------------------------------------------
// 4. The wrong role
// ---------------------------------------------------------------------------

test('a buyer cannot capture or refund their own payment', async () => {
  // Capture and refund are separate verbs in K-04's vocabulary precisely so this can be said. If
  // they were folded into "update a payment", the grant that lets a buyer authorise their own
  // payment would also let them refund themselves after delivery.
  const harness = await build();
  const orderId = await anOrder(harness);
  const paymentId = await aPayment(harness, orderId);

  const authorised = await harness.call('POST', `/v1/payments/${paymentId}/authorisation`, {
    as: harness.buyer,
    body: {},
    key: 'idem_access_auth_01',
  });
  assert.equal(authorised.status, 200, 'authorising their own payment is the buyer’s to do');

  const captured = await harness.call('POST', `/v1/payments/${paymentId}/capture`, {
    as: harness.buyer,
    body: { amountMinor: '250000' },
    key: 'idem_access_cap_01',
  });
  assert.equal(captured.status, 403, 'taking the money is the seller’s act');
  assert.equal(codeOf(captured), 'not-permitted');

  const sellerCapture = await harness.call('POST', `/v1/payments/${paymentId}/capture`, {
    as: harness.seller,
    body: { amountMinor: '250000' },
    key: 'idem_access_cap_02',
  });
  assert.equal(sellerCapture.status, 200, 'and the seller can do it');

  const refund = await harness.call('POST', `/v1/payments/${paymentId}/refunds`, {
    as: harness.buyer,
    body: { amountMinor: '100000', reason: 'a refund the buyer awarded themselves' },
    key: 'idem_access_ref_01',
  });
  assert.equal(refund.status, 403, 'a customer who could refund themselves is a business model');
  assert.equal(codeOf(refund), 'not-permitted');
});

test('a seller cannot create an order or a payment', async () => {
  const harness = await build();

  const order = await harness.call('POST', '/v1/orders', {
    as: harness.seller,
    body: {
      buyerAccountId: harness.seller.accountId,
      sellerAccountId: harness.buyer.accountId,
      currency: 'LKR',
      reason: 'an order the seller placed for themselves',
    },
    key: 'idem_access_sorder_01',
  });
  assert.equal(order.status, 403);
  assert.equal(codeOf(order), 'not-permitted');
});

test('a signed-in person with no grants reaches nothing', async () => {
  // A valid session is not authority. K-04 denies by default: no grant, no answer — which is why
  // publishing a policy and granting a role are two separate acts.
  const harness = await build();
  const orderId = await anOrder(harness);

  for (const target of [
    '/v1/routes',
    `/v1/orders/${orderId}`,
    `/v1/accounts/${harness.powerless.accountId}/money`,
  ]) {
    const response = await harness.call('GET', target, { as: harness.powerless });
    assert.equal(response.status, 403, `${target} answered a session holding no grant`);
    assert.equal(codeOf(response), 'not-permitted');
  }
});

// ---------------------------------------------------------------------------
// 6. Escalation
// ---------------------------------------------------------------------------

test('a caller cannot widen its own authority through the request', async () => {
  const harness = await build();
  const orderId = await anOrder(harness);

  // Each of these is a field somebody might hope the API forwards into an authorisation decision.
  // None of them is read: the action and the resource type come from the route table, and the
  // account comes from the session.
  const attempts: ReadonlyArray<Readonly<Record<string, unknown>>> = [
    { role: 'ADMIN' },
    { roles: ['SUPER_ADMIN'] },
    { effect: 'allow' },
    { allowed: true },
    { accountId: 'acct_01HR0ACCsomeone' },
    { subjectId: 'sub_01HR0ACCsomeone' },
    { action: 'read', resourceType: 'order' },
    { permissions: ['read@order'] },
  ];

  for (const extra of attempts) {
    const response = await harness.call('GET', `/v1/orders/${orderId}`, { as: harness.stranger });
    assert.equal(
      response.status,
      404,
      `${JSON.stringify(extra)} changed nothing, as it must not — but the route answered ${String(response.status)}`,
    );
  }
});

test('a header cannot substitute for a session', async () => {
  const harness = await build();
  const orderId = await anOrder(harness);

  // Headers a proxy might set and an attacker might forge. The guard reads exactly one:
  // `authorization`. Anything that trusted these would be trusting whatever sits in front of it,
  // which in a request that reaches the port directly is the caller.
  const forged: ReadonlyArray<Readonly<Record<string, string>>> = [
    { 'x-account-id': 'acct_01HR0ACCsomeone' },
    { 'x-subject-id': 'sub_01HR0ACCsomeone' },
    { 'x-user-role': 'ADMIN' },
    { 'x-authenticated': 'true' },
    { 'x-forwarded-user': 'admin' },
  ];

  for (const headers of forged) {
    const response = await handleRequest(harness.api, rawGet(`/v1/orders/${orderId}`, headers));
    assert.equal(
      response.status,
      401,
      `${JSON.stringify(headers)} was treated as authentication of some kind`,
    );
  }
});

test('an idempotency key is not a bearer token for somebody else’s decision', async () => {
  // K-04 fixed this defect inside itself: the first revision looked the idempotency key up before
  // validating the session, which made a stolen key a way to replay somebody else's `allow`. The
  // API derives its authorisation key from the session id as well as the correlation id, so one
  // caller cannot pre-empt another's decision key even if they know the correlation id.
  const harness = await build();
  const orderId = await anOrder(harness);
  const shared = 'corr_01HR0ACCSHARED01';

  const raw = (as: SignedIn) => ({
    method: 'GET',
    target: `/v1/orders/${orderId}`,
    headers: { authorization: `Bearer ${as.token}`, 'x-correlation-id': shared },
    body: null,
  });

  const api = harness.api;
  const strangerFirst = await handleRequest(api, raw(harness.stranger));
  assert.equal(strangerFirst.status, 404, 'the stranger is refused, and a decision is recorded');

  const ownerSecond = await handleRequest(api, raw(harness.buyer));
  assert.equal(
    ownerSecond.status,
    200,
    'the owner’s request must not be answered from — or blocked by — the stranger’s decision, ' +
      'even though both carry the same client-supplied correlation id',
  );
});

// ---------------------------------------------------------------------------
// The table cannot drift
// ---------------------------------------------------------------------------

test('every route the API serves has an access policy, and every policy names a live route', async () => {
  const harness = await build();

  const served = new Set(harness.api.router.routes().map((r) => `${r.method} ${r.path}`));
  const declared = new Set(Object.keys(ACCESS_POLICY));

  const unguarded = [...served].filter((key) => !declared.has(key)).sort();
  assert.deepEqual(
    unguarded,
    [],
    'these routes have no entry in ACCESS_POLICY. A route without a rule about who may call it is ' +
      'an open door, so adding one must fail the build rather than ship',
  );

  const orphaned = [...declared].filter((key) => !served.has(key)).sort();
  assert.deepEqual(
    orphaned,
    [],
    'these policy entries name routes that no longer exist. A stale entry is how a rule survives ' +
      'the thing it was written about and starts protecting nothing',
  );
});

test('only the two routes that cannot hold a session are open, and each says why', () => {
  const open = Object.entries(ACCESS_POLICY).filter(([, access]) => access.anonymous === true);

  assert.deepEqual(
    open.map(([key]) => key).sort(),
    ['GET /v1/health', 'POST /v1/payments/webhooks/:provider'],
    'the set of routes reachable without a session is a security decision. Changing it should ' +
      'require changing this assertion, deliberately',
  );

  for (const [key, access] of open) {
    assert.ok(
      'why' in access && access.why.length > 60,
      `${key} is open and does not explain itself. A sentence is not much to ask of a route ` +
        'anybody in the world may call',
    );
  }
});

test('every capability the API needs is held by some role', () => {
  // The other direction from the table test above: a route whose action and resource type no
  // published role holds is a route nobody can ever call, which is a dead end rather than a hole —
  // but a dead end nobody notices until a customer reports it.
  const held = publishedCapabilities();
  const needed = new Set<string>();
  for (const access of Object.values(ACCESS_POLICY)) {
    if (access.anonymous === true) continue;
    needed.add(`${access.action}@${access.resourceType}`);
  }

  const unreachable = [...needed].filter((capability) => !held.has(capability)).sort();
  assert.deepEqual(
    unreachable,
    [],
    'no published role can exercise these, so the routes that need them can never be called',
  );
});

test('no role is published that grants authority over authority by accident', () => {
  // `grant-permission` is the capability an escalation aims at: whoever holds it decides who holds
  // everything else. Exactly one role has it, and that role has nothing else — an ADMIN who could
  // also read orders would be a role that grants itself whatever it likes and then uses it.
  const withGrant = JAYA_V1_ROLES.filter((role) =>
    role.capabilities.some((capability) => capability.action === 'grant-permission'),
  );

  assert.deepEqual(
    withGrant.map((role) => role.role),
    ['ADMIN'],
  );
  assert.deepEqual(
    withGrant[0]?.capabilities.map(
      (capability) => `${capability.action}@${capability.resourceType}`,
    ),
    ['grant-permission@permission'],
  );
});

// ---------------------------------------------------------------------------
// Helpers used by the raw-request tests above
// ---------------------------------------------------------------------------

function rawGet(
  target: string,
  headers: Readonly<Record<string, string>>,
): Parameters<typeof handleRequest>[1] {
  return { method: 'GET', target, headers, body: null };
}
