/**
 * K-14 Notifications against a live PostgreSQL server — opt-in, and honestly skipped otherwise.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  InAppNotificationProvider,
  NotificationService,
  PostgresNotificationRepository,
} from '../../kernel/notifications/index.ts';
import { migrateDown, migrateUp } from '../../platform/db/runner.ts';
import type { Database } from '../../platform/db/client.ts';

import {
  createChannelRequest,
  recordDeliveryAttemptRequest,
  scheduleNotificationRequest,
  sendNotificationRequest,
} from '../helpers/notifications-fixtures.ts';
import {
  developmentDatabaseName,
  developmentSnapshot,
  liveTestOptions,
  withTestDatabase,
} from './harness.ts';

function resolveInAppProvider(provider: string): InAppNotificationProvider {
  if (provider === 'in_app') return new InAppNotificationProvider();
  throw new Error(`provider ${provider} has no test adapter`);
}

async function count(database: Database, table: string): Promise<number> {
  const client = await database.connect();
  try {
    const result = await client.query<{ count: string }>(`SELECT count(*) AS count FROM ${table};`);
    return Number(result.rows[0]?.count ?? 0);
  } finally {
    await client.release();
  }
}

async function refuses(database: Database, sql: string): Promise<string | null> {
  const client = await database.connect();
  try {
    await client.query(sql);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  } finally {
    await client.release();
  }
}

test(
  'creates a channel, sends, schedules, and records a delivery attempt end-to-end',
  liveTestOptions,
  async () => {
    const before = await developmentSnapshot();

    await withTestDatabase(async ({ database, directory, name }) => {
      assert.notEqual(
        name,
        developmentDatabaseName(),
        'the target is never the development database',
      );
      await migrateUp(database, { directory });

      const service = new NotificationService(
        new PostgresNotificationRepository(database),
        resolveInAppProvider,
      );

      const channel = await service.createChannel(createChannelRequest());
      assert.equal(channel.deduplicated, false);

      const sendRequest = sendNotificationRequest();
      const sent = await service.send(sendRequest);
      assert.equal(sent.deduplicated, false);
      assert.equal(sent.notification.status, 'sent');
      assert.equal(sent.notification.sentAt, sendRequest.createdAt);

      const status = await service.getStatus(sendRequest.notificationId);
      assert.equal(status, 'sent');

      const scheduleRequest = scheduleNotificationRequest();
      const scheduled = await service.schedule(scheduleRequest);
      assert.equal(scheduled.deduplicated, false);
      assert.equal(scheduled.notification.status, 'scheduled');

      const failedAttempt = recordDeliveryAttemptRequest({
        notificationId: sendRequest.notificationId,
        status: 'failure',
        errorCode: 'provider-unavailable',
        attemptedAt: '2026-04-01T12:00:02Z',
      });
      const attempt = await service.recordDeliveryAttempt(failedAttempt);
      assert.equal(attempt.deduplicated, false);
      assert.equal(attempt.attempt.status, 'failure');

      assert.equal(await count(database, 'kernel_notifications.channel'), 1);
      assert.equal(await count(database, 'kernel_notifications.notification'), 2);
      assert.equal(await count(database, 'kernel_notifications.delivery_attempt'), 2);
      assert.equal(await count(database, 'kernel_notifications.outbox'), 4);
    });

    const after = await developmentSnapshot();
    assert.deepEqual(
      after.applied.map((entry) => entry.version),
      before.applied.map((entry) => entry.version),
      'the development database was read and never written',
    );
  },
);

test('the database refuses a duplicate channel/provider pair', liveTestOptions, async () => {
  await withTestDatabase(async ({ database, directory }) => {
    await migrateUp(database, { directory });
    const service = new NotificationService(
      new PostgresNotificationRepository(database),
      resolveInAppProvider,
    );

    await service.createChannel(createChannelRequest({ channelId: 'chan_dup_01' }));

    const result = await refuses(
      database,
      `INSERT INTO kernel_notifications.channel
         (channel_id, channel, provider, enabled, configuration, created_at, idempotency_key)
       VALUES ('chan_dup_02', 'in_app', 'in_app', true, '{}', '2026-04-01T12:00:00Z', 'idem_chan_dup_02');`,
    );
    assert.ok(result !== null, 'a duplicate channel/provider pair must be refused');
    assert.match(result, /unique constraint/i);
  });
});

test('the database refuses to mutate a channel', liveTestOptions, async () => {
  await withTestDatabase(async ({ database, directory }) => {
    await migrateUp(database, { directory });
    const service = new NotificationService(
      new PostgresNotificationRepository(database),
      resolveInAppProvider,
    );

    const channel = await service.createChannel(
      createChannelRequest({ channelId: 'chan_mutate_01' }),
    );

    const update = await refuses(
      database,
      `UPDATE kernel_notifications.channel SET enabled = false WHERE channel_id = '${channel.channel.channelId}';`,
    );
    assert.ok(update !== null, 'updating a channel must be refused');
    assert.match(update, /append-only/i);

    const deleteChannel = await refuses(
      database,
      `DELETE FROM kernel_notifications.channel WHERE channel_id = '${channel.channel.channelId}';`,
    );
    assert.ok(deleteChannel !== null, 'deleting a channel must be refused');
    assert.match(deleteChannel, /append-only/i);
  });
});

test('the database enforces the notification status enum', liveTestOptions, async () => {
  await withTestDatabase(async ({ database, directory }) => {
    await migrateUp(database, { directory });

    const result = await refuses(
      database,
      `INSERT INTO kernel_notifications.notification
         (notification_id, account_id, channel, template_id, subject, body, payload, priority, status, scheduled_at, sent_at, created_at, idempotency_key)
       VALUES ('not_bad_status_01', 'acct_01HQZXBADSTAT', 'in_app', 'tmpl', 'Subj', 'Body', '{}', 'normal', 'cancelled', null, null, '2026-04-01T12:00:00Z', 'idem_not_badstatus_01');`,
    );
    assert.ok(result !== null, 'an unknown status must be refused');
    assert.match(result, /notification_status_known/i);
  });
});

test(
  'kernel_notifications rolls back independently of other schemas',
  liveTestOptions,
  async () => {
    await withTestDatabase(async ({ database, directory }) => {
      await migrateUp(database, { directory, target: '0020' });
      const service = new NotificationService(
        new PostgresNotificationRepository(database),
        resolveInAppProvider,
      );

      await service.createChannel(createChannelRequest({ channelId: 'chan_rollback_01' }));

      await migrateDown(database, { directory, version: '0020' });

      const client = await database.connect();
      try {
        await assert.rejects(client.query('SELECT 1 FROM kernel_notifications.channel LIMIT 1;'));
      } finally {
        await client.release();
      }
    });
  },
);
