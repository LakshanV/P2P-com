/**
 * K-08 — commit-time conflict parity and transaction composition (FND-003b correction).
 *
 * Two gaps, both invisible from the tests that already existed.
 *
 * **Conflict parity.** The in-memory repository is the reference implementation, so every guarantee
 * proved against it is only worth what its guards are worth. It detected a delivery whose row moved
 * underneath a transaction, but not the three *uniqueness* conflicts PostgreSQL enforces with
 * constraints: a second event under one idempotency key, a second delivery at one
 * `(event, subscription, generation)`, and two live claims holding one token. Each is reachable by
 * two overlapping transactions that each read a store where the row does not yet exist — so each
 * would have passed in memory and failed against a server, which is the worst way round.
 *
 * **Transaction composition.** CONTRACT.md §4 says a producing module must write its domain rows
 * and append its event in one transaction, and until now nothing in the component could do that:
 * `publish` always opened its own. The enlisted path does, and the interesting property is
 * negative — it must issue no `BEGIN`, `COMMIT` or `ROLLBACK` at all, because PostgreSQL has no
 * nested transactions and a stray `COMMIT` would end the caller's.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EnlistedEventRepository,
  EventError,
  EventService,
  EventTypeRegistry,
  InMemoryEventRepository,
  PostgresEventRepository,
  SubscriptionRegistry,
  enlistedClient,
} from '../kernel/event-infrastructure/index.ts';
import type { Delivery } from '../kernel/event-infrastructure/index.ts';

import {
  FAST_POLICY,
  OPERATOR,
  SUBSCRIPTIONS,
  TYPES,
  WORKER,
  build,
  publishRequest,
} from './helpers/event-fixtures.ts';
import { RecordingDatabase } from './helpers/recording-database.ts';

const codeOf = (error: unknown): string | undefined =>
  error instanceof EventError ? error.code : undefined;

const reasons = (results: PromiseSettledResult<unknown>[]): unknown[] =>
  results
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result): unknown => result.reason);

const delivery = (overrides: Partial<Delivery> = {}): Delivery => ({
  deliveryId: 'del-1',
  eventId: 'evt-1',
  subscription: 'audit-writer',
  generation: 1,
  status: 'pending',
  attempts: 0,
  nextAttemptAt: '2026-03-01T10:00:00Z',
  claimedBy: null,
  claimToken: null,
  claimExpiresAt: null,
  lastError: null,
  completedAt: null,
  createdAt: '2026-03-01T10:00:00Z',
  replayOf: null,
  replayReason: null,
  ...overrides,
});

// ---------------------------------------------------------------------------
// 1. Uniqueness conflicts, detected at commit
// ---------------------------------------------------------------------------

test('two overlapping appends under one idempotency key: one wins, one is refused', async () => {
  const repository = new InMemoryEventRepository();
  const envelopeFor = (eventId: string) => ({
    eventId,
    type: 'configuration.version_published',
    schemaVersion: 1,
    occurredAt: '2026-03-01T10:00:00Z',
    recordedAt: '2026-03-01T10:00:00Z',
    producer: 'K-05',
    correlationId: 'corr-1',
    causationId: null,
    payload: { version_id: 'ver-1' },
    payloadFingerprint: 'a'.repeat(64),
    idempotencyKey: 'shared-key',
    origin: 'system' as const,
  });

  // Both transactions read a store with no such key, because both snapshot before either commits.
  const outcomes = await Promise.allSettled([
    repository.withTransaction(async (tx) => {
      assert.equal(await tx.findEventByIdempotencyKey('shared-key'), null);
      await tx.insertEvent(envelopeFor('evt-a'));
    }),
    repository.withTransaction(async (tx) => {
      assert.equal(await tx.findEventByIdempotencyKey('shared-key'), null);
      await tx.insertEvent(envelopeFor('evt-b'));
    }),
  ]);

  assert.equal(reasons(outcomes).length, 1, 'exactly one may hold the key');
  assert.equal(codeOf(reasons(outcomes)[0]), 'idempotency-key-reuse');
  assert.equal(repository.events().length, 1, 'one event, as UNIQUE (idempotency_key) requires');
});

test('two overlapping replays of one delivery: one generation, not two', async () => {
  const repository = new InMemoryEventRepository();
  await repository.withTransaction(async (tx) => {
    await tx.insertEvent({
      eventId: 'evt-1',
      type: 'configuration.version_published',
      schemaVersion: 1,
      occurredAt: '2026-03-01T10:00:00Z',
      recordedAt: '2026-03-01T10:00:00Z',
      producer: 'K-05',
      correlationId: 'corr-1',
      causationId: null,
      payload: { version_id: 'ver-1' },
      payloadFingerprint: 'a'.repeat(64),
      idempotencyKey: 'idem-1',
      origin: 'system',
    });
    await tx.insertDelivery(delivery({ status: 'delivered', completedAt: '2026-03-01T10:01:00Z' }));
  });

  const outcomes = await Promise.allSettled([
    repository.withTransaction(async (tx) => {
      const latest = await tx.findLatestDelivery('evt-1', 'audit-writer');
      await tx.insertDelivery(
        delivery({ deliveryId: 'replay-a', generation: (latest?.generation ?? 0) + 1 }),
      );
    }),
    repository.withTransaction(async (tx) => {
      const latest = await tx.findLatestDelivery('evt-1', 'audit-writer');
      await tx.insertDelivery(
        delivery({ deliveryId: 'replay-b', generation: (latest?.generation ?? 0) + 1 }),
      );
    }),
  ]);

  assert.equal(
    reasons(outcomes).length,
    1,
    'two replays computed generation 2; only one may have it',
  );
  assert.equal(codeOf(reasons(outcomes)[0]), 'concurrent-modification');

  const generations = repository
    .deliveries()
    .filter((row) => row.subscription === 'audit-writer')
    .map((row) => row.generation);
  assert.deepEqual(generations.sort(), [1, 2], 'no duplicate generation survived');
});

test('two overlapping claims offering one token: one claim, not two', async () => {
  const repository = new InMemoryEventRepository();
  await repository.withTransaction(async (tx) => {
    await tx.insertEvent({
      eventId: 'evt-1',
      type: 'configuration.version_published',
      schemaVersion: 1,
      occurredAt: '2026-03-01T10:00:00Z',
      recordedAt: '2026-03-01T10:00:00Z',
      producer: 'K-05',
      correlationId: 'corr-1',
      causationId: null,
      payload: { version_id: 'ver-1' },
      payloadFingerprint: 'a'.repeat(64),
      idempotencyKey: 'idem-1',
      origin: 'system',
    });
    await tx.insertDelivery(delivery({ deliveryId: 'del-1' }));
    await tx.insertDelivery(delivery({ deliveryId: 'del-2', subscription: 'search-indexer' }));
  });

  // Two workers, two different deliveries, but the same token — a caller bug that PostgreSQL
  // catches with UNIQUE (claim_token). Neither transaction can see the other's claim.
  const claim = (subscription: string) =>
    repository.withTransaction((tx) =>
      tx.claimDueDeliveries({
        subscription,
        now: '2026-03-01T10:00:00Z',
        limit: 1,
        worker: 'worker-a',
        claimToken: 'shared-token',
        claimExpiresAt: '2026-03-01T10:05:00Z',
      }),
    );

  const outcomes = await Promise.allSettled([claim('audit-writer'), claim('search-indexer')]);

  assert.equal(reasons(outcomes).length, 1);
  assert.equal(codeOf(reasons(outcomes)[0]), 'claim-token-reuse');
  assert.equal(
    repository.deliveries().filter((row) => row.claimToken === 'shared-token').length,
    1,
    'one live claim holds the token',
  );
});

test('a refused commit writes nothing at all, not merely nothing conflicting', async () => {
  const repository = new InMemoryEventRepository();
  const committedBefore = repository.transactionsCommitted;

  const outcomes = await Promise.allSettled([
    repository.withTransaction(async (tx) => {
      await tx.insertEvent({
        eventId: 'evt-a',
        type: 'configuration.version_published',
        schemaVersion: 1,
        occurredAt: '2026-03-01T10:00:00Z',
        recordedAt: '2026-03-01T10:00:00Z',
        producer: 'K-05',
        correlationId: 'corr-1',
        causationId: null,
        payload: { version_id: 'ver-1' },
        payloadFingerprint: 'a'.repeat(64),
        idempotencyKey: 'shared-key',
        origin: 'system',
      });
      await tx.insertDelivery(delivery({ deliveryId: 'del-a', eventId: 'evt-a' }));
    }),
    repository.withTransaction(async (tx) => {
      await tx.insertEvent({
        eventId: 'evt-b',
        type: 'configuration.version_published',
        schemaVersion: 1,
        occurredAt: '2026-03-01T10:00:00Z',
        recordedAt: '2026-03-01T10:00:00Z',
        producer: 'K-05',
        correlationId: 'corr-2',
        causationId: null,
        payload: { version_id: 'ver-2' },
        payloadFingerprint: 'b'.repeat(64),
        idempotencyKey: 'shared-key',
        origin: 'system',
      });
      await tx.insertDelivery(delivery({ deliveryId: 'del-b', eventId: 'evt-b' }));
    }),
  ]);

  assert.equal(reasons(outcomes).length, 1);
  assert.equal(repository.events().length, 1);
  assert.equal(
    repository.deliveries().length,
    1,
    "the loser's delivery rolled back with its event, rather than being left with nothing to deliver",
  );
  assert.equal(repository.transactionsCommitted, committedBefore + 1);
  assert.equal(repository.transactionsRolledBack, 1);
});

// ---------------------------------------------------------------------------
// 2. Concurrent retries converge
// ---------------------------------------------------------------------------

test('two concurrent identical retries both return the original event and deliveries', async () => {
  const { service, repository } = build();
  const request = publishRequest({ eventId: 'evt-1', idempotencyKey: 'idem-1' });

  const [a, b] = await Promise.all([
    service.publish({ ...request }),
    service.publish({ ...request }),
  ]);

  // Neither caller failed: the publication they were both retrying succeeded, and each is told so.
  assert.equal(a.event.eventId, 'evt-1');
  assert.equal(b.event.eventId, 'evt-1');
  assert.equal(a.event.payloadFingerprint, b.event.payloadFingerprint);
  assert.ok(a.deduplicated || b.deduplicated, 'one of them converged on the other');
  assert.deepEqual(
    [...a.deliveries].map((d) => d.deliveryId).sort(),
    [...b.deliveries].map((d) => d.deliveryId).sort(),
    'and both were handed the same deliveries, not one an empty list',
  );
  assert.equal(a.deliveries.length, 2, 'one per subscriber, once');

  assert.equal(repository.events().length, 1);
  assert.equal(repository.deliveries().length, 2, 'the fan-out happened once');
});

test('three concurrent identical retries still produce exactly one event', async () => {
  const { service, repository } = build();
  const request = publishRequest({ eventId: 'evt-1', idempotencyKey: 'idem-1' });

  const results = await Promise.all([
    service.publish({ ...request }),
    service.publish({ ...request }),
    service.publish({ ...request }),
  ]);

  assert.equal(new Set(results.map((r) => r.event.eventId)).size, 1);
  assert.equal(results.filter((r) => !r.deduplicated).length, 1, 'exactly one did the work');
  assert.equal(repository.events().length, 1);
  assert.equal(repository.deliveries().length, 2);
});

test('concurrent reuse of one key for different content still fails closed', async () => {
  const { service, repository } = build();
  const base = publishRequest({ eventId: 'evt-1', idempotencyKey: 'idem-1' });

  const outcomes = await Promise.allSettled([
    service.publish({ ...base }),
    // Same key, different event. Convergence must not answer this with somebody else's event:
    // that would report success for a change that was never published.
    service.publish({
      ...base,
      eventId: 'evt-2',
      payload: { version_id: 'ver-99', config_key: 'session.timeout_seconds' },
    }),
  ]);

  const failures = reasons(outcomes);
  assert.equal(failures.length, 1, 'one succeeded, one was refused');
  assert.equal(codeOf(failures[0]), 'idempotency-key-reuse');
  assert.match(String((failures[0] as EventError).message), /eventId|payloadFingerprint/);
  assert.equal(repository.events().length, 1);
});

test('a duplicate event id under a different key is a duplicate id, not a convergence', async () => {
  const { service } = build();
  await service.publish(publishRequest({ eventId: 'evt-1', idempotencyKey: 'idem-1' }));

  // Nothing to converge on: the key is unused, so the conflict is exactly what it looks like.
  await assert.rejects(
    service.publish(publishRequest({ eventId: 'evt-1', idempotencyKey: 'idem-2' })),
    (error: unknown) => codeOf(error) === 'duplicate-event-id',
  );
});

test('a concurrent replay and a redelivery do not both create generation 2', async () => {
  const { service, repository } = build();
  service.register('audit-writer', () => Promise.resolve());

  await service.publish(publishRequest({ eventId: 'evt-1', idempotencyKey: 'idem-1' }));
  await service.deliver({
    subscription: 'audit-writer',
    worker: WORKER,
    claimToken: 'claim-1',
    now: '2026-03-01T10:00:00Z',
  });

  const outcomes = await Promise.allSettled([
    service.replay({
      eventId: 'evt-1',
      subscription: 'audit-writer',
      deliveryId: 'replay-a',
      operator: OPERATOR,
      reason: 'first operator',
      now: '2026-03-02T09:00:00Z',
    }),
    service.replay({
      eventId: 'evt-1',
      subscription: 'audit-writer',
      deliveryId: 'replay-b',
      operator: OPERATOR,
      reason: 'second operator, same minute',
      now: '2026-03-02T09:00:00Z',
    }),
  ]);

  assert.equal(reasons(outcomes).length, 1, 'two operators replaying at once: one wins');
  assert.equal(codeOf(reasons(outcomes)[0]), 'concurrent-modification');
  assert.equal(
    repository.deliveries().filter((row) => row.generation === 2).length,
    1,
    'one generation-2 delivery, so the consumer is not handed the same event twice over',
  );
});

// ---------------------------------------------------------------------------
// 3. Enlisting in a transaction the caller owns
// ---------------------------------------------------------------------------

/** A service that appends through a transaction the caller opened, rather than its own. */
const enlistedService = (client: Parameters<typeof enlistedClient>[0]): EventService => {
  const types = new EventTypeRegistry(TYPES);
  return new EventService(
    types,
    new SubscriptionRegistry(SUBSCRIPTIONS, types),
    PostgresEventRepository.enlist(client),
    FAST_POLICY,
  );
};

test('an enlisted append issues no transaction control of its own', async () => {
  const database = new RecordingDatabase({ selects: [{ match: /SELECT/i, rows: [] }] });

  // The caller opens the transaction. This is the producing module's `db.withTransaction(...)`.
  const client = await database.connect();
  await client.query('BEGIN;');
  const service = enlistedService(client);

  const result = await service.publish(
    publishRequest({ eventId: 'evt-1', idempotencyKey: 'idem-1' }),
  );
  assert.equal(result.event.eventId, 'evt-1');

  await client.query('COMMIT;');

  const control = database.statements().filter((sql) => /^(BEGIN|COMMIT|ROLLBACK)/i.test(sql));
  assert.deepEqual(
    control,
    ['BEGIN;', 'COMMIT;'],
    "exactly the caller's two statements; the append added none of its own",
  );
  assert.equal(database.sessionsOpened, 1, 'and it opened no second connection');
  assert.equal(
    database.sessionsReleased,
    0,
    "the caller's connection was not released underneath it",
  );
});

test("an enlisted append writes the event and its deliveries through the caller's client", async () => {
  const database = new RecordingDatabase({ selects: [{ match: /SELECT/i, rows: [] }] });
  const client = await database.connect();
  await client.query('BEGIN;');

  await enlistedService(client).publish(
    publishRequest({ eventId: 'evt-1', idempotencyKey: 'idem-1' }),
  );

  const inserts = database.statements().filter((sql) => /^INSERT INTO/i.test(sql));
  assert.equal(inserts.length, 3, 'one event and two deliveries');
  assert.ok(inserts.some((sql) => sql.includes('kernel_event_infrastructure.event (')));
  assert.equal(
    inserts.filter((sql) => sql.includes('kernel_event_infrastructure.event_delivery')).length,
    2,
  );
});

test('a failure inside an enlisted append propagates, so the caller rolls back', async () => {
  const database = new RecordingDatabase({
    selects: [{ match: /SELECT/i, rows: [] }],
    failOn: /INSERT INTO kernel_event_infrastructure\.event_delivery/i,
  });
  const client = await database.connect();
  await client.query('BEGIN;');

  await assert.rejects(
    enlistedService(client).publish(publishRequest({ eventId: 'evt-1', idempotencyKey: 'idem-1' })),
    // Swallowing this would commit the caller's domain rows with no event — the exact outcome the
    // shared transaction exists to prevent.
    (error: unknown) => error instanceof Error,
  );

  // The caller, not this component, decides what happens next.
  await client.query('ROLLBACK;');
  assert.deepEqual(
    database.statements().filter((sql) => /^(BEGIN|COMMIT|ROLLBACK)/i.test(sql)),
    ['BEGIN;', 'ROLLBACK;'],
    "no COMMIT was issued by the append, and the rollback is the caller's",
  );
});

test('nested transaction control is rejected, not passed through', async () => {
  const database = new RecordingDatabase();
  const client = enlistedClient(await database.connect());

  for (const sql of [
    'BEGIN;',
    '  begin;',
    'START TRANSACTION;',
    'COMMIT;',
    'commit;',
    'END;',
    'ROLLBACK;',
    'SAVEPOINT before_events;',
    'RELEASE SAVEPOINT before_events;',
  ]) {
    await assert.rejects(
      client.query(sql),
      (error: unknown) => {
        assert.equal(codeOf(error), 'nested-transaction');
        return true;
      },
      `${sql} must be refused: PostgreSQL has no nested transactions`,
    );
  }

  // Everything else passes straight through.
  await client.query('SELECT 1;');
  assert.ok(database.statements().includes('SELECT 1;'));
  assert.deepEqual(
    database.statements().filter((sql) => /^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT)/i.test(sql)),
    [],
    'not one of the refused statements reached the database',
  );
});

test('an enlisted repository never releases the connection it was handed', async () => {
  const database = new RecordingDatabase({ selects: [{ match: /SELECT/i, rows: [] }] });
  const client = await database.connect();
  const repository = new EnlistedEventRepository(client);

  await repository.withTransaction((tx) => tx.findEventById('evt-1'));

  assert.equal(
    database.sessionsReleased,
    0,
    'the connection belongs to the caller; releasing it would abort work this component cannot see',
  );
});

test('the repository-owned path still owns its transaction, unchanged', async () => {
  const database = new RecordingDatabase({ selects: [{ match: /SELECT/i, rows: [] }] });
  const repository = new PostgresEventRepository(database);

  await repository.withTransaction((tx) => tx.findEventById('evt-1'));

  assert.deepEqual(
    database.statements().filter((sql) => /^(BEGIN|COMMIT|ROLLBACK)/i.test(sql)),
    ['BEGIN;', 'COMMIT;'],
    'adding the enlisted path must not have changed the standalone one',
  );
  assert.equal(database.sessionsOpened, 1);
  assert.equal(database.sessionsReleased, 1, 'the path that opened the connection closes it');
});
