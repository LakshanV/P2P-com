/**
 * K-14 Notifications — domain types.
 *
 * Channel-neutral delivery of templated notifications. The first channel is in-app. This component
 * owns the notification, the delivery attempt and the channel configuration; it does not own the
 * account (K-03), the template body (a future template service) or any business outcome.
 *
 * Deterministic by construction: the caller supplies every identifier and every instant. Nothing
 * here reads a clock or generates randomness.
 *
 * Owned by: K-14 Notifications.
 */

/** Recognised notification channels. */
export const CHANNELS = ['in_app', 'email', 'sms', 'push', 'whatsapp'] as const;
export type Channel = (typeof CHANNELS)[number];

/** Urgency of a notification. */
export const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type Priority = (typeof PRIORITIES)[number];

/** Lifecycle of a notification. */
export const NOTIFICATION_STATUSES = ['pending', 'sent', 'failed', 'scheduled'] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

/** Result of a delivery attempt. */
export const ATTEMPT_STATUSES = ['success', 'failure'] as const;
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];

/**
 * A notification.
 *
 * The body is what was rendered from the template at send time; the payload is the variables that
 * produced it. Both are owned here as a record of what was dispatched, not as a template store.
 */
export interface Notification {
  /** Caller-supplied opaque and stable identifier. */
  readonly notificationId: string;
  /** The K-03 universal account that should receive this notification. */
  readonly accountId: string;
  /** Channel over which the notification should be delivered. */
  readonly channel: Channel;
  /** Template identifier, not a template body. */
  readonly templateId: string;
  /** Rendered subject line. */
  readonly subject: string;
  /** Rendered body. */
  readonly body: string;
  /** Variables that produced the rendered subject and body. */
  readonly payload: Readonly<Record<string, unknown>>;
  /** Urgency. */
  readonly priority: Priority;
  /** Current lifecycle status. */
  readonly status: NotificationStatus;
  /** When delivery is scheduled, for scheduled notifications; otherwise null. */
  readonly scheduledAt: string | null;
  /** When the notification was successfully delivered; otherwise null. */
  readonly sentAt: string | null;
  /** When the notification was created, as a canonical UTC instant. */
  readonly createdAt: string;
  /** Stable across retries of one logical send. */
  readonly idempotencyKey: string;
}

/**
 * One attempt to deliver a notification through a provider.
 *
 * Attempts are append-only. A failed attempt may be followed by further attempts; the notification's
 * status reflects the latest one.
 */
export interface DeliveryAttempt {
  /** Caller-supplied opaque and stable identifier. */
  readonly attemptId: string;
  /** The notification this attempt delivered. */
  readonly notificationId: string;
  /** Channel the attempt used. */
  readonly channel: Channel;
  /** Provider that handled the attempt, e.g. `in_app`, `mock_email`. */
  readonly provider: string;
  /** Whether the attempt succeeded. */
  readonly status: AttemptStatus;
  /** Refusal code when status is `failure`; otherwise null. */
  readonly errorCode: string | null;
  /** When the attempt happened, as a canonical UTC instant. */
  readonly attemptedAt: string;
  /** Stable across retries of one logical attempt. */
  readonly idempotencyKey: string;
}

/**
 * A configured delivery channel.
 *
 * Channels are created before they can be used. A channel/provider combination is unique, so two
 * providers cannot both claim the same channel vocabulary.
 */
export interface NotificationChannel {
  /** Caller-supplied opaque and stable identifier. */
  readonly channelId: string;
  /** The channel vocabulary this configuration serves. */
  readonly channel: Channel;
  /** Provider that implements this channel, e.g. `in_app`, `mock_email`. */
  readonly provider: string;
  /** Whether this channel may currently be used. */
  readonly enabled: boolean;
  /** Provider-specific configuration. */
  readonly configuration: Readonly<Record<string, unknown>>;
  /** When the channel was created, as a canonical UTC instant. */
  readonly createdAt: string;
  /** Stable across retries of one logical creation. */
  readonly idempotencyKey: string;
}

export type NotificationErrorCode =
  /** An identifier is not well formed. */
  | 'malformed-identifier'
  /** An identifier looks like a natural key. */
  | 'natural-identifier'
  /** An identifier names or looks like a credential. */
  | 'secret-bearing-input'
  /** The instant is not a real UTC instant. */
  | 'malformed-instant'
  /** A request carried a field belonging to another component. */
  | 'foreign-concern'
  /** A stored row, or a candidate record, is not what this component writes. */
  | 'malformed-record'
  /** A channel is not one K-14 recognises. */
  | 'invalid-channel'
  /** A priority is not one K-14 recognises. */
  | 'invalid-priority'
  /** A notification status is not one K-14 recognises. */
  | 'invalid-status'
  /** A delivery-attempt status is not one K-14 recognises. */
  | 'invalid-attempt-status'
  /** The idempotency key was already used for a different record. */
  | 'idempotency-key-reuse'
  /** A channel id already exists with different content. */
  | 'duplicate-channel-id'
  /** A channel/provider combination already exists. */
  | 'duplicate-channel-provider'
  /** A notification id already exists with different content. */
  | 'duplicate-notification-id'
  /** An attempt id already exists with different content. */
  | 'duplicate-attempt-id'
  /** The requested channel configuration does not exist. */
  | 'no-such-channel'
  /** The requested channel is disabled. */
  | 'channel-disabled'
  /** The requested notification does not exist. */
  | 'no-such-notification'
  /** An enlisted write tried to issue transaction control. */
  | 'nested-transaction';

/** A refusal the caller must act on. */
export class NotificationError extends Error {
  readonly code: NotificationErrorCode;

  constructor(code: NotificationErrorCode, message: string) {
    super(message);
    this.name = 'NotificationError';
    this.code = code;
  }
}
