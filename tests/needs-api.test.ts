/**
 * The Need routes: the first place a real person uses this platform as themselves.
 *
 * Everything before this served an order, a payment or a ledger position that somebody else had
 * created. These routes are where a customer says what they want, so the questions are different
 * from the ones the other API suites ask.
 *
 * **Whose Need is it?** A Need has exactly one party, unlike an order where a buyer and a seller
 * both legitimately reach the record. Nobody else may read it — not another customer, and not a
 * supplier, who sees a sourcing request derived from it rather than the words themselves.
 *
 * **Can a caller state a Need in somebody else's name?** The account comes from the session and
 * there is no `accountId` field to send. The suite checks that sending one anyway is refused rather
 * than ignored, because "ignored" is a behaviour that changes the first time somebody adds the field
 * for a different reason.
 *
 * **Do the words survive the wire?** A Need travels as JSON through a real pipeline. Whitespace, a
 * newline and an emoji are all things a reader could trim, normalise or mangle on the way in.
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

const NOW = '2026-07-01T09:00:00.000000Z';

/** Whitespace, an em dash, a newline, an emoji, an apostrophe and a telephone number. */
const AWKWARD =
  "  20 tonnes of cement — Matale, by Friday 🙏\nDon't call after 6pm; ring 0771234567.  ";

interface Harness {
  readonly call: (
    method: string,
    target: string,
    body?: unknown,
    options?: { readonly as?: SignedIn | null; readonly key?: string },
  ) => Promise<HttpResponse>;
  readonly buyer: SignedIn;
  readonly stranger: SignedIn;
  readonly needs: CommerceRequestService;
}

const codeOf = (response: HttpResponse): string =>
  (response.body as { code?: string }).code ?? '(no code)';

async function build(): Promise<Harness> {
  const orders = new OrderService(new InMemoryOrderRepository());
  const payments = new PaymentService(new InMemoryPaymentRepository(), resolveMockProvider);
  const journal = new LedgerService(new InMemoryLedgerRepository());
  const ledger = new FinancialLedgerService(
    new InMemoryFinancialLedgerRepository(),
    new K10LedgerPort(journal),
  );
  const needs = new CommerceRequestService(new InMemoryCommerceRequestRepository());

  const identity = await identityStack(NOW);
  const buyer = await identity.register({ handle: 'need-buyer', roles: ['CUSTOMER'] });
  const stranger = await identity.register({ handle: 'need-stranger', roles: ['CUSTOMER'] });

  const api = buildApi({
    services: {
      orders,
      payments,
      ledger,
      listings: new UniversalListingService(new InMemoryUniversalListingRepository()),
      needs,
      cockpit: new UserCockpitService({ orders, payments, ledger, journal }),
    },
    access: identity,
    clock: () => NOW,
  });

  let sequence = 0;
  const call: Harness['call'] = (method, target, body, options = {}) => {
    sequence += 1;
    const principal = options.as === undefined ? buyer : options.as;
    return handleRequest(api, {
      method,
      target,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(principal === null ? {} : { authorization: `Bearer ${principal.token}` }),
        'idempotency-key': options.key ?? `idem_ndapi_${String(sequence).padStart(4, '0')}`,
        'x-correlation-id': `corr_01HR0NDAPI${String(sequence).padStart(5, '0')}`,
      },
      body: body === undefined ? null : JSON.stringify(body),
    });
  };

  return { call, buyer, stranger, needs };
}

async function aNeed(harness: Harness, key: string, rawText = AWKWARD): Promise<string> {
  const created = await harness.call('POST', '/v1/needs', { channel: 'text', rawText }, { key });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return (created.body as { request: { requestId: string } }).request.requestId;
}

// ---------------------------------------------------------------------------
// Stating a Need
// ---------------------------------------------------------------------------

test('a signed-in person states a Need, and the words arrive intact', async () => {
  const harness = await build();

  const created = await harness.call(
    'POST',
    '/v1/needs',
    { channel: 'text', rawText: AWKWARD, neededBy: '2026-07-03T17:00:00.000000Z' },
    { key: 'idem_ndapi_state01' },
  );

  assert.equal(created.status, 201, JSON.stringify(created.body));
  const need = (created.body as { request: { rawText: string; accountId: string; status: string } })
    .request;

  assert.equal(
    need.rawText,
    AWKWARD,
    'whitespace, an em dash, a newline and an emoji all survive the wire',
  );
  assert.equal(
    need.accountId,
    harness.buyer.accountId,
    'the account comes from the session, and there is no field to send instead',
  );
  assert.equal(need.status, 'captured');
});

test('a caller cannot state a Need in somebody else’s name', async () => {
  // Refused rather than ignored. "Ignored" is a behaviour that changes the first time somebody adds
  // the field for a different reason, and a client that thought it was working would never find out.
  const harness = await build();

  for (const field of ['accountId', 'account_id']) {
    const response = await harness.call(
      'POST',
      '/v1/needs',
      { channel: 'text', rawText: 'a Need in another name', [field]: harness.stranger.accountId },
      { key: `idem_ndapi_own_${field.slice(0, 6)}` },
    );
    assert.equal(response.status, 400, `"${field}" was accepted`);
    assert.equal(codeOf(response), 'caller-asserted-need-field');
  }
});

test('a caller cannot declare a status or arrive with the platform’s own guess', async () => {
  const harness = await build();

  for (const body of [
    { status: 'ready' },
    { currentInterpretationId: 'int_01HR0NDAPIfake1' },
    { structured: { item: 'cement' } },
  ]) {
    const response = await harness.call(
      'POST',
      '/v1/needs',
      { channel: 'text', rawText: 'a Need arriving pre-decided', ...body },
      { key: `idem_ndapi_dec_${Object.keys(body)[0]?.slice(0, 6) ?? 'x'}` },
    );
    assert.equal(response.status, 400, `${JSON.stringify(body)} was accepted`);
    assert.equal(codeOf(response), 'caller-asserted-need-field');
  }
});

test('a retry with the same key states one Need, not two', async () => {
  const harness = await build();

  const first = await harness.call(
    'POST',
    '/v1/needs',
    { channel: 'text', rawText: 'a Need the client retried' },
    { key: 'idem_ndapi_retry01' },
  );
  const second = await harness.call(
    'POST',
    '/v1/needs',
    { channel: 'text', rawText: 'a Need the client retried' },
    { key: 'idem_ndapi_retry01' },
  );

  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(
    (second.body as { request: { requestId: string } }).request.requestId,
    (first.body as { request: { requestId: string } }).request.requestId,
  );
  assert.equal((await harness.needs.listNeedsForAccount(harness.buyer.accountId)).length, 1);
});

// ---------------------------------------------------------------------------
// Whose Need is it
// ---------------------------------------------------------------------------

test('one customer cannot read another’s Need, and cannot tell it exists', async () => {
  // A Need is the most personal record this platform holds: it is a sentence somebody wrote, and it
  // is exempt from the identifier rules precisely because it is prose. Reading somebody else's is
  // reading their words.
  const harness = await build();
  const requestId = await aNeed(harness, 'idem_ndapi_own001');

  const mine = await harness.call('GET', `/v1/needs/${requestId}`, undefined, {
    as: harness.buyer,
  });
  assert.equal(mine.status, 200);

  const theirs = await harness.call('GET', `/v1/needs/${requestId}`, undefined, {
    as: harness.stranger,
  });
  assert.equal(theirs.status, 404, 'the stranger holds a perfectly good "read Needs" grant');

  const absent = await harness.call('GET', '/v1/needs/req_01HR0NDAPInone1', undefined, {
    as: harness.stranger,
  });
  assert.deepEqual(
    { status: theirs.status, code: codeOf(theirs) },
    { status: absent.status, code: codeOf(absent) },
    'forbidden and absent are indistinguishable, or the route enumerates identifiers',
  );
});

test('every route that names a Need is checked against its owner', async () => {
  const harness = await build();
  const requestId = await aNeed(harness, 'idem_ndapi_own002');

  const reads: readonly string[] = [
    `/v1/needs/${requestId}`,
    `/v1/needs/${requestId}/interpretations`,
    `/v1/needs/${requestId}/media`,
    `/v1/needs/${requestId}/history`,
  ];
  for (const target of reads) {
    assert.equal(
      (await harness.call('GET', target, undefined, { as: harness.buyer })).status,
      200,
      `the owner cannot read ${target}`,
    );
    assert.equal(
      (await harness.call('GET', target, undefined, { as: harness.stranger })).status,
      404,
      `${target} leaked another party's Need`,
    );
  }

  const writes: ReadonlyArray<readonly [string, unknown]> = [
    [
      `/v1/needs/${requestId}/interpretations`,
      {
        origin: 'human',
        confidencePerMille: 1000,
        structured: { item: 'cement' },
        rationale: 'a stranger correcting somebody else’s Need',
      },
    ],
    [`/v1/needs/${requestId}/readiness`, { reason: 'a stranger declaring it ready' }],
    [`/v1/needs/${requestId}/cancellation`, { reason: 'a stranger withdrawing it' }],
  ];
  for (const [target, body] of writes) {
    const response = await harness.call('POST', target, body, { as: harness.stranger });
    assert.equal(response.status, 404, `${target} accepted a stranger's write`);
  }

  // And the Need is untouched by any of it.
  const after = await harness.needs.getNeed(requestId);
  assert.equal(after?.status, 'captured');
  assert.equal((await harness.needs.listInterpretations(requestId)).length, 0);
});

test('the list is scoped to the caller by construction', async () => {
  // There is no account parameter on this route, so there is nothing to get wrong. That is the
  // point: the safest identifier is the one a caller cannot supply.
  const harness = await build();
  await aNeed(harness, 'idem_ndapi_list001', 'the buyer’s first Need');
  await aNeed(harness, 'idem_ndapi_list002', 'the buyer’s second Need');

  const mine = await harness.call('GET', '/v1/needs', undefined, { as: harness.buyer });
  assert.equal(mine.status, 200);
  assert.equal((mine.body as { needs: unknown[] }).needs.length, 2);

  const theirs = await harness.call('GET', '/v1/needs', undefined, { as: harness.stranger });
  assert.equal(theirs.status, 200, 'a stranger has their own list, which is empty');
  assert.equal((theirs.body as { needs: unknown[] }).needs.length, 0);
});

test('an unauthenticated request reaches no Need route at all', async () => {
  const harness = await build();
  const requestId = await aNeed(harness, 'idem_ndapi_anon001');

  for (const [method, target] of [
    ['POST', '/v1/needs'],
    ['GET', '/v1/needs'],
    ['GET', `/v1/needs/${requestId}`],
    ['POST', `/v1/needs/${requestId}/interpretations`],
    ['POST', `/v1/needs/${requestId}/cancellation`],
  ] as const) {
    const response = await harness.call(method, target, {}, { as: null });
    assert.equal(response.status, 401, `${method} ${target} answered a request with no session`);
  }
});

// ---------------------------------------------------------------------------
// Correcting a reading
// ---------------------------------------------------------------------------

test('a customer corrects a reading of their own Need, and the wrong one stays', async () => {
  const harness = await build();
  const requestId = await aNeed(harness, 'idem_ndapi_corr001', 'I need the 6mm bolts, two boxes');

  const guessed = await harness.call(
    'POST',
    `/v1/needs/${requestId}/interpretations`,
    {
      origin: 'model',
      confidencePerMille: 610,
      structured: { item: 'bolt', size: '6cm', quantity: 2 },
      aiRunId: 'airun_01HR0NDAPI001',
      rationale: 'read the size as 6cm from an ambiguous abbreviation',
    },
    { key: 'idem_ndapi_int001' },
  );
  assert.equal(guessed.status, 201, JSON.stringify(guessed.body));

  const corrected = await harness.call(
    'POST',
    `/v1/needs/${requestId}/interpretations`,
    {
      origin: 'human',
      confidencePerMille: 1000,
      structured: { item: 'bolt', size: '6mm', quantity: 2 },
      rationale: 'the customer said 6mm, not 6cm',
    },
    { key: 'idem_ndapi_int002' },
  );
  assert.equal(corrected.status, 201);

  const history = await harness.call('GET', `/v1/needs/${requestId}/interpretations`);
  const readings = (history.body as { interpretations: { version: number; origin: string }[] })
    .interpretations;
  assert.deepEqual(
    readings.map((one) => [one.version, one.origin]),
    [
      [1, 'model'],
      [2, 'human'],
    ],
    'the wrong reading is not deleted; it is superseded',
  );

  // And the words are still what they were.
  const need = await harness.call('GET', `/v1/needs/${requestId}`);
  assert.equal(
    (need.body as { need: { rawText: string } }).need.rawText,
    'I need the 6mm bolts, two boxes',
  );
});

test('a fractional confidence is refused at the edge, not rounded', async () => {
  // The API reads it as an integer per-mille. A client sending 0.82 is told so rather than having
  // its number quietly truncated to zero, which is the kind of rounding that produces a Need the
  // sourcing ladder treats as a guess when the model was sure.
  const harness = await build();
  const requestId = await aNeed(harness, 'idem_ndapi_conf001');

  const response = await harness.call(
    'POST',
    `/v1/needs/${requestId}/interpretations`,
    {
      origin: 'rule',
      confidencePerMille: 0.82,
      structured: {},
      rationale: 'a confidence expressed as a fraction',
    },
    { key: 'idem_ndapi_conf002' },
  );

  assert.equal(response.status, 400);
  assert.notEqual(codeOf(response), '(no code)');
});

test('a Need can be made ready and withdrawn over HTTP, and the history says so', async () => {
  const harness = await build();
  const requestId = await aNeed(harness, 'idem_ndapi_life001');

  const ready = await harness.call(
    'POST',
    `/v1/needs/${requestId}/readiness`,
    { reason: 'the buyer confirmed the quantity' },
    { key: 'idem_ndapi_rdy001' },
  );
  assert.equal(ready.status, 200);
  assert.equal((ready.body as { request: { status: string } }).request.status, 'ready');

  const cancelled = await harness.call(
    'POST',
    `/v1/needs/${requestId}/cancellation`,
    { reason: 'the buyer no longer needs it' },
    { key: 'idem_ndapi_can001' },
  );
  assert.equal(cancelled.status, 200);
  assert.equal((cancelled.body as { request: { status: string } }).request.status, 'cancelled');

  const history = await harness.call('GET', `/v1/needs/${requestId}/history`);
  assert.deepEqual(
    (history.body as { history: { fromStatus: string | null; toStatus: string }[] }).history.map(
      (one) => [one.fromStatus, one.toStatus],
    ),
    [
      [null, 'captured'],
      ['captured', 'ready'],
      ['ready', 'cancelled'],
    ],
  );
});
