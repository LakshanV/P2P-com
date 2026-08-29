/**
 * K-14 Notifications — the immutability boundary.
 *
 * Every record that crosses a service or repository boundary is deep-frozen and cloned, so a caller
 * cannot edit what was stored. Notification records are append-only; the only defence against silent
 * mutation at the boundary is to make mutation throw.
 *
 * Owned by: K-14 Notifications.
 */

import type { DeliveryAttempt, Notification, NotificationChannel } from './types.ts';

/** A deep, frozen copy of a channel configuration. */
export function sealChannel(channel: NotificationChannel): NotificationChannel {
  return Object.freeze({
    ...channel,
    configuration: Object.freeze({ ...channel.configuration }),
  });
}

/** A deep, frozen copy of a notification. */
export function sealNotification(notification: Notification): Notification {
  return Object.freeze({
    ...notification,
    payload: Object.freeze({ ...notification.payload }),
  });
}

/** A deep, frozen copy of a delivery attempt. */
export function sealDeliveryAttempt(attempt: DeliveryAttempt): DeliveryAttempt {
  return Object.freeze({ ...attempt });
}

/** Frozen copies of a list. */
export function sealChannels(
  channels: readonly NotificationChannel[],
): readonly NotificationChannel[] {
  return Object.freeze(channels.map(sealChannel));
}

export function sealNotifications(notifications: readonly Notification[]): readonly Notification[] {
  return Object.freeze(notifications.map(sealNotification));
}

export function sealDeliveryAttempts(
  attempts: readonly DeliveryAttempt[],
): readonly DeliveryAttempt[] {
  return Object.freeze(attempts.map(sealDeliveryAttempt));
}

/** Is this channel sealed all the way down? */
export function isChannelSealed(channel: NotificationChannel): boolean {
  return Object.isFrozen(channel) && Object.isFrozen(channel.configuration);
}

/** Is this notification sealed all the way down? */
export function isNotificationSealed(notification: Notification): boolean {
  return Object.isFrozen(notification) && Object.isFrozen(notification.payload);
}

/** Is this delivery attempt sealed? */
export function isDeliveryAttemptSealed(attempt: DeliveryAttempt): boolean {
  return Object.isFrozen(attempt);
}
