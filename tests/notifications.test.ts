/**
 * K-14 Notifications — contract tests.
 *
 * Proves the public API, every refusal, idempotency, lifecycle, and the fact that the component
 * carries no business-module fields.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FOREIGN_FIELDS,
  InAppNotificationProvider,
  NotificationError,
  NotificationService,
  type Notification,
} from '../kernel/notifications/index.ts';

import {
  build,
  createChannelRequest,
  notificationRecord,
  recordDeliveryAttemptRequest,
  resolveInAppProvider,
  scheduleNotificationRequest,
  sendNotificationRequest,
} from './helpers/notifications-fixtures.ts';

const codeOf = (error: unknown): string | undefined =>
  error instanceof NotificationError ? error.code : undefined;

function service(): NotificationService {
  return new NotificationService(new InMemoryNotificationRepository(), resolveInAppProvider);
}

async function createInAppChannel(
  svc: NotificationService,
  overrides = {},
): Promise<{ channelId: string; idempotencyKey: string }> {
  const result = await svc.createChannel(createChannelRequest(overrides));
  assert.equal(result.deduplicated, false);
  return { channelId: result.channel.channelId, idempotencyKey: result.channel.idempotencyKey };
}

import { InMemoryNotificationRepository } from '../kernel/notifications/index.ts';

// ---------------------------------------------------------------------------
// createChannel
// ---------------------------------------------------------------------------

test('createChannel stores a channel and returns it', async () => {
  const svc = service();
  const request = createChannelRequest();
  const result = await svc.createChannel(request);
  assert.equal(result.deduplicated, false);
  assert.equal(result.channel.channelId, request.channelId);
  assert.equal(result.channel.channel, 'in_app');
  assert.equal(result.channel.provider, 'in_app');
  assert.equal(result.channel.enabled, true);
  assert.deepEqual(Object.keys(result.channel).sort(), [
    'channel',
    'channelId',
    'configuration',
    'createdAt',
    'enabled',
    'idempotencyKey',
    'provider',
  ]);
});

test('createChannel is idempotent for identical requests', async () => {
  const svc = service();
  const request = createChannelRequest();
  const first = await svc.createChannel(request);
  const second = await svc.createChannel(request);
  assert.equal(first.channel.channelId, second.channel.channelId);
  assert.equal(second.deduplicated, true);
});

test('createChannel refuses an invalid channel', async () => {
  const svc = service();
  await assert.rejects(
    svc.createChannel(createChannelRequest({ channel: 'fax' as unknown as 'in_app' })),
    (error: unknown) => codeOf(error) === 'invalid-channel',
  );
});

test('createChannel refuses a malformed instant', async () => {
  const svc = service();
  await assert.rejects(
    svc.createChannel(createChannelRequest({ createdAt: 'tomorrow' })),
    (error: unknown) => codeOf(error) === 'malformed-instant',
  );
});

test('createChannel refuses a foreign field', async () => {
  const svc = service();
  await assert.rejects(
    svc.createChannel({
      ...createChannelRequest(),
      orderId: 'ord_12345678',
    } as unknown as ReturnType<typeof createChannelRequest>),
    (error: unknown) => codeOf(error) === 'foreign-concern',
  );
});

test('createChannel refuses a duplicate channel/provider combination', async () => {
  const svc = service();
  await svc.createChannel(createChannelRequest({ channelId: 'chan_01HQZXDUP01' }));
  await assert.rejects(
    svc.createChannel(
      createChannelRequest({
        channelId: 'chan_01HQZXDUP02',
        provider: 'in_app',
      }),
    ),
    (error: unknown) => codeOf(error) === 'duplicate-channel-provider',
  );
});

test('createChannel refuses an idempotency key reused for a different channel', async () => {
  const svc = service();
  const key = 'idem_reused_channel_0001';
  await svc.createChannel(createChannelRequest({ idempotencyKey: key }));
  await assert.rejects(
    svc.createChannel(createChannelRequest({ idempotencyKey: key })),
    (error: unknown) => codeOf(error) === 'idempotency-key-reuse',
  );
});

test('createChannel refuses a duplicate channel id with different content', async () => {
  const svc = service();
  const channelId = 'chan_01HQZXDUPLICATE01';
  await svc.createChannel(createChannelRequest({ channelId }));
  await assert.rejects(
    svc.createChannel(createChannelRequest({ channelId, provider: 'other' })),
    (error: unknown) => codeOf(error) === 'duplicate-channel-id',
  );
});

// ---------------------------------------------------------------------------
// send
// ---------------------------------------------------------------------------

test('send stores a notification and delivers it in-app', async () => {
  const svc = service();
  await createInAppChannel(svc);
  const request = sendNotificationRequest();
  const result = await svc.send(request);
  assert.equal(result.deduplicated, false);
  assert.equal(result.notification.notificationId, request.notificationId);
  assert.equal(result.notification.status, 'sent');
  assert.equal(result.notification.sentAt, request.createdAt);
});

test('send is idempotent for identical requests', async () => {
  const svc = service();
  await createInAppChannel(svc);
  const request = sendNotificationRequest();
  const first = await svc.send(request);
  const second = await svc.send(request);
  assert.equal(first.notification.notificationId, second.notification.notificationId);
  assert.equal(second.deduplicated, true);
});

test('send refuses when no channel is configured', async () => {
  const svc = service();
  await assert.rejects(
    svc.send(sendNotificationRequest()),
    (error: unknown) => codeOf(error) === 'no-such-channel',
  );
});

test('send refuses a disabled channel', async () => {
  const svc = service();
  await svc.createChannel(createChannelRequest({ enabled: false }));
  await assert.rejects(
    svc.send(sendNotificationRequest()),
    (error: unknown) => codeOf(error) === 'channel-disabled',
  );
});

test('send refuses an invalid channel', async () => {
  const svc = service();
  await assert.rejects(
    svc.send(sendNotificationRequest({ channel: 'fax' as unknown as 'in_app' })),
    (error: unknown) => codeOf(error) === 'invalid-channel',
  );
});

test('send refuses an invalid priority', async () => {
  const svc = service();
  await createInAppChannel(svc);
  await assert.rejects(
    svc.send(sendNotificationRequest({ priority: 'highest' as unknown as 'normal' })),
    (error: unknown) => codeOf(error) === 'invalid-priority',
  );
});

test('send refuses a malformed instant', async () => {
  const svc = service();
  await createInAppChannel(svc);
  await assert.rejects(
    svc.send(sendNotificationRequest({ createdAt: 'tomorrow' })),
    (error: unknown) => codeOf(error) === 'malformed-instant',
  );
});

test('send refuses a foreign field', async () => {
  const svc = service();
  await createInAppChannel(svc);
  await assert.rejects(
    svc.send({ ...sendNotificationRequest(), orderId: 'ord_12345678' } as unknown as ReturnType<
      typeof sendNotificationRequest
    >),
    (error: unknown) => codeOf(error) === 'foreign-concern',
  );
});

test('send refuses a reused idempotency key for a different notification', async () => {
  const svc = service();
  await createInAppChannel(svc);
  const key = 'idem_reused_send_0001';
  await svc.send(sendNotificationRequest({ idempotencyKey: key }));
  await assert.rejects(
    svc.send(sendNotificationRequest({ idempotencyKey: key })),
    (error: unknown) => codeOf(error) === 'idempotency-key-reuse',
  );
});

test('send refuses a duplicate notification id with different content', async () => {
  const svc = service();
  await createInAppChannel(svc);
  const notificationId = 'not_01HQZXDUPLICATE01';
  await svc.send(sendNotificationRequest({ notificationId }));
  await assert.rejects(
    svc.send(sendNotificationRequest({ notificationId, subject: 'Different' })),
    (error: unknown) => codeOf(error) === 'duplicate-notification-id',
  );
});

// ---------------------------------------------------------------------------
// schedule
// ---------------------------------------------------------------------------

test('schedule stores a scheduled notification without delivering', async () => {
  const svc = service();
  await createInAppChannel(svc);
  const request = scheduleNotificationRequest();
  const result = await svc.schedule(request);
  assert.equal(result.deduplicated, false);
  assert.equal(result.notification.notificationId, request.notificationId);
  assert.equal(result.notification.status, 'scheduled');
  assert.equal(result.notification.scheduledAt, request.scheduledAt);
  assert.equal(result.notification.sentAt, null);
});

test('schedule is idempotent for identical requests', async () => {
  const svc = service();
  await createInAppChannel(svc);
  const request = scheduleNotificationRequest();
  const first = await svc.schedule(request);
  const second = await svc.schedule(request);
  assert.equal(first.notification.notificationId, second.notification.notificationId);
  assert.equal(second.deduplicated, true);
});

test('schedule refuses a disabled channel', async () => {
  const svc = service();
  await svc.createChannel(createChannelRequest({ enabled: false }));
  await assert.rejects(
    svc.schedule(scheduleNotificationRequest()),
    (error: unknown) => codeOf(error) === 'channel-disabled',
  );
});

test('schedule refuses a reused idempotency key for a different notification', async () => {
  const svc = service();
  await createInAppChannel(svc);
  const key = 'idem_reused_sched_0001';
  await svc.schedule(scheduleNotificationRequest({ idempotencyKey: key }));
  await assert.rejects(
    svc.schedule(scheduleNotificationRequest({ idempotencyKey: key })),
    (error: unknown) => codeOf(error) === 'idempotency-key-reuse',
  );
});

// ---------------------------------------------------------------------------
// getStatus
// ---------------------------------------------------------------------------

test('getStatus returns the current notification status', async () => {
  const svc = service();
  await createInAppChannel(svc);
  const request = sendNotificationRequest();
  await svc.send(request);
  const status = await svc.getStatus(request.notificationId);
  assert.equal(status, 'sent');
});

test('getStatus refuses a malformed notification id', async () => {
  const svc = service();
  await assert.rejects(
    svc.getStatus('short'),
    (error: unknown) => codeOf(error) === 'malformed-identifier',
  );
});

test('getStatus refuses a missing notification', async () => {
  const svc = service();
  await assert.rejects(
    svc.getStatus('not_01HQZXNOSUCH0001'),
    (error: unknown) => codeOf(error) === 'no-such-notification',
  );
});

// ---------------------------------------------------------------------------
// recordDeliveryAttempt
// ---------------------------------------------------------------------------

test('recordDeliveryAttempt updates a notification to sent', async () => {
  const svc = service();
  await createInAppChannel(svc);
  const request = sendNotificationRequest();
  await svc.send(request);

  const attemptRequest = recordDeliveryAttemptRequest({
    notificationId: request.notificationId,
    attemptedAt: '2026-04-01T12:00:02Z',
  });
  const result = await svc.recordDeliveryAttempt(attemptRequest);
  assert.equal(result.deduplicated, false);
  assert.equal(result.attempt.status, 'success');

  const status = await svc.getStatus(request.notificationId);
  assert.equal(status, 'sent');
});

test('recordDeliveryAttempt updates a notification to failed', async () => {
  const svc = service();
  await createInAppChannel(svc);
  const request = sendNotificationRequest();
  await svc.send(request);

  const attemptRequest = recordDeliveryAttemptRequest({
    notificationId: request.notificationId,
    status: 'failure',
    errorCode: 'provider-unavailable',
    attemptedAt: '2026-04-01T12:00:02Z',
  });
  const result = await svc.recordDeliveryAttempt(attemptRequest);
  assert.equal(result.deduplicated, false);
  assert.equal(result.attempt.status, 'failure');

  const status = await svc.getStatus(request.notificationId);
  assert.equal(status, 'failed');
});

test('recordDeliveryAttempt is idempotent for identical requests', async () => {
  const svc = service();
  await createInAppChannel(svc);
  const request = sendNotificationRequest();
  await svc.send(request);

  const attemptRequest = recordDeliveryAttemptRequest({
    notificationId: request.notificationId,
  });
  const first = await svc.recordDeliveryAttempt(attemptRequest);
  const second = await svc.recordDeliveryAttempt(attemptRequest);
  assert.equal(first.attempt.attemptId, second.attempt.attemptId);
  assert.equal(second.deduplicated, true);
});

test('recordDeliveryAttempt refuses when the notification does not exist', async () => {
  const svc = service();
  await createInAppChannel(svc);
  await assert.rejects(
    svc.recordDeliveryAttempt(recordDeliveryAttemptRequest()),
    (error: unknown) => codeOf(error) === 'no-such-notification',
  );
});

test('recordDeliveryAttempt refuses a channel mismatch', async () => {
  const svc = service();
  await createInAppChannel(svc);
  const request = sendNotificationRequest();
  await svc.send(request);

  await assert.rejects(
    svc.recordDeliveryAttempt(
      recordDeliveryAttemptRequest({
        notificationId: request.notificationId,
        channel: 'email',
      }),
    ),
    (error: unknown) => codeOf(error) === 'malformed-record',
  );
});

test('recordDeliveryAttempt refuses a reused idempotency key for a different attempt', async () => {
  const svc = service();
  await createInAppChannel(svc);
  const request = sendNotificationRequest();
  await svc.send(request);

  const key = 'idem_reused_attempt_0001';
  await svc.recordDeliveryAttempt(
    recordDeliveryAttemptRequest({ notificationId: request.notificationId, idempotencyKey: key }),
  );
  await assert.rejects(
    svc.recordDeliveryAttempt(
      recordDeliveryAttemptRequest({
        notificationId: request.notificationId,
        idempotencyKey: key,
        attemptId: 'att_01HQZXDIFFERENT01',
      }),
    ),
    (error: unknown) => codeOf(error) === 'idempotency-key-reuse',
  );
});

test('recordDeliveryAttempt refuses a duplicate attempt id with different content', async () => {
  const svc = service();
  await createInAppChannel(svc);
  const request = sendNotificationRequest();
  await svc.send(request);

  const attemptId = 'att_01HQZXDUPLICATE01';
  await svc.recordDeliveryAttempt(
    recordDeliveryAttemptRequest({ notificationId: request.notificationId, attemptId }),
  );
  await assert.rejects(
    svc.recordDeliveryAttempt(
      recordDeliveryAttemptRequest({
        notificationId: request.notificationId,
        attemptId,
        provider: 'other',
      }),
    ),
    (error: unknown) => codeOf(error) === 'duplicate-attempt-id',
  );
});

// ---------------------------------------------------------------------------
// Outbox
// ---------------------------------------------------------------------------

test('send writes a sent event and audit action to the outbox', async () => {
  const { service: svc, repository } = build();
  await svc.createChannel(createChannelRequest());
  const request = sendNotificationRequest();
  await svc.send(request);

  const entries = repository.outbox().entries();
  assert.equal(entries.length, 2);
  assert.ok(entries.some((entry) => entry.kind === 'event' && entry.outboxId.includes(':sent')));
  assert.ok(entries.some((entry) => entry.kind === 'audit' && entry.outboxId.includes(':sent')));
});

test('recordDeliveryAttempt writes a failed event and audit action to the outbox', async () => {
  const { service: svc, repository } = build();
  await svc.createChannel(createChannelRequest());
  const request = sendNotificationRequest();
  await svc.send(request);

  await svc.recordDeliveryAttempt(
    recordDeliveryAttemptRequest({
      notificationId: request.notificationId,
      status: 'failure',
      errorCode: 'provider-unavailable',
    }),
  );

  const entries = repository.outbox().entries();
  assert.ok(entries.some((entry) => entry.kind === 'event' && entry.outboxId.includes(':failed')));
  assert.ok(entries.some((entry) => entry.kind === 'audit' && entry.outboxId.includes(':failed')));
});

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

test('InAppNotificationProvider delivers synchronously', async () => {
  const provider = new InAppNotificationProvider();
  const notification: Notification = notificationRecord();
  const attempt = await provider.deliver(notification);
  assert.equal(attempt.status, 'success');
  assert.equal(attempt.channel, 'in_app');
  assert.equal(attempt.provider, 'in_app');
  assert.equal(attempt.notificationId, notification.notificationId);
});

// ---------------------------------------------------------------------------
// Foreign field registry
// ---------------------------------------------------------------------------

test('every FOREIGN_FIELDS entry names an owning component', () => {
  for (const [field, owner] of Object.entries(FOREIGN_FIELDS)) {
    assert.ok(owner.length > 0, `${field} has no owner`);
    assert.match(owner, /owns|belongs? to|is/, `${field} does not name an owner`);
  }
});
