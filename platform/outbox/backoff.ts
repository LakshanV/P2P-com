/**
 * Retry scheduling for the outbox relay.
 *
 * When a dispatch fails, the question is not whether to retry but *when*, and the answer has to be
 * a function of how many times it has already failed. A relay that retries immediately turns a
 * downstream outage into a tight loop against the thing that is already struggling.
 *
 * **The delay is exponential, capped, and deterministic.** There is no jitter, and its absence is
 * deliberate rather than an oversight. Jitter is the standard answer to a thundering herd, and it is
 * the right answer when many independent clients retry against one service. This is not that: one
 * relay claims rows with `FOR UPDATE SKIP LOCKED`, so two relay instances never hold the same row
 * and there is no herd to spread. What jitter would cost is the property this repository is built
 * on — that the same inputs produce the same outputs — and a retry schedule nobody can predict is a
 * retry schedule nobody can test.
 *
 * Owned by: platform substrate.
 */

import { formatInstant, parseInstant } from '../time/instant.ts';

export interface BackoffPolicy {
  /** The delay after the first failure, in milliseconds. */
  readonly baseMillis: number;
  /** The longest a retry is ever deferred, in milliseconds. */
  readonly ceilingMillis: number;
  /**
   * How many failures a row is allowed before the relay gives up.
   *
   * Reached, the row is dead-lettered rather than retried for ever. A row nothing waits on and
   * nobody retries is a row that quietly never happens, and the dead-letter record is what makes
   * that visible.
   */
  readonly maxAttempts: number;
}

/**
 * The default policy: 2 seconds doubling to a 5-minute ceiling, giving up after 8 attempts.
 *
 * Eight attempts spans a little over twenty minutes of real time, which is long enough to ride out
 * a restart or a brief outage and short enough that a genuinely poisoned row is visible within one
 * working attention span rather than one working day.
 */
export const DEFAULT_BACKOFF: BackoffPolicy = Object.freeze({
  baseMillis: 2_000,
  ceilingMillis: 300_000,
  maxAttempts: 8,
});

/**
 * How long to wait before attempt number `attempt`, in milliseconds.
 *
 * `attempt` is the count of failures so far, so the first retry — after one failure — waits
 * `baseMillis`. Doubling is done by shifting an exponent that is clamped **before** it is used, not
 * after: `2 ** 40` milliseconds is longer than the platform will exist, and computing it in order to
 * throw it away is the kind of thing that works until somebody changes the ceiling.
 */
export function backoffMillis(attempt: number, policy: BackoffPolicy = DEFAULT_BACKOFF): number {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new RangeError(
      `attempt is ${String(attempt)}; the count of failures so far is a positive integer`,
    );
  }

  // The exponent that would first exceed the ceiling. Anything beyond it is the ceiling anyway.
  const span = Math.max(policy.ceilingMillis / policy.baseMillis, 1);
  const maxExponent = Math.ceil(Math.log2(span));
  const exponent = Math.min(attempt - 1, maxExponent);

  return Math.min(policy.baseMillis * 2 ** exponent, policy.ceilingMillis);
}

/**
 * The instant a row becomes eligible again, or null when the relay should give up.
 *
 * Null is the dead-letter signal. Returning it rather than throwing keeps the decision in one place:
 * the caller asks "when next?" and is told either an instant or that there is no next.
 */
export function nextAttemptAt(
  now: string,
  attempt: number,
  policy: BackoffPolicy = DEFAULT_BACKOFF,
): string | null {
  if (attempt >= policy.maxAttempts) return null;

  const micros = parseInstant(now).epochMicros;
  return formatInstant(micros + BigInt(backoffMillis(attempt, policy)) * 1000n);
}
