/**
 * K-14 Notifications — the PostgreSQL adapter.
 *
 * Implements the persistence port against `kernel_notifications`. It knows SQL and nothing else: no
 * validation, no lifecycle, no referential check. Those live in the service, where they can be tested
 * without a server.
 *
 * Every `timestamptz` is projected as UTC text. JSON objects are stored as `jsonb` and read as
 * objects.
 *
 * No statement names another unit's schema, and there is no foreign key out of `kernel_notifications`.
 * The module's outbox table lives in the same schema.
 *
 * Owned by: K-14 Notifications.
 */

import { databaseErrorDetail } from '../../platform/db/client.ts';
import type { Database, DatabaseClient } from '../../platform/db/client.ts';
import type { OutboxEntry } from '../../platform/outbox/types.ts';

import { sealChannel, sealDeliveryAttempt, sealNotification } from './immutable.ts';
import type { NotificationRepository, NotificationTransaction } from './repository.ts';
import { validateChannel, validateDeliveryAttempt, validateNotification } from './validate.ts';
import {
  NotificationError,
  type NotificationErrorCode,
  type DeliveryAttempt,
  type Notification,
  type NotificationChannel,
} from './types.ts';

export const NOTIFICATION_SCHEMA = 'kernel_notifications';
export const CHANNEL_TABLE = `${NOTIFICATION_SCHEMA}.channel`;
export const NOTIFICATION_TABLE = `${NOTIFICATION_SCHEMA}.notification`;
export const DELIVERY_ATTEMPT_TABLE = `${NOTIFICATION_SCHEMA}.delivery_attempt`;
export const OUTBOX_TABLE = `${NOTIFICATION_SCHEMA}.outbox`;

/** SQLSTATE 23505. The only driver code this adapter interprets. */
const UNIQUE_VIOLATION = '23505';

const CONSTRAINT_MEANINGS: Readonly<
  Record<string, { readonly code: NotificationErrorCode; readonly explanation: string }>
> = {
  channel_pkey: {
    code: 'duplicate-channel-id',
    explanation: 'a channel with this id already exists, and a channel is never overwritten',
  },
  channel_idempotency_unique: {
    code: 'idempotency-key-reuse',
    explanation: 'this idempotency key has already been used for a channel',
  },
  channel_channel_provider_unique: {
    code: 'duplicate-channel-provider',
    explanation: 'this channel/provider combination is already registered',
  },
  notification_pkey: {
    code: 'duplicate-notification-id',
    explanation:
      'a notification with this id already exists, and a notification is never rewritten',
  },
  notification_idempotency_unique: {
    code: 'idempotency-key-reuse',
    explanation: 'this idempotency key has already been used for a notification',
  },
  delivery_attempt_pkey: {
    code: 'duplicate-attempt-id',
    explanation:
      'a delivery attempt with this id already exists, and a delivery attempt is never rewritten',
  },
  delivery_attempt_idempotency_unique: {
    code: 'idempotency-key-reuse',
    explanation: 'this idempotency key has already been used for a delivery attempt',
  },
};

function normalizeDatabaseError(error: unknown, operation: string): unknown {
  if (error instanceof NotificationError) return error;

  const detail = databaseErrorDetail(error);
  if (detail.code !== UNIQUE_VIOLATION) return error;

  const message = error instanceof Error ? error.message : String(error);
  const named =
    detail.constraint ??
    Object.keys(CONSTRAINT_MEANINGS).find((constraint) => message.includes(constraint));
  const meaning = named === undefined ? undefined : CONSTRAINT_MEANINGS[named];
  if (meaning === undefined) return error;

  return new NotificationError(meaning.code, `${operation} was refused: ${meaning.explanation}`);
}

const CHANNEL_COLUMNS = [
  'channel_id',
  'channel',
  'provider',
  'enabled',
  'configuration',
  'created_at',
  'idempotency_key',
] as const;

const NOTIFICATION_COLUMNS = [
  'notification_id',
  'account_id',
  'channel',
  'template_id',
  'subject',
  'body',
  'payload',
  'priority',
  'status',
  'scheduled_at',
  'sent_at',
  'created_at',
  'idempotency_key',
] as const;

const DELIVERY_ATTEMPT_COLUMNS = [
  'attempt_id',
  'notification_id',
  'channel',
  'provider',
  'status',
  'error_code',
  'attempted_at',
  'idempotency_key',
] as const;

function utcText(column: string): string {
  return `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${column}`;
}

const CHANNEL_PROJECTION = [
  'channel_id',
  'channel',
  'provider',
  'enabled',
  'configuration',
  utcText('created_at'),
  'idempotency_key',
].join(', ');

const NOTIFICATION_PROJECTION = [
  'notification_id',
  'account_id',
  'channel',
  'template_id',
  'subject',
  'body',
  'payload',
  'priority',
  'status',
  utcText('scheduled_at'),
  utcText('sent_at'),
  utcText('created_at'),
  'idempotency_key',
].join(', ');

const DELIVERY_ATTEMPT_PROJECTION = [
  'attempt_id',
  'notification_id',
  'channel',
  'provider',
  'status',
  'error_code',
  utcText('attempted_at'),
  'idempotency_key',
].join(', ');

const OUTBOX_COLUMN_NAMES = [
  'outbox_id',
  'idempotency_key',
  'kind',
  'payload',
  'recorded_at',
  'producer',
  'correlation_id',
  'processed_at',
  'retry_count',
  'last_error',
] as const;
const OUTBOX_COLUMNS = OUTBOX_COLUMN_NAMES.join(', ');

/** Exactly what `utcText` emits, and nothing else. */
const STORED_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/;

function instant(value: unknown, column: string): string {
  if (typeof value !== 'string') {
    throw new NotificationError(
      'malformed-record',
      `${column} came back as ${value instanceof Date ? 'a Date' : typeof value} rather than ` +
        'text. Timestamps are projected through to_char precisely so the driver never parses them',
    );
  }
  if (STORED_INSTANT.exec(value) === null) {
    throw new NotificationError(
      'malformed-record',
      `${column} holds "${value}", which is not a finite UTC timestamp in the projected form ` +
        'YYYY-MM-DDTHH:MM:SS.ffffffZ',
    );
  }
  return value;
}

function optionalInstant(value: unknown, column: string): string | null {
  if (value === null || value === undefined) return null;
  return instant(value, column);
}

function text(value: unknown, column: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new NotificationError(
      'malformed-record',
      `${column} is ${value === null ? 'null' : typeof value}; expected non-empty text`,
    );
  }
  return value;
}

function optionalText(value: unknown, column: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new NotificationError(
      'malformed-record',
      `${column} is ${typeof value}; expected text or null`,
    );
  }
  return value === '' ? null : value;
}

function booleanFrom(value: unknown, column: string): boolean {
  if (typeof value === 'boolean') return value;
  if (value === null || value === undefined) {
    throw new NotificationError('malformed-record', `${column} is null; expected a boolean`);
  }
  throw new NotificationError(
    'malformed-record',
    `${column} is ${typeof value}; expected a boolean`,
  );
}

function jsonObject(value: unknown, column: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new NotificationError(
      'malformed-record',
      `${column} is ${value === null ? 'null' : typeof value}; expected a JSON object`,
    );
  }
  return value as Record<string, unknown>;
}

export function toChannel(row: Record<string, unknown>): NotificationChannel {
  return sealChannel(
    validateChannel(
      {
        channelId: text(row.channel_id, 'channel_id'),
        channel: text(row.channel, 'channel'),
        provider: optionalText(row.provider, 'provider') as string,
        enabled: booleanFrom(row.enabled, 'enabled'),
        configuration: jsonObject(row.configuration, 'configuration'),
        createdAt: instant(row.created_at, 'created_at'),
        idempotencyKey: text(row.idempotency_key, 'idempotency_key'),
      },
      'stored row',
    ),
  );
}

export function toNotification(row: Record<string, unknown>): Notification {
  return sealNotification(
    validateNotification(
      {
        notificationId: text(row.notification_id, 'notification_id'),
        accountId: text(row.account_id, 'account_id'),
        channel: text(row.channel, 'channel'),
        templateId: text(row.template_id, 'template_id'),
        subject: text(row.subject, 'subject'),
        body: text(row.body, 'body'),
        payload: jsonObject(row.payload, 'payload'),
        priority: text(row.priority, 'priority'),
        status: text(row.status, 'status'),
        scheduledAt: optionalInstant(row.scheduled_at, 'scheduled_at'),
        sentAt: optionalInstant(row.sent_at, 'sent_at'),
        createdAt: instant(row.created_at, 'created_at'),
        idempotencyKey: text(row.idempotency_key, 'idempotency_key'),
      },
      'stored row',
    ),
  );
}

export function toDeliveryAttempt(row: Record<string, unknown>): DeliveryAttempt {
  return sealDeliveryAttempt(
    validateDeliveryAttempt(
      {
        attemptId: text(row.attempt_id, 'attempt_id'),
        notificationId: text(row.notification_id, 'notification_id'),
        channel: text(row.channel, 'channel'),
        provider: text(row.provider, 'provider'),
        status: text(row.status, 'status'),
        errorCode: optionalText(row.error_code, 'error_code'),
        attemptedAt: instant(row.attempted_at, 'attempted_at'),
        idempotencyKey: text(row.idempotency_key, 'idempotency_key'),
      },
      'stored row',
    ),
  );
}

const TRANSACTION_CONTROL =
  /^\s*(BEGIN|START\s+TRANSACTION|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE\s+SAVEPOINT)\b/i;

export function enlistedClient(client: DatabaseClient): DatabaseClient {
  return {
    query<QueryRow = Record<string, unknown>>(sql: string, params?: readonly unknown[]) {
      if (TRANSACTION_CONTROL.test(sql)) {
        return Promise.reject(
          new NotificationError(
            'nested-transaction',
            `an enlisted notification write may not issue "${sql.trim().split(/\s+/, 2).join(' ')}". ` +
              'The transaction belongs to the caller',
          ),
        );
      }
      return client.query<QueryRow>(sql, params);
    },
    release(): Promise<void> {
      return Promise.resolve();
    },
  };
}

export class EnlistedNotificationRepository implements NotificationRepository {
  readonly #client: DatabaseClient;

  constructor(client: DatabaseClient) {
    this.#client = enlistedClient(client);
  }

  withTransaction<T>(body: (tx: NotificationTransaction) => Promise<T>): Promise<T> {
    return body(new PostgresNotificationTransaction(this.#client));
  }
}

export class PostgresNotificationRepository implements NotificationRepository {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  static enlist(client: DatabaseClient): NotificationRepository {
    return new EnlistedNotificationRepository(client);
  }

  async withTransaction<T>(body: (tx: NotificationTransaction) => Promise<T>): Promise<T> {
    const client = await this.#database.connect();
    try {
      await client.query('BEGIN;');
      try {
        const result = await body(new PostgresNotificationTransaction(client));
        await client.query('COMMIT;');
        return result;
      } catch (error) {
        await client.query('ROLLBACK;');
        throw error;
      }
    } finally {
      await client.release();
    }
  }
}

export const TIMESTAMP_COLUMNS = ['created_at', 'scheduled_at', 'sent_at', 'attempted_at'] as const;

class PostgresNotificationTransaction implements NotificationTransaction {
  readonly #client: DatabaseClient;

  constructor(client: DatabaseClient) {
    this.#client = client;
  }

  async insertOutbox(entry: OutboxEntry): Promise<void> {
    await this.#client.query(
      `INSERT INTO ${OUTBOX_TABLE} (${OUTBOX_COLUMNS})
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10);`,
      [
        entry.outboxId,
        entry.idempotencyKey,
        entry.kind,
        JSON.stringify(entry.payload),
        entry.recordedAt,
        entry.producer,
        entry.correlationId,
        entry.processedAt,
        entry.retryCount,
        entry.lastError,
      ],
    );
  }

  async findChannelById(channelId: string): Promise<NotificationChannel | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${CHANNEL_PROJECTION} FROM ${CHANNEL_TABLE} WHERE channel_id = $1;`,
      [channelId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toChannel(row);
  }

  async findChannelByIdempotencyKey(idempotencyKey: string): Promise<NotificationChannel | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${CHANNEL_PROJECTION} FROM ${CHANNEL_TABLE} WHERE idempotency_key = $1;`,
      [idempotencyKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : toChannel(row);
  }

  async findChannelByChannel(channel: string): Promise<NotificationChannel | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${CHANNEL_PROJECTION} FROM ${CHANNEL_TABLE} WHERE channel = $1;`,
      [channel],
    );
    const row = result.rows[0];
    return row === undefined ? null : toChannel(row);
  }

  async findChannelByChannelAndProvider(
    channel: string,
    provider: string,
  ): Promise<NotificationChannel | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${CHANNEL_PROJECTION} FROM ${CHANNEL_TABLE} WHERE channel = $1 AND provider = $2;`,
      [channel, provider],
    );
    const row = result.rows[0];
    return row === undefined ? null : toChannel(row);
  }

  async insertChannel(channel: NotificationChannel): Promise<void> {
    try {
      await this.#client.query(
        `INSERT INTO ${CHANNEL_TABLE} (${CHANNEL_COLUMNS.join(', ')})
         VALUES ($1, $2, $3, $4, $5, $6, $7);`,
        [
          channel.channelId,
          channel.channel,
          channel.provider,
          channel.enabled,
          JSON.stringify(channel.configuration),
          channel.createdAt,
          channel.idempotencyKey,
        ],
      );
    } catch (error) {
      throw normalizeDatabaseError(error, 'insertChannel');
    }
  }

  async findNotificationById(notificationId: string): Promise<Notification | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${NOTIFICATION_PROJECTION} FROM ${NOTIFICATION_TABLE} WHERE notification_id = $1;`,
      [notificationId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toNotification(row);
  }

  async findNotificationByIdempotencyKey(idempotencyKey: string): Promise<Notification | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${NOTIFICATION_PROJECTION} FROM ${NOTIFICATION_TABLE} WHERE idempotency_key = $1;`,
      [idempotencyKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : toNotification(row);
  }

  async insertNotification(notification: Notification): Promise<void> {
    try {
      await this.#client.query(
        `INSERT INTO ${NOTIFICATION_TABLE} (${NOTIFICATION_COLUMNS.join(', ')})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13);`,
        [
          notification.notificationId,
          notification.accountId,
          notification.channel,
          notification.templateId,
          notification.subject,
          notification.body,
          JSON.stringify(notification.payload),
          notification.priority,
          notification.status,
          notification.scheduledAt,
          notification.sentAt,
          notification.createdAt,
          notification.idempotencyKey,
        ],
      );
    } catch (error) {
      throw normalizeDatabaseError(error, 'insertNotification');
    }
  }

  async updateNotificationStatus(notification: Notification): Promise<void> {
    await this.#client.query(
      `UPDATE ${NOTIFICATION_TABLE}
       SET status = $1, sent_at = $2
       WHERE notification_id = $3;`,
      [notification.status, notification.sentAt, notification.notificationId],
    );
  }

  async findDeliveryAttemptById(attemptId: string): Promise<DeliveryAttempt | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${DELIVERY_ATTEMPT_PROJECTION} FROM ${DELIVERY_ATTEMPT_TABLE} WHERE attempt_id = $1;`,
      [attemptId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toDeliveryAttempt(row);
  }

  async findDeliveryAttemptByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<DeliveryAttempt | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${DELIVERY_ATTEMPT_PROJECTION} FROM ${DELIVERY_ATTEMPT_TABLE} WHERE idempotency_key = $1;`,
      [idempotencyKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : toDeliveryAttempt(row);
  }

  async insertDeliveryAttempt(attempt: DeliveryAttempt): Promise<void> {
    try {
      await this.#client.query(
        `INSERT INTO ${DELIVERY_ATTEMPT_TABLE} (${DELIVERY_ATTEMPT_COLUMNS.join(', ')})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8);`,
        [
          attempt.attemptId,
          attempt.notificationId,
          attempt.channel,
          attempt.provider,
          attempt.status,
          attempt.errorCode,
          attempt.attemptedAt,
          attempt.idempotencyKey,
        ],
      );
    } catch (error) {
      throw normalizeDatabaseError(error, 'insertDeliveryAttempt');
    }
  }
}
