/**
 * The outbox relay worker, and the retry policy behind it.
 *
 * The relay shipped as a single-pass function that dispatched, and on failure recorded the error and
 * incremented a counter. That records what happened without changing what happens next: the same row
 * is retried on the very next poll, so a downstream outage becomes a tight loop against the thing
 * already struggling, and a permanently poisoned row is retried until somebody notices — which, for
 * a row nothing waits on, is usually never.
 *
 * What is tested here is the part that changes what happens next.
 *
 * **Backoff is deterministic.** There is no jitter, and its absence is a decision rather than an
 * oversight: one relay claims rows with `FOR UPDATE SKIP LOCKED`, so there is no herd to spread, and
 * a retry schedule nobody can predict is a retry schedule nobody can test.
 *
 * **The worker's clock and sleep are injected**, so the whole loop runs in microseconds and a test
 * never waits for anything.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_BACKOFF, backoffMillis, nextAttemptAt } from '../platform/outbox/backoff.ts';
import { eventOutboxEntry } from '../platform/outbox/builder.ts';
import { InMemoryOutboxStore } from '../platform/outbox/repository.ts';
import {
  runOutboxRelay,
  type AuditRecorder,
  type EventPublisher,
} from '../platform/outbox/relay.ts';
import type { OutboxEntry, OutboxSource } from '../platform/outbox/types.ts';
import {
  OutboxRelayWorker,
  type PassSummary,
  type WorkerEnvironment,
} from '../platform/outbox/worker.ts';

const T0 = '2026-07-01T09:00:00.000000Z';

function entry(id: string, kind: 'event' | 'audit' = 'event'): OutboxEntry {
  const built = eventOutboxEntry({
    outboxId: id,
    idempotencyKey: id,
    payload: { id },
    occurredAt: T0,
    recordedAt: T0,
    producer: 'K-05',
    correlationId: `corr_${id}`,
  });
  return { ...built, kind };
}

/** A publisher that fails a stated number of times, then succeeds. */
function flakyPublisher(failures: number): EventPublisher & { calls: number } {
  return {
    calls: 0,
    publish(): Promise<unknown> {
      this.calls += 1;
      if (this.calls <= failures) {
        return Promise.reject(new Error('the event log is unreachable'));
      }
      return Promise.resolve(undefined);
    },
  };
}

const OK_AUDIT: AuditRecorder = { record: () => Promise.resolve(undefined) };

// ---------------------------------------------------------------------------
// Backoff
// ---------------------------------------------------------------------------

test('the delay doubles from the base and stops at the ceiling', () => {
  assert.equal(backoffMillis(1), 2_000);
  assert.equal(backoffMillis(2), 4_000);
  assert.equal(backoffMillis(3), 8_000);
  assert.equal(backoffMillis(4), 16_000);
  assert.equal(backoffMillis(5), 32_000);
  assert.equal(backoffMillis(6), 64_000);
  assert.equal(backoffMillis(7), 128_000);
  assert.equal(backoffMillis(8), 256_000);
  assert.equal(backoffMillis(9), DEFAULT_BACKOFF.ceilingMillis);
  assert.equal(
    backoffMillis(200),
    DEFAULT_BACKOFF.ceilingMillis,
    'the exponent is clamped before it is used, not after: 2 ** 199 milliseconds is longer than ' +
      'the platform will exist',
  );
});

test('the delay is a pure function of the attempt number', () => {
  // No jitter, so two calls agree. A retry schedule nobody can predict is one nobody can test.
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    assert.equal(backoffMillis(attempt), backoffMillis(attempt));
  }
});

test('an attempt number that is not a positive integer is refused', () => {
  assert.throws(() => backoffMillis(0), RangeError);
  assert.throws(() => backoffMillis(-1), RangeError);
  assert.throws(() => backoffMillis(1.5), RangeError);
});

test('the next attempt is the instant plus the delay, until the policy gives up', () => {
  assert.equal(nextAttemptAt(T0, 1), '2026-07-01T09:00:02Z');
  assert.equal(nextAttemptAt(T0, 2), '2026-07-01T09:00:04Z');
  assert.equal(
    nextAttemptAt(T0, DEFAULT_BACKOFF.maxAttempts),
    null,
    'null is how the policy says there is no next attempt; the caller dead-letters rather than ' +
      'retrying for ever',
  );
});

test('a custom policy is honoured in full', () => {
  const policy = { baseMillis: 1_000, ceilingMillis: 4_000, maxAttempts: 3 };
  assert.equal(backoffMillis(1, policy), 1_000);
  assert.equal(backoffMillis(2, policy), 2_000);
  assert.equal(backoffMillis(3, policy), 4_000);
  assert.equal(backoffMillis(9, policy), 4_000);
  assert.equal(nextAttemptAt(T0, 3, policy), null);
});

// ---------------------------------------------------------------------------
// The relay
// ---------------------------------------------------------------------------

test('a successful dispatch marks the row processed and publishes once', async () => {
  const store = new InMemoryOutboxStore('K-05', 'kernel_configuration');
  store.insert(entry('K-05:one'));
  const events = flakyPublisher(0);

  const result = await runOutboxRelay({ sources: [store], events, audit: OK_AUDIT }, T0);

  assert.deepEqual(result, {
    dispatched: 1,
    failed: 0,
    skipped: 0,
    deadLettered: 0,
    sourceFailures: 0,
  });
  assert.equal(events.calls, 1);
  assert.equal(store.entries()[0]?.processedAt, T0);
});

test('a failed dispatch schedules the retry rather than repeating immediately', async () => {
  const store = new InMemoryOutboxStore('K-05', 'kernel_configuration');
  store.insert(entry('K-05:flaky'));
  const events = flakyPublisher(1);

  const first = await runOutboxRelay({ sources: [store], events, audit: OK_AUDIT }, T0);
  assert.equal(first.failed, 1);

  const row = store.entries()[0];
  assert.equal(row?.retryCount, 1);
  assert.equal(row?.lastError, 'the event log is unreachable');
  assert.equal(
    row?.nextAttemptAt,
    '2026-07-01T09:00:02Z',
    'the row is deferred, so the next poll at the same instant will not pick it up',
  );

  // A poll at the same instant finds nothing: this is the whole point.
  const immediately = await runOutboxRelay({ sources: [store], events, audit: OK_AUDIT }, T0);
  assert.equal(immediately.dispatched, 0);
  assert.equal(immediately.failed, 0);
  assert.equal(events.calls, 1, 'the downstream was not called again while the row was deferred');

  // Once the delay has passed, it is claimed and succeeds.
  const later = await runOutboxRelay(
    { sources: [store], events, audit: OK_AUDIT },
    '2026-07-01T09:00:03.000000Z',
  );
  assert.equal(later.dispatched, 1);
  assert.equal(events.calls, 2);
});

test('a row that keeps failing is given up on, with the reason recorded', async () => {
  const store = new InMemoryOutboxStore('K-05', 'kernel_configuration');
  store.insert(entry('K-05:poison'));
  const events = flakyPublisher(Number.MAX_SAFE_INTEGER);
  const policy = { baseMillis: 1_000, ceilingMillis: 4_000, maxAttempts: 3 };

  let now = T0;
  let deadLettered = 0;
  for (let pass = 0; pass < 5; pass += 1) {
    const result = await runOutboxRelay(
      { sources: [store], events, audit: OK_AUDIT, backoff: policy },
      now,
    );
    deadLettered += result.deadLettered;
    // Jump well past any scheduled retry, so each pass genuinely claims the row.
    now = `2026-07-01T09:0${String(pass + 1)}:00.000000Z`;
  }

  assert.equal(deadLettered, 1, 'the relay gave up exactly once');
  const row = store.entries()[0];
  assert.equal(row?.retryCount, 3);
  assert.notEqual(row?.deadLetteredAt, null);
  assert.match(String(row?.deadLetterReason), /gave up after 3 attempts/);
  assert.equal(
    row?.processedAt,
    null,
    'a dead-lettered row was never dispatched; marking it processed would tell every reader the ' +
      'opposite of what happened',
  );
  assert.equal(
    events.calls,
    3,
    'the relay stopped calling the downstream once it had given up, rather than retrying for ever',
  );
});

test('a dead-lettered row is never claimed again', async () => {
  const store = new InMemoryOutboxStore('K-05', 'kernel_configuration');
  store.insert(entry('K-05:gone'));
  await store.markDeadLettered('K-05:gone', 'poisoned', 8, T0);

  const events = flakyPublisher(0);
  const result = await runOutboxRelay(
    { sources: [store], events, audit: OK_AUDIT },
    '2026-07-02T09:00:00.000000Z',
  );

  assert.deepEqual(result, {
    dispatched: 0,
    failed: 0,
    skipped: 0,
    deadLettered: 0,
    sourceFailures: 0,
  });
  assert.equal(events.calls, 0);
});

test('an audit row goes to the recorder and an event row to the publisher', async () => {
  const store = new InMemoryOutboxStore('K-05', 'kernel_configuration');
  store.insert(entry('K-05:evt', 'event'));
  store.insert(entry('K-05:aud', 'audit'));

  const published: unknown[] = [];
  const recorded: unknown[] = [];
  await runOutboxRelay(
    {
      sources: [store],
      events: {
        publish: (request) => {
          published.push(request);
          return Promise.resolve(undefined);
        },
      },
      audit: {
        record: (request) => {
          recorded.push(request);
          return Promise.resolve(undefined);
        },
      },
    },
    T0,
  );

  assert.equal(published.length, 1);
  assert.equal(recorded.length, 1);
});

test('one unreachable source does not stop the others', async () => {
  const healthy = new InMemoryOutboxStore('K-05', 'kernel_configuration');
  healthy.insert(entry('K-05:fine'));

  const broken = {
    name: 'M-99',
    schema: 'module_broken',
    poll: () => Promise.reject(new Error('connection refused')),
    markProcessed: () => Promise.resolve(),
    markError: () => Promise.resolve(),
    markDeadLettered: () => Promise.resolve(),
  };

  const result = await runOutboxRelay({ sources: [broken, healthy], audit: OK_AUDIT }, T0);

  assert.equal(
    result.dispatched,
    1,
    'a relay that gave up on every module because one schema was unavailable would turn a partial ' +
      'outage into a total one',
  );
  assert.equal(
    result.sourceFailures,
    1,
    'and it is counted, because "nothing to do" and "could not look" reported as the same thing is ' +
      'how a module’s events pile up unpublished behind a healthy-looking zero',
  );
});

// ---------------------------------------------------------------------------
// The worker
// ---------------------------------------------------------------------------

/** A clock that advances one second per read, and a sleep that returns immediately. */
function testEnvironment(
  onPass?: (summary: PassSummary) => void,
): WorkerEnvironment & { slept: number[] } {
  let second = 0;
  return {
    slept: [],
    now(): string {
      const value = `2026-07-01T09:00:${String(second).padStart(2, '0')}.000000Z`;
      second += 1;
      return value;
    },
    sleep(millis: number): Promise<void> {
      this.slept.push(millis);
      return Promise.resolve();
    },
    ...(onPass === undefined ? {} : { onPass }),
  };
}

test('the worker runs the requested number of passes and reports what it did', async () => {
  const store = new InMemoryOutboxStore('K-05', 'kernel_configuration');
  store.insert(entry('K-05:w1'));
  store.insert(entry('K-05:w2'));

  const environment = testEnvironment();
  const worker = new OutboxRelayWorker(
    { sources: [store], audit: OK_AUDIT, limit: 1, maxPasses: 3 },
    environment,
  );

  const report = await worker.run();

  assert.equal(report.passes, 3);
  assert.equal(report.dispatched, 2, 'one row per pass at a limit of one, then nothing left');
  assert.equal(report.stopped, false, 'it ended by reaching maxPasses, not by being stopped');
  assert.equal(worker.running, false);
});

test('the worker waits longer after an idle pass than after a busy one', async () => {
  const store = new InMemoryOutboxStore('K-05', 'kernel_configuration');
  store.insert(entry('K-05:busy'));

  const environment = testEnvironment();
  const worker = new OutboxRelayWorker(
    { sources: [store], audit: OK_AUDIT, maxPasses: 3, busyMillis: 10, idleMillis: 500 },
    environment,
  );
  await worker.run();

  assert.deepEqual(
    environment.slept,
    [10, 500],
    'a pass that found work polls again promptly to drain the backlog; an empty table is left alone',
  );
});

test('stop() ends the loop after the pass it is in', async () => {
  const store = new InMemoryOutboxStore('K-05', 'kernel_configuration');
  for (let index = 0; index < 10; index += 1) store.insert(entry(`K-05:many${String(index)}`));

  // The callback has to reach a worker that does not exist when the environment is built, so it
  // goes through a holder rather than a variable the linter can see is assigned once.
  const holder: { worker?: OutboxRelayWorker } = {};
  const environment = testEnvironment(() => {
    holder.worker?.stop();
  });
  holder.worker = new OutboxRelayWorker(
    { sources: [store], audit: OK_AUDIT, limit: 1 },
    environment,
  );

  const report = await holder.worker.run();

  assert.equal(report.passes, 1, 'the pass in progress finished; no second pass started');
  assert.equal(report.stopped, true);
  assert.deepEqual(
    environment.slept,
    [],
    'a worker asked to stop does not then sit out its own idle delay',
  );
});

test('stop() before run() means no pass ever starts', async () => {
  const store = new InMemoryOutboxStore('K-05', 'kernel_configuration');
  store.insert(entry('K-05:never'));

  const worker = new OutboxRelayWorker({ sources: [store], audit: OK_AUDIT }, testEnvironment());
  worker.stop();
  const report = await worker.run();

  assert.equal(report.passes, 0, 'a process signalled during startup should not begin work');
  assert.equal(store.entries()[0]?.processedAt, null);
});

test('a pass that throws is counted, reported, and does not end the loop', async () => {
  // `runOutboxRelay` swallows a single unreachable source, so reaching the worker's own catch means
  // something broader went wrong. The loop must survive it and back off further.
  const summaries: PassSummary[] = [];
  const environment = testEnvironment((summary) => summaries.push(summary));
  const worker = new OutboxRelayWorker(
    { sources: null as unknown as readonly OutboxSource[], maxPasses: 2, errorMillis: 9_999 },
    environment,
  );

  const report = await worker.run();

  assert.equal(report.errors, 2);
  assert.equal(report.passes, 2, 'the loop survived the failure rather than exiting');
  assert.equal(summaries[0]?.errored, true);
  assert.ok(String(summaries[0]?.error).length > 0, 'the failure is reported, not swallowed');
  assert.deepEqual(
    environment.slept,
    [9_999],
    'a hard-down dependency is backed off from further than an idle table is',
  );
});

test('one worker cannot be run twice at once', async () => {
  const store = new InMemoryOutboxStore('K-05', 'kernel_configuration');
  const worker = new OutboxRelayWorker(
    { sources: [store], audit: OK_AUDIT, maxPasses: 1 },
    testEnvironment(),
  );

  const first = worker.run();
  await assert.rejects(() => worker.run(), /already running/);
  await first;
});

test('every pass is reported, in order, with what it did', async () => {
  const store = new InMemoryOutboxStore('K-05', 'kernel_configuration');
  store.insert(entry('K-05:report'));

  const summaries: PassSummary[] = [];
  const environment = testEnvironment((summary) => summaries.push(summary));
  const worker = new OutboxRelayWorker(
    { sources: [store], audit: OK_AUDIT, maxPasses: 2 },
    environment,
  );
  await worker.run();

  assert.deepEqual(
    summaries.map((summary) => summary.pass),
    [1, 2],
  );
  assert.equal(summaries[0]?.dispatched, 1);
  assert.equal(summaries[1]?.dispatched, 0);
  assert.equal(
    summaries[0]?.startedAt,
    '2026-07-01T09:00:00.000000Z',
    'the instant is the one the injected clock gave, so a report can be asserted exactly',
  );
});
