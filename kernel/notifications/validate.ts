/**
 * K-14 Notifications — validation of complete records, wherever they came from.
 *
 * One function per record type, called by the service on the way in and by the PostgreSQL decoder
 * on the way out. There is no second list of rules to keep in step.
 *
 * Owned by: K-14 Notifications.
 */

import { formatInstant, InvalidInstantError, parseInstant } from '../../platform/time/instant.ts';

import { assertAccountId, assertChannel, assertPriority } from './registry.ts';
import {
  ATTEMPT_STATUSES,
  NOTIFICATION_STATUSES,
  NotificationError,
  type DeliveryAttempt,
  type Notification,
  type NotificationChannel,
  type NotificationStatus,
} from './types.ts';

/** Where the record came from. Only affects the wording of a refusal. */
export type RecordSource = 'request' | 'stored row';

export const STORED_ROW_NOTE =
  'A stored row that fails this was not written by this component — refusing it rather than ' +
  'presenting it as a real record';

export function validateChannel(candidate: unknown, source: RecordSource): NotificationChannel {
  try {
    return checkChannel(candidate, source);
  } catch (error) {
    if (source === 'request' || !(error instanceof NotificationError)) throw error;
    throw new NotificationError(error.code, `${error.message}. ${STORED_ROW_NOTE}`);
  }
}

const CHANNEL_FIELDS: readonly string[] = [
  'channelId',
  'channel',
  'provider',
  'enabled',
  'configuration',
  'createdAt',
  'idempotencyKey',
];

function checkChannel(candidate: unknown, source: RecordSource): NotificationChannel {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new NotificationError(
      'malformed-record',
      `a channel must be an object, got ${candidate === null ? 'null' : typeof candidate}`,
    );
  }

  for (const key of Object.keys(candidate)) {
    if (!CHANNEL_FIELDS.includes(key)) {
      throw new NotificationError(
        'malformed-record',
        `a channel carried the unrecognised field "${key}"; the permitted fields are ` +
          CHANNEL_FIELDS.join(', '),
      );
    }
  }

  const fields = candidate as Record<string, unknown>;
  return {
    channelId: assertAccountId(fields.channelId, 'channelId'),
    channel: assertChannel(fields.channel, 'channel'),
    provider: assertNonEmptyText(fields.provider, 'provider'),
    enabled: assertBoolean(fields.enabled, 'enabled'),
    configuration: assertJsonObject(fields.configuration, 'configuration'),
    createdAt: checkInstant(fields.createdAt, 'createdAt', source),
    idempotencyKey: assertAccountId(fields.idempotencyKey, 'idempotencyKey'),
  };
}

export function validateNotification(candidate: unknown, source: RecordSource): Notification {
  try {
    return checkNotification(candidate, source);
  } catch (error) {
    if (source === 'request' || !(error instanceof NotificationError)) throw error;
    throw new NotificationError(error.code, `${error.message}. ${STORED_ROW_NOTE}`);
  }
}

const NOTIFICATION_FIELDS: readonly string[] = [
  'notificationId',
  'accountId',
  'channel',
  'templateId',
  'subject',
  'body',
  'payload',
  'priority',
  'status',
  'scheduledAt',
  'sentAt',
  'createdAt',
  'idempotencyKey',
];

function checkNotification(candidate: unknown, source: RecordSource): Notification {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new NotificationError(
      'malformed-record',
      `a notification must be an object, got ${candidate === null ? 'null' : typeof candidate}`,
    );
  }

  for (const key of Object.keys(candidate)) {
    if (!NOTIFICATION_FIELDS.includes(key)) {
      throw new NotificationError(
        'malformed-record',
        `a notification carried the unrecognised field "${key}"; the permitted fields are ` +
          NOTIFICATION_FIELDS.join(', '),
      );
    }
  }

  const fields = candidate as Record<string, unknown>;
  return {
    notificationId: assertAccountId(fields.notificationId, 'notificationId'),
    accountId: assertAccountId(fields.accountId, 'accountId'),
    channel: assertChannel(fields.channel, 'channel'),
    templateId: assertNonEmptyText(fields.templateId, 'templateId'),
    subject: assertNonEmptyText(fields.subject, 'subject'),
    body: assertNonEmptyText(fields.body, 'body'),
    payload: assertJsonObject(fields.payload, 'payload'),
    priority: assertPriority(fields.priority, 'priority'),
    status: assertStatus(fields.status, 'status'),
    scheduledAt: assertOptionalInstant(fields.scheduledAt, 'scheduledAt', source),
    sentAt: assertOptionalInstant(fields.sentAt, 'sentAt', source),
    createdAt: checkInstant(fields.createdAt, 'createdAt', source),
    idempotencyKey: assertAccountId(fields.idempotencyKey, 'idempotencyKey'),
  };
}

export function validateDeliveryAttempt(candidate: unknown, source: RecordSource): DeliveryAttempt {
  try {
    return checkDeliveryAttempt(candidate, source);
  } catch (error) {
    if (source === 'request' || !(error instanceof NotificationError)) throw error;
    throw new NotificationError(error.code, `${error.message}. ${STORED_ROW_NOTE}`);
  }
}

const DELIVERY_ATTEMPT_FIELDS: readonly string[] = [
  'attemptId',
  'notificationId',
  'channel',
  'provider',
  'status',
  'errorCode',
  'attemptedAt',
  'idempotencyKey',
];

function checkDeliveryAttempt(candidate: unknown, source: RecordSource): DeliveryAttempt {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new NotificationError(
      'malformed-record',
      `a delivery attempt must be an object, got ${candidate === null ? 'null' : typeof candidate}`,
    );
  }

  for (const key of Object.keys(candidate)) {
    if (!DELIVERY_ATTEMPT_FIELDS.includes(key)) {
      throw new NotificationError(
        'malformed-record',
        `a delivery attempt carried the unrecognised field "${key}"; the permitted fields are ` +
          DELIVERY_ATTEMPT_FIELDS.join(', '),
      );
    }
  }

  const fields = candidate as Record<string, unknown>;
  return {
    attemptId: assertAccountId(fields.attemptId, 'attemptId'),
    notificationId: assertAccountId(fields.notificationId, 'notificationId'),
    channel: assertChannel(fields.channel, 'channel'),
    provider: assertNonEmptyText(fields.provider, 'provider'),
    status: assertAttemptStatus(fields.status, 'status'),
    errorCode: assertOptionalNonEmptyText(fields.errorCode, 'errorCode'),
    attemptedAt: checkInstant(fields.attemptedAt, 'attemptedAt', source),
    idempotencyKey: assertAccountId(fields.idempotencyKey, 'idempotencyKey'),
  };
}

function assertStatus(value: unknown, field: string): NotificationStatus {
  if (typeof value !== 'string' || !(NOTIFICATION_STATUSES as readonly string[]).includes(value)) {
    throw new NotificationError(
      'invalid-status',
      `${field} is "${String(value)}"; expected one of ${NOTIFICATION_STATUSES.join(', ')}`,
    );
  }
  return value as NotificationStatus;
}

function assertAttemptStatus(value: unknown, field: string): 'success' | 'failure' {
  if (typeof value !== 'string' || !(ATTEMPT_STATUSES as readonly string[]).includes(value)) {
    throw new NotificationError(
      'invalid-attempt-status',
      `${field} is "${String(value)}"; expected one of ${ATTEMPT_STATUSES.join(', ')}`,
    );
  }
  return value as 'success' | 'failure';
}

function assertBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new NotificationError(
      'malformed-record',
      `${field} is ${value === null ? 'null' : typeof value}; expected a boolean`,
    );
  }
  return value;
}

function assertNonEmptyText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new NotificationError(
      'malformed-record',
      `${field} is ${value === null ? 'null' : typeof value}; expected non-empty text`,
    );
  }
  return value;
}

function assertOptionalNonEmptyText(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value === '') {
    throw new NotificationError(
      'malformed-record',
      `${field} is ${value === null ? 'null' : typeof value}; expected non-empty text or null`,
    );
  }
  return value;
}

function assertJsonObject(value: unknown, field: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new NotificationError(
      'malformed-record',
      `${field} must be a JSON object, got ${value === null ? 'null' : typeof value}`,
    );
  }
  return value as Record<string, unknown>;
}

/** The exact form PostgreSQL to_char(...) emits for a timestamptz. */
const STORED_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/;

function checkInstant(value: unknown, field: string, source: RecordSource): string {
  if (source === 'stored row') {
    if (typeof value !== 'string') {
      throw new NotificationError(
        'malformed-record',
        `${field} came back as ${value instanceof Date ? 'a Date' : typeof value} rather than ` +
          'text. Timestamps are projected through to_char precisely so the driver never parses them',
      );
    }
    if (STORED_INSTANT.exec(value) === null) {
      throw new NotificationError(
        'malformed-record',
        `${field} holds "${value}", which is not a finite UTC timestamp in the projected form ` +
          'YYYY-MM-DDTHH:MM:SS.ffffffZ',
      );
    }
    try {
      return formatInstant(parseInstant(value).epochMicros);
    } catch (error) {
      if (error instanceof InvalidInstantError) {
        throw new NotificationError('malformed-record', `${field}: ${error.message}`);
      }
      throw error;
    }
  }

  if (typeof value !== 'string') {
    throw new NotificationError(
      'malformed-instant',
      `${field} is ${value === null ? 'null' : typeof value}; expected a UTC instant string`,
    );
  }
  try {
    return parseInstant(value).source;
  } catch (error) {
    if (error instanceof InvalidInstantError) {
      throw new NotificationError('malformed-instant', `${field}: ${error.message}`);
    }
    throw error;
  }
}

function assertOptionalInstant(value: unknown, field: string, source: RecordSource): string | null {
  if (value === null || value === undefined) return null;
  return checkInstant(value, field, source);
}
