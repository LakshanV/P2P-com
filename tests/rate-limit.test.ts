/**
 * Rate limiting: the bucket, the key, and the ways a caller might try to get a fresh one.
 *
 * This is the deployment blocker that sign-in created. Verifying a password costs a scrypt hash at
 * OWASP's interactive parameters — roughly 128 MB and a few hundred milliseconds, deliberately — so
 * an unthrottled endpoint that verifies credentials is both a guessing surface and the cheapest way
 * anybody has to exhaust the server. The property that makes a stolen password table worthless is
 * the property that makes this necessary.
 *
 * Two claims carry the suite.
 *
 * **A bucket refills, and never further than full.** A fixed window would let a caller spend its
 * whole allowance at the end of one window and its whole next allowance at the start of the next —
 * twice the limit, back to back, which is the burst the limit existed to prevent.
 *
 * **A caller cannot choose its own bucket.** Everything an attacker controls — the forwarded-for
 * header, the absence of a session, the route — is checked here, because a limiter whose key the
 * caller picks is not a limiter.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { buildThrottle, throttleFor, VERIFICATION_RULE } from '../apps/api/throttle.ts';
import {
  InMemoryRateLimitStore,
  clientAddress,
  type RateLimitRule,
} from '../platform/http/rate-limit.ts';
import type { HttpRequest, HttpResponse } from '../platform/http/types.ts';

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
import { buildApi } from '../apps/api/app.ts';
import { handleRequest } from '../platform/http/pipeline.ts';
import { identityStack } from './helpers/api-identity.ts';
import { inMemoryTendering } from './helpers/tendering-services.ts';

const NOW = '2026-07-01T09:00:00.000000Z';

const TEN_PER_MINUTE: RateLimitRule = Object.freeze({ burst: 10, refillPerSecond: 1 / 6 });

/** A request with only what the throttle reads. */
function request(headers: Record<string, string> = {}): HttpRequest {
  return {
    method: 'POST',
    path: '/v1/orders',
    headers,
    query: {},
    params: {},
    body: null,
    rawBody: null,
  };
}

// ---------------------------------------------------------------------------
// The bucket
// ---------------------------------------------------------------------------

test('a bucket permits its burst and then refuses', async () => {
  const store = new InMemoryRateLimitStore();
  const at = 1_000_000;

  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const decision = await store.consume('k', TEN_PER_MINUTE, at);
    assert.equal(decision.allowed, true, `attempt ${String(attempt)} was refused`);
    assert.equal(decision.remaining, 10 - attempt);
    assert.equal(decision.limit, 10);
  }

  const refused = await store.consume('k', TEN_PER_MINUTE, at);
  assert.equal(refused.allowed, false);
  assert.equal(refused.remaining, 0);
  assert.equal(refused.retryAfterSeconds, 6, 'one token refills every six seconds');
});

test('a refusal never says to retry immediately', async () => {
  // `Retry-After: 0` invites the retry the refusal was trying to stop, so the floor is one second
  // even when a token is very nearly available.
  const store = new InMemoryRateLimitStore();
  const fast: RateLimitRule = { burst: 1, refillPerSecond: 1000 };

  await store.consume('k', fast, 0);
  const refused = await store.consume('k', fast, 0);

  assert.equal(refused.allowed, false);
  assert.equal(refused.retryAfterSeconds, 1);
});

test('a bucket refills over time, and never past full', async () => {
  const store = new InMemoryRateLimitStore();
  const start = 1_000_000;

  for (let index = 0; index < 10; index += 1) await store.consume('k', TEN_PER_MINUTE, start);
  assert.equal((await store.consume('k', TEN_PER_MINUTE, start)).allowed, false);

  // Twelve seconds: two tokens.
  const first = await store.consume('k', TEN_PER_MINUTE, start + 12_000);
  assert.equal(first.allowed, true);
  const second = await store.consume('k', TEN_PER_MINUTE, start + 12_000);
  assert.equal(second.allowed, true);
  assert.equal((await store.consume('k', TEN_PER_MINUTE, start + 12_000)).allowed, false);

  // An hour of quiet does not bank an hour of requests. Without the clamp, a caller could go away
  // for a day and come back with a day's allowance in one burst, which is the opposite of a limit.
  let allowed = 0;
  for (let index = 0; index < 50; index += 1) {
    if ((await store.consume('k', TEN_PER_MINUTE, start + 3_600_000)).allowed) allowed += 1;
  }
  assert.equal(allowed, 10, 'the bucket refills to its capacity and no further');
});

test('a clock that steps backwards does not drain a bucket', async () => {
  // An NTP correction moves the clock backwards. Elapsed time is clamped at zero rather than going
  // negative, so the worst a backwards step can do is fail to refill.
  const store = new InMemoryRateLimitStore();
  await store.consume('k', TEN_PER_MINUTE, 1_000_000);

  const decision = await store.consume('k', TEN_PER_MINUTE, 900_000);
  assert.equal(decision.allowed, true);
  assert.equal(decision.remaining, 8, 'two spent, none conjured and none destroyed');
});

test('buckets are keyed separately and do not interfere', async () => {
  const store = new InMemoryRateLimitStore();
  for (let index = 0; index < 10; index += 1) await store.consume('a', TEN_PER_MINUTE, 0);

  assert.equal((await store.consume('a', TEN_PER_MINUTE, 0)).allowed, false);
  assert.equal((await store.consume('b', TEN_PER_MINUTE, 0)).allowed, true);
});

test('idle buckets are swept, so the limiter is not itself a memory exhaustion vector', async () => {
  // A limiter keyed by client address is keyed by something an attacker can vary. One that
  // remembered every key it had ever seen would be a defence that hands over a way to exhaust the
  // process — so a bucket nobody has touched for five minutes, which is necessarily full and
  // therefore carries no information, is dropped.
  const store = new InMemoryRateLimitStore();
  for (let index = 0; index < 500; index += 1) {
    await store.consume(`addr:${String(index)}`, TEN_PER_MINUTE, 0);
  }
  assert.equal(store.size(), 500);

  await store.consume('addr:live', TEN_PER_MINUTE, 400_000);
  assert.equal(store.size(), 1, 'only the bucket touched at the later instant survives');
});

// ---------------------------------------------------------------------------
// The key: what a caller can and cannot choose
// ---------------------------------------------------------------------------

test('X-Forwarded-For is ignored unless a proxy has been declared', () => {
  // The defect this prevents is total rather than partial: a caller that could set its own address
  // would put a fresh one in the header on every request and never share a bucket with itself.
  const headers = { 'x-forwarded-for': '203.0.113.9' };

  assert.equal(
    clientAddress(headers, '10.0.0.1', 0),
    '10.0.0.1',
    'with no declared proxy, only the socket is believed',
  );
  assert.equal(clientAddress(headers, '10.0.0.1', 1), '203.0.113.9');
});

test('with a declared proxy, only the hops that proxy wrote are trusted', () => {
  // Left to right: client, then each proxy. With one trusted proxy in front, the rightmost entry is
  // the one our own infrastructure wrote and everything left of it is the caller's invention.
  const headers = { 'x-forwarded-for': 'spoofed-by-the-caller, 198.51.100.7' };

  assert.equal(
    clientAddress(headers, '10.0.0.1', 1),
    '198.51.100.7',
    'the entry our proxy appended, not the one the caller supplied',
  );
});

test('a missing or empty forwarded-for falls back to the socket', () => {
  assert.equal(clientAddress({}, '10.0.0.1', 2), '10.0.0.1');
  assert.equal(clientAddress({ 'x-forwarded-for': '' }, '10.0.0.1', 2), '10.0.0.1');
  assert.equal(clientAddress({}, null, 0), 'unknown', 'a request with no socket still gets a key');
});

test('the session token is hashed into the key and never used as one', async () => {
  // A bucket key is held in memory, written to a durable store, and printed while debugging. A
  // bearer token that reached any of those is a bearer token that has been disclosed.
  const seen: string[] = [];
  const throttle = buildThrottle({
    store: {
      consume: (key, rule, now) => {
        seen.push(key);
        return new InMemoryRateLimitStore().consume(key, rule, now);
      },
    },
    now: () => '2026-07-01T09:00:00.000000Z',
  });

  const token = 'a-secret-session-token-nobody-should-ever-see-in-a-log';
  await throttle(
    request({ authorization: `Bearer ${token}` }),
    {
      method: 'POST',
      path: '/v1/orders',
    },
    '10.0.0.1',
  );

  const key = seen[0] ?? '';
  assert.ok(!key.includes(token), 'the token itself must never appear in a bucket key');
  assert.ok(
    key.includes(createHash('sha256').update(token, 'utf8').digest('hex').slice(0, 32)),
    'the key is derived from the token, so the same session shares one bucket',
  );
});

test('omitting the Authorization header is not a way to opt out of the limit', async () => {
  // If a missing session meant no key, "send no header" would be the loophole — and the requests
  // that arrive without a session are precisely the ones nobody has vouched for.
  const seen: string[] = [];
  const store = new InMemoryRateLimitStore();
  const throttle = buildThrottle({
    store: {
      consume: (key, rule, now) => {
        seen.push(key);
        return store.consume(key, rule, now);
      },
    },
    now: () => '2026-07-01T09:00:00.000000Z',
  });

  await throttle(request(), { method: 'POST', path: '/v1/orders' }, '10.0.0.1');
  assert.ok(seen[0]?.includes('addr:10.0.0.1'), 'it falls back to the address');

  // And a malformed header falls back the same way rather than producing a distinct bucket per
  // malformation, which would be the loophole with extra steps.
  await throttle(
    request({ authorization: 'Bearer' }),
    { method: 'POST', path: '/v1/orders' },
    '10.0.0.1',
  );
  assert.ok(seen[1]?.includes('addr:10.0.0.1'));
});

test('one route’s allowance is not another’s', async () => {
  // A client hammering one endpoint must not spend the allowance it needs to read its own cockpit.
  const seen: string[] = [];
  const throttle = buildThrottle({
    store: {
      consume: (key, rule, now) => {
        seen.push(key);
        return new InMemoryRateLimitStore().consume(key, rule, now);
      },
    },
    now: () => '2026-07-01T09:00:00.000000Z',
  });

  const headers = { authorization: 'Bearer aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' };
  await throttle(request(headers), { method: 'POST', path: '/v1/orders' }, '10.0.0.1');
  await throttle(request(headers), { method: 'GET', path: '/v1/orders/:orderId' }, '10.0.0.1');

  assert.notEqual(seen[0], seen[1]);
  assert.ok(seen[0]?.startsWith('POST /v1/orders|'));
  assert.ok(seen[1]?.startsWith('GET /v1/orders/:orderId|'));
});

// ---------------------------------------------------------------------------
// The policy
// ---------------------------------------------------------------------------

test('health is never limited, and the webhook route is limited by address', () => {
  // A load balancer polls health constantly and must never be refused; refusing it would take the
  // instance out of rotation, which is a self-inflicted outage.
  assert.equal(throttleFor({ method: 'GET', path: '/v1/health' }).rule, null);

  const webhook = throttleFor({
    method: 'POST',
    path: '/v1/payments/webhooks/:provider',
  });
  assert.equal(
    webhook.by,
    'address',
    'a gateway holds no session, so there is nothing else to key it by',
  );
  assert.notEqual(webhook.rule, null);
});

test('writes are limited harder than reads, and both are keyed by session', () => {
  const write = throttleFor({ method: 'POST', path: '/v1/orders' });
  const read = throttleFor({ method: 'GET', path: '/v1/orders/:orderId' });

  assert.equal(write.by, 'session');
  assert.equal(read.by, 'session');
  assert.ok(
    (write.rule?.refillPerSecond ?? 0) < (read.rule?.refillPerSecond ?? 0),
    'a write costs something irreversible; a read does not',
  );
});

test('the verification rule is strict enough to make online guessing pointless', () => {
  // Ten tries, then one every six seconds: six hundred attempts a day against one account. A
  // wordlist is not a wordlist at that rate. It is also the cap on how much scrypt work one caller
  // can make the server do, which is the half of this that is about availability rather than
  // secrecy.
  assert.equal(VERIFICATION_RULE.burst, 10);
  assert.ok(VERIFICATION_RULE.refillPerSecond <= 1 / 6);

  const perHour = VERIFICATION_RULE.refillPerSecond * 3600;
  assert.ok(perHour <= 600, `${String(perHour)} attempts an hour is too many for a password`);
});

test('an unknown route gets its method’s limit rather than no limit', () => {
  // The default matters more than any entry in the table. A route added next week is limited by
  // what its method costs, so forgetting to think about a new route fails safe.
  const invented = throttleFor({ method: 'POST', path: '/v1/something-added-later' });
  assert.notEqual(invented.rule, null);
  assert.equal(invented.by, 'session');
});

// ---------------------------------------------------------------------------
// Through the pipeline
// ---------------------------------------------------------------------------

test('a throttled caller gets a 429 with the headers needed to back off', async () => {
  const identity = await identityStack(NOW);
  const caller = await identity.register({ handle: 'throttled', roles: ['CUSTOMER'] });

  const orders = new OrderService(new InMemoryOrderRepository());
  const payments = new PaymentService(new InMemoryPaymentRepository(), resolveMockProvider);
  const journal = new LedgerService(new InMemoryLedgerRepository());
  const ledger = new FinancialLedgerService(
    new InMemoryFinancialLedgerRepository(),
    new K10LedgerPort(journal),
  );

  let authorisations = 0;
  const api = buildApi({
    services: {
      orders,
      payments,
      ledger,
      listings: new UniversalListingService(new InMemoryUniversalListingRepository()),
      needs: new CommerceRequestService(new InMemoryCommerceRequestRepository()),
      ...inMemoryTendering(),
      cockpit: new UserCockpitService({ orders, payments, ledger, journal }),
    },
    access: {
      ...identity,
      permissions: new Proxy(identity.permissions, {
        get(target, property, receiver) {
          if (property === 'authorize') {
            return async (...args: Parameters<typeof target.authorize>) => {
              authorisations += 1;
              return target.authorize(...args);
            };
          }
          return Reflect.get(target, property, receiver) as unknown;
        },
      }),
    },
    throttle: { store: new InMemoryRateLimitStore(), now: () => NOW },
    clock: () => NOW,
  });

  const send = (index: number): Promise<HttpResponse> =>
    handleRequest(api, {
      method: 'GET',
      target: '/v1/routes',
      headers: {
        authorization: `Bearer ${caller.token}`,
        'x-correlation-id': `corr_01HR0RATE${String(index).padStart(5, '0')}`,
      },
      body: null,
      socketAddress: '10.0.0.1',
    });

  // The read rule is 120 at once. The clock is pinned, so nothing refills.
  for (let index = 0; index < 120; index += 1) {
    const response = await send(index);
    assert.equal(response.status, 200, `request ${String(index)} was refused early`);
  }
  const authorisedBefore = authorisations;

  const refused = await send(120);
  assert.equal(refused.status, 429);
  assert.equal((refused.body as { code: string }).code, 'rate-limited');
  assert.equal(refused.headers['retry-after'], '1');
  assert.equal(refused.headers['x-ratelimit-limit'], '120');
  assert.equal(refused.headers['x-ratelimit-remaining'], '0');
  assert.ok(
    refused.headers['x-correlation-id'] !== undefined,
    'a refusal a client will report must still be traceable',
  );

  assert.equal(
    authorisations,
    authorisedBefore,
    'a throttled request must not reach authorisation. Authorising costs a session validation, an ' +
      'account lookup and a grant evaluation, and a caller being throttled is exactly the caller ' +
      'that must not be able to make the server do that work',
  );
});

test('a throttled caller does not consume another caller’s allowance', async () => {
  const identity = await identityStack(NOW);
  const heavy = await identity.register({ handle: 'heavy', roles: ['CUSTOMER'] });
  const quiet = await identity.register({ handle: 'quiet', roles: ['CUSTOMER'] });

  const orders = new OrderService(new InMemoryOrderRepository());
  const payments = new PaymentService(new InMemoryPaymentRepository(), resolveMockProvider);
  const journal = new LedgerService(new InMemoryLedgerRepository());
  const ledger = new FinancialLedgerService(
    new InMemoryFinancialLedgerRepository(),
    new K10LedgerPort(journal),
  );

  const api = buildApi({
    services: {
      orders,
      payments,
      ledger,
      listings: new UniversalListingService(new InMemoryUniversalListingRepository()),
      needs: new CommerceRequestService(new InMemoryCommerceRequestRepository()),
      ...inMemoryTendering(),
      cockpit: new UserCockpitService({ orders, payments, ledger, journal }),
    },
    access: identity,
    throttle: { store: new InMemoryRateLimitStore(), now: () => NOW },
    clock: () => NOW,
  });

  const send = (token: string, index: number): Promise<HttpResponse> =>
    handleRequest(api, {
      method: 'GET',
      target: '/v1/routes',
      headers: {
        authorization: `Bearer ${token}`,
        'x-correlation-id': `corr_01HR0SHARE${String(index).padStart(4, '0')}`,
      },
      body: null,
      // The same address on purpose: two customers behind one office gateway must not share a
      // bucket, or one of them takes the other offline by working hard.
      socketAddress: '10.0.0.1',
    });

  for (let index = 0; index < 121; index += 1) await send(heavy.token, index);
  assert.equal((await send(heavy.token, 500)).status, 429, 'the heavy caller is throttled');
  assert.equal(
    (await send(quiet.token, 501)).status,
    200,
    'and the quiet one, on the same address, is not',
  );
});
