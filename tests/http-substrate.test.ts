/**
 * The HTTP substrate: routing, the request pipeline, problem responses and the request context.
 *
 * Everything here is a function from a request object to a response object, so the suite never binds
 * a port and never waits for a socket. That is the point of the shape.
 *
 * Three properties are worth stating before the tests.
 *
 * **A path that exists under another method answers 405, not 404.** The difference matters to a
 * client: 404 says stop asking, 405 says ask differently.
 *
 * **An unclassified exception tells the caller nothing.** A driver error names tables, constraints
 * and sometimes values; it belongs in a log, not in a response to a stranger.
 *
 * **The context is the only nondeterminism.** Every module below refuses to read a clock, which is
 * what makes their suites exact — so the request context is where the clock and the random generator
 * live, and injecting it makes even the API deterministic under test.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { assertOpaqueIdentifier } from '../kernel/identity/index.ts';
import { deriveId, nowInstant, randomId, requestContext } from '../platform/http/context.ts';
import {
  handleRequest,
  type DescribeError,
  type RequestRecord,
} from '../platform/http/pipeline.ts';
import { problem } from '../platform/http/problem.ts';
import { Router, splitTarget } from '../platform/http/router.ts';
import { json, noContent, type HttpRequest, type HttpResponse } from '../platform/http/types.ts';

const CORRELATION = 'corr_01HR0HTTP0001';

/** K-01's rule, as the application wires it in. */
const validate = (candidate: string): void => {
  assertOpaqueIdentifier(candidate, 'identifier');
};

function ok(body: unknown): (request: HttpRequest) => Promise<HttpResponse> {
  return () => Promise.resolve(json(200, body));
}

function pipeline(
  router: Router,
  describe: DescribeError = () => null,
  observe?: (record: RequestRecord) => void,
) {
  return {
    router,
    describe,
    correlationFor: () => CORRELATION,
    ...(observe === undefined ? {} : { observe }),
  };
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

test('a route matches its own shape and binds its parameters', () => {
  const router = new Router()
    .add({ method: 'GET', path: '/orders/:orderId', handler: ok({}), summary: 'read an order' })
    .add({
      method: 'GET',
      path: '/orders/:orderId/items',
      handler: ok({}),
      summary: 'list order items',
    });

  const matched = router.match('GET', '/orders/ord_123/items');
  assert.equal(matched.kind, 'matched');
  assert.deepEqual(matched.params, { orderId: 'ord_123' });

  const single = router.match('GET', '/orders/ord_123');
  assert.equal(single.kind, 'matched');
  assert.deepEqual(single.params, { orderId: 'ord_123' });
});

test('a path that exists under another method is 405, not 404', () => {
  const router = new Router()
    .add({ method: 'POST', path: '/orders', handler: ok({}), summary: 'create' })
    .add({ method: 'GET', path: '/orders', handler: ok({}), summary: 'list' });

  const wrongMethod = router.match('DELETE', '/orders');
  assert.equal(wrongMethod.kind, 'method-not-allowed');
  assert.deepEqual([...(wrongMethod.allowed ?? [])].sort(), ['GET', 'POST']);

  assert.equal(router.match('GET', '/nowhere').kind, 'not-found');
});

test('two routes claiming one method and path are refused at registration', () => {
  const router = new Router().add({
    method: 'GET',
    path: '/orders/:id',
    handler: ok({}),
    summary: 'first',
  });

  assert.throws(
    () => router.add({ method: 'GET', path: '/orders/:other', handler: ok({}), summary: 'second' }),
    /would never be reached/,
    'which of two identical routes wins should not be an accident of declaration order',
  );
});

test('an empty path segment does not match a parameter', () => {
  const router = new Router().add({
    method: 'GET',
    path: '/orders/:orderId',
    handler: ok({}),
    summary: 'read',
  });

  assert.equal(
    router.match('GET', '/orders/').kind,
    'not-found',
    'an empty parameter names nothing, and passing "" to a module would produce a worse message',
  );
});

test('a parameter is URL-decoded', () => {
  const router = new Router().add({
    method: 'GET',
    path: '/accounts/:id',
    handler: ok({}),
    summary: 'read',
  });
  const matched = router.match('GET', '/accounts/acct%3A123');
  assert.deepEqual(matched.params, { id: 'acct:123' });
});

test('a query string is split from the path and decoded', () => {
  assert.deepEqual(splitTarget('/orders'), { path: '/orders', query: {} });
  assert.deepEqual(splitTarget('/orders?status=placed&limit=10'), {
    path: '/orders',
    query: { status: 'placed', limit: '10' },
  });
  assert.deepEqual(splitTarget('/search?q=two+words'), {
    path: '/search',
    query: { q: 'two words' },
  });
  assert.deepEqual(
    splitTarget('/orders?flag'),
    { path: '/orders', query: { flag: '' } },
    'a bare key is present with an empty value, which is what a client meant by sending it',
  );
});

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

test('a handled request carries the correlation id, whatever the outcome', async () => {
  const router = new Router().add({
    method: 'GET',
    path: '/health',
    handler: ok({ status: 'ok' }),
    summary: 'health',
  });

  const good = await handleRequest(pipeline(router), {
    method: 'GET',
    target: '/health',
    headers: {},
    body: null,
  });
  assert.equal(good.status, 200);
  assert.equal(good.headers['x-correlation-id'], CORRELATION);

  const missing = await handleRequest(pipeline(router), {
    method: 'GET',
    target: '/nowhere',
    headers: {},
    body: null,
  });
  assert.equal(missing.status, 404);
  assert.equal(
    missing.headers['x-correlation-id'],
    CORRELATION,
    'a client who can quote one thing when something breaks should be able to quote it always',
  );
});

test('a body that is not JSON is refused without echoing it back', async () => {
  const router = new Router().add({
    method: 'POST',
    path: '/orders',
    handler: ok({}),
    summary: 'create',
  });

  const response = await handleRequest(pipeline(router), {
    method: 'POST',
    target: '/orders',
    headers: { 'content-type': 'application/json' },
    body: '{"unclosed":',
  });

  assert.equal(response.status, 400);
  const body = response.body as { code: string; detail: string };
  assert.equal(body.code, 'malformed-json');
  assert.equal(
    body.detail,
    'The request body is not valid JSON.',
    'the parser message names an offset and sometimes echoes the payload; neither helps a caller',
  );
});

test('a body without a JSON content type is refused', async () => {
  const router = new Router().add({
    method: 'POST',
    path: '/orders',
    handler: ok({}),
    summary: 'create',
  });

  const response = await handleRequest(pipeline(router), {
    method: 'POST',
    target: '/orders',
    headers: { 'content-type': 'text/plain' },
    body: '{"a":1}',
  });

  assert.equal(response.status, 415);
  assert.equal((response.body as { code: string }).code, 'unsupported-media-type');
});

test('a body over the limit is refused before a handler sees it', async () => {
  let reached = false;
  const router = new Router().add({
    method: 'POST',
    path: '/orders',
    handler: () => {
      reached = true;
      return Promise.resolve(json(200, {}));
    },
    summary: 'create',
  });

  const response = await handleRequest(
    { ...pipeline(router), maxBodyBytes: 16 },
    {
      method: 'POST',
      target: '/orders',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ padding: 'x'.repeat(100) }),
    },
  );

  assert.equal(response.status, 413);
  assert.equal(reached, false);
});

test('a described refusal keeps its code, so a client can branch on it', async () => {
  // Written out rather than as a parameter property: this repository strips types rather than
  // compiling them, so `constructor(readonly code: string)` is not runnable syntax.
  class ModuleError extends Error {
    readonly code: string;

    constructor(code: string) {
      super(`refused: ${code}`);
      this.code = code;
    }
  }

  const router = new Router().add({
    method: 'POST',
    path: '/orders',
    handler: () => Promise.reject(new ModuleError('illegal-transition')),
    summary: 'create',
  });

  const describe: DescribeError = (error) =>
    error instanceof ModuleError ? { status: 409, code: error.code, detail: error.message } : null;

  const response = await handleRequest(pipeline(router, describe), {
    method: 'POST',
    target: '/orders',
    headers: {},
    body: null,
  });

  assert.equal(response.status, 409);
  const body = response.body as { code: string; type: string; detail: string };
  assert.equal(body.code, 'illegal-transition');
  assert.equal(body.type, 'https://jaya.lk/problems/illegal-transition');
  assert.match(body.detail, /illegal-transition/);
  assert.equal(response.headers['content-type'], 'application/problem+json');
});

test('an unclassified exception tells the caller nothing and the observer everything', async () => {
  const secret = new Error(
    'duplicate key value violates unique constraint "payment_idempotency_unique" ' +
      'DETAIL: Key (idempotency_key)=(idem_customer_42) already exists.',
  );
  const router = new Router().add({
    method: 'POST',
    path: '/orders',
    handler: () => Promise.reject(secret),
    summary: 'create',
  });

  const seen: RequestRecord[] = [];
  const response = await handleRequest(
    pipeline(
      router,
      () => null,
      (r) => seen.push(r),
    ),
    {
      method: 'POST',
      target: '/orders',
      headers: {},
      body: null,
    },
  );

  assert.equal(response.status, 500);
  const body = response.body as { detail: string; code: string };
  assert.equal(body.code, 'internal-error');
  assert.ok(
    !body.detail.includes('idem_customer_42') && !body.detail.includes('constraint'),
    'a driver error names tables, constraints and sometimes values; none of it is a stranger’s business',
  );
  assert.equal(
    seen[0]?.unclassified,
    secret,
    'the whole error reaches the observer, because that is where it can be logged and fixed',
  );
});

test('every request is observed, with its status and its refusal code', async () => {
  const router = new Router().add({
    method: 'GET',
    path: '/orders/:id',
    handler: ok({}),
    summary: 'read',
  });

  const seen: RequestRecord[] = [];
  const options = pipeline(
    router,
    () => null,
    (record) => seen.push(record),
  );

  await handleRequest(options, { method: 'GET', target: '/orders/ord_1', headers: {}, body: null });
  await handleRequest(options, { method: 'GET', target: '/missing', headers: {}, body: null });

  assert.deepEqual(
    seen.map((record) => [record.status, record.code]),
    [
      [200, null],
      [404, 'no-such-route'],
    ],
  );
  assert.equal(seen[0]?.path, '/orders/ord_1');
});

test('a method the API does not implement at all is refused', async () => {
  const router = new Router().add({
    method: 'GET',
    path: '/orders',
    handler: ok({}),
    summary: 'list',
  });

  const response = await handleRequest(pipeline(router), {
    method: 'TRACE',
    target: '/orders',
    headers: {},
    body: null,
  });

  assert.equal(response.status, 405);
  assert.equal((response.body as { code: string }).code, 'method-not-supported');
});

test('a 405 tells the client what it could have used', async () => {
  const router = new Router()
    .add({ method: 'GET', path: '/orders', handler: ok({}), summary: 'list' })
    .add({ method: 'POST', path: '/orders', handler: ok({}), summary: 'create' });

  const response = await handleRequest(pipeline(router), {
    method: 'DELETE',
    target: '/orders',
    headers: {},
    body: null,
  });

  assert.equal(response.status, 405);
  assert.match(String(response.headers.allow), /GET/);
  assert.match(String(response.headers.allow), /POST/);
});

test('a 204 carries no body', () => {
  const response = noContent();
  assert.equal(response.status, 204);
  assert.equal(response.body, null);
});

// ---------------------------------------------------------------------------
// Problem details
// ---------------------------------------------------------------------------

test('a problem response carries the code, the correlation id and a resolvable type', () => {
  const response = problem({
    status: 422,
    code: 'allocation-mismatch',
    detail: 'the legs are worth 900 against an obligation of 1000',
    correlationId: CORRELATION,
    errors: { 'legs[0].amountMinor': 'too small' },
  });

  const body = response.body as Record<string, unknown>;
  assert.equal(body.status, 422);
  assert.equal(body.title, 'Unprocessable Content');
  assert.equal(body.code, 'allocation-mismatch');
  assert.equal(body.correlationId, CORRELATION);
  assert.deepEqual(body.errors, { 'legs[0].amountMinor': 'too small' });
});

// ---------------------------------------------------------------------------
// The request context
// ---------------------------------------------------------------------------

test('a generated identifier satisfies the rule every module applies', () => {
  // Not a formality: the opacity rule refuses any run of twelve digits, because that is what a card
  // number looks like, and a base32 string of random bytes produces one eventually.
  for (let index = 0; index < 500; index += 1) {
    const id = randomId('ord', { validate });
    assertOpaqueIdentifier(id, 'generated id');
    assert.match(id, /^ord_/);
  }
});

test('a generator that keeps producing refused ids fails loudly rather than spinning', () => {
  assert.throws(
    () =>
      randomId('ord', {
        bytes: () => new Uint8Array(12),
        validate: () => {
          throw new Error('never acceptable');
        },
      }),
    /8 attempts/,
  );
});

test('a derived identifier is stable for a key and different across keys', () => {
  const first = deriveId('ord', 'order', 'idem_customer_1', validate);
  const again = deriveId('ord', 'order', 'idem_customer_1', validate);
  const other = deriveId('ord', 'order', 'idem_customer_2', validate);
  const otherKind = deriveId('ord', 'snapshot', 'idem_customer_1', validate);

  assert.equal(first, again, 'a retry must address the record the first attempt created');
  assert.notEqual(first, other);
  assert.notEqual(
    first,
    otherKind,
    'one request creates several records; they must not collide with each other',
  );
  assertOpaqueIdentifier(first, 'derived id');
});

test('the context derives from the caller’s idempotency key', () => {
  const context = requestContext({
    correlationId: CORRELATION,
    idempotencyKey: 'idem_customer_7',
    now: '2026-07-01T09:00:00.000000Z',
    validate,
  });

  assert.equal(context.now, '2026-07-01T09:00:00.000000Z');
  assert.equal(context.derivedId('ord', 'order'), context.derivedId('ord', 'order'));
  assert.notEqual(context.newId('ord'), context.newId('ord'), 'a fresh id is fresh each time');
});

test('the instant the context reads is one every validator accepts', () => {
  const instant = nowInstant(() => Date.parse('2026-07-01T09:00:00.123Z'));
  assert.equal(
    instant,
    '2026-07-01T09:00:00.123000Z',
    'toISOString gives milliseconds; the platform’s instants are microsecond-capable, and a ' +
      'consistent width is what lets a stored row be compared with a fresh one',
  );
});
