/**
 * K-08 claims a **batch**, against a real PostgreSQL server.
 *
 * This suite exists because of a defect that survived from migration 0004 until an end-to-end
 * journey happened to produce two due deliveries for one subscription at the same moment.
 *
 * `claimDueDeliveries(limit)` stamps every row in the batch with the same claim token — the token
 * identifies one *claim*, and a claim covers a batch. `UNIQUE (claim_token)` allowed it on exactly
 * one row, so any claim of more than one delivery failed with a constraint violation from inside
 * the claim. **Batching never worked against PostgreSQL**, and a subscription with a backlog made no
 * progress at all rather than making progress one row at a time.
 *
 * Every unit test passed throughout, because the in-memory repository allowed the batch. That is the
 * shape of failure this file is for: the two implementations disagreeing about something no test
 * asked either of them.
 *
 * The other half is that reuse is **still** refused. Two claims that cannot be told apart defeat the
 * guard that stops a worker whose lease expired from acknowledging work somebody else now owns, and
 * that guard is the whole reason the token exists.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EventError,
  EventService,
  EventTypeRegistry,
  PostgresEventRepository,
  SubscriptionRegistry,
  type EventTypeDefinition,
} from '../../kernel/event-infrastructure/index.ts';
import { migrateUp } from '../../platform/db/runner.ts';
import type { Database } from '../../platform/db/client.ts';

import { liveTestOptions, withTestDatabase } from './harness.ts';

const NOW = '2026-07-01T09:00:00.000000Z';
const LATER = '2026-07-01T09:05:00.000000Z';

const TYPE: EventTypeDefinition = {
  type: 'inventory.item_reserved',
  schemaVersion: 1,
  owner: 'M-04',
  description: 'Stock was held for an order line.',
  payloadFields: [
    { name: 'listing_id', kind: 'string', required: true, description: 'The listing.' },
  ],
};

const SUBSCRIPTION = {
  subscription: 'batching-consumer',
  owner: 'apps/api',
  types: ['inventory.item_reserved'],
  description:
    'A consumer that receives more than one event at a time, which is the ordinary case.',
};

function serviceFor(database: Database): EventService {
  const types = new EventTypeRegistry([TYPE]);
  return new EventService(
    types,
    new SubscriptionRegistry([SUBSCRIPTION], types),
    new PostgresEventRepository(database),
  );
}

/** Publish `count` events, so the subscription has a backlog to claim. */
async function publish(events: EventService, count: number): Promise<void> {
  for (let index = 1; index <= count; index += 1) {
    const tag = String(index).padStart(4, '0');
    await events.publish({
      eventId: `evt_live_claim${tag}`,
      type: TYPE.type,
      schemaVersion: 1,
      occurredAt: NOW,
      producer: 'M-04',
      correlationId: `corr_live_claim${tag}`,
      causationId: null,
      origin: 'system',
      actor: { kind: 'system', id: 'M-04' },
      idempotencyKey: `idem_live_claim${tag}`,
      now: NOW,
      payload: { listing_id: `lst_live_claim${tag}` },
    });
  }
}

test('a consumer claims several due deliveries at once', liveTestOptions, async () => {
  await withTestDatabase(async ({ database, directory }) => {
    await migrateUp(database, { directory });
    const events = serviceFor(database);

    const handled: string[] = [];
    events.register(SUBSCRIPTION.subscription, (context) => {
      handled.push(context.envelope.eventId);
      return Promise.resolve();
    });

    await publish(events, 3);

    const outcomes = await events.deliver({
      subscription: SUBSCRIPTION.subscription,
      worker: { kind: 'system', id: 'batching-worker' },
      claimToken: 'clm_live_claim000001',
      now: LATER,
      limit: 10,
    });

    assert.equal(
      outcomes.length,
      3,
      'all three were claimed in one call. Before migration 0056 this violated a unique index and ' +
        'the whole claim failed, so a subscription with a backlog made no progress at all',
    );
    assert.equal(handled.length, 3, 'and the handler ran for each');

    const remaining = await events.deliver({
      subscription: SUBSCRIPTION.subscription,
      worker: { kind: 'system', id: 'batching-worker' },
      claimToken: 'clm_live_claim000002',
      now: LATER,
      limit: 10,
    });
    assert.equal(
      remaining.length,
      0,
      'and nothing is left due, because all three were acknowledged',
    );
  });
});

test('every row in one batch carries the same claim token', liveTestOptions, async () => {
  // The property migration 0056 makes storable. A token identifies one claim, and a claim covers a
  // batch — so a stale worker presenting an old token finds nothing to update, for every row it
  // once held rather than for one of them.
  await withTestDatabase(async ({ database, directory }) => {
    await migrateUp(database, { directory });
    const events = serviceFor(database);

    // A handler that refuses, so the deliveries stay in flight and their claim is observable.
    events.register(SUBSCRIPTION.subscription, () =>
      Promise.reject(new Error('the consumer is down')),
    );

    await publish(events, 2);
    await events.deliver({
      subscription: SUBSCRIPTION.subscription,
      worker: { kind: 'system', id: 'batching-worker' },
      claimToken: 'clm_live_claim000003',
      now: LATER,
      limit: 10,
    });

    const client = await database.connect();
    try {
      const rows = await client.query<{ attempts: number; last_error: string | null }>(
        `SELECT attempts, last_error FROM kernel_event_infrastructure.event_delivery
          ORDER BY delivery_id;`,
      );
      assert.equal(rows.rows.length, 2);
      assert.ok(
        rows.rows.every((row) => row.attempts === 1),
        'both were attempted, which means both were claimed',
      );
      assert.ok(
        rows.rows.every((row) => (row.last_error ?? '').includes('the consumer is down')),
        'and both recorded the same refusal, rather than one failing on a constraint',
      );
    } finally {
      await client.release();
    }
  });
});

test('a reused claim token is still refused', liveTestOptions, async () => {
  // Moved from a unique index to a check inside the claim, and it must keep biting: two claims that
  // cannot be told apart defeat the guard that stops a worker whose lease expired from
  // acknowledging work another worker now owns. Exercised through the repository rather than the
  // service, because a token is held only while a claim is in flight — and `deliver` always runs a
  // handler, which resolves the claim one way or the other before it returns.
  await withTestDatabase(async ({ database, directory }) => {
    await migrateUp(database, { directory });
    const events = serviceFor(database);
    await publish(events, 2);

    const repository = new PostgresEventRepository(database);
    const claim = (claimToken: string): Promise<readonly unknown[]> =>
      repository.withTransaction((tx) =>
        tx.claimDueDeliveries({
          subscription: SUBSCRIPTION.subscription,
          now: LATER,
          limit: 1,
          worker: 'batching-worker',
          claimToken,
          claimExpiresAt: '2026-07-01T09:30:00.000000Z',
        }),
      );

    const first = await claim('clm_live_claim000004');
    assert.equal(first.length, 1, 'the first claim holds a delivery');

    await assert.rejects(
      claim('clm_live_claim000004'),
      (error: unknown) => error instanceof EventError && error.code === 'claim-token-reuse',
    );

    // A different token claims the other one, which is what a second worker legitimately does.
    const second = await claim('clm_live_claim000005');
    assert.equal(second.length, 1);
  });
});
