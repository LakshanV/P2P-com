/**
 * Outbox relay (FND-003d).
 *
 * Polls a set of module outbox tables and dispatches unprocessed rows to the downstream event log
 * and audit log. The relay is intentionally thin: it does not interpret payloads, it only moves
 * them. Validation of event types and audit actions happens inside K-08 and K-09 when the payload is
 * consumed.
 *
 * The relay is a platform component, so it must not statically import any kernel service. It
 * accepts narrow publisher/recorder interfaces and the app wires the real services.
 *
 * Owned by: platform substrate.
 */

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
}

export interface RelayResult {
  readonly dispatched: number;
  readonly failed: number;
  readonly skipped: number;
}

/**
 * Dispatch every unprocessed outbox row to the appropriate downstream service.
 *
 * Rows are processed one at a time so a failure in one row does not prevent the dispatch of the
 * next. On success the row is marked processed; on failure the error is recorded and the retry
 * count is incremented.
 */
export async function runOutboxRelay(options: RelayOptions, now: string): Promise<RelayResult> {
  const events = options.events ?? NOOP_PUBLISHER;
  const audit = options.audit ?? NOOP_RECORDER;
  const limit = options.limit ?? 100;

  let dispatched = 0;
  let failed = 0;
  let skipped = 0;

  for (const source of options.sources) {
    const rows = await source.poll(limit, now);
    for (const row of rows) {
      const result = await dispatchOne({ events, audit, source, row, now });
      if (result === 'dispatched') dispatched += 1;
      else if (result === 'failed') failed += 1;
      else skipped += 1;
    }
  }

  return { dispatched, failed, skipped };
}

type DispatchOutcome = 'dispatched' | 'failed' | 'skipped';

async function dispatchOne(options: {
  readonly events: EventPublisher;
  readonly audit: AuditRecorder;
  readonly source: OutboxSource;
  readonly row: OutboxEntry;
  readonly now: string;
}): Promise<DispatchOutcome> {
  if (options.row.processedAt !== null) return 'skipped';

  try {
    if (options.row.kind === 'event') {
      await options.events.publish(options.row.payload);
    } else if (options.row.kind === 'audit') {
      await options.audit.record(options.row.payload);
    } else {
      await options.source.markError(
        options.row.outboxId,
        `unknown outbox kind: ${String(options.row.kind)}`,
        options.row.retryCount + 1,
        options.now,
      );
      return 'failed';
    }
    await options.source.markProcessed(options.row.outboxId, options.now);
    return 'dispatched';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await options.source.markError(
      options.row.outboxId,
      message,
      options.row.retryCount + 1,
      options.now,
    );
    return 'failed';
  }
}

const NOOP_PUBLISHER: EventPublisher = {
  publish: () => Promise.resolve(undefined),
};

const NOOP_RECORDER: AuditRecorder = {
  record: () => Promise.resolve(undefined),
};
