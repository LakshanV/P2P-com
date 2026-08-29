/**
 * Outbox relay against a live PostgreSQL server (FND-003d).
 *
 * The relay itself is pure logic and is already tested in memory by every module's outbox unit
 * suite. What cannot be proved without a server is that the relay can poll rows from a real module
 * outbox table, dispatch them through real downstream interfaces, mark them processed, and remain
 * idempotent on a second run.
 *
 * The test seeds rows directly into a module-owned outbox table, bypassing the producing service,
 * so the claim is specifically about the relay and the schema — not about any module's publication
 * logic.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type { Database } from '../../platform/db/client.ts';
import { migrateUp } from '../../platform/db/runner.ts';
import { runOutboxRelay } from '../../platform/outbox/relay.ts';
import { PostgresOutboxSource } from '../../platform/outbox/postgres-source.ts';

import { liveTestOptions, withTestDatabase } from './harness.ts';

const SCHEMA = 'kernel_configuration';
const TABLE = `${SCHEMA}.outbox`;

async function seedRows(database: Database): Promise<void> {
  const client = await database.connect();
  try {
    await client.query(
      `INSERT INTO ${TABLE}
         (outbox_id, idempotency_key, kind, payload, recorded_at, producer, correlation_id)
       VALUES
         ($1, $2, $3, $4, $5, $6, $7),
         ($8, $9, $10, $11, $12, $13, $14);`,
      [
        'ob-event-1',
        'idem-event-1',
        'event',
        { type: 'configuration.version_published', version_id: 'ver-1' },
        '2026-01-01T00:00:00Z',
        'K-05',
        'corr-1',
        'ob-audit-1',
        'idem-audit-1',
        'audit',
        { action: 'configuration.version_published', version_id: 'ver-1' },
        '2026-01-01T00:00:01Z',
        'K-05',
        'corr-1',
      ],
    );
  } finally {
    await client.release();
  }
}

async function loadRows(database: Database): Promise<readonly Record<string, unknown>[]> {
  const client = await database.connect();
  try {
    const result = await client.query<Record<string, unknown>>(
      `SELECT outbox_id, kind, processed_at, retry_count, last_error
       FROM ${TABLE}
       ORDER BY recorded_at ASC, outbox_id ASC;`,
    );
    return result.rows;
  } finally {
    await client.release();
  }
}

test(
  'the relay dispatches real outbox rows, marks them processed, and is idempotent',
  liveTestOptions,
  async () => {
    await withTestDatabase(async ({ database, directory }) => {
      await migrateUp(database, { directory, target: '0016' });

      await seedRows(database);

      const source = new PostgresOutboxSource({
        name: 'kernel_configuration',
        schema: SCHEMA,
        database,
      });
      const events: unknown[] = [];
      const audits: unknown[] = [];

      const result = await runOutboxRelay(
        {
          sources: [source],
          events: {
            publish: (request: unknown): Promise<void> => {
              events.push(request);
              return Promise.resolve();
            },
          },
          audit: {
            record: (request: unknown): Promise<void> => {
              audits.push(request);
              return Promise.resolve();
            },
          },
          limit: 10,
        },
        '2026-01-01T01:00:00Z',
      );

      assert.equal(result.dispatched, 2, 'both rows must be dispatched');
      assert.equal(result.failed, 0, 'no row may fail');
      assert.equal(result.skipped, 0, 'no row may be skipped on the first run');
      assert.equal(events.length, 1, 'the event row must reach the event publisher');
      assert.equal(audits.length, 1, 'the audit row must reach the audit recorder');

      const rows = await loadRows(database);
      assert.equal(rows.length, 2);
      assert.ok(
        rows.every((row) => row.processed_at !== null),
        'every row must be marked processed',
      );
      assert.ok(
        rows.every((row) => row.retry_count === 0 && row.last_error === null),
        'a successful dispatch leaves no error or retry state',
      );

      const rerun = await runOutboxRelay(
        {
          sources: [source],
          events: { publish: (): Promise<void> => Promise.reject(new Error('must not be called')) },
          audit: { record: (): Promise<void> => Promise.reject(new Error('must not be called')) },
          limit: 10,
        },
        '2026-01-01T01:01:00Z',
      );

      assert.equal(rerun.dispatched, 0, 'processed rows are not dispatched again');
      assert.equal(rerun.failed, 0, 'processed rows must not fail');
      assert.equal(
        rerun.dispatched + rerun.failed,
        0,
        'no downstream handler may be invoked once the rows are processed',
      );
    });
  },
);
