/**
 * K-14 Notifications — the persistence port.
 *
 * The service is written against this interface. The port exposes channel configurations,
 * notifications, delivery attempts and the outbox insert every producing module must support.
 *
 * Owned by: K-14 Notifications.
 */

import { InMemoryOutboxStore } from '../../platform/outbox/repository.ts';
import type { OutboxEntry, OutboxTransaction } from '../../platform/outbox/types.ts';

import {
  sealChannel,
  sealChannels,
  sealDeliveryAttempt,
  sealDeliveryAttempts,
  sealNotification,
  sealNotifications,
} from './immutable.ts';
import {
  NotificationError,
  type DeliveryAttempt,
  type Notification,
  type NotificationChannel,
} from './types.ts';

export interface NotificationTransaction extends OutboxTransaction {
  /** Channel lookup and creation. */
  findChannelById(channelId: string): Promise<NotificationChannel | null>;
  findChannelByIdempotencyKey(idempotencyKey: string): Promise<NotificationChannel | null>;
  findChannelByChannel(channel: string): Promise<NotificationChannel | null>;
  findChannelByChannelAndProvider(
    channel: string,
    provider: string,
  ): Promise<NotificationChannel | null>;
  insertChannel(channel: NotificationChannel): Promise<void>;

  /** Notification lookup and creation. */
  findNotificationById(notificationId: string): Promise<Notification | null>;
  findNotificationByIdempotencyKey(idempotencyKey: string): Promise<Notification | null>;
  insertNotification(notification: Notification): Promise<void>;
  updateNotificationStatus(notification: Notification): Promise<void>;

  /** Delivery attempt lookup and creation. */
  findDeliveryAttemptById(attemptId: string): Promise<DeliveryAttempt | null>;
  findDeliveryAttemptByIdempotencyKey(idempotencyKey: string): Promise<DeliveryAttempt | null>;
  insertDeliveryAttempt(attempt: DeliveryAttempt): Promise<void>;
}

export interface NotificationRepository {
  /**
   * Run `body` in one transaction. An exception must roll everything back — a caller that sees a
   * failure must be able to assume nothing was written, including a half-written notification or
   * delivery attempt.
   */
  withTransaction<T>(body: (tx: NotificationTransaction) => Promise<T>): Promise<T>;
}

/**
 * An in-memory repository.
 *
 * The reference implementation of the port's contract. It enforces the same uniqueness rules the
 * database does, and checks them **at commit against the store as it stands** rather than against the
 * snapshot the transaction read. Two callers that both read "no such channel" must not both win.
 */
export class InMemoryNotificationRepository implements NotificationRepository {
  #channels: NotificationChannel[] = [];
  #notifications: Notification[] = [];
  #attempts: DeliveryAttempt[] = [];
  readonly #outbox = new InMemoryOutboxStore('K-14', 'kernel_notifications');
  transactionsCommitted = 0;
  transactionsRolledBack = 0;

  channels(): readonly NotificationChannel[] {
    return sealChannels(this.#channels);
  }

  notifications(): readonly Notification[] {
    return sealNotifications(this.#notifications);
  }

  deliveryAttempts(): readonly DeliveryAttempt[] {
    return sealDeliveryAttempts(this.#attempts);
  }

  outbox(): InMemoryOutboxStore {
    return this.#outbox;
  }

  /** Seed state directly, for tests that need a starting point without going through the service. */
  seed(state: {
    readonly channels?: readonly NotificationChannel[];
    readonly notifications?: readonly Notification[];
    readonly attempts?: readonly DeliveryAttempt[];
    readonly outbox?: readonly OutboxEntry[];
  }): void {
    this.#channels = (state.channels ?? []).map(sealChannel);
    this.#notifications = (state.notifications ?? []).map(sealNotification);
    this.#attempts = (state.attempts ?? []).map(sealDeliveryAttempt);
    this.#outbox.seed(state.outbox ?? []);
  }

  async withTransaction<T>(body: (tx: NotificationTransaction) => Promise<T>): Promise<T> {
    const working = {
      channels: this.#channels.map(sealChannel),
      notifications: this.#notifications.map(sealNotification),
      attempts: this.#attempts.map(sealDeliveryAttempt),
    };
    const outboxWorking = new InMemoryOutboxStore(this.#outbox.name, this.#outbox.schema);
    outboxWorking.seed(this.#outbox.entries());

    const touched = new Touched();
    const tx = new InMemoryNotificationTransaction(working, outboxWorking, touched);

    try {
      const result = await body(tx);
      this.#commit(working, touched);
      this.#outbox.seed(outboxWorking.entries());
      this.transactionsCommitted += 1;
      return result;
    } catch (error) {
      this.transactionsRolledBack += 1;
      throw error;
    }
  }

  #commit(working: WorkingSet, touched: Touched): void {
    // Channels
    for (const channel of working.channels) {
      if (touched.channels.has(channel.channelId)) {
        if (this.#channels.some((held) => held.channelId === channel.channelId)) {
          throw new NotificationError(
            'duplicate-channel-id',
            `channel ${channel.channelId} was created by another transaction while this one was open`,
          );
        }
      }
      if (touched.channelKeys.has(channel.idempotencyKey)) {
        const holder = this.#channels.find(
          (held) => held.idempotencyKey === channel.idempotencyKey,
        );
        if (holder !== undefined) {
          throw new NotificationError(
            'idempotency-key-reuse',
            `idempotency key "${channel.idempotencyKey}" was used by channel ${holder.channelId}, ` +
              'created by another transaction while this one was open',
          );
        }
      }
      if (touched.channelProviders.has(`${channel.channel}:${channel.provider}`)) {
        const holder = this.#channels.find(
          (held) => held.channel === channel.channel && held.provider === channel.provider,
        );
        if (holder !== undefined) {
          throw new NotificationError(
            'duplicate-channel-provider',
            `channel/provider "${channel.channel}/${channel.provider}" was created as ` +
              `${holder.channelId} by another transaction while this one was open`,
          );
        }
      }
    }

    // Notifications
    for (const notification of working.notifications) {
      if (touched.notifications.has(notification.notificationId)) {
        if (
          this.#notifications.some((held) => held.notificationId === notification.notificationId)
        ) {
          throw new NotificationError(
            'duplicate-notification-id',
            `notification ${notification.notificationId} was created by another transaction while ` +
              'this one was open',
          );
        }
      }
      if (touched.notificationKeys.has(notification.idempotencyKey)) {
        const holder = this.#notifications.find(
          (held) => held.idempotencyKey === notification.idempotencyKey,
        );
        if (holder !== undefined) {
          throw new NotificationError(
            'idempotency-key-reuse',
            `idempotency key "${notification.idempotencyKey}" was used by notification ` +
              `${holder.notificationId}, created by another transaction while this one was open`,
          );
        }
      }
    }

    // Delivery attempts
    for (const attempt of working.attempts) {
      if (touched.attempts.has(attempt.attemptId)) {
        if (this.#attempts.some((held) => held.attemptId === attempt.attemptId)) {
          throw new NotificationError(
            'duplicate-attempt-id',
            `delivery attempt ${attempt.attemptId} was created by another transaction while ` +
              'this one was open',
          );
        }
      }
      if (touched.attemptKeys.has(attempt.idempotencyKey)) {
        const holder = this.#attempts.find(
          (held) => held.idempotencyKey === attempt.idempotencyKey,
        );
        if (holder !== undefined) {
          throw new NotificationError(
            'idempotency-key-reuse',
            `idempotency key "${attempt.idempotencyKey}" was used by delivery attempt ` +
              `${holder.attemptId}, created by another transaction while this one was open`,
          );
        }
      }
    }

    // Notification status updates: a touched notification id may already exist in the store.
    for (const notification of working.notifications) {
      if (touched.notificationStatus.has(notification.notificationId)) {
        this.#notifications = this.#notifications.map((held) =>
          held.notificationId === notification.notificationId
            ? sealNotification(notification)
            : held,
        );
      }
    }

    this.#channels = [
      ...this.#channels,
      ...working.channels.filter((c) => touched.channels.has(c.channelId)),
    ];
    this.#notifications = [
      ...this.#notifications,
      ...working.notifications.filter((n) => touched.notifications.has(n.notificationId)),
    ];
    this.#attempts = [
      ...this.#attempts,
      ...working.attempts.filter((a) => touched.attempts.has(a.attemptId)),
    ];
  }
}

class WorkingSet {
  channels: NotificationChannel[];
  notifications: Notification[];
  attempts: DeliveryAttempt[];

  constructor(snapshot: {
    channels: NotificationChannel[];
    notifications: Notification[];
    attempts: DeliveryAttempt[];
  }) {
    this.channels = snapshot.channels;
    this.notifications = snapshot.notifications;
    this.attempts = snapshot.attempts;
  }
}

class Touched {
  readonly channels = new Set<string>();
  readonly channelKeys = new Set<string>();
  readonly channelProviders = new Set<string>();
  readonly notifications = new Set<string>();
  readonly notificationKeys = new Set<string>();
  readonly notificationStatus = new Set<string>();
  readonly attempts = new Set<string>();
  readonly attemptKeys = new Set<string>();
}

class InMemoryNotificationTransaction implements NotificationTransaction {
  readonly #state: WorkingSet;
  readonly #outbox: InMemoryOutboxStore;
  readonly #touched: Touched;

  constructor(state: WorkingSet, outbox: InMemoryOutboxStore, touched: Touched) {
    this.#state = state;
    this.#outbox = outbox;
    this.#touched = touched;
  }

  insertOutbox(entry: OutboxEntry): Promise<void> {
    this.#outbox.insert(entry);
    return Promise.resolve();
  }

  findChannelById(channelId: string): Promise<NotificationChannel | null> {
    const found = this.#state.channels.find((c) => c.channelId === channelId);
    return Promise.resolve(found === undefined ? null : sealChannel(found));
  }

  findChannelByIdempotencyKey(idempotencyKey: string): Promise<NotificationChannel | null> {
    const found = this.#state.channels.find((c) => c.idempotencyKey === idempotencyKey);
    return Promise.resolve(found === undefined ? null : sealChannel(found));
  }

  findChannelByChannel(channel: string): Promise<NotificationChannel | null> {
    const found = this.#state.channels.find((c) => c.channel === channel);
    return Promise.resolve(found === undefined ? null : sealChannel(found));
  }

  findChannelByChannelAndProvider(
    channel: string,
    provider: string,
  ): Promise<NotificationChannel | null> {
    const found = this.#state.channels.find(
      (c) => c.channel === channel && c.provider === provider,
    );
    return Promise.resolve(found === undefined ? null : sealChannel(found));
  }

  insertChannel(channel: NotificationChannel): Promise<void> {
    if (this.#state.channels.some((held) => held.channelId === channel.channelId)) {
      return Promise.reject(
        new NotificationError(
          'duplicate-channel-id',
          `channel ${channel.channelId} already exists. A channel is created once and never rewritten`,
        ),
      );
    }
    if (this.#state.channels.some((held) => held.idempotencyKey === channel.idempotencyKey)) {
      return Promise.reject(
        new NotificationError(
          'idempotency-key-reuse',
          `idempotency key "${channel.idempotencyKey}" has already been used`,
        ),
      );
    }
    if (
      this.#state.channels.some(
        (held) => held.channel === channel.channel && held.provider === channel.provider,
      )
    ) {
      return Promise.reject(
        new NotificationError(
          'duplicate-channel-provider',
          `channel "${channel.channel}" already has a provider "${channel.provider}"`,
        ),
      );
    }
    this.#state.channels.push(sealChannel(channel));
    this.#touched.channels.add(channel.channelId);
    this.#touched.channelKeys.add(channel.idempotencyKey);
    this.#touched.channelProviders.add(`${channel.channel}:${channel.provider}`);
    return Promise.resolve();
  }

  findNotificationById(notificationId: string): Promise<Notification | null> {
    const found = this.#state.notifications.find((n) => n.notificationId === notificationId);
    return Promise.resolve(found === undefined ? null : sealNotification(found));
  }

  findNotificationByIdempotencyKey(idempotencyKey: string): Promise<Notification | null> {
    const found = this.#state.notifications.find((n) => n.idempotencyKey === idempotencyKey);
    return Promise.resolve(found === undefined ? null : sealNotification(found));
  }

  insertNotification(notification: Notification): Promise<void> {
    if (
      this.#state.notifications.some((held) => held.notificationId === notification.notificationId)
    ) {
      return Promise.reject(
        new NotificationError(
          'duplicate-notification-id',
          `notification ${notification.notificationId} already exists. A notification is created once and never rewritten`,
        ),
      );
    }
    if (
      this.#state.notifications.some((held) => held.idempotencyKey === notification.idempotencyKey)
    ) {
      return Promise.reject(
        new NotificationError(
          'idempotency-key-reuse',
          `idempotency key "${notification.idempotencyKey}" has already been used`,
        ),
      );
    }
    this.#state.notifications.push(sealNotification(notification));
    this.#touched.notifications.add(notification.notificationId);
    this.#touched.notificationKeys.add(notification.idempotencyKey);
    return Promise.resolve();
  }

  updateNotificationStatus(notification: Notification): Promise<void> {
    const index = this.#state.notifications.findIndex(
      (held) => held.notificationId === notification.notificationId,
    );
    if (index === -1) {
      return Promise.reject(
        new NotificationError(
          'no-such-notification',
          `notification ${notification.notificationId} does not exist`,
        ),
      );
    }
    this.#state.notifications[index] = sealNotification(notification);
    this.#touched.notificationStatus.add(notification.notificationId);
    return Promise.resolve();
  }

  findDeliveryAttemptById(attemptId: string): Promise<DeliveryAttempt | null> {
    const found = this.#state.attempts.find((a) => a.attemptId === attemptId);
    return Promise.resolve(found === undefined ? null : sealDeliveryAttempt(found));
  }

  findDeliveryAttemptByIdempotencyKey(idempotencyKey: string): Promise<DeliveryAttempt | null> {
    const found = this.#state.attempts.find((a) => a.idempotencyKey === idempotencyKey);
    return Promise.resolve(found === undefined ? null : sealDeliveryAttempt(found));
  }

  insertDeliveryAttempt(attempt: DeliveryAttempt): Promise<void> {
    if (this.#state.attempts.some((held) => held.attemptId === attempt.attemptId)) {
      return Promise.reject(
        new NotificationError(
          'duplicate-attempt-id',
          `delivery attempt ${attempt.attemptId} already exists. A delivery attempt is created once and never rewritten`,
        ),
      );
    }
    if (this.#state.attempts.some((held) => held.idempotencyKey === attempt.idempotencyKey)) {
      return Promise.reject(
        new NotificationError(
          'idempotency-key-reuse',
          `idempotency key "${attempt.idempotencyKey}" has already been used`,
        ),
      );
    }
    this.#state.attempts.push(sealDeliveryAttempt(attempt));
    this.#touched.attempts.add(attempt.attemptId);
    this.#touched.attemptKeys.add(attempt.idempotencyKey);
    return Promise.resolve();
  }
}
