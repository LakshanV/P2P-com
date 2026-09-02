/**
 * The HTTP API, exercised end to end against in-memory modules.
 *
 * No port is bound and no database is touched, so the whole surface runs in milliseconds. What is
 * being tested is the layer itself — that a request reaches the right module with the right
 * identifiers, and that what comes back is something a client can act on.
 *
 * Four properties carry the layer.
 *
 * **A write needs an `Idempotency-Key`, and is refused without one.** Every identifier a write
 * creates is derived from that key, so retrying with the same key converges on the same record. The
 * alternative — inventing a key — makes every retry a new payment and hides that decision from the
 * person who would be charged for it.
 *
 * **A refusal keeps its code.** M-11, M-12 and M-13 all refuse with machine-readable codes, and the
 * API's job is to get them to the client with a sensible status rather than collapsing them into
 * "400 bad request".
 *
 * **Money crosses the wire as a string.** A JSON number is a double, and a double cannot hold
 * 9007199254740993 minor units. A client that sends a number is told why rather than silently
 * rounded.
 *
 * **An unclassified failure tells the caller nothing.** A driver error names tables and constraints;
 * it belongs in a log.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

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
import {
  InMemoryUniversalListingRepository,
  UniversalListingService,
} from '../modules/universal-listing/index.ts';
import {
  CommerceRequestService,
  InMemoryCommerceRequestRepository,
} from '../modules/commerce-request/index.ts';
import { UserCockpitService } from '../modules/user-cockpit/index.ts';
import { buildApi, type ApiServices } from '../apps/api/app.ts';
import { CLASSIFIED_CODES } from '../apps/api/errors.ts';
import {
  SIGNATURE_HEADER,
  webhookSecrets,
  webhookSignatureHeader,
} from '../apps/api/webhook-signature.ts';
import { identityStack, type IdentityStack, type SignedIn } from './helpers/api-identity.ts';
import { handleRequest, type RequestRecord } from '../platform/http/pipeline.ts';
import type { HttpResponse } from '../platform/http/types.ts';
import { inMemoryTendering } from './helpers/tendering-services.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUYER = 'acct_01HR0API0buyer1';
const SELLER = 'acct_01HR0API0sellr1';
const NOW = '2026-07-01T09:00:00.000000Z';
/** The mock provider's webhook signing secret, shared between this suite and the API it builds. */
const LISTING = 'lst_01HR0API000001';
const VERSION = 'ver_01HR0API000001';
const WEBHOOK_SECRET = 'a-signing-secret-only-the-provider-and-this-deployment-hold';

interface Harness {
  readonly call: (
    method: string,
    target: string,
    body?: unknown,
    headers?: Record<string, string>,
  ) => Promise<HttpResponse>;
  readonly observed: RequestRecord[];
  readonly services: ApiServices;
  readonly identity: IdentityStack;
  readonly buyer: SignedIn;
  readonly seller: SignedIn;
}

/**
 * The asset types K-10 has to know about before M-13 can open an account in one.
 *
 * Registered directly rather than over HTTP: there is no route for it, and inventing one for a test
 * would be a route nothing else uses. Asset types are a deployment decision, not a request.
 */
async function registerAssets(ledger: LedgerService): Promise<void> {
  await ledger.registerAssetType({
    assetTypeId: 'jaya_reward',
    assetClass: 'reward',
    symbol: 'JAYAREWARD',
    precision: 0,
    transferability: false,
    withdrawability: false,
    valuationSource: 'fixed',
    issuer: 'iss_01HR0APIjayaplt',
    unit: 'point',
    redeemable: true,
    convertible: false,
    expiryDays: null,
    restrictions: {},
    custodyProvider: null,
    jurisdiction: 'GLOBAL',
  });
}

async function build(): Promise<Harness> {
  const orders = new OrderService(new InMemoryOrderRepository());
  const payments = new PaymentService(new InMemoryPaymentRepository(), resolveMockProvider);
  const kernelLedger = new LedgerService(new InMemoryLedgerRepository());
  await registerAssets(kernelLedger);
  const ledger = new FinancialLedgerService(
    new InMemoryFinancialLedgerRepository(),
    new K10LedgerPort(kernelLedger),
  );
  // A published listing with stock, because adding an order line now reserves against M-04 rather
  // than believing a `reservationId` the client sent. TRACKED is the mode the ordering tests want:
  // it is the one where a reservation is required and can therefore fail.
  const listings = new UniversalListingService(new InMemoryUniversalListingRepository());
  await listings.createListing({
    listingId: LISTING,
    accountId: SELLER,
    commerceUnitTypeId: 'cut_01HR0API000001',
    createdAt: NOW,
    updatedAt: NOW,
    correlationId: 'corr_01HR0APIsetup01',
    idempotencyKey: 'idem_api_listing_01',
    recordId: 'rec_01HR0APIsetup01',
  });
  await listings.publishListing({
    versionId: VERSION,
    listingId: LISTING,
    title: 'Ceylon cinnamon, Alba grade, 500g',
    description: 'Hand-rolled quills from a single estate in Matale.',
    unitPriceMinor: 250n,
    currency: 'LKR',
    quantityAvailable: 500n,
    inventoryMode: 'tracked',
    attributes: {},
    publishedAt: NOW,
    correlationId: 'corr_01HR0APIsetup01',
    idempotencyKey: 'idem_api_version_01',
  });
  await listings.receiveInventory({
    movementId: 'mov_01HR0APIsetup01',
    listingId: LISTING,
    versionId: VERSION,
    quantity: 500n,
    reason: 'opening stock for the suite',
    occurredAt: NOW,
    correlationId: 'corr_01HR0APIsetup01',
    idempotencyKey: 'idem_api_stock_01',
  });

  const services: ApiServices = {
    orders,
    payments,
    ledger,
    listings,
    needs: new CommerceRequestService(new InMemoryCommerceRequestRepository()),
    ...inMemoryTendering(),
    cockpit: new UserCockpitService({ orders, payments, ledger, journal: kernelLedger }),
  };

  const observed: RequestRecord[] = [];

  // A real identity stack, and two real people. Every request in this file is now made *by*
  // somebody: K-01 minted the subject, K-03 opened the account the fixtures trade within, K-02
  // issued the session and K-04 evaluated a grant before the handler ran.
  //
  // The buyer holds both roles. This suite is about the API layer — statuses, idempotency,
  // serialisation — and making every capture switch tokens would bury that under authorisation
  // plumbing. Which roles may do what is the subject of `tests/api-access.test.ts`, where the two
  // parties are kept apart on purpose.
  const identity = await identityStack(NOW);
  const buyer = await identity.register({
    handle: 'api-buyer',
    accountId: BUYER,
    roles: ['CUSTOMER', 'SUPPLIER'],
  });
  const seller = await identity.register({
    handle: 'api-seller',
    accountId: SELLER,
    roles: ['SUPPLIER', 'CUSTOMER'],
  });

  const api = buildApi({
    services,
    access: identity,
    webhookSecrets: webhookSecrets({ mock: WEBHOOK_SECRET }),
    // Pinned, so every assertion in this file is about the API rather than about the clock.
    clock: () => NOW,
    generateCorrelationId: () => 'corr_01HR0APIGENERATED',
    observe: (record) => observed.push(record),
  });

  const call = (
    method: string,
    target: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<HttpResponse> =>
    handleRequest(api, {
      method,
      target,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        // Overridable, so a test can present no session, a stranger's, or the seller's.
        authorization: `Bearer ${buyer.token}`,
        ...headers,
      },
      body: body === undefined ? null : JSON.stringify(body),
    });

  return { call, observed, services, identity, buyer, seller };
}

/** A write with an idempotency key, which is what every write needs. */
function keyed(key: string): Record<string, string> {
  return { 'idempotency-key': key };
}

const codeOf = (response: HttpResponse): string => (response.body as { code: string }).code;

// ---------------------------------------------------------------------------
// The shape of the API
// ---------------------------------------------------------------------------

test('health answers without touching a module', async () => {
  const { call } = await build();
  const response = await call('GET', '/v1/health');

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { status: 'ok' });
});

test('the route inventory lists every path, with what it is for', async () => {
  const { call } = await build();
  const response = await call('GET', '/v1/routes');
  const routes = (response.body as { routes: { path: string; summary: string }[] }).routes;

  assert.ok(routes.length > 20, 'the API serves more than a handful of routes');
  for (const route of routes) {
    assert.ok(route.summary.length > 0, `${route.path} has no summary`);
    assert.match(route.path, /^\/v1\//, 'every route is versioned');
  }
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

test('a write without an idempotency key is refused, and told why', async () => {
  const { call } = await build();
  const response = await call('POST', '/v1/orders', {
    buyerAccountId: BUYER,
    sellerAccountId: SELLER,
    currency: 'LKR',
    reason: 'the buyer started a basket',
  });

  assert.equal(response.status, 400);
  assert.equal(codeOf(response), 'missing-idempotency-key');
  assert.match(
    (response.body as { detail: string }).detail,
    /charging somebody once and charging them twice/,
    'the message says what the header is for, not merely that it is missing',
  );
});

test('a read needs no idempotency key', async () => {
  const { call } = await build();
  const response = await call('GET', '/v1/orders/ord_01HR0APInothing');
  assert.equal(response.status, 404, 'it got as far as the module, which found nothing');
});

test('the same key twice creates one order', async () => {
  const { call } = await build();
  const body = {
    buyerAccountId: BUYER,
    sellerAccountId: SELLER,
    currency: 'LKR',
    reason: 'the buyer started a basket',
  };

  const first = await call('POST', '/v1/orders', body, keyed('idem_api_order_1'));
  const second = await call('POST', '/v1/orders', body, keyed('idem_api_order_1'));

  assert.equal(first.status, 201);
  assert.equal(
    second.status,
    200,
    'a replay is 200, not 201: nothing was created this time, and saying otherwise would make a ' +
      'retry indistinguishable from a first attempt',
  );

  const firstOrder = (first.body as { order: { orderId: string } }).order;
  const secondOrder = (second.body as { order: { orderId: string } }).order;
  assert.equal(firstOrder.orderId, secondOrder.orderId, 'the same key addresses the same order');
});

test('two different keys create two orders', async () => {
  const { call } = await build();
  const body = {
    buyerAccountId: BUYER,
    sellerAccountId: SELLER,
    currency: 'LKR',
    reason: 'the buyer started a basket',
  };

  const first = await call('POST', '/v1/orders', body, keyed('idem_api_order_a'));
  const second = await call('POST', '/v1/orders', body, keyed('idem_api_order_b'));

  assert.notEqual(
    (first.body as { order: { orderId: string } }).order.orderId,
    (second.body as { order: { orderId: string } }).order.orderId,
  );
});

test('an idempotency key that identifies a person is refused', async () => {
  const { call } = await build();
  const response = await call(
    'POST',
    '/v1/orders',
    { buyerAccountId: BUYER, sellerAccountId: SELLER, currency: 'LKR', reason: 'basket' },
    keyed('buyer@example.com'),
  );

  assert.equal(response.status, 400);
  assert.equal(codeOf(response), 'malformed-idempotency-key');
  assert.match(
    (response.body as { detail: string }).detail,
    /copied into every record/,
    'the key is not a scratch value; it lands in rows that outlive the request',
  );
});

// ---------------------------------------------------------------------------
// Money on the wire
// ---------------------------------------------------------------------------

test('an amount sent as a JSON number is refused, with the reason', async () => {
  const { call } = await build();
  const created = await call(
    'POST',
    '/v1/orders',
    { buyerAccountId: BUYER, sellerAccountId: SELLER, currency: 'LKR', reason: 'basket' },
    keyed('idem_api_num_order'),
  );
  const orderId = (created.body as { order: { orderId: string } }).order.orderId;

  const response = await call(
    'POST',
    `/v1/orders/${orderId}/items`,
    {
      listingId: LISTING,
      versionId: VERSION,
      commerceUnitTypeId: 'cut_01HR0API000001',
      quantity: '2',
      unitPriceMinor: 150,
      lineTotalMinor: '300',
      currency: 'LKR',
    },
    keyed('idem_api_num_item'),
  );

  assert.equal(response.status, 400);
  assert.equal(codeOf(response), 'amount-must-be-a-string');
  assert.match((response.body as { detail: string }).detail, /cannot hold an exact amount above/);
});

test('an amount beyond the safe-integer range survives the round trip', async () => {
  const { call } = await build();
  const huge = '9007199254740993';

  const created = await call(
    'POST',
    '/v1/payments',
    {
      orderId: 'ord_01HR0APIhuge001',
      payerAccountId: BUYER,
      payeeAccountId: SELLER,
      provider: 'mock',
      rail: 'card',
      instrumentToken: 'tok_01HR0APIgood01',
      assetCode: 'LKR',
      assetScale: 2,
      amountMinor: huge,
    },
    keyed('idem_api_huge_pay'),
  );

  assert.equal(created.status, 201);
  const payment = (created.body as { payment: { amountMinor: unknown } }).payment;
  assert.equal(
    String(payment.amountMinor),
    huge,
    'the amount is a bigint all the way through; nothing rounded it',
  );
});

// ---------------------------------------------------------------------------
// Refusals keep their codes
// ---------------------------------------------------------------------------

test('a module refusal keeps its code and gets a sensible status', async () => {
  const { call } = await build();
  const created = await call(
    'POST',
    '/v1/orders',
    { buyerAccountId: BUYER, sellerAccountId: SELLER, currency: 'LKR', reason: 'basket' },
    keyed('idem_api_trans_ord'),
  );
  const orderId = (created.body as { order: { orderId: string } }).order.orderId;

  // A draft cannot be confirmed: it has not been placed.
  const response = await call(
    'POST',
    `/v1/orders/${orderId}/confirmation`,
    { reason: 'the seller accepted' },
    keyed('idem_api_trans_cnf'),
  );

  assert.equal(
    response.status,
    422,
    'the request is well formed and describes something the state machine will not do',
  );
  assert.equal(codeOf(response), 'illegal-transition');
  assert.equal(response.headers['content-type'], 'application/problem+json');
});

test('a conflict is 409 and a domain refusal is 422', async () => {
  const { call } = await build();

  const paymentBody = {
    orderId: 'ord_01HR0APIconf001',
    payerAccountId: BUYER,
    payeeAccountId: SELLER,
    provider: 'mock',
    rail: 'card',
    instrumentToken: 'tok_01HR0APIgood01',
    assetCode: 'LKR',
    assetScale: 2,
    amountMinor: '100000',
  };
  await call('POST', '/v1/payments', paymentBody, keyed('idem_api_conflict'));

  // The same key, different content: a conflict the client has to look at.
  const conflict = await call(
    'POST',
    '/v1/payments',
    { ...paymentBody, amountMinor: '999999' },
    keyed('idem_api_conflict'),
  );
  assert.equal(conflict.status, 409);
  assert.equal(codeOf(conflict), 'idempotency-key-reuse');

  // Internally issued value: well formed, and something the domain will not do.
  const internal = await call(
    'POST',
    '/v1/payments',
    { ...paymentBody, assetCode: 'JAYA_REWARD' },
    keyed('idem_api_internal'),
  );
  assert.equal(internal.status, 422);
  assert.equal(codeOf(internal), 'internal-value-not-settleable');
});

test('a gateway refusal is 502, because it is neither the client’s fault nor ours', async () => {
  const { call } = await build();
  const created = await call(
    'POST',
    '/v1/payments',
    {
      orderId: 'ord_01HR0APIdecl001',
      payerAccountId: BUYER,
      payeeAccountId: SELLER,
      provider: 'mock',
      rail: 'card',
      instrumentToken: 'tok_01HR0APIdecline',
      assetCode: 'LKR',
      assetScale: 2,
      amountMinor: '100000',
    },
    keyed('idem_api_decline_p'),
  );
  const paymentId = (created.body as { payment: { paymentId: string } }).payment.paymentId;

  const response = await call(
    'POST',
    `/v1/payments/${paymentId}/authorisation`,
    {},
    keyed('idem_api_decline_a'),
  );

  assert.equal(response.status, 502);
  assert.equal(codeOf(response), 'provider-failed');
});

/**
 * Every code a module's error type declares, read from its own source.
 *
 * Derived rather than listed, so a module that adds a refusal code cannot quietly acquire a 500:
 * the check fails until somebody decides what status the new code deserves.
 */
function declaredCodes(moduleDir: string): readonly string[] {
  const source = readFileSync(path.join(REPO_ROOT, 'modules', moduleDir, 'types.ts'), 'utf8');
  const union = /export type \w*ErrorCode =([\s\S]*?);\r?\n/.exec(source);
  assert.ok(union !== null, `${moduleDir} declares no error-code union`);
  return [...String(union[1]).matchAll(/\|\s*'([a-z-]+)'/g)].map((match) => String(match[1]));
}

test('every refusal code a module can raise has a status', () => {
  // A code missing from the tables produces a 500 rather than something a client can act on. This
  // reads each module's own union from disk, so the tables cannot fall behind the modules.
  const modules: Readonly<Record<string, string>> = {
    orders: 'orders',
    payments: 'payments',
    'financial-ledger': 'financial-ledger',
    'user-cockpit': 'user-cockpit',
  };

  for (const [key, dir] of Object.entries(modules)) {
    const classified = new Set(CLASSIFIED_CODES[key] ?? []);
    const missing = declaredCodes(dir).filter((code) => !classified.has(code));
    assert.deepEqual(
      missing,
      [],
      `${dir} can refuse with ${missing.join(', ')}, and the API has no status for ${
        missing.length === 1 ? 'it' : 'them'
      }. An unclassified refusal reaches the client as a 500`,
    );
  }

  for (const [module, codes] of Object.entries(CLASSIFIED_CODES)) {
    assert.ok(codes.length > 0, `${module} classifies nothing`);
    assert.equal(new Set(codes).size, codes.length, `${module} lists a code twice`);
  }
});

// ---------------------------------------------------------------------------
// A journey
// ---------------------------------------------------------------------------

test('an order can be created, filled, placed and confirmed over HTTP', async () => {
  const { call } = await build();

  const created = await call(
    'POST',
    '/v1/orders',
    { buyerAccountId: BUYER, sellerAccountId: SELLER, currency: 'LKR', reason: 'basket' },
    keyed('idem_api_flow_ord'),
  );
  assert.equal(created.status, 201);
  const orderId = (created.body as { order: { orderId: string } }).order.orderId;

  const item = await call(
    'POST',
    `/v1/orders/${orderId}/items`,
    {
      listingId: LISTING,
      versionId: VERSION,
      commerceUnitTypeId: 'cut_01HR0API000001',
      quantity: '3',
      unitPriceMinor: '250',
      lineTotalMinor: '750',
      currency: 'LKR',
    },
    keyed('idem_api_flow_item'),
  );
  assert.equal(item.status, 201);

  const placed = await call(
    'POST',
    `/v1/orders/${orderId}/placement`,
    { expectedTotalMinor: '750', policyVersionId: null, reason: 'the buyer placed the order' },
    keyed('idem_api_flow_place'),
  );
  assert.equal(placed.status, 200);
  assert.equal((placed.body as { order: { status: string } }).order.status, 'placed');

  const confirmed = await call(
    'POST',
    `/v1/orders/${orderId}/confirmation`,
    { reason: 'the seller accepted' },
    keyed('idem_api_flow_conf'),
  );
  assert.equal((confirmed.body as { order: { status: string } }).order.status, 'confirmed');

  const read = await call('GET', `/v1/orders/${orderId}`);
  assert.equal((read.body as { order: { status: string } }).order.status, 'confirmed');

  const history = await call('GET', `/v1/orders/${orderId}/history`);
  assert.equal(
    (history.body as { events: unknown[] }).events.length,
    3,
    'created, placed, confirmed. Adding a line is not a lifecycle transition, and M-11 does not ' +
      'record one for it',
  );

  const snapshot = await call('GET', `/v1/orders/${orderId}/snapshot`);
  assert.equal(snapshot.status, 200);
});

test('a payment can be requested, authorised, captured and refunded over HTTP', async () => {
  const { call } = await build();

  const created = await call(
    'POST',
    '/v1/payments',
    {
      orderId: 'ord_01HR0APIflow001',
      payerAccountId: BUYER,
      payeeAccountId: SELLER,
      provider: 'mock',
      rail: 'card',
      instrumentToken: 'tok_01HR0APIgood01',
      assetCode: 'LKR',
      assetScale: 2,
      amountMinor: '1000000',
    },
    keyed('idem_api_pay_req'),
  );
  const paymentId = (created.body as { payment: { paymentId: string } }).payment.paymentId;

  await call('POST', `/v1/payments/${paymentId}/authorisation`, {}, keyed('idem_api_pay_auth'));
  const captured = await call(
    'POST',
    `/v1/payments/${paymentId}/capture`,
    { amountMinor: '1000000' },
    keyed('idem_api_pay_cap'),
  );
  assert.equal((captured.body as { payment: { status: string } }).payment.status, 'captured');

  const refunded = await call(
    'POST',
    `/v1/payments/${paymentId}/refunds`,
    { amountMinor: '400000', reason: 'the buyer returned part of the order' },
    keyed('idem_api_pay_ref'),
  );
  assert.equal(refunded.status, 201);
  assert.equal(
    (refunded.body as { payment: { status: string } }).payment.status,
    'partially-refunded',
  );

  const attempts = await call('GET', `/v1/payments/${paymentId}/attempts`);
  assert.equal(
    (attempts.body as { attempts: unknown[] }).attempts.length,
    3,
    'the reconciliation trail holds every provider call: authorise, capture, refund',
  );
});

/**
 * The webhook route, which is the only door into this platform that a stranger can knock on.
 *
 * The defect these cases exist to keep closed: the route used to read `signatureVerified` out of the
 * request body. M-12 refuses `unverified-webhook` correctly, but the caller was supplying the
 * answer, so `{"signatureVerified": true, "assertedStatus": "captured"}` from anybody at all moved a
 * payment. The check is now computed here, from a secret the caller does not hold.
 */
const HOOK_BODY = {
  providerEventId: 'evt_api_0001',
  paymentId: null,
  kind: 'charge.captured',
  assertedStatus: null,
  assertedAmountMinor: null,
  failureCode: null,
  payload: { note: 'from the gateway' },
};

/** Sign a body the way the provider would, at the pinned instant this suite runs at. */
function signed(
  body: unknown,
  secret = WEBHOOK_SECRET,
  atSeconds?: number,
): Record<string, string> {
  const raw = JSON.stringify(body);
  const seconds = atSeconds ?? Math.floor(Date.parse(NOW) / 1000);
  return { [SIGNATURE_HEADER]: webhookSignatureHeader(secret, seconds, raw) };
}

test('an unsigned webhook is refused before M-12 is asked anything', async () => {
  const { call } = await build();

  const response = await call('POST', '/v1/payments/webhooks/mock', HOOK_BODY, {
    ...keyed('idem_api_hook_unsigned'),
  });

  assert.equal(response.status, 401, 'an unsigned delivery is an instruction from a stranger');
  assert.equal(codeOf(response), 'unsigned-webhook');
});

test('a webhook signed with the wrong secret is refused', async () => {
  const { call } = await build();

  const response = await call('POST', '/v1/payments/webhooks/mock', HOOK_BODY, {
    ...keyed('idem_api_hook_wrong'),
    ...signed(HOOK_BODY, 'a-secret-this-deployment-does-not-hold'),
  });

  assert.equal(response.status, 401);
  assert.equal(codeOf(response), 'bad-webhook-signature');
  assert.ok(
    !(response.body as { detail: string }).detail.includes('does not hold'),
    'the refusal must not repeat the secret it was given',
  );
});

test('a webhook signed for an unconfigured provider is refused the same way', async () => {
  // Deliberately indistinguishable from a wrong signature. A different code here would answer
  // "which gateways does this deployment integrate with?" for anybody who asked.
  const { call } = await build();

  const response = await call('POST', '/v1/payments/webhooks/stripe', HOOK_BODY, {
    ...keyed('idem_api_hook_unknown'),
    ...signed(HOOK_BODY),
  });

  assert.equal(response.status, 401);
  assert.equal(codeOf(response), 'bad-webhook-signature');
});

test('a webhook whose timestamp is outside the window is refused, even correctly signed', async () => {
  const { call } = await build();

  const anHourAgo = Math.floor(Date.parse(NOW) / 1000) - 3600;
  const response = await call('POST', '/v1/payments/webhooks/mock', HOOK_BODY, {
    ...keyed('idem_api_hook_stale'),
    ...signed(HOOK_BODY, WEBHOOK_SECRET, anHourAgo),
  });

  assert.equal(response.status, 401, 'a signature with no expiry can be replayed for ever');
  assert.equal(codeOf(response), 'stale-webhook');
});

test('a body that claims the signature was checked is refused by name', async () => {
  const { call } = await build();
  const claiming = { ...HOOK_BODY, signatureVerified: true };

  const response = await call('POST', '/v1/payments/webhooks/mock', claiming, {
    ...keyed('idem_api_hook_claim'),
    // Correctly signed, so the *only* reason this fails is the field itself.
    ...signed(claiming),
  });

  assert.equal(response.status, 400);
  assert.equal(codeOf(response), 'caller-asserted-verification');
});

test('a genuinely signed webhook is accepted', async () => {
  const { call } = await build();

  const response = await call('POST', '/v1/payments/webhooks/mock', HOOK_BODY, {
    ...keyed('idem_api_hook_ok'),
    ...signed(HOOK_BODY),
  });

  assert.equal(
    response.status,
    202,
    'a provider retrying on anything but 2xx would retry a stale event for ever',
  );
});

test('a mixed-value purchase can be allocated and committed over HTTP', async () => {
  const { call, services } = await build();

  void services;

  const wallets: Record<string, string> = {};
  for (const [name, spec] of Object.entries({
    buyerRewards: { ownerAccountId: BUYER, assetTypeId: 'jaya_reward', purpose: 'spending' },
    sellerRewards: { ownerAccountId: SELLER, assetTypeId: 'jaya_reward', purpose: 'earnings' },
  })) {
    const response = await call(
      'POST',
      '/v1/wallets',
      { ...spec, normalBalance: 'credit' },
      keyed(`idem_api_wal_${name}`),
    );
    assert.equal(response.status, 201, `opening ${name} failed: ${JSON.stringify(response.body)}`);
    wallets[name] = (response.body as { wallet: { walletId: string } }).wallet.walletId;
  }

  const allocated = await call(
    'POST',
    '/v1/value-plans',
    {
      obligationId: 'ord_01HR0APIplan001',
      obligationKind: 'order',
      payerAccountId: BUYER,
      payeeAccountId: SELLER,
      settlementAssetTypeId: 'jaya_reward',
      targetAmountMinor: '500',
      legs: [
        {
          kind: 'internal',
          assetTypeId: 'jaya_reward',
          sourceWalletId: wallets.buyerRewards,
          destinationWalletId: wallets.sellerRewards,
          amountMinor: '500',
          rateNumerator: '1',
          rateDenominator: '1',
          settlementEquivalentMinor: '500',
        },
      ],
    },
    keyed('idem_api_plan_alloc'),
  );
  assert.equal(allocated.status, 201, JSON.stringify(allocated.body));
  const planId = (allocated.body as { plan: { planId: string } }).plan.planId;

  const committed = await call(
    'POST',
    `/v1/value-plans/${planId}/commitment`,
    {},
    keyed('idem_api_plan_commit'),
  );
  assert.equal(committed.status, 200, JSON.stringify(committed.body));
  assert.equal(
    (committed.body as { plan: { status: string } }).plan.status,
    'settled',
    'a plan with no external leg settles at commit: everything it needed has moved',
  );

  const coverage = await call('GET', `/v1/value-plans/${planId}/coverage`);
  const figures = (coverage.body as { coverage: { postedMinor: unknown; fullySettled: boolean } })
    .coverage;
  assert.equal(String(figures.postedMinor), '500');
  assert.equal(figures.fullySettled, true);
});

test('an allocation that does not add up is refused with its own code', async () => {
  const { call } = await build();

  const buyer = await call(
    'POST',
    '/v1/wallets',
    {
      ownerAccountId: BUYER,
      assetTypeId: 'jaya_reward',
      purpose: 'spending',
      normalBalance: 'credit',
    },
    keyed('idem_api_mis_buyer'),
  );
  const seller = await call(
    'POST',
    '/v1/wallets',
    {
      ownerAccountId: SELLER,
      assetTypeId: 'jaya_reward',
      purpose: 'earnings',
      normalBalance: 'credit',
    },
    keyed('idem_api_mis_seller'),
  );

  const response = await call(
    'POST',
    '/v1/value-plans',
    {
      obligationId: 'ord_01HR0APImis0001',
      obligationKind: 'order',
      payerAccountId: BUYER,
      payeeAccountId: SELLER,
      settlementAssetTypeId: 'jaya_reward',
      targetAmountMinor: '1000',
      legs: [
        {
          kind: 'internal',
          assetTypeId: 'jaya_reward',
          sourceWalletId: (buyer.body as { wallet: { walletId: string } }).wallet.walletId,
          destinationWalletId: (seller.body as { wallet: { walletId: string } }).wallet.walletId,
          amountMinor: '900',
          rateNumerator: '1',
          rateDenominator: '1',
          settlementEquivalentMinor: '900',
        },
      ],
    },
    keyed('idem_api_mis_plan'),
  );

  assert.equal(response.status, 422);
  assert.equal(codeOf(response), 'allocation-mismatch');
  assert.match((response.body as { detail: string }).detail, /900 against an obligation of 1000/);
});

// ---------------------------------------------------------------------------
// Correlation and observation
// ---------------------------------------------------------------------------

test('a client’s correlation id is honoured and echoed', async () => {
  const { call } = await build();
  const response = await call('GET', '/v1/health', undefined, {
    'x-correlation-id': 'corr_01HR0APICLIENT1',
  });

  assert.equal(response.headers['x-correlation-id'], 'corr_01HR0APICLIENT1');
});

test('a correlation id that identifies a person is replaced rather than refused', async () => {
  const { call } = await build();
  const response = await call('GET', '/v1/health', undefined, {
    'x-correlation-id': 'caller@example.com',
  });

  assert.equal(response.status, 200, 'a bad correlation id is not worth failing a request over');
  assert.equal(
    response.headers['x-correlation-id'],
    'corr_01HR0APIGENERATED',
    'but it must not be copied into every record the request creates',
  );
});

test('every request is observed with its status and code', async () => {
  const { call, observed } = await build();

  await call('GET', '/v1/health');
  await call('GET', '/v1/nothing-here');

  assert.deepEqual(
    observed.map((record) => [record.method, record.status, record.code]),
    [
      ['GET', 200, null],
      ['GET', 404, 'no-such-route'],
    ],
  );
});

test('an unclassified failure tells the caller nothing and the observer everything', async () => {
  const { observed, identity, buyer } = await build();
  const secret = new Error('connection to 10.0.0.4:5432 refused for user "jaya_app"');

  // `getOrder` is called twice on this path: once by the ownership check and once by the handler.
  // Both must fail the same way — an ownership check that swallowed a driver error would answer
  // 404 for a database that is merely down, which is a lie about whether the order exists.
  const api = buildApi({
    services: {
      orders: {
        getOrder: () => Promise.reject(secret),
      } as unknown as ApiServices['orders'],
      payments: {} as unknown as ApiServices['payments'],
      ledger: {} as unknown as ApiServices['ledger'],
      cockpit: {} as unknown as ApiServices['cockpit'],
      listings: {} as unknown as ApiServices['listings'],
      needs: {} as unknown as ApiServices['needs'],
      tenders: {} as unknown as ApiServices['tenders'],
      quotes: {} as unknown as ApiServices['quotes'],
    },
    access: identity,
    clock: () => NOW,
    generateCorrelationId: () => 'corr_01HR0APIGENERATED',
    observe: (record) => observed.push(record),
  });

  const response = await handleRequest(api, {
    method: 'GET',
    target: '/v1/orders/ord_01HR0APIboom001',
    headers: { authorization: `Bearer ${buyer.token}` },
    body: null,
  });

  assert.equal(response.status, 500);
  const detail = (response.body as { detail: string }).detail;
  assert.ok(
    !detail.includes('10.0.0.4') && !detail.includes('jaya_app'),
    'a connection error names hosts and database users; none of it is a stranger’s business',
  );
  assert.equal(observed.at(-1)?.unclassified, secret);
});

test('a response carrying an amount survives JSON serialisation', async () => {
  // `JSON.stringify` throws on a bigint rather than rounding it, so before the pipeline converted
  // them a response carrying an order total failed *after* the work had been committed: a 500 for a
  // request that succeeded. This is the regression that must not come back.
  const { call } = await build();

  const created = await call(
    'POST',
    '/v1/payments',
    {
      orderId: 'ord_01HR0APIser0001',
      payerAccountId: BUYER,
      payeeAccountId: SELLER,
      provider: 'mock',
      rail: 'card',
      instrumentToken: 'tok_01HR0APIgood01',
      assetCode: 'LKR',
      assetScale: 2,
      amountMinor: '250000',
    },
    keyed('idem_api_ser_pay'),
  );

  const serialised = JSON.stringify(created.body);
  assert.ok(serialised.includes('"250000"'), 'the amount is on the wire as a decimal string');

  const round = JSON.parse(serialised) as { payment: { amountMinor: unknown } };
  assert.equal(
    typeof round.payment.amountMinor,
    'string',
    'a consumer that parses it into a double has made a choice rather than inherited a rounding',
  );
});

test('a retry a second later, with a fresh correlation id, still converges', async () => {
  // The defect a live test caught and the unit suites could not: idempotency compared the instant
  // and the correlation id, so a retry — which arrives later and carries a fresh correlation id by
  // definition — was reported as a conflict. Pinning the clock hid it. This does not pin it.
  const orders = new OrderService(new InMemoryOrderRepository());
  const payments = new PaymentService(new InMemoryPaymentRepository(), resolveMockProvider);
  const kernelLedger = new LedgerService(new InMemoryLedgerRepository());
  await registerAssets(kernelLedger);
  const ledger = new FinancialLedgerService(
    new InMemoryFinancialLedgerRepository(),
    new K10LedgerPort(kernelLedger),
  );

  const identity = await identityStack(NOW);
  const buyer = await identity.register({ handle: 'drift-buyer', accountId: BUYER });
  await identity.register({ handle: 'drift-seller', accountId: SELLER });

  let tick = 0;
  const api = buildApi({
    services: {
      orders,
      payments,
      ledger,
      listings: new UniversalListingService(new InMemoryUniversalListingRepository()),
      needs: new CommerceRequestService(new InMemoryCommerceRequestRepository()),
      ...inMemoryTendering(),
      cockpit: new UserCockpitService({ orders, payments, ledger, journal: kernelLedger }),
    },
    access: identity,
    // A different instant and a different correlation id on each request, as production gives.
    clock: () => `2026-07-01T09:00:0${String(tick++)}.000000Z`,
    generateCorrelationId: () => `corr_01HR0APIGEN${String(tick).padStart(4, '0')}`,
  });

  const send = (): Promise<HttpResponse> =>
    handleRequest(api, {
      method: 'POST',
      target: '/v1/orders',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'idem_api_drift_01',
        authorization: `Bearer ${buyer.token}`,
      },
      body: JSON.stringify({
        buyerAccountId: BUYER,
        sellerAccountId: SELLER,
        currency: 'LKR',
        reason: 'a basket the client retried a second later',
      }),
    });

  const first = await send();
  const second = await send();

  assert.equal(first.status, 201);
  assert.equal(
    second.status,
    200,
    'a retry that arrives later, with a fresh correlation id, is still the same request',
  );
  assert.equal(
    (first.body as { order: { orderId: string } }).order.orderId,
    (second.body as { order: { orderId: string } }).order.orderId,
  );
});

test('MY MONEY is served over HTTP, and never as one total', async () => {
  const { call } = await build();

  await call(
    'POST',
    '/v1/wallets',
    {
      ownerAccountId: BUYER,
      assetTypeId: 'jaya_reward',
      purpose: 'spending',
      normalBalance: 'credit',
    },
    keyed('idem_api_ckpt_wal'),
  );

  const response = await call('GET', `/v1/accounts/${BUYER}/money`);
  assert.equal(response.status, 200);

  const view = response.body as {
    holdings: { symbol: string; total: unknown; positions: { withdrawable: boolean }[] }[];
    empty: boolean;
    asOf: string;
  };

  assert.equal(view.empty, false);
  assert.equal(view.holdings.length, 1);
  assert.equal(view.holdings[0]?.symbol, 'JAYAREWARD');
  assert.equal(
    view.holdings[0]?.positions[0]?.withdrawable,
    false,
    'the screen is told this is not cash, next to the number rather than in a footnote',
  );
  assert.ok(
    !Object.keys(view).includes('total'),
    'there is no single total across asset types, and there must not be',
  );
  assert.ok(view.asOf.length > 0, 'every figure is derived, so the instant is stated');
});
