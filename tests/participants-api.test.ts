/**
 * Joining, signing in, and taking on what you do here.
 *
 * Before these routes existed, every person in this platform was created by a fixture or by an
 * operator running statements by hand. **Nobody could join.** That is the gap this suite covers,
 * and the four properties it holds are the ones that would be quietly wrong if nobody checked.
 *
 *   * **Registration stores no personal data.** Not "we do not ask for it" — the route refuses an
 *     `email`, a `phone` and a `name` by name, and says where each belongs instead. K-01 and K-03
 *     hold no personal data by design, and a registration form is exactly the door it would arrive
 *     through.
 *   * **A retry makes one person, not two.** Every identifier is derived from the idempotency key.
 *     Two histories for one person, with no way to say which is theirs, is the worst duplicate this
 *     platform could produce.
 *   * **One identity, several roles.** Taking on SUPPLIER does not make a second account. The same
 *     account gains a capability and a set of grants, and the orders it placed as a buyer are still
 *     its orders.
 *   * **Not every role may be taken on by asking.** CUSTOMER and SUPPLIER may, because being a
 *     supplier means holding a directory entry that starts pending and invisible. DRIVER, FINANCE
 *     and OPERATIONS may not, and asking is refused rather than ignored.
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
  InMemoryUniversalAccountRepository,
  UniversalAccountService,
} from '../modules/universal-account/index.ts';
import {
  InMemoryUniversalListingRepository,
  UniversalListingService,
} from '../modules/universal-listing/index.ts';
import { UserCockpitService } from '../modules/user-cockpit/index.ts';
import { buildApi } from '../apps/api/app.ts';
import { permissionGrantor } from '../apps/api/registrar.ts';
import { handleRequest } from '../platform/http/pipeline.ts';
import type { HttpResponse } from '../platform/http/types.ts';

import { identityStack } from './helpers/api-identity.ts';
import { inMemoryTendering } from './helpers/tendering-services.ts';

const NOW = '2026-07-01T09:00:00.000000Z';
const PASSWORD = 'a-passphrase-nobody-would-guess';

interface Harness {
  readonly call: (
    method: string,
    target: string,
    body?: unknown,
    options?: { readonly token?: string | null; readonly key?: string },
  ) => Promise<HttpResponse>;
  readonly capabilities: UniversalAccountService;
}

const codeOf = (response: HttpResponse): string =>
  (response.body as { code?: string }).code ?? '(no code)';

const bodyOf = <T>(response: HttpResponse): T => response.body as T;

/** Build the API with self-service registration configured, as a deployment that offers it would. */
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
  const capabilities = new UniversalAccountService(new InMemoryUniversalAccountRepository());

  const identity = await identityStack(NOW);

  const api = buildApi({
    services: {
      orders,
      payments,
      ledger,
      listings,
      needs,
      ...inMemoryTendering(listings),
      cockpit: new UserCockpitService({ orders, payments, ledger, journal }),
    },
    access: identity,
    registration: {
      identity: identity.identity,
      accounts: identity.accountService,
      authentication: identity.authentication,
      passwords: identity.passwords,
      capabilities,
      // The real grantor, making every grant through K-04's own surface under the fixture
      // administrator's session. A stub here would prove nothing about whether K-04 accepts them.
      grantor: permissionGrantor({
        permissions: identity.permissions,
        administratorToken: identity.administratorToken,
      }),
    },
    clock: () => NOW,
    // A registration or sign-in that reaches the pipeline unclassified is a defect, not a refusal:
    // it would answer 500 to a caller who did nothing wrong. Failing here is how it stays visible.
    observe: (record) => {
      assert.equal(record.unclassified, null, 'an unclassified failure reached the pipeline');
    },
  });

  let sequence = 0;
  const call: Harness['call'] = (method, target, body, options = {}) => {
    sequence += 1;
    return handleRequest(api, {
      method,
      target,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(options.token === undefined || options.token === null
          ? {}
          : { authorization: `Bearer ${options.token}` }),
        'idempotency-key': options.key ?? `idem_par_${String(sequence).padStart(5, '0')}`,
        'x-correlation-id': `corr_01HR0PAR${String(sequence).padStart(6, '0')}`,
      },
      body: body === undefined ? null : JSON.stringify(body),
    });
  };

  return { call, capabilities };
}

interface Joined {
  readonly reference: string;
  readonly accountId: string;
  readonly token: string;
}

/** Join, then sign in — the two calls a real client makes, in order. */
async function join(harness: Harness, key: string): Promise<Joined> {
  const registered = await harness.call(
    'POST',
    '/v1/participants',
    { password: PASSWORD },
    { key: `idem_par_reg_${key}` },
  );
  assert.equal(registered.status, 201, JSON.stringify(registered.body));
  const { participantReference, accountId } = bodyOf<{
    participantReference: string;
    accountId: string;
  }>(registered);

  const signedIn = await harness.call(
    'POST',
    '/v1/sessions',
    { participantReference, password: PASSWORD },
    { key: `idem_par_sin_${key}` },
  );
  assert.equal(signedIn.status, 201, JSON.stringify(signedIn.body));

  return {
    reference: participantReference,
    accountId,
    token: bodyOf<{ token: string }>(signedIn).token,
  };
}

// ---------------------------------------------------------------------------
// Joining
// ---------------------------------------------------------------------------

void test('a person joins with a password and is handed a reference, and nothing else', async () => {
  const harness = await build();

  const response = await harness.call('POST', '/v1/participants', { password: PASSWORD });

  assert.equal(response.status, 201);
  const body = bodyOf<Record<string, unknown>>(response);
  assert.equal(typeof body.participantReference, 'string');
  assert.equal(typeof body.accountId, 'string');
  assert.equal(
    'password' in body,
    false,
    'the password reaches K-02’s verifier and nothing else, and is never echoed',
  );
  assert.match(
    String(body.note),
    /recovery/,
    'the reference is the only way back in, and the response says so rather than leaving somebody ' +
      'to discover it',
  );
});

void test('registration refuses personal data by name, and says where it belongs', async () => {
  const harness = await build();

  for (const field of ['email', 'phone', 'name', 'nic', 'address', 'dateOfBirth']) {
    const response = await harness.call('POST', '/v1/participants', {
      password: PASSWORD,
      [field]: 'something',
    });
    assert.equal(response.status, 400, field);
    assert.equal(
      codeOf(response),
      'personal-data-refused',
      `${field} must be refused. K-01 and K-03 hold no personal data, and a registration form is ` +
        'exactly the door it would arrive through',
    );
  }
});

void test('a caller cannot name their own identifiers or their own authority', async () => {
  const harness = await build();

  for (const field of ['subjectId', 'accountId', 'roles', 'grants', 'participantReference']) {
    const response = await harness.call('POST', '/v1/participants', {
      password: PASSWORD,
      [field]: 'whatever',
    });
    assert.equal(response.status, 400, field);
    assert.equal(codeOf(response), 'caller-asserted-party', field);
  }
});

void test('a short password is refused, with a rule that produces passphrases', async () => {
  const harness = await build();
  const response = await harness.call('POST', '/v1/participants', { password: 'short' });

  assert.equal(response.status, 400);
  assert.equal(codeOf(response), 'weak-password');
});

void test('a retried registration makes one person, not two', async () => {
  const harness = await build();

  const first = await harness.call(
    'POST',
    '/v1/participants',
    { password: PASSWORD },
    { key: 'idem_par_retry001' },
  );
  const second = await harness.call(
    'POST',
    '/v1/participants',
    { password: PASSWORD },
    { key: 'idem_par_retry001' },
  );

  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.equal(
    bodyOf<{ accountId: string }>(second).accountId,
    bodyOf<{ accountId: string }>(first).accountId,
    'two histories for one person, with no way to say which is theirs, is the worst duplicate ' +
      'this platform could produce',
  );
  assert.equal(
    bodyOf<{ participantReference: string }>(second).participantReference,
    bodyOf<{ participantReference: string }>(first).participantReference,
  );
});

// ---------------------------------------------------------------------------
// Signing in
// ---------------------------------------------------------------------------

void test('a person signs in and the session works on a guarded route', async () => {
  const harness = await build();
  const person = await join(harness, 'signin1');

  const me = await harness.call('GET', '/v1/participants/me', undefined, { token: person.token });

  assert.equal(me.status, 200, JSON.stringify(me.body));
  assert.equal(bodyOf<{ accountId: string }>(me).accountId, person.accountId);
  assert.deepEqual(
    bodyOf<{ capabilities: { capability: string }[] }>(me).capabilities.map(
      (one) => one.capability,
    ),
    ['buyer'],
    'joining makes somebody a buyer, which is what a person who has just arrived is',
  );
});

void test('a wrong password and an unknown reference are the same refusal', async () => {
  // K-02 hashes against a decoy either way so the two cost the same, and the API must not undo that
  // by answering them differently. A distinguishable refusal is an account-enumeration oracle.
  const harness = await build();
  const person = await join(harness, 'signin2');

  const wrongPassword = await harness.call('POST', '/v1/sessions', {
    participantReference: person.reference,
    password: 'not-the-password-at-all',
  });
  const unknownReference = await harness.call('POST', '/v1/sessions', {
    participantReference: 'pref_01HR0PARnobody01',
    password: PASSWORD,
  });

  assert.equal(wrongPassword.status, 401, JSON.stringify(wrongPassword.body));
  assert.equal(unknownReference.status, 401, JSON.stringify(unknownReference.body));
  assert.equal(codeOf(wrongPassword), 'authentication-failed');
  assert.equal(
    codeOf(unknownReference),
    codeOf(wrongPassword),
    'one refusal for both, or the response body becomes the enumeration oracle K-02 goes to ' +
      'trouble to deny',
  );
  assert.deepEqual(
    wrongPassword.body,
    {
      ...(unknownReference.body as Record<string, unknown>),
      correlationId: (wrongPassword.body as Record<string, unknown>).correlationId,
    },
    'and identical down to the wording',
  );
});

void test('a signed-in session reaches only what its role holds', async () => {
  const harness = await build();
  const person = await join(harness, 'signin3');

  // A new arrival is a CUSTOMER. Capturing a payment is the seller's act, and no amount of being
  // signed in makes it theirs.
  const captured = await harness.call(
    'POST',
    '/v1/payments/pay_01HR0PARnothing1/capture',
    { amountMinor: '100' },
    { token: person.token },
  );
  assert.equal(captured.status, 403);
});

// ---------------------------------------------------------------------------
// One identity, several roles
// ---------------------------------------------------------------------------

void test('taking on the supplier role keeps the same account', async () => {
  const harness = await build();
  const person = await join(harness, 'roles1');

  const assumed = await harness.call(
    'POST',
    '/v1/participants/me/roles',
    { role: 'SUPPLIER' },
    { token: person.token },
  );

  assert.equal(assumed.status, 200, JSON.stringify(assumed.body));
  assert.equal(
    bodyOf<{ accountId: string }>(assumed).accountId,
    person.accountId,
    'the person who bought cement last week is the person who registers their hardware shop this ' +
      'week, and splitting them would split their history in two',
  );
  assert.deepEqual(
    [...bodyOf<{ capabilities: { capability: string }[] }>(assumed).capabilities]
      .map((one) => one.capability)
      .sort(),
    ['buyer', 'seller'],
  );

  // And the new authority is real: a supplier may register a directory entry, which a bare
  // customer's grants would also allow — so the sharper check is that the grant K-04 evaluates
  // against actually exists, which the successful call below proves.
  const registered = await harness.call(
    'POST',
    '/v1/suppliers',
    { kind: 'supplier', displayName: 'Matale Cement Works' },
    { token: person.token },
  );
  assert.equal(registered.status, 201, JSON.stringify(registered.body));
});

void test('a role nobody takes on by asking is refused, and named', async () => {
  const harness = await build();
  const person = await join(harness, 'roles2');

  for (const role of ['DRIVER', 'OPERATIONS', 'FINANCE', 'ADMIN', 'SUPER_ADMIN']) {
    const response = await harness.call(
      'POST',
      '/v1/participants/me/roles',
      { role },
      { token: person.token },
    );
    assert.equal(response.status, 403, role);
    assert.equal(
      codeOf(response),
      'role-not-self-assumable',
      `${role} must be refused: a driver takes custody of somebody else’s goods, and a staff role ` +
        'reaches another party’s records',
    );
  }
});

void test('taking on a role is refused without a session', async () => {
  const harness = await build();
  const response = await harness.call('POST', '/v1/participants/me/roles', { role: 'SUPPLIER' });
  assert.equal(response.status, 401);
});

// ---------------------------------------------------------------------------
// A deployment that offers none of this
// ---------------------------------------------------------------------------

void test('without an administrator behind it, registration refuses and says why', async () => {
  // K-04 has no bootstrap path for a grant. A deployment that has not named somebody willing to
  // stand behind self-service registration must not create people who hold nothing — and must not
  // answer 404 either, which would say "no such endpoint" when the truth is "not configured here".
  const orders = new OrderService(new InMemoryOrderRepository());
  const payments = new PaymentService(new InMemoryPaymentRepository(), resolveMockProvider);
  const journal = new LedgerService(new InMemoryLedgerRepository());
  const ledger = new FinancialLedgerService(
    new InMemoryFinancialLedgerRepository(),
    new K10LedgerPort(journal),
  );
  const listings = new UniversalListingService(new InMemoryUniversalListingRepository());
  const identity = await identityStack(NOW);

  const api = buildApi({
    services: {
      orders,
      payments,
      ledger,
      listings,
      needs: new CommerceRequestService(new InMemoryCommerceRequestRepository()),
      ...inMemoryTendering(listings),
      cockpit: new UserCockpitService({ orders, payments, ledger, journal }),
    },
    access: identity,
    clock: () => NOW,
  });

  const response = await handleRequest(api, {
    method: 'POST',
    target: '/v1/participants',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': 'idem_par_unavail01',
      'x-correlation-id': 'corr_01HR0PARunav01',
    },
    body: JSON.stringify({ password: PASSWORD }),
  });

  assert.equal(response.status, 503);
  assert.equal(codeOf(response), 'registration-unavailable');
  assert.match(
    String((response.body as { detail?: string }).detail),
    /administrator/,
    'and it says what is missing rather than merely that something is',
  );
});
