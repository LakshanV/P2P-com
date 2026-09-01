/**
 * The outbox relay worker against a live PostgreSQL server — opt-in, and honestly skipped otherwise.
 *
 * Two properties can only be shown here, because both are about what the database does when two
 * processes want the same row.
 *
 * **`FOR UPDATE SKIP LOCKED` is what makes a second relay safe.** Two sources polling the same table
 * concurrently must partition the work between them, not both be handed it. Without that, every fact
 * is published twice, and a consumer that deduplicates is not something a relay may assume. The
 * in-memory reference cannot demonstrate this at all: there is no lock to skip.
 *
 * **The claim is a lease, not a lock.** The claiming transaction commits immediately — so a relay
 * that dies mid-dispatch does not hold the row for ever — and pushes `next_attempt_at` out, so a
 * second relay does not re-claim what the first is still working on.
 *
 * Also proved here: that migrations 0033–0047 gave every outbox table the columns the relay needs,
 * that a dead-lettered row is never claimed again, and that the database refuses to record a
 * dead-lettered row as processed.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { migrateUp } from '../../platform/db/runner.ts';
import type { Database } from '../../platform/db/client.ts';
import { PostgresOutboxSource } from '../../platform/outbox/postgres-source.ts';
import { runOutboxRelay } from '../../platform/outbox/relay.ts';
import { OutboxRelayWorker, type PassSummary } from '../../platform/outbox/worker.ts';

import { liveTestOptions, withTestDatabase } from './harness.ts';

const SCHEMA = 'kernel_configuration';
const TABLE = `${SCHEMA}.outbox`;

/** Every schema that owns an outbox table, so the column check covers all of them. */
const OUTBOX_SCHEMAS: readonly string[] = [
  'kernel_ai_gateway',
  'kernel_commerce_unit_registry',
  'kernel_configuration',
  'kernel_conversation_foundation',
  'kernel_feature_flags',
  'kernel_ledger_foundation',
  'kernel_notifications',
  'kernel_policy_engine',
  'kernel_search_foundation',
  'module_capability_verification',
  'module_financial_ledger',
  'module_orders',
  'module_payments',
  'module_universal_account',
  'module_universal_listing',
];

async function seed(database: Database, count: number): Promise<void> {
  const client = await database.connect();
  try {
    for (let index = 0; index < count; index += 1) {
      const id = `ob-${String(index).padStart(4, '0')}`;
      await client.query(
        `INSERT INTO ${TABLE}
           (outbox_id, idempotency_key, kind, payload, recorded_at, producer, correlation_id)
         VALUES ($1, $2, 'event', $3::jsonb, $4::timestamptz, 'K-05', 'corr-relay');`,
        [id, `idem-${id}`, JSON.stringify({ id }), '2026-01-01T00:00:00Z'],
      );
    }
  } finally {
    await client.release();
  }
}

async function scalar(database: Database, sql: string): Promise<string> {
  const client = await database.connect();
  try {
    const result = await client.query<{ value: string }>(sql);
    return String(result.rows[0]?.value ?? '');
  } finally {
    await client.release();
  }
}

test('every outbox table has the columns a production relay needs', liveTestOptions, async () => {
  await withTestDatabase(async ({ database, directory }) => {
    await migrateUp(database, { directory });

    const client = await database.connect();
    try {
      for (const schema of OUTBOX_SCHEMAS) {
        const result = await client.query<{ column_name: string }>(
          `SELECT column_name FROM information_schema.columns
              WHERE table_schema = $1 AND table_name = 'outbox'
                AND column_name IN ('next_attempt_at', 'dead_lettered_at', 'dead_letter_reason')
              ORDER BY column_name;`,
          [schema],
        );
        assert.deepEqual(
          result.rows.map((row) => row.column_name),
          ['dead_letter_reason', 'dead_lettered_at', 'next_attempt_at'],
          `${schema}.outbox is missing relay columns. The outbox is one contract every producer ` +
            'implements identically; a source the relay cannot treat like the others is a source ' +
            'whose events silently stop being published',
        );
      }
    } finally {
      await client.release();
    }
  });
});

test(
  'two relays polling the same table partition the work rather than duplicating it',
  liveTestOptions,
  async () => {
    await withTestDatabase(async ({ database, directory }) => {
      await migrateUp(database, { directory });
      await seed(database, 20);

      // Two sources, two connections, one table. This is the case the whole claim design exists for.
      const first = new PostgresOutboxSource({ name: 'a', schema: SCHEMA, database });
      const second = new PostgresOutboxSource({ name: 'b', schema: SCHEMA, database });

      const dispatched: string[] = [];
      const publisher = {
        publish: (request: unknown): Promise<void> => {
          dispatched.push(String((request as { id?: string }).id));
          return Promise.resolve();
        },
      };

      const [left, right] = await Promise.all([
        runOutboxRelay({ sources: [first], events: publisher, limit: 20 }, '2026-01-01T01:00:00Z'),
        runOutboxRelay({ sources: [second], events: publisher, limit: 20 }, '2026-01-01T01:00:00Z'),
      ]);

      assert.equal(
        left.dispatched + right.dispatched,
        20,
        'every row must be dispatched exactly once between the two relays',
      );
      assert.equal(
        new Set(dispatched).size,
        20,
        'a row dispatched by both relays publishes one fact twice, and a consumer that ' +
          'deduplicates is not something a relay may assume',
      );
      assert.equal(
        await scalar(
          database,
          `SELECT count(*) AS value FROM ${TABLE} WHERE processed_at IS NULL;`,
        ),
        '0',
      );
    });
  },
);

test(
  'a claimed row is leased, so a second relay does not re-take it immediately',
  liveTestOptions,
  async () => {
    await withTestDatabase(async ({ database, directory }) => {
      await migrateUp(database, { directory });
      await seed(database, 3);

      const claimer = new PostgresOutboxSource({
        name: 'a',
        schema: SCHEMA,
        database,
        leaseMillis: 30_000,
      });
      const other = new PostgresOutboxSource({ name: 'b', schema: SCHEMA, database });

      const claimed = await claimer.poll(3, '2026-01-01T01:00:00Z');
      assert.equal(claimed.length, 3);

      // The claiming transaction has committed, so the row locks are gone — but the lease has not
      // expired, so nothing is claimable.
      const immediately = await other.poll(3, '2026-01-01T01:00:00Z');
      assert.deepEqual(
        immediately.map((row) => row.outboxId),
        [],
        'a second relay re-took rows the first is still dispatching',
      );

      // Once the lease expires, an abandoned row is claimable again: the lease is what stops a
      // crashed relay stranding work for ever.
      const later = await other.poll(3, '2026-01-01T01:01:00Z');
      assert.equal(later.length, 3, 'a crashed relay must not hold a row past its lease');
    });
  },
);

test(
  'a failing row is deferred, then given up on, and never claimed again',
  liveTestOptions,
  async () => {
    await withTestDatabase(async ({ database, directory }) => {
      await migrateUp(database, { directory });
      await seed(database, 1);

      const source = new PostgresOutboxSource({ name: 'a', schema: SCHEMA, database });
      const alwaysFails = {
        publish: (): Promise<void> => Promise.reject(new Error('the event log is unreachable')),
      };
      const policy = { baseMillis: 1_000, ceilingMillis: 2_000, maxAttempts: 3 };

      let deadLettered = 0;
      for (let pass = 0; pass < 4; pass += 1) {
        // Each pass is a minute later, well past both the backoff and the lease.
        const now = `2026-01-01T0${String(pass + 1)}:00:00Z`;
        const result = await runOutboxRelay(
          { sources: [source], events: alwaysFails, backoff: policy },
          now,
        );
        deadLettered += result.deadLettered;
      }

      assert.equal(deadLettered, 1, 'the relay gave up exactly once');

      assert.equal(
        await scalar(
          database,
          `SELECT count(*) AS value FROM ${TABLE} WHERE dead_lettered_at IS NOT NULL;`,
        ),
        '1',
      );
      assert.equal(
        await scalar(
          database,
          `SELECT count(*) AS value FROM ${TABLE} WHERE processed_at IS NOT NULL;`,
        ),
        '0',
        'a dead-lettered row was never dispatched; recording it as processed would tell every ' +
          'reader the opposite of what happened',
      );

      // And it is out of the claimable set for good.
      const nothing = await source.poll(10, '2027-01-01T00:00:00Z');
      assert.deepEqual(nothing, []);

      const abandoned = await source.deadLettered(10);
      assert.equal(abandoned.length, 1);
      assert.match(String(abandoned[0]?.deadLetterReason), /gave up after 3 attempts/);
    });
  },
);

test(
  'the database refuses to record a dead-lettered row as processed',
  liveTestOptions,
  async () => {
    await withTestDatabase(async ({ database, directory }) => {
      await migrateUp(database, { directory });
      await seed(database, 1);

      const client = await database.connect();
      try {
        await client.query(
          `UPDATE ${TABLE} SET dead_lettered_at = now(), dead_letter_reason = 'poisoned'
            WHERE outbox_id = 'ob-0000';`,
        );

        let refused: string | null = null;
        try {
          await client.query(
            `UPDATE ${TABLE} SET processed_at = now() WHERE outbox_id = 'ob-0000';`,
          );
        } catch (error) {
          refused = error instanceof Error ? error.message : String(error);
        }
        assert.ok(refused !== null, 'a dead-lettered row was recorded as processed');
        assert.match(refused, /dead_letter_is_not_processed/);

        // And a dead-letter decision nobody can reconstruct is refused too.
        let unexplained: string | null = null;
        try {
          await client.query(
            `UPDATE ${TABLE} SET dead_letter_reason = NULL WHERE outbox_id = 'ob-0000';`,
          );
        } catch (error) {
          unexplained = error instanceof Error ? error.message : String(error);
        }
        assert.ok(unexplained !== null, 'a row was abandoned with no reason recorded');
      } finally {
        await client.release();
      }
    });
  },
);

test(
  'the worker drains a backlog against a real database and stops cleanly',
  liveTestOptions,
  async () => {
    await withTestDatabase(async ({ database, directory }) => {
      await migrateUp(database, { directory });
      await seed(database, 25);

      const source = new PostgresOutboxSource({ name: 'a', schema: SCHEMA, database });
      const summaries: PassSummary[] = [];

      let tick = 0;
      const worker = new OutboxRelayWorker(
        { sources: [source], limit: 10, maxPasses: 10, busyMillis: 0, idleMillis: 0 },
        {
          now: () => {
            tick += 1;
            return `2026-01-01T0${String(Math.min(tick, 9))}:00:00Z`;
          },
          sleep: () => Promise.resolve(),
          onPass: (summary) => summaries.push(summary),
        },
      );

      const report = await worker.run();

      assert.equal(report.dispatched, 25, 'the whole backlog was drained');
      assert.equal(report.failed, 0);
      assert.equal(report.sourceFailures, 0);
      assert.equal(
        await scalar(
          database,
          `SELECT count(*) AS value FROM ${TABLE} WHERE processed_at IS NULL;`,
        ),
        '0',
      );
      assert.ok(
        summaries.length >= 3,
        'a limit of ten against twenty-five rows takes at least three passes',
      );
      assert.equal(worker.running, false, 'the worker stopped cleanly');
    });
  },
);
