/**
 * K-14 Notifications — public surface.
 *
 * Everything another unit may depend on is re-exported here. Anything not listed is internal and
 * may change without notice; see kernel/notifications/CONTRACT.md for the contract this fixes.
 *
 * K-14 delivers channel-neutral templated notifications. It depends on the platform substrate, K-03
 * Accounts (for identifier rules and the recipient account reference), K-08 Event Infrastructure and
 * K-09 Audit Foundation. It does not import any business module, financial module or AI gateway.
 *
 * Owned by: K-14 Notifications.
 */

export {
  CHANNELS,
  NOTIFICATION_STATUSES,
  PRIORITIES,
  NotificationError,
  type Channel,
  type DeliveryAttempt,
  type Notification,
  type NotificationChannel,
  type NotificationErrorCode,
  type NotificationStatus,
  type Priority,
} from './types.ts';

export {
  FOREIGN_FIELDS,
  ACCOUNT_REFUSALS,
  assertAccountId,
  assertChannel,
  assertPriority,
} from './registry.ts';

export {
  isChannelSealed,
  isDeliveryAttemptSealed,
  isNotificationSealed,
  sealChannel,
  sealChannels,
  sealDeliveryAttempt,
  sealDeliveryAttempts,
  sealNotification,
  sealNotifications,
} from './immutable.ts';

export { validateChannel, validateDeliveryAttempt, validateNotification } from './validate.ts';
export type { RecordSource } from './validate.ts';

export { NotificationService } from './service.ts';
export type {
  CreateChannelRequest,
  CreateChannelResult,
  RecordDeliveryAttemptRequest,
  RecordDeliveryAttemptResult,
  ScheduleNotificationRequest,
  ScheduleNotificationResult,
  SendNotificationRequest,
  SendNotificationResult,
} from './service.ts';

export { InMemoryNotificationRepository } from './repository.ts';
export type { NotificationRepository, NotificationTransaction } from './repository.ts';

export {
  CHANNEL_TABLE,
  DELIVERY_ATTEMPT_TABLE,
  EnlistedNotificationRepository,
  NOTIFICATION_SCHEMA,
  NOTIFICATION_TABLE,
  OUTBOX_TABLE,
  PostgresNotificationRepository,
  TIMESTAMP_COLUMNS,
  enlistedClient,
  toChannel,
  toDeliveryAttempt,
  toNotification,
} from './postgres-repository.ts';

export {
  NOTIFICATION_FAILED_ACTION,
  NOTIFICATION_FAILED_EVENT,
  NOTIFICATION_SENT_ACTION,
  NOTIFICATION_SENT_EVENT,
  makeNotificationFailedAction,
  makeNotificationFailedEvent,
  makeNotificationSentAction,
  makeNotificationSentEvent,
} from './outbox.ts';

export type { NotificationProvider } from './providers/notification-provider.ts';
export { InAppNotificationProvider } from './providers/in-app-provider.ts';
