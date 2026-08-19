/**
 * K-08 Event Infrastructure — delivery, retry, dead-lettering and replay (FND-003b).
 *
 * These are the cases that decide whether the component is worth having. Every one of them is a
 * situation that happens in production and is almost never tested, because provoking it against a
 * real broker means killing a process at a precise instant:
 *
 *   - two workers reaching for the same delivery;
 *   - a worker whose lease expires mid-handler, returning to acknowledge work somebody else now
 *     owns;
 *   - a crash *after* the handler succeeded but *before* the acknowledgement — the window that
 *     makes at-least-once delivery at-least-once rather than exactly-once;
 *   - a handler that throws, and must not be able to acknowledge anything;
 *   - a replay that must not silently re-run an effect the consumer already applied.
 *
 * Against an injected repository each is three lines and deterministic.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EventError,
  backoffSeconds,
  DEFAULT_RETRY_POLICY,
} from '../kernel/event-infrastructure/index.ts';
import type { Delivery, HandlerContext } from '../kernel/event-infrastructure/index.ts';

import {
  AI,
  FAST_POLICY,
  OPERATOR,
  WORKER,
  build,
  publishRequest,
} from './helpers/event-fixtures.ts';

const codeOf = (error: unknown): string | undefined =>
  error instanceof EventError ? error.code : undefined;

/** A handler that records what it saw, and fails on demand. */
function recordingHandler(options: { failTimes?: number; onCall?: () => void } = {}): {
  handler: (context: HandlerContext) => Promise<void>;
  calls: HandlerContext[];
} {
  const calls: HandlerContext[] = [];
  let remainingFailures = options.failTimes ?? 0;
  return {
    calls,
    handler: (context) => {
      calls.push(context);
      options.onCall?.();
      if (remainingFailures > 0) {
        remainingFailures -= 1;
        return Promise.reject(new Error('handler exploded'));
      }
      return Promise.resolve();
    },
  };
}

const deliveryOf = (
  repository: { deliveries(): readonly Delivery[] },
  subscription: string,
): Delivery => {
  const rows = repository
    .deliveries()
    .filter((delivery) => delivery.subscription === subscription)
    .sort((a, b) => b.generation - a.generation);
  assert.ok(rows[0] !== undefined, `no delivery for ${subscription}`);
  return rows[0];
};

// ---------------------------------------------------------------------------
// The happy path, and what it writes
// ---------------------------------------------------------------------------

test('a delivered event is acknowledged once and leaves exactly one receipt', async () => {
  const { service, repository } = build();
  const { handler, calls } = recordingHandler();
  service.register('audit-writer', handler);

  await service.publish(publishRequest({ eventId: 'evt-1', idempotencyKey: 'k-1' }));
  const outcomes = await service.deliver({
    subscription: 'audit-writer',
    worker: WORKER,
    claimToken: 'claim-1',
    now: '2026-03-01T10:00:05Z',
  });

  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0]?.kind, 'delivered');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.envelope.eventId, 'evt-1');
  assert.equal(calls[0]?.attempt, 1);
  assert.equal(calls[0]?.idempotencyKey, 'audit-writer:evt-1');

  const delivery = deliveryOf(repository, 'audit-writer');
  assert.equal(delivery.status, 'delivered');
  assert.equal(delivery.completedAt, '2026-03-01T10:00:05Z');
  assert.equal(delivery.claimToken, null, 'the claim is released on completion');
  assert.equal(repository.receipts().length, 1);
  assert.deepEqual(repository.receipts()[0], {
    subscription: 'audit-writer',
    eventId: 'evt-1',
    deliveryId: delivery.deliveryId,
    processedAt: '2026-03-01T10:00:05Z',
  });
});

test('one subscription being delivered leaves the others untouched', async () => {
  const { service, repository } = build();
  service.register('audit-writer', recordingHandler().handler);

  await service.publish(publishRequest({ eventId: 'evt-1', idempotencyKey: 'k-1' }));
  await service.deliver({
    subscription: 'audit-writer',
    worker: WORKER,
    claimToken: 'claim-1',
    now: '2026-03-01T10:00:05Z',
  });

  assert.equal(deliveryOf(repository, 'audit-writer').status, 'delivered');
  assert.equal(
    deliveryOf(repository, 'search-indexer').status,
    'pending',
    'a slow consumer does not hold up a fast one, and a fast one does not acknowledge for it',
  );
});

test('a delivery that is not yet due is not claimed', async () => {
  const { service } = build();
  const { handler, calls } = recordingHandler({ failTimes: 1 });
  service.register('audit-writer', handler);

  await service.publish(publishRequest({ eventId: 'evt-1', idempotencyKey: 'k-1' }));
  await service.deliver({
    subscription: 'audit-writer',
    worker: WORKER,
    claimToken: 'claim-1',
    now: '2026-03-01T10:00:05Z',
  });
  assert.equal(calls.length, 1, 'failed once, so a retry is scheduled 10s out');

  const tooEarly = await service.deliver({
    subscription: 'audit-writer',
    worker: WORKER,
    claimToken: 'claim-2',
    now: '2026-03-01T10:00:09Z',
  });
  assert.deepEqual(tooEarly, [], 'nothing is due yet');
  assert.equal(calls.length, 1);
});

// ---------------------------------------------------------------------------
// Handler failure, bounded backoff, dead-lettering
// ---------------------------------------------------------------------------

test('a handler that throws never acknowledges, and schedules a bounded retry', async () => {
  const { service, repository } = build();
  service.register('audit-writer', recordingHandler({ failTimes: 99 }).handler);

  await service.publish(publishRequest({ eventId: 'evt-1', idempotencyKey: 'k-1' }));
  const outcomes = await service.deliver({
    subscription: 'audit-writer',
    worker: WORKER,
    claimToken: 'claim-1',
    now: '2026-03-01T10:00:05Z',
  });

  assert.equal(outcomes[0]?.kind, 'retry-scheduled');
  assert.equal(outcomes[0]?.error, 'handler exploded');
  assert.equal(outcomes[0]?.nextAttemptAt, '2026-03-01T10:00:15Z', 'base backoff is 10s');

  const delivery = deliveryOf(repository, 'audit-writer');
  assert.equal(delivery.status, 'pending', 'back in the queue, not acknowledged');
  assert.equal(delivery.attempts, 1);
  assert.equal(delivery.completedAt, null);
  assert.equal(
    repository.receipts().length,
    0,
    'no receipt: a handler that threw has not processed the event, whatever it wrote',
  );
});

test('backoff doubles, is capped, and never depends on randomness', () => {
  assert.equal(backoffSeconds(1, FAST_POLICY), 10);
  assert.equal(backoffSeconds(2, FAST_POLICY), 20);
  assert.equal(backoffSeconds(3, FAST_POLICY), 40);
  assert.equal(backoffSeconds(4, FAST_POLICY), 60, 'capped at maxBackoffSeconds');
  assert.equal(backoffSeconds(99, FAST_POLICY), 60);
  assert.equal(backoffSeconds(0, FAST_POLICY), 10, 'a nonsensical attempt still yields the base');

  // Unbounded growth is the failure mode a cap exists to prevent: without one, attempt 40 of the
  // default policy schedules a retry roughly 17 billion years out.
  assert.equal(backoffSeconds(40, DEFAULT_RETRY_POLICY), DEFAULT_RETRY_POLICY.maxBackoffSeconds);

  // Deterministic: same input, same answer, every time.
  for (let i = 0; i < 5; i += 1) assert.equal(backoffSeconds(3, FAST_POLICY), 40);
});

test('a delivery that exhausts its attempts is dead-lettered, terminally', async () => {
  const { service, repository } = build();
  service.register('audit-writer', recordingHandler({ failTimes: 99 }).handler);
  await service.publish(publishRequest({ eventId: 'evt-1', idempotencyKey: 'k-1' }));

  const schedule = ['2026-03-01T10:00:05Z', '2026-03-01T10:01:00Z', '2026-03-01T10:02:00Z'];
  const kinds: string[] = [];
  for (const [index, now] of schedule.entries()) {
    const outcomes = await service.deliver({
      subscription: 'audit-writer',
      worker: WORKER,
      claimToken: `claim-${index}`,
      now,
    });
    kinds.push(outcomes[0]?.kind ?? 'none');
  }

  assert.deepEqual(kinds, ['retry-scheduled', 'retry-scheduled', 'dead-lettered']);

  const delivery = deliveryOf(repository, 'audit-writer');
  assert.equal(delivery.status, 'dead-lettered');
  assert.equal(delivery.attempts, 3, 'maxAttempts');
  assert.equal(delivery.lastError, 'handler exploded');
  assert.equal(repository.receipts().length, 0);

  // Terminal means terminal: a further pass finds nothing to claim.
  const after = await service.deliver({
    subscription: 'audit-writer',
    worker: WORKER,
    claimToken: 'claim-late',
    now: '2026-03-01T11:00:00Z',
  });
  assert.deepEqual(after, [], 'a dead-lettered delivery is never retried automatically');
});

test('the event itself is untouched by any number of failed deliveries', async () => {
  const { service, repository } = build();
  service.register('audit-writer', recordingHandler({ failTimes: 99 }).handler);
  const published = await service.publish(
    publishRequest({ eventId: 'evt-1', idempotencyKey: 'k-1' }),
  );

  for (const [index, now] of ['2026-03-01T10:00:05Z', '2026-03-01T10:01:00Z'].entries()) {
    await service.deliver({
      subscription: 'audit-writer',
      worker: WORKER,
      claimToken: `claim-${index}`,
      now,
    });
  }

  assert.deepEqual(
    repository.events()[0],
    { ...published.event, payload: { ...published.event.payload } },
    'delivery state lives on the delivery; a retry loop never rewrites history',
  );
});

// ---------------------------------------------------------------------------
// Concurrency: two workers, one delivery
// ---------------------------------------------------------------------------

test('two workers claiming at once: one gets the delivery, the other gets nothing', async () => {
  const { service, repository } = build();
  const calls: string[] = [];
  service.register('audit-writer', (context) => {
    calls.push(context.deliveryId);
    return Promise.resolve();
  });

  await service.publish(publishRequest({ eventId: 'evt-1', idempotencyKey: 'k-1' }));

  const [a, b] = await Promise.all([
    service.deliver({
      subscription: 'audit-writer',
      worker: { id: 'worker-a', kind: 'system' },
      claimToken: 'claim-a',
      now: '2026-03-01T10:00:05Z',
    }),
    service.deliver({
      subscription: 'audit-writer',
      worker: { id: 'worker-b', kind: 'system' },
      claimToken: 'claim-b',
      now: '2026-03-01T10:00:05Z',
    }),
  ]);

  const claimed = [...a, ...b];
  assert.equal(claimed.length, 1, 'exactly one worker claimed the delivery');
  assert.equal(claimed[0]?.kind, 'delivered');
  assert.equal(calls.length, 1, 'the handler ran once');
  assert.equal(repository.receipts().length, 1);
  assert.equal(deliveryOf(repository, 'audit-writer').attempts, 1, 'one attempt was burned');
});

test('a worker whose lease expired cannot acknowledge work another worker now owns', async () => {
  const { service, repository } = build();

  let releaseSlowWorker: (() => void) | undefined;
  const slowWork = new Promise<void>((resolve) => {
    releaseSlowWorker = resolve;
  });
  let announceEntered: (() => void) | undefined;
  const handlerEntered = new Promise<void>((resolve) => {
    announceEntered = resolve;
  });

  let handlerCalls = 0;
  service.register('audit-writer', async () => {
    handlerCalls += 1;
    if (handlerCalls === 1) {
      // A has the claim and is inside its handler. It stalls past its lease from here.
      announceEntered?.();
      await slowWork;
    }
  });

  await service.publish(publishRequest({ eventId: 'evt-1', idempotencyKey: 'k-1' }));

  const stalled = service.deliver({
    subscription: 'audit-writer',
    worker: { id: 'worker-a', kind: 'system' },
    claimToken: 'claim-a',
    now: '2026-03-01T10:00:00Z',
  });
  await handlerEntered;

  const claim = repository.deliveries()[0];
  assert.equal(claim?.status, 'in-flight');
  assert.equal(claim?.claimToken, 'claim-a');
  assert.equal(claim?.claimExpiresAt, '2026-03-01T10:00:30Z', 'a 30s lease');

  // 31 seconds later the lease is dead, so B may take the delivery over.
  const takeover = await service.deliver({
    subscription: 'audit-writer',
    worker: { id: 'worker-b', kind: 'system' },
    claimToken: 'claim-b',
    now: '2026-03-01T10:00:31Z',
  });
  assert.equal(takeover[0]?.kind, 'delivered', 'B claimed the abandoned delivery and completed it');
  assert.equal(handlerCalls, 2);

  releaseSlowWorker?.();
  const late = await stalled;

  assert.equal(
    late[0]?.kind,
    'lost-claim',
    "A's handler returned, but A no longer owns the delivery and may not report success",
  );
  assert.match(String(late[0]?.error), /already delivered|not claim "claim-a"/);

  const delivery = deliveryOf(repository, 'audit-writer');
  assert.equal(delivery.status, 'delivered');
  assert.equal(delivery.completedAt, '2026-03-01T10:00:31Z', "B's completion stands, not A's");
  assert.equal(delivery.attempts, 2, 'both claims burned an attempt');
  assert.equal(
    repository.receipts().length,
    1,
    'exactly one authoritative completion, however many workers thought they had done the work',
  );
});

test('a stale worker is refused even while the winner is still working', async () => {
  // The sharper form of the previous case. There, the winner had already finished, so the loser
  // was caught by "this delivery is terminal". Here the winner is mid-handler, the row is still
  // in-flight, and the *only* thing standing between two authoritative completions is that the
  // loser's claim token is no longer the current one.
  const { service, repository } = build();

  const entered: Array<() => void> = [];
  const release: Array<() => void> = [];
  const gate = (index: number): Promise<void> =>
    new Promise<void>((resolve) => {
      release[index] = resolve;
    });

  let handlerCalls = 0;
  service.register('audit-writer', async () => {
    const index = handlerCalls;
    handlerCalls += 1;
    const waiting = gate(index);
    entered[index]?.();
    await waiting;
  });

  const enteredOnce = new Promise<void>((resolve) => {
    entered[0] = resolve;
  });
  const enteredTwice = new Promise<void>((resolve) => {
    entered[1] = resolve;
  });

  await service.publish(publishRequest({ eventId: 'evt-1', idempotencyKey: 'k-1' }));

  const workerA = service.deliver({
    subscription: 'audit-writer',
    worker: { id: 'worker-a', kind: 'system' },
    claimToken: 'claim-a',
    now: '2026-03-01T10:00:00Z',
  });
  await enteredOnce;

  // A's lease dies; B takes over and is still inside its handler.
  const workerB = service.deliver({
    subscription: 'audit-writer',
    worker: { id: 'worker-b', kind: 'system' },
    claimToken: 'claim-b',
    now: '2026-03-01T10:00:31Z',
  });
  await enteredTwice;

  const inFlight = repository.deliveries()[0];
  assert.equal(inFlight?.status, 'in-flight', 'B holds the delivery right now');
  assert.equal(inFlight?.claimToken, 'claim-b');

  // A finishes first and tries to acknowledge. The row is not terminal, so only the token can
  // refuse it.
  release[0]?.();
  const lateA = await workerA;
  assert.equal(lateA[0]?.kind, 'lost-claim');
  assert.match(String(lateA[0]?.error), /not claim "claim-a"/);
  assert.equal(repository.receipts().length, 0, 'A wrote no receipt');
  assert.equal(
    repository.deliveries()[0]?.status,
    'in-flight',
    "A's attempt to finish did not disturb B's claim",
  );

  release[1]?.();
  const doneB = await workerB;
  assert.equal(doneB[0]?.kind, 'delivered');
  assert.equal(repository.receipts().length, 1, 'exactly one authoritative completion');
});

test('a claim token in use may not be reused, because it identifies one claim', async () => {
  const { service } = build();

  let releaseSlowWorker: (() => void) | undefined;
  const slowWork = new Promise<void>((resolve) => {
    releaseSlowWorker = resolve;
  });
  let announceEntered: (() => void) | undefined;
  const handlerEntered = new Promise<void>((resolve) => {
    announceEntered = resolve;
  });

  let handlerCalls = 0;
  service.register('audit-writer', async () => {
    handlerCalls += 1;
    if (handlerCalls === 1) {
      announceEntered?.();
      await slowWork;
    }
  });

  await service.publish(publishRequest({ eventId: 'evt-1', idempotencyKey: 'k-1' }));
  await service.publish(publishRequest({ eventId: 'evt-2', idempotencyKey: 'k-2' }));

  const held = service.deliver({
    subscription: 'audit-writer',
    worker: WORKER,
    claimToken: 'claim-1',
    limit: 1,
    now: '2026-03-01T10:00:00Z',
  });
  await handlerEntered;

  // A second claim offering the same token, while the first still holds it. Two claims that cannot
  // be told apart would defeat the guard that stops a stale worker acknowledging.
  await assert.rejects(
    service.deliver({
      subscription: 'audit-writer',
      worker: WORKER,
      claimToken: 'claim-1',
      now: '2026-03-01T10:00:05Z',
    }),
    (error: unknown) => codeOf(error) === 'claim-token-reuse',
  );

  releaseSlowWorker?.();
  await held;
});

// ---------------------------------------------------------------------------
// The crash window
// ---------------------------------------------------------------------------

test('a crash after the handler succeeded but before acknowledgement redelivers exactly once', async () => {
  const { service, repository } = build();

  let handlerCalls = 0;
  let crashNow = true;
  service.register('audit-writer', () => {
    handlerCalls += 1;
    if (crashNow) {
      // The handler's effect has landed. The process dies here, so the acknowledgement and the
      // receipt — which share a transaction — never happen.
      crashNow = false;
      throw new Error('process died after the effect landed');
    }
    return Promise.resolve();
  });

  await service.publish(publishRequest({ eventId: 'evt-1', idempotencyKey: 'k-1' }));
  const first = await service.deliver({
    subscription: 'audit-writer',
    worker: { id: 'worker-a', kind: 'system' },
    claimToken: 'claim-a',
    now: '2026-03-01T10:00:00Z',
  });

  assert.equal(first[0]?.kind, 'retry-scheduled');
  assert.equal(
    repository.receipts().length,
    0,
    'no receipt was written, because the acknowledgement never happened',
  );

  // The delivery comes back round, and the handler runs a second time. That is at-least-once, and
  // it is why a handler is handed an idempotency key rather than a promise of uniqueness.
  const second = await service.deliver({
    subscription: 'audit-writer',
    worker: { id: 'worker-b', kind: 'system' },
    claimToken: 'claim-b',
    now: '2026-03-01T10:00:20Z',
  });

  assert.equal(second[0]?.kind, 'delivered');
  assert.equal(handlerCalls, 2, 'the effect was applied twice — at-least-once, honestly');
  assert.equal(repository.receipts().length, 1, 'but exactly one receipt, and one acknowledgement');
  assert.equal(deliveryOf(repository, 'audit-writer').status, 'delivered');
  assert.equal(deliveryOf(repository, 'audit-writer').attempts, 2);
});

test('a receipt suppresses redelivery to the handler entirely', async () => {
  const { service, repository } = build();
  let handlerCalls = 0;
  service.register('audit-writer', () => {
    handlerCalls += 1;
    return Promise.resolve();
  });

  await service.publish(publishRequest({ eventId: 'evt-1', idempotencyKey: 'k-1' }));
  await service.deliver({
    subscription: 'audit-writer',
    worker: WORKER,
    claimToken: 'claim-1',
    now: '2026-03-01T10:00:00Z',
  });
  assert.equal(handlerCalls, 1);

  // A second, redundant delivery of the same event: manufactured by replaying without discarding
  // the receipt, which is precisely the case an operator must not be able to trigger by accident.
  await service.replay({
    eventId: 'evt-1',
    subscription: 'audit-writer',
    deliveryId: 'replay-1',
    operator: OPERATOR,
    reason: 'checking',
    now: '2026-03-01T11:00:00Z',
  });
  const outcomes = await service.deliver({
    subscription: 'audit-writer',
    worker: WORKER,
    claimToken: 'claim-2',
    now: '2026-03-01T11:00:00Z',
  });

  assert.equal(outcomes[0]?.kind, 'deduplicated');
  assert.equal(handlerCalls, 1, 'consumer code was not reached a second time');
  assert.equal(repository.receipts().length, 1);
});

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

test('replay appends a new generation and never revives the superseded delivery', async () => {
  const { service, repository } = build();
  service.register('audit-writer', recordingHandler().handler);

  await service.publish(publishRequest({ eventId: 'evt-1', idempotencyKey: 'k-1' }));
  await service.deliver({
    subscription: 'audit-writer',
    worker: WORKER,
    claimToken: 'claim-1',
    now: '2026-03-01T10:00:00Z',
  });
  const original = deliveryOf(repository, 'audit-writer');

  const replay = await service.replay({
    eventId: 'evt-1',
    subscription: 'audit-writer',
    deliveryId: 'replay-1',
    operator: OPERATOR,
    reason: 'audit rebuild after incident 41',
    now: '2026-03-02T09:00:00Z',
    discardReceipt: true,
  });

  assert.equal(replay.delivery.generation, 2);
  assert.equal(replay.delivery.status, 'pending');
  assert.equal(replay.delivery.attempts, 0);
  assert.equal(replay.delivery.replayOf, original.deliveryId);
  assert.equal(replay.delivery.replayReason, 'ops-alice: audit rebuild after incident 41');
  assert.equal(replay.supersededDeliveryId, original.deliveryId);
  assert.equal(replay.receiptDiscarded, true);

  const superseded = repository
    .deliveries()
    .find((delivery) => delivery.deliveryId === original.deliveryId);
  assert.equal(superseded?.status, 'delivered', 'the old row stays exactly as it was');
  assert.equal(superseded?.generation, 1);
  assert.equal(superseded?.completedAt, '2026-03-01T10:00:00Z');
});

test('replay does not bypass deduplication unless the operator discards the receipt', async () => {
  const { service, repository } = build();
  let handlerCalls = 0;
  service.register('audit-writer', () => {
    handlerCalls += 1;
    return Promise.resolve();
  });

  await service.publish(publishRequest({ eventId: 'evt-1', idempotencyKey: 'k-1' }));
  await service.deliver({
    subscription: 'audit-writer',
    worker: WORKER,
    claimToken: 'claim-1',
    now: '2026-03-01T10:00:00Z',
  });

  // Default: the receipt stands, so the replay is deduplicated rather than re-run.
  const cautious = await service.replay({
    eventId: 'evt-1',
    subscription: 'audit-writer',
    deliveryId: 'replay-1',
    operator: OPERATOR,
    reason: 'redeliver notification',
    now: '2026-03-02T09:00:00Z',
  });
  assert.equal(cautious.receiptDiscarded, false);
  await service.deliver({
    subscription: 'audit-writer',
    worker: WORKER,
    claimToken: 'claim-2',
    now: '2026-03-02T09:00:00Z',
  });
  assert.equal(handlerCalls, 1, 'the effect was not re-applied');

  // Explicit: the operator says the consumer's effect was lost, and takes responsibility.
  const deliberate = await service.replay({
    eventId: 'evt-1',
    subscription: 'audit-writer',
    deliveryId: 'replay-2',
    operator: OPERATOR,
    reason: 'audit rows lost in incident 41',
    now: '2026-03-02T10:00:00Z',
    discardReceipt: true,
  });
  assert.equal(deliberate.receiptDiscarded, true);
  assert.equal(deliberate.delivery.generation, 3);
  await service.deliver({
    subscription: 'audit-writer',
    worker: WORKER,
    claimToken: 'claim-3',
    now: '2026-03-02T10:00:00Z',
  });
  assert.equal(handlerCalls, 2, 'and only then does consumer code run again');
  assert.equal(repository.receipts().length, 1, 'the receipt is rewritten, not duplicated');
});

test('a dead-lettered delivery can be replayed once its cause is fixed', async () => {
  const { service, repository } = build();
  let failing = true;
  service.register('audit-writer', () => {
    if (failing) return Promise.reject(new Error('downstream down'));
    return Promise.resolve();
  });

  await service.publish(publishRequest({ eventId: 'evt-1', idempotencyKey: 'k-1' }));
  for (const [index, now] of [
    '2026-03-01T10:00:00Z',
    '2026-03-01T10:01:00Z',
    '2026-03-01T10:02:00Z',
  ].entries()) {
    await service.deliver({
      subscription: 'audit-writer',
      worker: WORKER,
      claimToken: `claim-${index}`,
      now,
    });
  }
  assert.equal(deliveryOf(repository, 'audit-writer').status, 'dead-lettered');

  failing = false;
  await service.replay({
    eventId: 'evt-1',
    subscription: 'audit-writer',
    deliveryId: 'replay-1',
    operator: OPERATOR,
    reason: 'downstream restored',
    now: '2026-03-01T12:00:00Z',
  });
  const outcomes = await service.deliver({
    subscription: 'audit-writer',
    worker: WORKER,
    claimToken: 'claim-replay',
    now: '2026-03-01T12:00:00Z',
  });

  assert.equal(outcomes[0]?.kind, 'delivered');
  assert.equal(deliveryOf(repository, 'audit-writer').generation, 2);
});

test('replay is refused while a delivery is still live', async () => {
  const { service } = build();
  service.register('audit-writer', recordingHandler({ failTimes: 99 }).handler);
  await service.publish(publishRequest({ eventId: 'evt-1', idempotencyKey: 'k-1' }));

  // Pending: never delivered yet.
  await assert.rejects(
    service.replay({
      eventId: 'evt-1',
      subscription: 'audit-writer',
      deliveryId: 'replay-1',
      operator: OPERATOR,
      reason: 'impatient',
      now: '2026-03-01T10:00:00Z',
    }),
    (error: unknown) => codeOf(error) === 'delivery-not-terminal',
  );
});

test('replay requires an operator and a reason, and AI may never order one', async () => {
  const { service } = build();
  service.register('audit-writer', recordingHandler().handler);
  await service.publish(publishRequest({ eventId: 'evt-1', idempotencyKey: 'k-1' }));
  await service.deliver({
    subscription: 'audit-writer',
    worker: WORKER,
    claimToken: 'claim-1',
    now: '2026-03-01T10:00:00Z',
  });

  const base = {
    eventId: 'evt-1',
    subscription: 'audit-writer',
    deliveryId: 'replay-1',
    reason: 'because',
    now: '2026-03-02T09:00:00Z',
  };

  await assert.rejects(
    service.replay({ ...base, operator: AI }),
    (error: unknown) => codeOf(error) === 'replay-not-authorised',
  );
  await assert.rejects(
    service.replay({ ...base, operator: WORKER }),
    (error: unknown) => codeOf(error) === 'replay-not-authorised',
    'automatic replay is how one incident becomes two',
  );
  await assert.rejects(
    service.replay({ ...base, operator: OPERATOR, reason: '   ' }),
    (error: unknown) => codeOf(error) === 'replay-not-authorised',
  );
});

test('replay refuses an unknown event and an unsubscribed consumer', async () => {
  const { service } = build();
  service.register('audit-writer', recordingHandler().handler);
  await service.publish(publishRequest({ eventId: 'evt-1', idempotencyKey: 'k-1' }));

  await assert.rejects(
    service.replay({
      eventId: 'evt-nope',
      subscription: 'audit-writer',
      deliveryId: 'r-1',
      operator: OPERATOR,
      reason: 'x',
      now: '2026-03-02T09:00:00Z',
    }),
    (error: unknown) => codeOf(error) === 'no-such-event',
  );
  await assert.rejects(
    service.replay({
      eventId: 'evt-1',
      subscription: 'not-registered',
      deliveryId: 'r-1',
      operator: OPERATOR,
      reason: 'x',
      now: '2026-03-02T09:00:00Z',
    }),
    (error: unknown) => codeOf(error) === 'unknown-subscription',
  );
});

test('replay leaves the original event byte-identical, fingerprint included', async () => {
  const { service, repository } = build();
  service.register('audit-writer', recordingHandler().handler);

  const published = await service.publish(
    publishRequest({ eventId: 'evt-1', idempotencyKey: 'k-1' }),
  );
  const before = structuredClone(repository.events()[0]);

  await service.deliver({
    subscription: 'audit-writer',
    worker: WORKER,
    claimToken: 'claim-1',
    now: '2026-03-01T10:00:00Z',
  });
  await service.replay({
    eventId: 'evt-1',
    subscription: 'audit-writer',
    deliveryId: 'replay-1',
    operator: OPERATOR,
    reason: 'rebuild',
    now: '2026-03-02T09:00:00Z',
    discardReceipt: true,
  });
  await service.deliver({
    subscription: 'audit-writer',
    worker: WORKER,
    claimToken: 'claim-2',
    now: '2026-03-02T09:00:00Z',
  });

  const after = repository.events()[0];
  assert.deepEqual(after, before, 'the evidence is unchanged by anything delivery did to it');
  assert.equal(after?.payloadFingerprint, published.event.payloadFingerprint);
  assert.equal(repository.events().length, 1, 'replay redelivers an event, it does not copy one');
});

// ---------------------------------------------------------------------------
// AI cannot mark anything delivered
// ---------------------------------------------------------------------------

test('an AI worker may not claim or acknowledge a delivery', async () => {
  const { service, repository } = build();
  service.register('audit-writer', recordingHandler().handler);
  await service.publish(publishRequest({ eventId: 'evt-1', idempotencyKey: 'k-1' }));

  await assert.rejects(
    service.deliver({
      subscription: 'audit-writer',
      worker: AI,
      claimToken: 'claim-ai',
      now: '2026-03-01T10:00:00Z',
    }),
    (error: unknown) => {
      assert.equal(codeOf(error), 'ai-not-permitted');
      assert.match((error as EventError).message, /really processed it, which AI cannot know/);
      return true;
    },
  );

  assert.equal(deliveryOf(repository, 'audit-writer').status, 'pending', 'nothing was claimed');
  assert.equal(repository.receipts().length, 0);
});

test('delivering to a subscription with no handler is refused rather than burning attempts', async () => {
  const { service, repository } = build();
  await service.publish(publishRequest({ eventId: 'evt-1', idempotencyKey: 'k-1' }));

  await assert.rejects(
    service.deliver({
      subscription: 'search-indexer',
      worker: WORKER,
      claimToken: 'claim-1',
      now: '2026-03-01T10:00:00Z',
    }),
    (error: unknown) => codeOf(error) === 'unknown-subscription',
  );
  assert.equal(deliveryOf(repository, 'search-indexer').attempts, 0, 'no attempt was consumed');

  await assert.rejects(
    service.deliver({
      subscription: 'nobody-subscribed',
      worker: WORKER,
      claimToken: 'claim-2',
      now: '2026-03-01T10:00:00Z',
    }),
    (error: unknown) => codeOf(error) === 'unknown-subscription',
  );
});
