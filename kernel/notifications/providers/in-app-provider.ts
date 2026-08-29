/**
 * K-14 Notifications — in-app provider.
 *
 * The first supported channel. In-app delivery succeeds synchronously: the notification is written
 * to the account's in-app inbox by storing it, and the attempt records that fact.
 *
 * Deterministic by construction: the caller supplies the attempt id and instant.
 *
 * Owned by: K-14 Notifications.
 */

import type { NotificationProvider } from './notification-provider.ts';
import type { DeliveryAttempt, Notification } from '../types.ts';

export class InAppNotificationProvider implements NotificationProvider {
  readonly channel = 'in_app';
  readonly provider = 'in_app';

  deliver(notification: Notification): Promise<DeliveryAttempt> {
    // Synchronous success for in-app notifications. The caller supplies the attempt id and instant;
    // no clock is read here.
    const attempt: DeliveryAttempt = {
      attemptId: `${notification.notificationId}:in_app`,
      notificationId: notification.notificationId,
      channel: 'in_app',
      provider: 'in_app',
      status: 'success',
      errorCode: null,
      attemptedAt: notification.createdAt,
      idempotencyKey: `${notification.idempotencyKey}:in_app`,
    };
    return Promise.resolve(attempt);
  }
}
