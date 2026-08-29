/**
 * K-14 Notifications — provider port.
 *
 * A provider turns a notification into a delivery attempt. Implementations live outside the service
 * so the service stays channel-neutral: it looks up the provider name in a registry and calls the
 * adapter without knowing the channel's mechanics.
 *
 * Owned by: K-14 Notifications.
 */

import type { DeliveryAttempt, Notification } from '../types.ts';

export interface NotificationProvider {
  readonly channel: string;
  readonly provider: string;
  deliver(notification: Notification): Promise<DeliveryAttempt>;
}
