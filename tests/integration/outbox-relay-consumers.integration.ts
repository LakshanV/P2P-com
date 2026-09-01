/**
 * Module outbox rows reach K-08 Event Infrastructure and K-09 Audit Foundation end-to-end.
 *
 * This test proves that a module-owned outbox row produced by a real business mutation is dispatched
 * by the platform relay, through the K-08 and K-09 adapters, and lands as a durable event and audit
 * record. It is the live-PostgreSQL counterpart to the in-memory outbox tests in each kernel component.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type { Database } from '../../platform/db/client.ts';

import {
  AuditActionRegistry,
  AuditService,
  AuditServiceRecorder,
  PostgresAuditRepository,
} from '../../kernel/audit-foundation/index.ts';
import {
  CONFIGURATION_VERSION_PUBLISHED_ACTION,
  CONFIGURATION_VERSION_PUBLISHED_EVENT,
  ConfigurationRegistry,
  ConfigurationService,
  GLOBAL_SCOPE,
  PostgresConfigurationRepository,
} from '../../kernel/configuration/index.ts';
import {
  EventService,
  EventServicePublisher,
  EventTypeRegistry,
  PostgresEventRepository,
  SubscriptionRegistry,
} from '../../kernel/event-infrastructure/index.ts';
import { migrateUp } from '../../platform/db/runner.ts';
import { runOutboxRelay } from '../../platform/outbox/relay.ts';
import { PostgresOutboxSource } from '../../platform/outbox/postgres-source.ts';

import { liveTestOptions, withTestDatabase } from './harness.ts';

const KEYS = [
  {
    id: 'session.timeout_seconds',
    description: 'How long an idle session survives.',
    schema: { kind: 'duration-seconds', minimum: 60, maximum: 86_400 },
    scopes: ['global', 'tenant'],
  },
] as const;

const OUTBOX_SCHEMAS = [
  'kernel_configuration',
  'kernel_feature_flags',
  'kernel_policy_engine',
  'kernel_commerce_unit_registry',
] as const;

test(
  'module outbox rows are dispatched to K-08 events and K-09 audit records',
  liveTestOptions,
  async () => {
    await withTestDatabase(async ({ database, directory }) => {
      // Migrated in full rather than to 0016: the relay reads next_attempt_at and dead_lettered_at,
      // which migration 0035 adds to this table.
      await migrateUp(database, { directory });

      const configService = new ConfigurationService(
        new ConfigurationRegistry(KEYS),
        new PostgresConfigurationRepository(database),
      );

      const eventService = new EventService(
        new EventTypeRegistry([CONFIGURATION_VERSION_PUBLISHED_EVENT]),
        new SubscriptionRegistry(
          [],
          new EventTypeRegistry([CONFIGURATION_VERSION_PUBLISHED_EVENT]),
        ),
        new PostgresEventRepository(database),
      );

      const auditService = new AuditService(
        new AuditActionRegistry([CONFIGURATION_VERSION_PUBLISHED_ACTION]),
        new PostgresAuditRepository(database),
      );

      const result = await configService.publish({
        key: 'session.timeout_seconds',
        scope: GLOBAL_SCOPE,
        value: 900,
        effectiveFrom: '2026-01-01T00:00:00Z',
        expectedActiveVersionId: null,
        idempotencyKey: 'idem-1',
        versionId: 'ver-1',
        origin: 'human',
        authorityLevel: 'global',
        now: '2026-01-01T00:00:00Z',
      });
      assert.equal(result.deduplicated, false, 'the publication must create a new version');

      const sources = OUTBOX_SCHEMAS.map(
        (schema) => new PostgresOutboxSource({ name: schema, schema, database }),
      );

      const relay = await runOutboxRelay(
        {
          sources,
          events: new EventServicePublisher(eventService),
          audit: new AuditServiceRecorder(auditService),
          limit: 100,
        },
        '2026-01-01T01:00:00Z',
      );

      assert.equal(
        relay.dispatched,
        2,
        'the K-05 publication produced one event and one audit row',
      );
      assert.equal(relay.failed, 0, 'no dispatch may fail against valid K-08/K-09 payloads');
      assert.equal(relay.skipped, 0, 'unprocessed rows are not skipped');

      const eventCount = await countEvents(database);
      assert.equal(eventCount, 1, 'exactly one event must be persisted in K-08');

      const auditCount = await countAuditRecords(database);
      assert.equal(auditCount, 1, 'exactly one audit record must be persisted in K-09');

      const outboxProcessed = await countProcessedOutboxRows(database, 'kernel_configuration');
      assert.equal(outboxProcessed, 2, 'both outbox rows must be marked processed');

      const rerun = await runOutboxRelay(
        {
          sources,
          events: new EventServicePublisher(eventService),
          audit: new AuditServiceRecorder(auditService),
          limit: 100,
        },
        '2026-01-01T01:01:00Z',
      );

      assert.equal(rerun.dispatched, 0, 'processed rows must not be dispatched again');
      assert.equal(rerun.failed, 0, 'processed rows must not fail');
      assert.equal(await countEvents(database), 1, 'no duplicate events');
      assert.equal(await countAuditRecords(database), 1, 'no duplicate audit records');
    });
  },
);

async function countEvents(database: Database): Promise<number> {
  const client = await database.connect();
  try {
    const result = await client.query<{ count: string }>(
      'SELECT count(*) AS count FROM kernel_event_infrastructure.event;',
    );
    return Number(result.rows[0]?.count ?? 0);
  } finally {
    await client.release();
  }
}

async function countAuditRecords(database: Database): Promise<number> {
  const client = await database.connect();
  try {
    const result = await client.query<{ count: string }>(
      'SELECT count(*) AS count FROM kernel_audit_foundation.audit_record;',
    );
    return Number(result.rows[0]?.count ?? 0);
  } finally {
    await client.release();
  }
}

async function countProcessedOutboxRows(database: Database, schema: string): Promise<number> {
  const client = await database.connect();
  try {
    const result = await client.query<{ count: string }>(
      `SELECT count(*) AS count FROM ${schema}.outbox WHERE processed_at IS NOT NULL;`,
    );
    return Number(result.rows[0]?.count ?? 0);
  } finally {
    await client.release();
  }
}
