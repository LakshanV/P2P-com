/**
 * K-14 Notifications — outbox event and audit definitions.
 *
 * These definitions describe the facts K-14 publishes when a notification is sent or fails. They
 * are declared separately from the service so a relay can register them without importing K-14
 * internals.
 *
 * Owned by: K-14 Notifications.
 */

import type { AuditActionDefinition, EvidenceField } from '../audit-foundation/registry.ts';
import { auditOutboxEntry, eventOutboxEntry } from '../../platform/outbox/builder.ts';
import type { OutboxEntry } from '../../platform/outbox/types.ts';
import type { EventTypeDefinition, PayloadField } from '../event-infrastructure/registry.ts';

import type { DeliveryAttempt, Notification } from './types.ts';

export const NOTIFICATION_SENT_EVENT: EventTypeDefinition = {
  type: 'notification.sent',
  schemaVersion: 1,
  owner: 'K-14',
  description: 'A notification was delivered successfully.',
  payloadFields: [
    {
      name: 'notification_id',
      kind: 'string',
      required: true,
      description: 'The notification identifier.',
    },
    {
      name: 'account_id',
      kind: 'string',
      required: true,
      description: 'The recipient universal account.',
    },
    {
      name: 'channel',
      kind: 'string',
      required: true,
      description: 'The channel through which the notification was delivered.',
    },
    {
      name: 'template_id',
      kind: 'string',
      required: true,
      description: 'The template identifier used to render the notification.',
    },
    {
      name: 'sent_at',
      kind: 'string',
      required: true,
      description: 'ISO-8601 instant when the notification was delivered.',
    },
    {
      name: 'idempotency_key',
      kind: 'string',
      required: true,
      description: 'The idempotency key supplied when sending the notification.',
    },
  ] satisfies PayloadField[],
};

export const NOTIFICATION_FAILED_EVENT: EventTypeDefinition = {
  type: 'notification.failed',
  schemaVersion: 1,
  owner: 'K-14',
  description: 'A notification delivery attempt failed.',
  payloadFields: [
    {
      name: 'notification_id',
      kind: 'string',
      required: true,
      description: 'The notification identifier.',
    },
    {
      name: 'account_id',
      kind: 'string',
      required: true,
      description: 'The recipient universal account.',
    },
    {
      name: 'channel',
      kind: 'string',
      required: true,
      description: 'The channel through which delivery was attempted.',
    },
    {
      name: 'template_id',
      kind: 'string',
      required: true,
      description: 'The template identifier used to render the notification.',
    },
    {
      name: 'error_code',
      kind: 'string',
      required: true,
      description: 'The refusal code describing why delivery failed.',
    },
    {
      name: 'attempted_at',
      kind: 'string',
      required: true,
      description: 'ISO-8601 instant when the delivery attempt happened.',
    },
    {
      name: 'idempotency_key',
      kind: 'string',
      required: true,
      description: 'The idempotency key supplied when sending the notification.',
    },
  ] satisfies PayloadField[],
};

export const NOTIFICATION_SENT_ACTION: AuditActionDefinition = {
  action: 'notification.sent',
  owner: 'K-14',
  authority: 'business-authoritative',
  description: 'A notification was delivered successfully.',
  resourceTypes: ['notification'],
  evidenceFields: [
    {
      name: 'notification_id',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The notification identifier.',
    },
    {
      name: 'account_id',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The recipient universal account.',
    },
    {
      name: 'channel',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The channel through which the notification was delivered.',
    },
    {
      name: 'template_id',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The template identifier used to render the notification.',
    },
    {
      name: 'sent_at',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'ISO-8601 instant when the notification was delivered.',
    },
    {
      name: 'idempotency_key',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The idempotency key supplied when sending the notification.',
    },
  ] satisfies EvidenceField[],
};

export const NOTIFICATION_FAILED_ACTION: AuditActionDefinition = {
  action: 'notification.failed',
  owner: 'K-14',
  authority: 'business-authoritative',
  description: 'A notification delivery attempt failed.',
  resourceTypes: ['notification'],
  evidenceFields: [
    {
      name: 'notification_id',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The notification identifier.',
    },
    {
      name: 'account_id',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The recipient universal account.',
    },
    {
      name: 'channel',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The channel through which delivery was attempted.',
    },
    {
      name: 'template_id',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The template identifier used to render the notification.',
    },
    {
      name: 'error_code',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The refusal code describing why delivery failed.',
    },
    {
      name: 'attempted_at',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'ISO-8601 instant when the delivery attempt happened.',
    },
    {
      name: 'idempotency_key',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The idempotency key supplied when sending the notification.',
    },
  ] satisfies EvidenceField[],
};

export function makeNotificationSentEvent(
  notification: Notification,
  attempt: DeliveryAttempt,
  correlationId: string,
  causationId: string | null,
): OutboxEntry {
  const eventId = `${attempt.attemptId}:sent`;
  const recordedAt = notification.sentAt ?? notification.createdAt;

  return eventOutboxEntry({
    outboxId: `K-14:${eventId}`,
    idempotencyKey: `K-14:${eventId}`,
    payload: {
      eventId,
      type: NOTIFICATION_SENT_EVENT.type,
      schemaVersion: NOTIFICATION_SENT_EVENT.schemaVersion,
      occurredAt: recordedAt,
      recordedAt,
      producer: 'K-14',
      correlationId,
      causationId,
      origin: 'system',
      actor: { kind: 'system', id: 'K-14' },
      idempotencyKey: `K-14:${eventId}`,
      now: recordedAt,
      payload: {
        notification_id: notification.notificationId,
        account_id: notification.accountId,
        channel: notification.channel,
        template_id: notification.templateId,
        sent_at: recordedAt,
        idempotency_key: notification.idempotencyKey,
      },
    },
    occurredAt: recordedAt,
    recordedAt,
    producer: 'K-14',
    correlationId,
    causationId,
  });
}

export function makeNotificationFailedEvent(
  notification: Notification,
  attempt: DeliveryAttempt,
  correlationId: string,
  causationId: string | null,
): OutboxEntry {
  const eventId = `${attempt.attemptId}:failed`;
  const recordedAt = attempt.attemptedAt;

  return eventOutboxEntry({
    outboxId: `K-14:${eventId}`,
    idempotencyKey: `K-14:${eventId}`,
    payload: {
      eventId,
      type: NOTIFICATION_FAILED_EVENT.type,
      schemaVersion: NOTIFICATION_FAILED_EVENT.schemaVersion,
      occurredAt: recordedAt,
      recordedAt,
      producer: 'K-14',
      correlationId,
      causationId,
      origin: 'system',
      actor: { kind: 'system', id: 'K-14' },
      idempotencyKey: `K-14:${eventId}`,
      now: recordedAt,
      payload: {
        notification_id: notification.notificationId,
        account_id: notification.accountId,
        channel: notification.channel,
        template_id: notification.templateId,
        error_code: attempt.errorCode ?? 'unknown',
        attempted_at: attempt.attemptedAt,
        idempotency_key: notification.idempotencyKey,
      },
    },
    occurredAt: recordedAt,
    recordedAt,
    producer: 'K-14',
    correlationId,
    causationId,
  });
}

export function makeNotificationSentAction(
  notification: Notification,
  attempt: DeliveryAttempt,
  correlationId: string,
  causationId: string | null,
): OutboxEntry {
  const recordId = `${attempt.attemptId}:sent`;
  const outboxId = `K-14:audit:${recordId}`;
  const recordedAt = notification.sentAt ?? notification.createdAt;

  return auditOutboxEntry({
    outboxId,
    idempotencyKey: outboxId,
    payload: {
      recordId,
      action: NOTIFICATION_SENT_ACTION.action,
      recordedAt,
      actor: { kind: 'system', id: 'K-14', authentication: 'unauthenticated', sessionId: null },
      resource: { owner: 'K-14', type: 'notification', id: notification.notificationId },
      outcome: 'succeeded',
      reason: `notification ${notification.notificationId} delivered on channel ${notification.channel}`,
      correlationId,
      causationId,
      idempotencyKey: outboxId,
      evidence: {
        notification_id: notification.notificationId,
        account_id: notification.accountId,
        channel: notification.channel,
        template_id: notification.templateId,
        sent_at: recordedAt,
        idempotency_key: notification.idempotencyKey,
      },
    },
    recordedAt,
    producer: 'K-14',
    correlationId,
    causationId,
  });
}

export function makeNotificationFailedAction(
  notification: Notification,
  attempt: DeliveryAttempt,
  correlationId: string,
  causationId: string | null,
): OutboxEntry {
  const recordId = `${attempt.attemptId}:failed`;
  const outboxId = `K-14:audit:${recordId}`;
  const recordedAt = attempt.attemptedAt;

  return auditOutboxEntry({
    outboxId,
    idempotencyKey: outboxId,
    payload: {
      recordId,
      action: NOTIFICATION_FAILED_ACTION.action,
      recordedAt,
      actor: { kind: 'system', id: 'K-14', authentication: 'unauthenticated', sessionId: null },
      resource: { owner: 'K-14', type: 'notification', id: notification.notificationId },
      outcome: 'failed',
      reason: `notification ${notification.notificationId} failed on channel ${notification.channel}: ${attempt.errorCode ?? 'unknown'}`,
      correlationId,
      causationId,
      idempotencyKey: outboxId,
      evidence: {
        notification_id: notification.notificationId,
        account_id: notification.accountId,
        channel: notification.channel,
        template_id: notification.templateId,
        error_code: attempt.errorCode ?? 'unknown',
        attempted_at: attempt.attemptedAt,
        idempotency_key: notification.idempotencyKey,
      },
    },
    recordedAt,
    producer: 'K-14',
    correlationId,
    causationId,
  });
}
