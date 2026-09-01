/**
 * How hard each route is throttled, and what the bucket is keyed by.
 *
 * The substrate owns the mechanism — a token bucket, a store, a decision. This file owns the
 * judgement: which routes deserve which limit, and *whose* allowance is being spent.
 *
 * **The key is the interesting decision, not the number.**
 *
 * An authenticated request is keyed by the caller's session, because that is what actually
 * identifies who is asking. Keying an authenticated request by address would punish an office
 * behind one NAT gateway for having many customers, and would let one customer with many addresses
 * escape entirely.
 *
 * A request that has not authenticated yet — sign-in, above all — can only be keyed by the address
 * the socket came from, because there is nothing else. That is a blunt instrument: it shares a
 * bucket between everybody behind one gateway. It is used anyway, because the alternative for an
 * unauthenticated endpoint is no limit at all, and it is set generously enough that ordinary
 * shared-address use does not trip it while a credential-stuffing run does.
 *
 * **The session token is hashed into the key, never used as one.** A bucket key ends up in memory,
 * in a durable store, and eventually in somebody's debugging output. A bearer token that reached any
 * of those is a bearer token that has been disclosed.
 *
 * **Writes are limited harder than reads**, because a write is what costs something irreversible.
 * And the routes that verify a proof — sign-in, and anything that will join it — are limited hardest
 * of all, because each attempt costs the server a deliberately expensive scrypt hash.
 *
 * Owned by: apps/api.
 */

import { createHash } from 'node:crypto';

import type { MatchedRoute } from '../../platform/http/pipeline.ts';
import {
  clientAddress,
  type RateLimitDecision,
  type RateLimitRule,
  type RateLimitStore,
} from '../../platform/http/rate-limit.ts';
import type { HttpRequest } from '../../platform/http/types.ts';

/**
 * Verifying a proof: the hardest limit in the platform.
 *
 * Ten attempts, refilling at one every six seconds. A person who mistypes their password four times
 * running notices nothing. A script trying a wordlist gets ten tries and then ten an hour, which
 * makes an online guessing attack pointless — and, just as importantly, caps how much scrypt work
 * one caller can make the server do.
 */
const VERIFICATION: RateLimitRule = Object.freeze({ burst: 10, refillPerSecond: 1 / 6 });

/**
 * Writes. Thirty at once, then two a second sustained.
 *
 * Set from what a person doing real work looks like: filling an order with a dozen lines, retrying
 * a payment, correcting something. Nothing a human does through a screen approaches it; a loop
 * does immediately.
 */
const WRITE: RateLimitRule = Object.freeze({ burst: 30, refillPerSecond: 2 });

/** Reads. Loose, because a cockpit legitimately fans out across several sections at once. */
const READ: RateLimitRule = Object.freeze({ burst: 120, refillPerSecond: 10 });

/**
 * Provider deliveries, keyed by address.
 *
 * A gateway retrying a backlog is a legitimate burst, so this is wide. It exists so that an
 * unauthenticated route — which this one is, because a gateway holds no session — cannot be used to
 * make the server verify signatures indefinitely.
 */
const WEBHOOK: RateLimitRule = Object.freeze({ burst: 200, refillPerSecond: 20 });

/** Health. Deliberately unlimited: a load balancer polls it constantly and must never be refused. */
const UNLIMITED = null;

type Keying = 'session' | 'address';

interface Throttle {
  readonly rule: RateLimitRule | null;
  readonly by: Keying;
}

/**
 * Which limit applies to which shape of route.
 *
 * Keyed by method rather than enumerated route by route, with named exceptions. An exhaustive table
 * like `ACCESS_POLICY` is right for access — every route needs its own deliberate answer to "who may
 * call this" — and wrong here: a limit is a property of what a request *costs*, and a route added
 * next week costs what its method costs. A default of "no limit" would be the dangerous choice; the
 * default here is the limit for its method.
 */
const EXCEPTIONS: Readonly<Record<string, Throttle>> = Object.freeze({
  'GET /v1/health': { rule: UNLIMITED, by: 'address' },
  'POST /v1/payments/webhooks/:provider': { rule: WEBHOOK, by: 'address' },
  // Anything that verifies a proof belongs here. Sign-in has no route yet — registration and
  // authentication are still driven through K-02 directly — so this entry is a placeholder that the
  // test below pins, rather than a rule for a route that exists.
});

const WRITE_METHODS: readonly string[] = ['POST', 'PUT', 'PATCH', 'DELETE'];

/** The rule for a route, and what its bucket is keyed by. */
export function throttleFor(route: MatchedRoute): Throttle {
  const exception = EXCEPTIONS[`${route.method} ${route.path}`];
  if (exception !== undefined) return exception;
  return {
    rule: WRITE_METHODS.includes(route.method) ? WRITE : READ,
    by: 'session',
  };
}

/** The limit applied to a route that verifies a credential. Exported so a sign-in route can use it. */
export const VERIFICATION_RULE = VERIFICATION;

export interface ThrottleOptions {
  readonly store: RateLimitStore;
  /** "Now", from the same clock the rest of the application uses. */
  readonly now: () => string;
  /**
   * How many proxies sit in front of this process.
   *
   * Zero — the default — means `X-Forwarded-For` is ignored entirely, which is right for a process
   * reachable directly and right for a developer running it locally. Setting it wrongly high is the
   * failure mode to fear: it lets a caller pick its own bucket by writing the header, which removes
   * the limit rather than loosening it.
   */
  readonly trustedProxyCount?: number;
}

const ALLOWED_UNLIMITED: RateLimitDecision = Object.freeze({
  allowed: true,
  remaining: Number.MAX_SAFE_INTEGER,
  retryAfterSeconds: 0,
  limit: Number.MAX_SAFE_INTEGER,
});

/**
 * The pipeline's rate-limit hook.
 *
 * A request whose session cannot be read — no header, or a malformed one — falls back to its
 * address. It must: otherwise "send no `Authorization` header" would be a way to opt out of the
 * limit, and the requests that arrive without a session are exactly the ones nobody has vouched for
 * yet.
 */
export function buildThrottle(
  options: ThrottleOptions,
): (
  request: HttpRequest,
  route: MatchedRoute,
  socketAddress: string | null,
) => Promise<RateLimitDecision> {
  const trusted = options.trustedProxyCount ?? 0;

  return (request, route, socketAddress) => {
    const throttle = throttleFor(route);
    if (throttle.rule === null) return Promise.resolve(ALLOWED_UNLIMITED);

    const address = clientAddress(request.headers, socketAddress, trusted);
    const key =
      throttle.by === 'session'
        ? (sessionKey(request.headers.authorization) ?? `addr:${address}`)
        : `addr:${address}`;

    const millis = Date.parse(options.now());
    return options.store.consume(
      // The route is part of the key, so a client hammering one endpoint does not spend the
      // allowance it needs to read its own cockpit.
      `${route.method} ${route.path}|${key}`,
      throttle.rule,
      Number.isNaN(millis) ? 0 : millis,
    );
  };
}

/**
 * A stable, non-reversible handle for a session, from its bearer token.
 *
 * SHA-256, truncated. The token itself must never become a key: keys are held in memory, written to
 * durable stores, and printed while debugging, and a bearer token that reaches any of those is
 * disclosed. Truncation is safe here because a collision costs two callers a shared allowance, not
 * a shared identity.
 */
function sessionKey(header: string | undefined): string | null {
  if (header === undefined) return null;
  const match = /^Bearer (\S+)$/.exec(header);
  const token = match?.[1];
  if (token === undefined) return null;
  return `sess:${createHash('sha256').update(token, 'utf8').digest('hex').slice(0, 32)}`;
}
