/**
 * K-14 Notifications — the service.
 *
 * Five operations:
 *
 *   `createChannel`        — register a channel/provider configuration, refusing duplicates.
 *   `send`                 — validate, look up the channel, deliver through the provider,
 *                            record the attempt, update the notification status, and emit an event
 *                            and audit record.
 *   `schedule`             — like send but status=scheduled and scheduledAt in the future. No
 *                            delivery in this slice.
 *   `getStatus`            — look up a notification by id and return its status.
 *   `recordDeliveryAttempt`— record an external delivery attempt, update the notification status,
 *                            and emit an event and audit record.
 *
 * Deterministic by construction: the caller supplies the identifiers and the instants. Nothing
 * here reads a clock or generates randomness.
 *
 * Owned by: K-14 Notifications.
 */

import type { NotificationProvider } from './providers/notification-provider.ts';
import {
  makeNotificationFailedAction,
  makeNotificationFailedEvent,
  makeNotificationSentAction,
  makeNotificationSentEvent,
} from './outbox.ts';
import { FOREIGN_FIELDS, assertAccountId } from './registry.ts';
import type { NotificationRepository } from './repository.ts';
import { sealChannel, sealDeliveryAttempt, sealNotification } from './immutable.ts';
import { validateChannel, validateDeliveryAttempt, validateNotification } from './validate.ts';
import {
  NotificationError,
  type Channel,
  type DeliveryAttempt,
  type Notification,
  type NotificationChannel,
  type NotificationStatus,
  type Priority,
} from './types.ts';

export interface CreateChannelRequest {
  readonly channelId: string;
  readonly channel: Channel;
  readonly provider: string;
  readonly enabled: boolean;
  readonly configuration: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly idempotencyKey: string;
}

export interface CreateChannelResult {
  readonly channel: NotificationChannel;
  readonly deduplicated: boolean;
}

export interface SendNotificationRequest {
  readonly notificationId: string;
  readonly accountId: string;
  readonly channel: Channel;
  readonly templateId: string;
  readonly subject: string;
  readonly body: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly priority: Priority;
  readonly createdAt: string;
  readonly idempotencyKey: string;
}

export interface SendNotificationResult {
  readonly notification: Notification;
  readonly deduplicated: boolean;
}

export interface ScheduleNotificationRequest {
  readonly notificationId: string;
  readonly accountId: string;
  readonly channel: Channel;
  readonly templateId: string;
  readonly subject: string;
  readonly body: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly priority: Priority;
  readonly scheduledAt: string;
  readonly createdAt: string;
  readonly idempotencyKey: string;
}

export interface ScheduleNotificationResult {
  readonly notification: Notification;
  readonly deduplicated: boolean;
}

export interface RecordDeliveryAttemptRequest {
  readonly attemptId: string;
  readonly notificationId: string;
  readonly channel: Channel;
  readonly provider: string;
  readonly status: 'success' | 'failure';
  readonly errorCode: string | null;
  readonly attemptedAt: string;
  readonly idempotencyKey: string;
}

export interface RecordDeliveryAttemptResult {
  readonly attempt: DeliveryAttempt;
  readonly deduplicated: boolean;
}

const CREATE_CHANNEL_KEYS: readonly string[] = [
  'channelId',
  'channel',
  'provider',
  'enabled',
  'configuration',
  'createdAt',
  'idempotencyKey',
];

const SEND_NOTIFICATION_KEYS: readonly string[] = [
  'notificationId',
  'accountId',
  'channel',
  'templateId',
  'subject',
  'body',
  'payload',
  'priority',
  'createdAt',
  'idempotencyKey',
];

const SCHEDULE_NOTIFICATION_KEYS: readonly string[] = [
  'notificationId',
  'accountId',
  'channel',
  'templateId',
  'subject',
  'body',
  'payload',
  'priority',
  'scheduledAt',
  'createdAt',
  'idempotencyKey',
];

const RECORD_DELIVERY_ATTEMPT_KEYS: readonly string[] = [
  'attemptId',
  'notificationId',
  'channel',
  'provider',
  'status',
  'errorCode',
  'attemptedAt',
  'idempotencyKey',
];

export class NotificationService {
  readonly #repository: NotificationRepository;
  readonly #resolveProvider: (provider: string) => NotificationProvider;

  constructor(
    repository: NotificationRepository,
    resolveProvider: (provider: string) => NotificationProvider,
  ) {
    this.#repository = repository;
    this.#resolveProvider = resolveProvider;
  }

  /**
   * Register a channel/provider configuration.
   *
   * Validates, checks idempotency, and stores the configuration. A duplicate channel/provider
   * combination is refused.
   */
  async createChannel(request: CreateChannelRequest): Promise<CreateChannelResult> {
    assertNoForeignConcerns(request, CREATE_CHANNEL_KEYS, 'createChannel');
    const channel = sealChannel(
      validateChannel(
        {
          channelId: request.channelId,
          channel: request.channel,
          provider: request.provider,
          enabled: request.enabled,
          configuration: request.configuration,
          createdAt: request.createdAt,
          idempotencyKey: request.idempotencyKey,
        },
        'request',
      ),
    );

    try {
      return await this.#insertChannel(channel);
    } catch (error) {
      const conflicted =
        error instanceof NotificationError &&
        (error.code === 'duplicate-channel-id' ||
          error.code === 'duplicate-channel-provider' ||
          error.code === 'idempotency-key-reuse');
      if (!conflicted) throw error;

      const winner = await this.#repository.withTransaction((tx) =>
        tx.findChannelByIdempotencyKey(channel.idempotencyKey),
      );
      if (winner === null || !channelEquals(winner, channel)) throw error;
      return { channel: sealChannel(winner), deduplicated: true };
    }
  }

  async #insertChannel(channel: NotificationChannel): Promise<CreateChannelResult> {
    return this.#repository.withTransaction(async (tx) => {
      const existingKey = await tx.findChannelByIdempotencyKey(channel.idempotencyKey);
      if (existingKey !== null) {
        if (!channelEquals(existingKey, channel)) {
          throw new NotificationError(
            'idempotency-key-reuse',
            `idempotency key "${channel.idempotencyKey}" has already been used for a different channel`,
          );
        }
        return { channel: sealChannel(existingKey), deduplicated: true };
      }

      const existingId = await tx.findChannelById(channel.channelId);
      if (existingId !== null) {
        if (channelEquals(existingId, channel)) {
          return { channel: sealChannel(existingId), deduplicated: true };
        }
        throw new NotificationError(
          'duplicate-channel-id',
          `channel ${channel.channelId} already exists. A channel is created once and never rewritten`,
        );
      }

      const existingProvider = await tx.findChannelByChannelAndProvider(
        channel.channel,
        channel.provider,
      );
      if (existingProvider !== null) {
        if (channelEquals(existingProvider, channel)) {
          return { channel: sealChannel(existingProvider), deduplicated: true };
        }
        throw new NotificationError(
          'duplicate-channel-provider',
          `channel "${channel.channel}" already has a provider "${channel.provider}". ` +
            'Each channel/provider combination may be registered only once',
        );
      }

      await tx.insertChannel(channel);
      return { channel, deduplicated: false };
    });
  }

  /**
   * Send a notification.
   *
   * Validates, checks idempotency, looks up the channel, refuses a disabled channel, creates the
   * notification with status `pending`, delivers it through the channel's provider, records the
   * attempt, updates the status to `sent` or `failed`, and emits the matching event and audit record.
   */
  async send(request: SendNotificationRequest): Promise<SendNotificationResult> {
    assertNoForeignConcerns(request, SEND_NOTIFICATION_KEYS, 'send');
    const pending = sealNotification(
      validateNotification(
        {
          notificationId: request.notificationId,
          accountId: request.accountId,
          channel: request.channel,
          templateId: request.templateId,
          subject: request.subject,
          body: request.body,
          payload: request.payload,
          priority: request.priority,
          status: 'pending',
          scheduledAt: null,
          sentAt: null,
          createdAt: request.createdAt,
          idempotencyKey: request.idempotencyKey,
        },
        'request',
      ),
    );

    try {
      return await this.#send(pending);
    } catch (error) {
      const conflicted =
        error instanceof NotificationError &&
        (error.code === 'duplicate-notification-id' || error.code === 'idempotency-key-reuse');
      if (!conflicted) throw error;

      const winner = await this.#repository.withTransaction((tx) =>
        tx.findNotificationByIdempotencyKey(pending.idempotencyKey),
      );
      if (winner === null || !notificationSendEquals(winner, pending)) throw error;
      return { notification: sealNotification(winner), deduplicated: true };
    }
  }

  async #send(pending: Notification): Promise<SendNotificationResult> {
    return this.#repository.withTransaction(async (tx) => {
      const existingKey = await tx.findNotificationByIdempotencyKey(pending.idempotencyKey);
      if (existingKey !== null) {
        if (!notificationSendEquals(existingKey, pending)) {
          throw new NotificationError(
            'idempotency-key-reuse',
            `idempotency key "${pending.idempotencyKey}" has already been used for a different notification`,
          );
        }
        return { notification: sealNotification(existingKey), deduplicated: true };
      }

      const existingId = await tx.findNotificationById(pending.notificationId);
      if (existingId !== null) {
        if (notificationSendEquals(existingId, pending)) {
          return { notification: sealNotification(existingId), deduplicated: true };
        }
        throw new NotificationError(
          'duplicate-notification-id',
          `notification ${pending.notificationId} already exists. A notification is created once and never rewritten`,
        );
      }

      const channel = await this.#requireEnabledChannel(tx, pending.channel);
      const provider = this.#resolveProvider(channel.provider);
      const attempt = sealDeliveryAttempt(await provider.deliver(pending));

      const notification = sealNotification({
        ...pending,
        status: attempt.status === 'success' ? 'sent' : 'failed',
        sentAt: attempt.status === 'success' ? attempt.attemptedAt : null,
      });

      await tx.insertNotification(notification);
      await tx.insertDeliveryAttempt(attempt);
      await this.#emit(notification, attempt, tx);

      return { notification, deduplicated: false };
    });
  }

  /**
   * Schedule a notification for future delivery.
   *
   * Like send but status=scheduled and scheduledAt in the future. No delivery is attempted in this
   * slice.
   */
  async schedule(request: ScheduleNotificationRequest): Promise<ScheduleNotificationResult> {
    assertNoForeignConcerns(request, SCHEDULE_NOTIFICATION_KEYS, 'schedule');
    const scheduled = sealNotification(
      validateNotification(
        {
          notificationId: request.notificationId,
          accountId: request.accountId,
          channel: request.channel,
          templateId: request.templateId,
          subject: request.subject,
          body: request.body,
          payload: request.payload,
          priority: request.priority,
          status: 'scheduled',
          scheduledAt: request.scheduledAt,
          sentAt: null,
          createdAt: request.createdAt,
          idempotencyKey: request.idempotencyKey,
        },
        'request',
      ),
    );

    try {
      return await this.#schedule(scheduled);
    } catch (error) {
      const conflicted =
        error instanceof NotificationError &&
        (error.code === 'duplicate-notification-id' || error.code === 'idempotency-key-reuse');
      if (!conflicted) throw error;

      const winner = await this.#repository.withTransaction((tx) =>
        tx.findNotificationByIdempotencyKey(scheduled.idempotencyKey),
      );
      if (winner === null || !notificationScheduleEquals(winner, scheduled)) throw error;
      return { notification: sealNotification(winner), deduplicated: true };
    }
  }

  async #schedule(scheduled: Notification): Promise<ScheduleNotificationResult> {
    return this.#repository.withTransaction(async (tx) => {
      const existingKey = await tx.findNotificationByIdempotencyKey(scheduled.idempotencyKey);
      if (existingKey !== null) {
        if (!notificationScheduleEquals(existingKey, scheduled)) {
          throw new NotificationError(
            'idempotency-key-reuse',
            `idempotency key "${scheduled.idempotencyKey}" has already been used for a different notification`,
          );
        }
        return { notification: sealNotification(existingKey), deduplicated: true };
      }

      const existingId = await tx.findNotificationById(scheduled.notificationId);
      if (existingId !== null) {
        if (notificationScheduleEquals(existingId, scheduled)) {
          return { notification: sealNotification(existingId), deduplicated: true };
        }
        throw new NotificationError(
          'duplicate-notification-id',
          `notification ${scheduled.notificationId} already exists. A notification is created once and never rewritten`,
        );
      }

      await this.#requireEnabledChannel(tx, scheduled.channel);
      await tx.insertNotification(scheduled);
      return { notification: scheduled, deduplicated: false };
    });
  }

  /** The current status of one notification. */
  async getStatus(notificationId: string): Promise<NotificationStatus> {
    assertAccountId(notificationId, 'notificationId');
    const notification = await this.#repository.withTransaction((tx: NotificationRepositoryTx) =>
      tx.findNotificationById(notificationId),
    );
    if (notification === null) {
      throw new NotificationError('no-such-notification', `no notification ${notificationId}`);
    }
    return notification.status;
  }

  /**
   * Record a delivery attempt made outside this component.
   *
   * Validates, checks idempotency, updates the notification status to `sent` or `failed`, stores the
   * attempt, and emits the matching event and audit record.
   */
  async recordDeliveryAttempt(
    request: RecordDeliveryAttemptRequest,
  ): Promise<RecordDeliveryAttemptResult> {
    assertNoForeignConcerns(request, RECORD_DELIVERY_ATTEMPT_KEYS, 'recordDeliveryAttempt');
    const attempt = sealDeliveryAttempt(
      validateDeliveryAttempt(
        {
          attemptId: request.attemptId,
          notificationId: request.notificationId,
          channel: request.channel,
          provider: request.provider,
          status: request.status,
          errorCode: request.errorCode,
          attemptedAt: request.attemptedAt,
          idempotencyKey: request.idempotencyKey,
        },
        'request',
      ),
    );

    try {
      return await this.#recordAttempt(attempt);
    } catch (error) {
      const conflicted =
        error instanceof NotificationError &&
        (error.code === 'duplicate-attempt-id' || error.code === 'idempotency-key-reuse');
      if (!conflicted) throw error;

      const winner = await this.#repository.withTransaction((tx) =>
        tx.findDeliveryAttemptByIdempotencyKey(attempt.idempotencyKey),
      );
      if (winner === null || !attemptEquals(winner, attempt)) throw error;
      return { attempt: sealDeliveryAttempt(winner), deduplicated: true };
    }
  }

  async #recordAttempt(attempt: DeliveryAttempt): Promise<RecordDeliveryAttemptResult> {
    return this.#repository.withTransaction(async (tx) => {
      const existingKey = await tx.findDeliveryAttemptByIdempotencyKey(attempt.idempotencyKey);
      if (existingKey !== null) {
        if (!attemptEquals(existingKey, attempt)) {
          throw new NotificationError(
            'idempotency-key-reuse',
            `idempotency key "${attempt.idempotencyKey}" has already been used for a different delivery attempt`,
          );
        }
        return { attempt: sealDeliveryAttempt(existingKey), deduplicated: true };
      }

      const existingId = await tx.findDeliveryAttemptById(attempt.attemptId);
      if (existingId !== null) {
        if (attemptEquals(existingId, attempt)) {
          return { attempt: sealDeliveryAttempt(existingId), deduplicated: true };
        }
        throw new NotificationError(
          'duplicate-attempt-id',
          `delivery attempt ${attempt.attemptId} already exists. A delivery attempt is created once and never rewritten`,
        );
      }

      const notification = await tx.findNotificationById(attempt.notificationId);
      if (notification === null) {
        throw new NotificationError(
          'no-such-notification',
          `notification ${attempt.notificationId} does not exist. A delivery attempt must relate to a notification that has already been created`,
        );
      }
      if (notification.channel !== attempt.channel) {
        throw new NotificationError(
          'malformed-record',
          `attempt channel "${attempt.channel}" does not match notification channel "${notification.channel}"`,
        );
      }

      const updated = sealNotification({
        ...notification,
        status: attempt.status === 'success' ? 'sent' : 'failed',
        sentAt: attempt.status === 'success' ? attempt.attemptedAt : notification.sentAt,
      });

      await tx.updateNotificationStatus(updated);
      await tx.insertDeliveryAttempt(attempt);
      await this.#emit(updated, attempt, tx);

      return { attempt, deduplicated: false };
    });
  }

  async #requireEnabledChannel(
    tx: NotificationRepositoryTx,
    channel: Channel,
  ): Promise<NotificationChannel> {
    const found = await tx.findChannelByChannel(channel);
    if (found === null) {
      throw new NotificationError(
        'no-such-channel',
        `no channel configured for "${channel}". Create the channel before sending notifications through it`,
      );
    }
    if (!found.enabled) {
      throw new NotificationError(
        'channel-disabled',
        `channel "${channel}" is disabled. Enable it before sending notifications through it`,
      );
    }
    return found;
  }

  async #emit(
    notification: Notification,
    attempt: DeliveryAttempt,
    tx: NotificationRepositoryTx,
  ): Promise<void> {
    const correlationId = notification.notificationId;
    const causationId: string | null = null;

    if (attempt.status === 'success') {
      await tx.insertOutbox(
        makeNotificationSentEvent(notification, attempt, correlationId, causationId),
      );
      await tx.insertOutbox(
        makeNotificationSentAction(notification, attempt, correlationId, causationId),
      );
    } else {
      await tx.insertOutbox(
        makeNotificationFailedEvent(notification, attempt, correlationId, causationId),
      );
      await tx.insertOutbox(
        makeNotificationFailedAction(notification, attempt, correlationId, causationId),
      );
    }
  }
}

import type { NotificationTransaction as NotificationRepositoryTx } from './repository.ts';

function assertNoForeignConcerns(
  request: object,
  permitted: readonly string[],
  operation: string,
): void {
  if (request === null || typeof request !== 'object') {
    throw new NotificationError(
      'malformed-record',
      `${operation} needs a request object, got ${request === null ? 'null' : typeof request}`,
    );
  }

  for (const key of Object.keys(request)) {
    if (permitted.includes(key)) continue;

    const owner = FOREIGN_FIELDS[key];
    if (owner !== undefined) {
      throw new NotificationError(
        'foreign-concern',
        `${operation} carried "${key}", but ${owner}. A notification record carries only what K-14 owns`,
      );
    }
    throw new NotificationError(
      'foreign-concern',
      `${operation} carried the unrecognised field "${key}". The permitted fields are ` +
        `${permitted.join(', ')}; anything else would be accepted and silently dropped`,
    );
  }
}

function channelEquals(a: NotificationChannel, b: NotificationChannel): boolean {
  return (
    a.channelId === b.channelId &&
    a.channel === b.channel &&
    a.provider === b.provider &&
    a.enabled === b.enabled &&
    JSON.stringify(a.configuration) === JSON.stringify(b.configuration) &&
    a.createdAt === b.createdAt
  );
}

function notificationSendEquals(a: Notification, b: Notification): boolean {
  return (
    a.notificationId === b.notificationId &&
    a.accountId === b.accountId &&
    a.channel === b.channel &&
    a.templateId === b.templateId &&
    a.subject === b.subject &&
    a.body === b.body &&
    JSON.stringify(a.payload) === JSON.stringify(b.payload) &&
    a.priority === b.priority &&
    a.createdAt === b.createdAt
  );
}

function notificationScheduleEquals(a: Notification, b: Notification): boolean {
  return notificationSendEquals(a, b) && a.scheduledAt === b.scheduledAt && a.status === b.status;
}

function attemptEquals(a: DeliveryAttempt, b: DeliveryAttempt): boolean {
  return (
    a.attemptId === b.attemptId &&
    a.notificationId === b.notificationId &&
    a.channel === b.channel &&
    a.provider === b.provider &&
    a.status === b.status &&
    a.errorCode === b.errorCode &&
    a.attemptedAt === b.attemptedAt
  );
}
