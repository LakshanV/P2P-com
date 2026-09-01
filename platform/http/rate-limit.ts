/**
 * Rate limiting: how often one caller may ask.
 *
 * This became urgent the moment sign-in started working, and for two reasons that pull in opposite
 * directions. Sign-in is where credentials are guessed, so it must be throttled hard. And sign-in
 * verifies a scrypt hash at OWASP's interactive parameters — roughly 128 MB and a few hundred
 * milliseconds *by design* — so an unthrottled login endpoint is also the cheapest way anybody has
 * to exhaust the server, using requests that look entirely legitimate. The expensive password
 * hashing that makes a stolen table worthless is the same property that makes this necessary.
 *
 * **A token bucket, not a fixed window.** A fixed window lets a caller spend its whole allowance at
 * 11:59:59 and its whole next allowance at 12:00:00 — twice the limit, back to back, which is
 * exactly the burst the limit existed to prevent. A bucket refills continuously, so the worst case
 * is the bucket's own capacity.
 *
 * **`now` is injected, like everywhere else in this repository.** A limiter that read the wall clock
 * would need a test that sleeps, and a test that sleeps is a test somebody makes shorter until it
 * is a test of nothing.
 *
 * **The store is a port.** The one that ships holds buckets in a `Map`, which is correct for a
 * single process and honestly wrong for two: each instance would enforce the limit separately, so
 * two instances would permit twice as much. That is acceptable while one process serves the
 * platform and stops being acceptable the moment a second one starts — which is a deployment
 * decision, and belongs in a note somebody reads before scaling rather than in a silent behaviour
 * change.
 *
 * Owned by: platform substrate.
 */

/** What a limiter decided about one request. */
export interface RateLimitDecision {
  readonly allowed: boolean;
  /** Requests still available in this bucket, floored at zero. Reported to the client. */
  readonly remaining: number;
  /** Whole seconds until one more request would be permitted. Zero when the request was allowed. */
  readonly retryAfterSeconds: number;
  /** The bucket's capacity, so a client can see what it is being held to. */
  readonly limit: number;
}

/** One rule: a capacity, and how fast it refills. */
export interface RateLimitRule {
  /** The most requests that can be made at once, from a full bucket. */
  readonly burst: number;
  /** The sustained rate, per second. Fractional values are the point: 0.2 is one every five seconds. */
  readonly refillPerSecond: number;
}

/**
 * Where buckets live.
 *
 * `consume` is one operation rather than a read and a write, because a limiter split into two
 * round trips is a limiter two concurrent requests can both pass. A durable implementation must do
 * the same thing in one statement.
 */
export interface RateLimitStore {
  consume(key: string, rule: RateLimitRule, nowMillis: number): Promise<RateLimitDecision>;
}

interface Bucket {
  /** Tokens available, fractional. */
  tokens: number;
  /** When `tokens` was last correct. */
  atMillis: number;
}

/**
 * Buckets in memory, for a single process.
 *
 * Idle buckets are swept rather than kept for ever: a limiter keyed by client address is keyed by
 * something an attacker can vary, so an implementation that remembered every key it had ever seen
 * would be a memory exhaustion vector wearing the costume of a defence. A bucket that has been full
 * for longer than it takes to refill carries no information — it is indistinguishable from a caller
 * nobody has seen — so dropping it is free.
 */
export class InMemoryRateLimitStore implements RateLimitStore {
  readonly #buckets = new Map<string, Bucket>();
  readonly #maximumKeys: number;
  #lastSweepMillis = 0;

  constructor(maximumKeys = 100_000) {
    this.#maximumKeys = maximumKeys;
  }

  consume(key: string, rule: RateLimitRule, nowMillis: number): Promise<RateLimitDecision> {
    this.#sweep(nowMillis);

    const existing = this.#buckets.get(key);
    const bucket: Bucket = existing ?? { tokens: rule.burst, atMillis: nowMillis };

    if (existing !== undefined) {
      // Refill for the time that has passed. Clamped at zero so a clock that steps backwards — an
      // NTP correction, say — cannot drain a bucket rather than leaving it alone.
      const elapsedSeconds = Math.max(0, (nowMillis - bucket.atMillis) / 1000);
      bucket.tokens = Math.min(rule.burst, bucket.tokens + elapsedSeconds * rule.refillPerSecond);
      bucket.atMillis = nowMillis;
    }

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      this.#buckets.set(key, bucket);
      return Promise.resolve({
        allowed: true,
        remaining: Math.floor(bucket.tokens),
        retryAfterSeconds: 0,
        limit: rule.burst,
      });
    }

    this.#buckets.set(key, bucket);
    const needed = 1 - bucket.tokens;
    return Promise.resolve({
      allowed: false,
      remaining: 0,
      // Rounded **up**, and never below one: a `Retry-After: 0` invites an immediate retry, which
      // is the behaviour the refusal was trying to stop.
      retryAfterSeconds: Math.max(1, Math.ceil(needed / rule.refillPerSecond)),
      limit: rule.burst,
    });
  }

  /** How many buckets are held. For a test that asserts on the sweep rather than around it. */
  size(): number {
    return this.#buckets.size;
  }

  #sweep(nowMillis: number): void {
    // At most once a minute, and immediately if the map has grown past its bound. The bound is a
    // backstop: without it a flood of distinct keys could outrun the interval.
    const overdue = nowMillis - this.#lastSweepMillis >= 60_000;
    if (!overdue && this.#buckets.size <= this.#maximumKeys) return;
    this.#lastSweepMillis = nowMillis;

    for (const [key, bucket] of this.#buckets) {
      // Five minutes of not being touched. Any rule this platform sets refills fully in far less,
      // so such a bucket is already full and holding it changes no decision.
      if (nowMillis - bucket.atMillis > 300_000) this.#buckets.delete(key);
    }
  }
}

/**
 * The client's address, as far as it can be trusted.
 *
 * `X-Forwarded-For` is written by whatever spoke to the proxy, which in a request that reaches the
 * port directly is the attacker. Honouring it unconditionally does not merely fail to help — it
 * removes the limit entirely, because a caller can put a fresh address in the header on every
 * request and never share a bucket with itself.
 *
 * So the header is read only when the deployment declares how many proxies sit in front, and only
 * that many entries are skipped from the right. A deployment behind no proxy declares zero and the
 * header is ignored, which is the safe default and the one a developer running locally gets.
 */
export function clientAddress(
  headers: Readonly<Record<string, string>>,
  socketAddress: string | null,
  trustedProxyCount: number,
): string {
  if (trustedProxyCount <= 0) return socketAddress ?? 'unknown';

  const forwarded = headers['x-forwarded-for'];
  if (forwarded === undefined || forwarded === '') return socketAddress ?? 'unknown';

  // Left to right is client, then each proxy in turn. The rightmost `trustedProxyCount` entries
  // were written by infrastructure this deployment controls; anything further left was written by
  // somebody it does not.
  const hops = forwarded
    .split(',')
    .map((hop) => hop.trim())
    .filter((hop) => hop !== '');

  const index = hops.length - trustedProxyCount;
  return hops[index] ?? socketAddress ?? 'unknown';
}
