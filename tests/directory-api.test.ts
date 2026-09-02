/**
 * The directory routes: how a business joins the network, and what stops it joining on its own terms.
 *
 * M-48 already refuses a malformed record. What it cannot refuse — because none of it is about the
 * record — is **who is asking**, and that is what this suite is about.
 *
 *   * **Nobody registers anybody else.** The party is the session. Sending `accountId` is refused
 *     rather than ignored, because a caller who could name the party could register a competitor
 *     under a name they chose and then close them.
 *   * **Registration is not admission.** A supplier holds `create` and `update` over their own
 *     entry and never `admit`, so activating themselves is refused by K-04 before any handler runs.
 *     Somebody who legitimately holds `admit` still cannot decide their own entry, which the
 *     handler checks because K-04 honestly cannot.
 *   * **A party reaches their own entry and no other.** Every route that names an entry resolves it
 *     to the one account that trades under it, and a stranger gets 404 rather than 403: telling
 *     somebody that a supplier id exists is telling them about a business that did not ask them to
 *     know.
 *   * **A search is gated.** No category, no answer — because the ungated query is the platform's
 *     commercial map and this is exactly the endpoint it would leave through.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CommerceRequestService,
  InMemoryCommerceRequestRepository,
} from '../modules/commerce-request/index.ts';
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
import { UserCockpitService } from '../modules/user-cockpit/index.ts';
import { buildApi } from '../apps/api/app.ts';
import { handleRequest } from '../platform/http/pipeline.ts';
import type { HttpResponse } from '../platform/http/types.ts';

import { identityStack, type SignedIn } from './helpers/api-identity.ts';
import { inMemoryTendering, type TenderingServices } from './helpers/tendering-services.ts';

const NOW = '2026-07-01T09:00:00.000000Z';

interface Harness {
  readonly call: (
    method: string,
    target: string,
    body?: unknown,
    options?: {
      readonly as?: SignedIn | null;
      readonly key?: string;
      /** Declared on the routes that act on another party. Absent everywhere else, deliberately. */
      readonly purpose?: string;
    },
  ) => Promise<HttpResponse>;
  readonly cement: SignedIn;
  readonly flange: SignedIn;
  readonly buyer: SignedIn;
  /** Holds `admit`, and nothing that would let them read what anybody bought. */
  readonly operator: SignedIn;
  readonly services: TenderingServices;
}

const codeOf = (response: HttpResponse): string =>
  (response.body as { code?: string }).code ?? '(no code)';

const bodyOf = <T>(response: HttpResponse): T => response.body as T;

async function build(): Promise<Harness> {
  const orders = new OrderService(new InMemoryOrderRepository());
  const payments = new PaymentService(new InMemoryPaymentRepository(), resolveMockProvider);
  const journal = new LedgerService(new InMemoryLedgerRepository());
  const ledger = new FinancialLedgerService(
    new InMemoryFinancialLedgerRepository(),
    new K10LedgerPort(journal),
  );
  const listings = new UniversalListingService(new InMemoryUniversalListingRepository());
  const needs = new CommerceRequestService(new InMemoryCommerceRequestRepository());
  const services = inMemoryTendering(listings);

  const identity = await identityStack(NOW);
  const cement = await identity.register({ handle: 'dir-cement', roles: ['SUPPLIER'] });
  const flange = await identity.register({ handle: 'dir-flange', roles: ['SUPPLIER'] });
  const buyer = await identity.register({ handle: 'dir-buyer', roles: ['CUSTOMER'] });
  // Two roles on one identity, which is the platform's own claim about people: the person who
  // admits businesses to the market can also run one. It is what makes the next test possible.
  const operator = await identity.register({
    handle: 'dir-operator',
    roles: ['OPERATIONS', 'SUPPLIER'],
  });

  const api = buildApi({
    services: {
      orders,
      payments,
      ledger,
      listings,
      needs,
      ...services,
      cockpit: new UserCockpitService({ orders, payments, ledger, journal }),
    },
    access: identity,
    clock: () => NOW,
  });

  let sequence = 0;
  const call: Harness['call'] = (method, target, body, options = {}) => {
    sequence += 1;
    const principal = options.as === undefined ? cement : options.as;
    return handleRequest(api, {
      method,
      target,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(principal === null ? {} : { authorization: `Bearer ${principal.token}` }),
        ...(options.purpose === undefined ? {} : { 'x-access-purpose': options.purpose }),
        'idempotency-key': options.key ?? `idem_dir_${String(sequence).padStart(5, '0')}`,
        'x-correlation-id': `corr_01HR0DAP${String(sequence).padStart(6, '0')}`,
      },
      body: body === undefined ? null : JSON.stringify(body),
    });
  };

  return { call, cement, flange, buyer, operator, services };
}

/** Register a party and return the supplier id the platform minted for them. */
async function register(harness: Harness, as: SignedIn, displayName: string): Promise<string> {
  const response = await harness.call(
    'POST',
    '/v1/suppliers',
    { kind: 'supplier', displayName },
    { as },
  );
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return bodyOf<{ entry: { supplierId: string } }>(response).entry.supplierId;
}

/** Admit a party to the market, as somebody who may, saying why they are looking. */
async function admit(harness: Harness, supplierId: string): Promise<HttpResponse> {
  return harness.call(
    'POST',
    `/v1/suppliers/${supplierId}/status`,
    { status: 'active', reason: 'trade licence checked and the address is a real yard' },
    { as: harness.operator, purpose: 'safety-review' },
  );
}

// ---------------------------------------------------------------------------
// Joining
// ---------------------------------------------------------------------------

void test('registering puts a party in the directory and not in the market', async () => {
  const harness = await build();

  const response = await harness.call('POST', '/v1/suppliers', {
    kind: 'supplier',
    displayName: 'Matale Cement Works',
  });

  assert.equal(response.status, 201);
  const { entry } = bodyOf<{ entry: Record<string, unknown> }>(response);
  assert.equal(entry.status, 'pending', 'signing up does not put you in the market');
  assert.equal(
    entry.acceptsOrders,
    false,
    'and it does not open you for orders either. A platform where registering was enough would ' +
      'give the first tender to whoever registered fastest',
  );
  assert.equal(entry.accountId, harness.cement.accountId, 'the party is the session');
});

void test('a caller cannot register somebody else, or register themselves as admitted', async () => {
  const harness = await build();

  for (const body of [
    { kind: 'supplier', displayName: 'Not mine', accountId: 'acct_01HR0DAPother01' },
    { kind: 'supplier', displayName: 'Already in', status: 'active' },
    { kind: 'supplier', displayName: 'Open please', acceptsOrders: true },
    { kind: 'supplier', displayName: 'Trust me', verified: true },
  ]) {
    const response = await harness.call('POST', '/v1/suppliers', body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(codeOf(response), 'caller-asserted-party', JSON.stringify(body));
  }
});

void test('one account holds one entry, and the second attempt says so', async () => {
  const harness = await build();
  await register(harness, harness.cement, 'Matale Cement Works');

  const again = await harness.call('POST', '/v1/suppliers', {
    kind: 'merchant',
    displayName: 'A second business under the same account',
  });

  assert.equal(again.status, 409);
  assert.equal(
    codeOf(again),
    'already-registered',
    'a party with two entries can be invited twice to one tender and answer once',
  );
});

void test('a retried registration converges rather than registering twice', async () => {
  const harness = await build();
  const body = { kind: 'supplier', displayName: 'Matale Cement Works' };

  const first = await harness.call('POST', '/v1/suppliers', body, { key: 'idem_dir_retry01' });
  const second = await harness.call('POST', '/v1/suppliers', body, { key: 'idem_dir_retry01' });

  assert.equal(first.status, 201);
  assert.equal(second.status, 200, 'the retry is answered with the entry the first call made');
  assert.equal(
    bodyOf<{ entry: { supplierId: string } }>(second).entry.supplierId,
    bodyOf<{ entry: { supplierId: string } }>(first).entry.supplierId,
  );
});

void test('a party asks about itself without knowing its own supplier id', async () => {
  const harness = await build();
  const supplierId = await register(harness, harness.cement, 'Matale Cement Works');

  const mine = await harness.call('GET', '/v1/suppliers/me');

  assert.equal(mine.status, 200, '/me is a route and not a supplier id');
  assert.equal(bodyOf<{ entry: { supplierId: string } }>(mine).entry.supplierId, supplierId);
});

void test('a party who has not registered is told so rather than told nothing', async () => {
  const harness = await build();
  const response = await harness.call('GET', '/v1/suppliers/me');

  assert.equal(response.status, 404);
  assert.equal(codeOf(response), 'not-registered');
});

// ---------------------------------------------------------------------------
// Admission is somebody else's decision
// ---------------------------------------------------------------------------

void test('a supplier cannot admit themselves to the market', async () => {
  const harness = await build();
  const supplierId = await register(harness, harness.cement, 'Matale Cement Works');

  const response = await harness.call(
    'POST',
    `/v1/suppliers/${supplierId}/status`,
    { status: 'active', reason: 'I have checked my own documents and they are fine' },
    { purpose: 'safety-review' },
  );

  assert.equal(
    response.status,
    403,
    'K-04 refuses it by verb: no trading role holds `admit`, so this never reaches a handler',
  );

  const still = await harness.call('GET', '/v1/suppliers/me');
  assert.equal(bodyOf<{ entry: { status: string } }>(still).entry.status, 'pending');
});

void test('somebody who may admit still cannot admit their own entry', async () => {
  // The case K-04 honestly cannot catch: the verb is held, and the object is their own. Without
  // this check an operator could register their own supply business and let it into the market.
  const harness = await build();
  const own = await register(harness, harness.operator, 'The operator’s own hardware shop');

  const response = await harness.call(
    'POST',
    `/v1/suppliers/${own}/status`,
    { status: 'active', reason: 'it is my own business and I say it is fine' },
    { as: harness.operator, purpose: 'safety-review' },
  );

  assert.equal(response.status, 409);
  assert.equal(codeOf(response), 'not-your-decision');
});

void test('an operator admits a party, and the history says why', async () => {
  const harness = await build();
  const supplierId = await register(harness, harness.cement, 'Matale Cement Works');

  const admitted = await admit(harness, supplierId);
  assert.equal(admitted.status, 200, JSON.stringify(admitted.body));
  assert.equal(bodyOf<{ entry: { status: string } }>(admitted).entry.status, 'active');

  const history = await harness.call('GET', `/v1/suppliers/${supplierId}/history`);
  const events = bodyOf<{ history: { toStatus: string; reason: string }[] }>(history).history;
  assert.deepEqual(
    events.map((event) => event.toStatus),
    ['pending', 'active'],
  );
  assert.match(
    events[1]?.reason ?? '',
    /trade licence/,
    'a party whose status changed is entitled to the reason, and it survives on the record',
  );
});

void test('a status change with no reason is refused', async () => {
  const harness = await build();
  const supplierId = await register(harness, harness.cement, 'Matale Cement Works');

  const response = await harness.call(
    'POST',
    `/v1/suppliers/${supplierId}/status`,
    { status: 'suspended', reason: 'no' },
    { as: harness.operator, purpose: 'safety-review' },
  );

  assert.equal(response.status, 400);
  assert.equal(codeOf(response), 'malformed-reason', '"suspended" is not a reason');
});

// ---------------------------------------------------------------------------
// One party, one entry, and nobody else's
// ---------------------------------------------------------------------------

void test('a supplier cannot read or change another supplier’s entry', async () => {
  const harness = await build();
  const mine = await register(harness, harness.cement, 'Matale Cement Works');
  await register(harness, harness.flange, 'Flange and Fitting');

  for (const [method, path, body] of [
    ['GET', `/v1/suppliers/${mine}`, undefined],
    ['GET', `/v1/suppliers/${mine}/facets`, undefined],
    ['GET', `/v1/suppliers/${mine}/history`, undefined],
    ['POST', `/v1/suppliers/${mine}/facets`, { kind: 'category', value: 'cement' }],
    ['PUT', `/v1/suppliers/${mine}/availability`, { acceptsOrders: false }],
  ] as const) {
    const response = await harness.call(method, path, body, { as: harness.flange });
    assert.equal(response.status, 404, `${method} ${path}`);
    assert.equal(
      codeOf(response),
      'not-found',
      'a stranger is told the entry does not exist, not that it is not theirs',
    );
  }
});

void test('an unauthenticated caller reaches none of it', async () => {
  const harness = await build();
  const response = await harness.call('GET', '/v1/suppliers?category=cement', undefined, {
    as: null,
  });
  assert.equal(response.status, 401);
});

// ---------------------------------------------------------------------------
// What a party declares
// ---------------------------------------------------------------------------

void test('a party declares what it deals in, and stops dealing in it', async () => {
  const harness = await build();
  const supplierId = await register(harness, harness.cement, 'Matale Cement Works');

  const declared = await harness.call('POST', `/v1/suppliers/${supplierId}/facets`, {
    kind: 'category',
    value: 'cement',
  });
  assert.equal(declared.status, 201, JSON.stringify(declared.body));

  const withdrawn = await harness.call(
    'DELETE',
    `/v1/suppliers/${supplierId}/facets/category/cement`,
  );
  assert.equal(withdrawn.status, 200);

  const facets = await harness.call('GET', `/v1/suppliers/${supplierId}/facets`);
  const rows = bodyOf<{ facets: { value: string; status: string }[] }>(facets).facets;
  assert.equal(rows.length, 1, 'a withdrawal moves the row rather than adding a second one');
  assert.equal(rows[0]?.status, 'withdrawn');
});

void test('a telephone number is not a category, and the route says which field', async () => {
  const harness = await build();
  const supplierId = await register(harness, harness.cement, 'Matale Cement Works');

  const response = await harness.call('POST', `/v1/suppliers/${supplierId}/facets`, {
    kind: 'category',
    value: '0771234567',
  });

  assert.equal(response.status, 400);
  assert.equal(
    codeOf(response),
    'malformed-record',
    'a code travels into every invitation this supplier receives',
  );
});

void test('a party has one primary branch, and the second is refused', async () => {
  const harness = await build();
  const supplierId = await register(harness, harness.cement, 'Matale Cement Works');

  const first = await harness.call('POST', `/v1/suppliers/${supplierId}/locations`, {
    name: 'Matale yard',
    district: 'matale',
    primary: true,
  });
  assert.equal(first.status, 201, JSON.stringify(first.body));

  const second = await harness.call('POST', `/v1/suppliers/${supplierId}/locations`, {
    name: 'Kandy yard',
    district: 'kandy',
    primary: true,
  });
  assert.equal(second.status, 409);
  assert.equal(codeOf(second), 'primary-location-exists');
});

void test('availability is a boolean and not a word that looks like one', async () => {
  const harness = await build();
  const supplierId = await register(harness, harness.cement, 'Matale Cement Works');

  const response = await harness.call('PUT', `/v1/suppliers/${supplierId}/availability`, {
    acceptsOrders: 'false',
  });

  assert.equal(response.status, 400);
  assert.equal(
    codeOf(response),
    'malformed-field',
    'the string "false" is true in most languages, and a supplier closed for the week is not ' +
      'somebody to guess about',
  );
});

// ---------------------------------------------------------------------------
// Finding somebody
// ---------------------------------------------------------------------------

void test('a search with no category is refused rather than answered with everybody', async () => {
  const harness = await build();
  const response = await harness.call('GET', '/v1/suppliers', undefined, { as: harness.buyer });

  assert.equal(response.status, 400);
  assert.equal(codeOf(response), 'ungated-query');
});

void test('a buyer finds the open parties in a category and nobody else', async () => {
  const harness = await build();

  // Admitted and open.
  const cementId = await register(harness, harness.cement, 'Matale Cement Works');
  await admit(harness, cementId);
  await harness.call('POST', `/v1/suppliers/${cementId}/facets`, {
    kind: 'category',
    value: 'cement',
  });
  await harness.call('PUT', `/v1/suppliers/${cementId}/availability`, { acceptsOrders: true });

  // Registered, in the same category, and never admitted.
  const flangeId = await register(harness, harness.flange, 'Flange and Fitting');
  await harness.call(
    'POST',
    `/v1/suppliers/${flangeId}/facets`,
    { kind: 'category', value: 'cement' },
    { as: harness.flange },
  );

  const found = await harness.call('GET', '/v1/suppliers?category=cement', undefined, {
    as: harness.buyer,
  });

  assert.equal(found.status, 200, JSON.stringify(found.body));
  const suppliers = bodyOf<{ suppliers: { entry: { supplierId: string } }[] }>(found).suppliers;
  assert.deepEqual(
    suppliers.map((profile) => profile.entry.supplierId),
    [cementId],
    'the pending party is in the directory and not in the market',
  );

  const elsewhere = await harness.call('GET', '/v1/suppliers?category=laptops', undefined, {
    as: harness.buyer,
  });
  assert.deepEqual(
    bodyOf<{ suppliers: unknown[] }>(elsewhere).suppliers,
    [],
    'and a cement supplier is not offered for laptops',
  );
});

void test('acting on another party needs a declared purpose, and the right one', async () => {
  // The two halves of the mechanism that lets `admit` reach somebody else's entry at all. Without
  // the first, staff access would be unreviewable; without the second, "any word will do" would
  // make the purpose a formality rather than a check.
  const harness = await build();
  const supplierId = await register(harness, harness.cement, 'Matale Cement Works');
  const body = { status: 'active', reason: 'trade licence checked and the yard is real' };

  const unstated = await harness.call('POST', `/v1/suppliers/${supplierId}/status`, body, {
    as: harness.operator,
  });
  assert.equal(unstated.status, 400);
  assert.equal(
    codeOf(unstated),
    'purpose-required',
    'staff access is role-based, purpose-based and audited, and a request with no stated reason ' +
      'is one nobody can review afterwards',
  );

  const wrong = await harness.call('POST', `/v1/suppliers/${supplierId}/status`, body, {
    as: harness.operator,
    purpose: 'fraud-investigation',
  });
  assert.equal(
    wrong.status,
    403,
    'the grant names one purpose and the caller declared another. A purpose nobody checks is a ' +
      'field, not a control',
  );

  const still = await harness.call('GET', `/v1/suppliers/${supplierId}/history`);
  const events = bodyOf<{ history: { toStatus: string }[] }>(still).history;
  assert.deepEqual(
    events.map((event) => event.toStatus),
    ['pending'],
    'and nothing moved',
  );
});

void test('the cross-party exemption applies to that route and no other', async () => {
  // The risk of the mechanism is that it leaks: a route marked as acting on another party skips
  // the ownership check, so this asserts the skip is per route rather than per resource type. The
  // operator holds `admit` and may decide about this party — and still cannot read their entry.
  const harness = await build();
  const supplierId = await register(harness, harness.cement, 'Matale Cement Works');
  assert.equal((await admit(harness, supplierId)).status, 200);

  for (const path of [
    `/v1/suppliers/${supplierId}`,
    `/v1/suppliers/${supplierId}/facets`,
    `/v1/suppliers/${supplierId}/locations`,
    `/v1/suppliers/${supplierId}/history`,
  ]) {
    const response = await harness.call('GET', path, undefined, {
      as: harness.operator,
      purpose: 'safety-review',
    });
    assert.equal(response.status, 404, path);
    assert.equal(
      codeOf(response),
      'not-found',
      'admitting a business is not a licence to read what it deals in afterwards',
    );
  }
});
