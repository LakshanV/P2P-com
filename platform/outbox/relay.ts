/**
 * Outbox relay.
 *
 * Claims unprocessed rows from a set of module outbox tables and dispatches them to the downstream
 * event log and audit log. The relay is intentionally thin: it does not interpret payloads, it moves
 * them. Validation of event types and audit actions happens inside K-08 and K-09 when the payload is
 * consumed.
 *
 * The relay is a platform component, so it must not statically import any kernel service. It accepts
 * narrow publisher and recorder interfaces and the application wires the real ones.
 *
 * Three rules make it safe to run more than one of these at once, and to keep running it when the
 * downstream is broken.
 *
 * **A failed row is rescheduled, not retried immediately.** The delay grows with the number of
 * failures, so a downstream outage does not become a tight loop against the thing already
 * struggling.
 *
 * **A row that keeps failing is eventually given up on**, with the reason recorded. A relay that
 * retries for ever burns capacity on a row that will never succeed and hides the fact that it never
 * succeeded.
 *
 * **A dead-lettered row is not marked processed.** It was never dispatched, and recording it as
 * processed would tell every reader the opposite of what happened.
 *
 * Owned by: platform substrate.
 */

import { DEFAULT_BACKOFF, nextAttemptAt, type BackoffPolicy } from './backoff.ts';
import type { OutboxEntry, OutboxSource } from './types.ts';

export interface EventPublisher {
  publish(request: unknown): Promise<unknown>;
}

export interface AuditRecorder {
  record(request: unknown): Promise<unknown>;
}

export interface RelayOptions {
  readonly sources: readonly OutboxSource[];
  readonly events?: EventPublisher;
  readonly audit?: AuditRecorder;
  /** Maximum rows to claim from each source in one run. */
  readonly limit?: number;
  /** How failures are rescheduled, and when the relay gives up. */
  readonly backoff?: BackoffPolicy;
}

export interface RelayResult {
  readonly dispatched: number;
  readonly failed: number;
  readonly skipped: number;
  /** Rows the relay gave up on in this run. */
  readonly deadLettered: number;
  /**
   * Sources that could not be polled at all.
   *
   * Counted rather than thrown, because one unreachable schema must not stop the others — but
   * counted rather than ignored, because a source that silently returns nothing is
   * indistinguishable from a source with nothing to do, and a relay that cannot tell the difference
   * will report a healthy zero while a module's events pile up unpublished.
   */
  readonly sourceFailures: number;
}

/**
 * Dispatch every claimed outbox row to the appropriate downstream service.
 *
 * Rows are processed one at a time so a failure in one does not prevent the dispatch of the next.
 * On success the row is marked processed; on failure it is rescheduled, or dead-lettered once it
 * has failed as many times as the policy allows.
 */
export async function runOutboxRelay(options: RelayOptions, now: string): Promise<RelayResult> {
  const events = options.events ?? NOOP_PUBLISHER;
  const audit = options.audit ?? NOOP_RECORDER;
  const limit = options.limit ?? 100;
  const backoff = options.backoff ?? DEFAULT_BACKOFF;

  let dispatched = 0;
  let failed = 0;
  let skipped = 0;
  let deadLettered = 0;
  let sourceFailures = 0;

  for (const source of options.sources) {
    let rows: readonly OutboxEntry[];
    try {
      rows = await source.poll(limit, now);
    } catch {
      // One unreachable source must not stop the others. A relay that gave up on every module
      // because one schema was unavailable would turn a partial outage into a total one — but it
      // is counted, so "nothing to do" and "could not look" are never reported as the same thing.
      sourceFailures += 1;
      continue;
    }

    for (const row of rows) {
      const result = await dispatchOne({ events, audit, source, row, now, backoff });
      if (result === 'dispatched') dispatched += 1;
      else if (result === 'failed') failed += 1;
      else if (result === 'dead-lettered') deadLettered += 1;
      else skipped += 1;
    }
  }

  return { dispatched, failed, skipped, deadLettered, sourceFailures };
}

type DispatchOutcome = 'dispatched' | 'failed' | 'dead-lettered' | 'skipped';

async function dispatchOne(options: {
  readonly events: EventPublisher;
  readonly audit: AuditRecorder;
  readonly source: OutboxSource;
  readonly row: OutboxEntry;
  readonly now: string;
  readonly backoff: BackoffPolicy;
}): Promise<DispatchOutcome> {
  // A claim can race a dispatch that has just finished, so this is checked rather than assumed.
  if (options.row.processedAt !== null) return 'skipped';
  if (options.row.deadLetteredAt !== null) return 'skipped';

  try {
    if (options.row.kind === 'event') {
      await options.events.publish(options.row.payload);
    } else {
      await options.audit.record(options.row.payload);
    }
    await options.source.markProcessed(options.row.outboxId, options.now);
    return 'dispatched';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return recordFailure(options.source, options.row, message, options.now, options.backoff);
  }
}

/**
 * Reschedule a failed row, or give up on it.
 *
 * The choice is the backoff policy's: it is asked when the next attempt should be, and answering
 * "there is no next attempt" is how it says the row has had enough chances.
 */
async function recordFailure(
  source: OutboxSource,
  row: OutboxEntry,
  message: string,
  now: string,
  backoff: BackoffPolicy,
): Promise<DispatchOutcome> {
  const attempt = row.retryCount + 1;
  const next = nextAttemptAt(now, attempt, backoff);

  if (next === null) {
    await source.markDeadLettered(
      row.outboxId,
      `gave up after ${String(attempt)} attempts: ${message}`,
      attempt,
      now,
    );
    return 'dead-lettered';
  }

  await source.markError(row.outboxId, message, attempt, next);
  return 'failed';
}

const NOOP_PUBLISHER: EventPublisher = {
  publish: () => Promise.resolve(undefined),
};

const NOOP_RECORDER: AuditRecorder = {
  record: () => Promise.resolve(undefined),
};
