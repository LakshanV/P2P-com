/**
 * Shared fixtures for the K-14 Notifications suites.
 */

import {
  InAppNotificationProvider,
  InMemoryNotificationRepository,
  NotificationService,
  type CreateChannelRequest,
  type DeliveryAttempt,
  type Notification,
  type NotificationChannel,
  type RecordDeliveryAttemptRequest,
  type ScheduleNotificationRequest,
  type SendNotificationRequest,
} from '../../kernel/notifications/index.ts';

export interface Harness {
  readonly service: NotificationService;
  readonly repository: InMemoryNotificationRepository;
}

export function resolveInAppProvider(provider: string): InAppNotificationProvider {
  if (provider === 'in_app') return new InAppNotificationProvider();
  throw new Error(`provider ${provider} has no test adapter`);
}

export function build(): Harness {
  const repository = new InMemoryNotificationRepository();
  return {
    service: new NotificationService(repository, resolveInAppProvider),
    repository,
  };
}

let sequence = 0;

function seq(): string {
  sequence += 1;
  return String(sequence).padStart(4, '0');
}

export function createChannelRequest(
  overrides: Partial<CreateChannelRequest> = {},
): CreateChannelRequest {
  const n = seq();
  return {
    channelId: `chan_01HQZX${n}`,
    channel: 'in_app',
    provider: 'in_app',
    enabled: true,
    configuration: {},
    createdAt: '2026-04-01T12:00:00Z',
    idempotencyKey: `idem_chan_${n}`,
    ...overrides,
  };
}

export function channelRecord(overrides: Partial<NotificationChannel> = {}): NotificationChannel {
  const n = seq();
  return {
    channelId: `chan_01HQZY${n}`,
    channel: 'in_app',
    provider: 'in_app',
    enabled: true,
    configuration: {},
    createdAt: '2026-04-01T12:00:00Z',
    idempotencyKey: `idem_chan_${n}`,
    ...overrides,
  };
}

export function sendNotificationRequest(
  overrides: Partial<SendNotificationRequest> = {},
): SendNotificationRequest {
  const n = seq();
  return {
    notificationId: `not_01HQZX${n}`,
    accountId: `acct_01HQZX${n}`,
    channel: 'in_app',
    templateId: `tmpl_welcome_${n}`,
    subject: 'Welcome',
    body: 'Hello, world.',
    payload: { name: 'World' },
    priority: 'normal',
    createdAt: '2026-04-01T12:00:00Z',
    idempotencyKey: `idem_send_${n}`,
    ...overrides,
  };
}

export function notificationRecord(overrides: Partial<Notification> = {}): Notification {
  const n = seq();
  return {
    notificationId: `not_01HQZY${n}`,
    accountId: `acct_01HQZY${n}`,
    channel: 'in_app',
    templateId: `tmpl_welcome_${n}`,
    subject: 'Welcome',
    body: 'Hello, world.',
    payload: { name: 'World' },
    priority: 'normal',
    status: 'pending',
    scheduledAt: null,
    sentAt: null,
    createdAt: '2026-04-01T12:00:00Z',
    idempotencyKey: `idem_not_${n}`,
    ...overrides,
  };
}

export function scheduleNotificationRequest(
  overrides: Partial<ScheduleNotificationRequest> = {},
): ScheduleNotificationRequest {
  const n = seq();
  return {
    notificationId: `not_01HQZX${n}`,
    accountId: `acct_01HQZX${n}`,
    channel: 'in_app',
    templateId: `tmpl_reminder_${n}`,
    subject: 'Reminder',
    body: 'This is scheduled.',
    payload: { when: 'later' },
    priority: 'normal',
    scheduledAt: '2026-04-02T12:00:00Z',
    createdAt: '2026-04-01T12:00:00Z',
    idempotencyKey: `idem_sched_${n}`,
    ...overrides,
  };
}

export function recordDeliveryAttemptRequest(
  overrides: Partial<RecordDeliveryAttemptRequest> = {},
): RecordDeliveryAttemptRequest {
  const n = seq();
  return {
    attemptId: `att_01HQZX${n}`,
    notificationId: `not_01HQZX${n}`,
    channel: 'in_app',
    provider: 'in_app',
    status: 'success',
    errorCode: null,
    attemptedAt: '2026-04-01T12:00:01Z',
    idempotencyKey: `idem_att_${n}`,
    ...overrides,
  };
}

export function deliveryAttemptRecord(overrides: Partial<DeliveryAttempt> = {}): DeliveryAttempt {
  const n = seq();
  return {
    attemptId: `att_01HQZY${n}`,
    notificationId: `not_01HQZY${n}`,
    channel: 'in_app',
    provider: 'in_app',
    status: 'success',
    errorCode: null,
    attemptedAt: '2026-04-01T12:00:01Z',
    idempotencyKey: `idem_att_${n}`,
    ...overrides,
  };
}

export function channelRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    channel_id: 'chan_01HQZXTESTROW',
    channel: 'in_app',
    provider: 'in_app',
    enabled: true,
    configuration: {},
    created_at: '2026-04-01T12:00:00.000000Z',
    idempotency_key: 'idem_chan_01HQZXTESTROW',
    ...overrides,
  };
}

export function notificationRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    notification_id: 'not_01HQZXTESTROW',
    account_id: 'acct_01HQZXTESTROW',
    channel: 'in_app',
    template_id: 'tmpl_test',
    subject: 'Test',
    body: 'Body',
    payload: {},
    priority: 'normal',
    status: 'pending',
    scheduled_at: null,
    sent_at: null,
    created_at: '2026-04-01T12:00:00.000000Z',
    idempotency_key: 'idem_not_01HQZXTESTROW',
    ...overrides,
  };
}

export function deliveryAttemptRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    attempt_id: 'att_01HQZXTESTROW',
    notification_id: 'not_01HQZXTESTROW',
    channel: 'in_app',
    provider: 'in_app',
    status: 'success',
    error_code: null,
    attempted_at: '2026-04-01T12:00:01.000000Z',
    idempotency_key: 'idem_att_01HQZXTESTROW',
    ...overrides,
  };
}
