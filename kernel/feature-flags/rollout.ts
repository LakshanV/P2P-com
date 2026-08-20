/**
 * K-07 Feature Flags — deterministic percentage bucketing (FND-004e).
 *
 * A percentage rollout has to be **stable**: the same subject must get the same answer on every
 * request, on every process, after every restart, or a user watches a feature appear and vanish
 * as their requests land on different machines. That rules out randomness, and it rules out
 * anything derived from a process, a time or a request id.
 *
 * So the bucket is a pure hash of three things:
 *
 *   - the **flag key**, so two flags at 10% do not select the same tenth of the population — which
 *     would mean the 10% who got the first risky feature are exactly the 10% who get the second;
 *   - the **rollout salt** from the version, so an operator who wants a genuinely fresh draw can
 *     publish a new version with a new salt rather than hoping a hash moves;
 *   - the **subject key**, which is an opaque handle and never a name, an email or a device id.
 *
 * The subject key is hashed, not stored — but "hashed" is not "anonymous" when the input space is
 * small, so `registry.ts` refuses natural and PII-shaped keys before they reach this file rather
 * than relying on the hash to hide them.
 *
 * Ten thousand buckets, so a whole percent is exactly one hundred of them and the boundary
 * arithmetic is exact: at 0% nothing is included, at 100% everything is, and no bucket is on both
 * sides of a threshold.
 *
 * Owned by: K-07 Feature Flags.
 */

import { createHash } from 'node:crypto';

export const BUCKET_COUNT = 10_000;

/**
 * The bucket a subject falls in for one flag version: an integer in [0, 10000).
 *
 * Uses the first four bytes of SHA-256 as an unsigned big-endian integer, taken modulo the bucket
 * count. The modulo bias over 2^32 against 10^4 is smaller than one part in four hundred thousand,
 * which is far below the granularity a whole-percent rollout can express.
 */
export function bucketOf(flagKey: string, rolloutSalt: string, subjectKey: string): number {
  const digest = createHash('sha256')
    .update(`${flagKey}:${rolloutSalt}:${subjectKey}`, 'utf8')
    .digest();
  return digest.readUInt32BE(0) % BUCKET_COUNT;
}

/**
 * Whether a bucket is inside a whole-percent rollout.
 *
 * Strictly less than, so 0% includes nobody — the boundary that matters most, because a rollout
 * that has not started must be off for everybody rather than on for whoever hashes to zero.
 */
export function inRollout(bucket: number, percentage: number): boolean {
  return bucket < percentage * (BUCKET_COUNT / 100);
}
