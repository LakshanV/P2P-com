/**
 * Turning a response body into something JSON can carry.
 *
 * Every amount in this platform is a `bigint`, because a double cannot hold an exact number of
 * minor units above 2^53. `JSON.stringify` **throws** on a `bigint` — it does not round it, it
 * refuses — so a response carrying an order total would have failed at the point of serialisation,
 * after the work was done and committed. The client would have seen a 500 for a request that
 * succeeded.
 *
 * So every `bigint` becomes its decimal string, which is the same convention the outbox events and
 * the request readers already use: amounts cross the wire as strings, in both directions, and a
 * consumer that parses one into a double has made a choice rather than inherited a rounding.
 *
 * The conversion happens in the pipeline rather than in the socket adapter, so a test that calls the
 * pipeline sees exactly the representation a client sees. A conversion that happened one layer lower
 * would leave every suite asserting against a shape no client ever receives.
 *
 * Owned by: platform substrate.
 */

/**
 * A structure with every `bigint` replaced by its decimal string.
 *
 * Recurses through arrays and plain objects. A `Date` would be a bug in this platform — instants are
 * strings everywhere — so it is left alone to fail visibly rather than being quietly formatted.
 */
export function toJsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(toJsonSafe);

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = toJsonSafe(entry);
  }
  return out;
}
