/**
 * K-12 Conversation Foundation — the PostgreSQL adapter.
 *
 * Implements the persistence port against `kernel_conversation_foundation`. It knows SQL and nothing else: no
 * validation, no lifecycle, no cross-component existence checks. Those live in the service, where
 * they can be tested without a server.
 *
 * Every `timestamptz` is projected as UTC text. No statement names another unit's schema, and there
 * is no foreign key out of `kernel_conversation_foundation`. The module's outbox table lives in the same
 * schema.
 *
 * Owned by: K-12 Conversation Foundation.
 */

import { databaseErrorDetail } from '../../platform/db/client.ts';
import type { Database, DatabaseClient } from '../../platform/db/client.ts';
import { InvalidInstantError, parseInstant } from '../../platform/time/instant.ts';
import type { OutboxEntry } from '../../platform/outbox/types.ts';

import { sealConversation, sealMessage, sealParticipant } from './immutable.ts';
import type { ConversationRepository, ConversationTransaction } from './repository.ts';
import { validateConversation, validateMessage, validateParticipant } from './validate.ts';
import {
  ConversationError,
  type ConversationErrorCode,
  type Conversation as ConversationRecord,
  type Message,
  type Participant,
} from './types.ts';

export const CONVERSATION_SCHEMA = 'kernel_conversation_foundation';
export const CONVERSATION_TABLE = `${CONVERSATION_SCHEMA}.conversation`;
export const PARTICIPANT_TABLE = `${CONVERSATION_SCHEMA}.participant`;
export const MESSAGE_TABLE = `${CONVERSATION_SCHEMA}.message`;
export const OUTBOX_TABLE = `${CONVERSATION_SCHEMA}.outbox`;

/** SQLSTATE 23505. The only driver code this adapter interprets. */
const UNIQUE_VIOLATION = '23505';

const CONSTRAINT_MEANINGS: Readonly<
  Record<string, { readonly code: ConversationErrorCode; readonly explanation: string }>
> = {
  conversation_pkey: {
    code: 'duplicate-conversation-id',
    explanation:
      'a conversation with this id already exists, and a conversation is never rewritten',
  },
  conversation_idempotency_unique: {
    code: 'idempotency-key-reuse',
    explanation: 'this idempotency key has already been used for a conversation',
  },
  participant_pkey: {
    code: 'duplicate-participant-id',
    explanation: 'a participant with this id already exists, and a participant is never rewritten',
  },
  participant_idempotency_unique: {
    code: 'idempotency-key-reuse',
    explanation: 'this idempotency key has already been used for a participant',
  },
  participant_conversation_account_unique: {
    code: 'duplicate-participant-account',
    explanation: 'this account is already a participant in this conversation',
  },
  message_pkey: {
    code: 'duplicate-message-id',
    explanation: 'a message with this id already exists, and a message is never rewritten',
  },
  message_idempotency_unique: {
    code: 'idempotency-key-reuse',
    explanation: 'this idempotency key has already been used for a message',
  },
  outbox_pkey: {
    code: 'idempotency-key-reuse',
    explanation: 'this outbox id already exists',
  },
  outbox_idempotency_unique: {
    code: 'idempotency-key-reuse',
    explanation: 'this outbox idempotency key has already been used',
  },
};

function normalizeDatabaseError(error: unknown, operation: string): unknown {
  if (error instanceof ConversationError) return error;

  const detail = databaseErrorDetail(error);
  if (detail.code !== UNIQUE_VIOLATION) return error;

  const message = error instanceof Error ? error.message : String(error);
  const named =
    detail.constraint ??
    Object.keys(CONSTRAINT_MEANINGS).find((constraint) => message.includes(constraint));
  const meaning = named === undefined ? undefined : CONSTRAINT_MEANINGS[named];
  if (meaning === undefined) return error;

  return new ConversationError(meaning.code, `${operation} was refused: ${meaning.explanation}`);
}

const CONVERSATION_COLUMNS = [
  'conversation_id',
  'title',
  'context',
  'created_at',
  'idempotency_key',
] as const;

const PARTICIPANT_COLUMNS = [
  'participant_id',
  'conversation_id',
  'account_id',
  'role',
  'joined_at',
  'idempotency_key',
] as const;

const MESSAGE_COLUMNS = [
  'message_id',
  'conversation_id',
  'participant_id',
  'content',
  'message_type',
  'sent_at',
  'idempotency_key',
] as const;

/** The `timestamptz` columns in this schema. They are projected as text. */
export const TIMESTAMP_COLUMNS = ['created_at', 'joined_at', 'sent_at'] as const;

/** Deterministic UTC text: no session TimeZone, no locale field, six fractional digits. */
function utcText(column: string): string {
  return `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${column}`;
}

const CONVERSATION_PROJECTION = [
  'conversation_id',
  'title',
  'context',
  utcText('created_at'),
  'idempotency_key',
].join(', ');

const PARTICIPANT_PROJECTION = [
  'participant_id',
  'conversation_id',
  'account_id',
  'role',
  utcText('joined_at'),
  'idempotency_key',
].join(', ');

const MESSAGE_PROJECTION = [
  'message_id',
  'conversation_id',
  'participant_id',
  'content',
  'message_type',
  utcText('sent_at'),
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

const STORED_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/;

function instant(value: unknown, column: string): string {
  if (typeof value !== 'string') {
    throw new ConversationError(
      'malformed-record',
      `${column} came back as ${value instanceof Date ? 'a Date' : typeof value} rather than ` +
        'text. Timestamps are projected through to_char precisely so the driver never parses them',
    );
  }
  const match = STORED_INSTANT.exec(value);
  if (match === null) {
    throw new ConversationError(
      'malformed-record',
      `${column} holds "${value}", which is not a finite UTC timestamp in the projected form ` +
        'YYYY-MM-DDTHH:MM:SS.ffffffZ',
    );
  }
  try {
    parseInstant(value);
  } catch (error) {
    if (error instanceof InvalidInstantError) {
      throw new ConversationError('malformed-record', `${column}: ${error.message}`);
    }
    throw error;
  }
  const [, year, month, day, hour, minute, second, fraction = ''] = match;
  const digits = fraction.replace(/0+$/, '');
  return `${year}-${month}-${day}T${hour}:${minute}:${second}${digits === '' ? '' : `.${digits}`}Z`;
}

function text(value: unknown, column: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new ConversationError(
      'malformed-record',
      `${column} is ${value === null ? 'null' : typeof value}; expected non-empty text`,
    );
  }
  return value;
}

function optionalText(value: unknown, column: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new ConversationError(
      'malformed-record',
      `${column} is ${typeof value}; expected text or null`,
    );
  }
  return value;
}

function context(value: unknown, column: string): 'direct' | 'transaction' | 'support' | 'ai' {
  if (typeof value !== 'string' || !['direct', 'transaction', 'support', 'ai'].includes(value)) {
    throw new ConversationError(
      'malformed-record',
      `${column} is "${String(value)}"; expected one of direct, transaction, support, ai`,
    );
  }
  return value as 'direct' | 'transaction' | 'support' | 'ai';
}

function role(value: unknown, column: string): 'owner' | 'member' | 'ai' | 'system' {
  if (typeof value !== 'string' || !['owner', 'member', 'ai', 'system'].includes(value)) {
    throw new ConversationError(
      'malformed-record',
      `${column} is "${String(value)}"; expected one of owner, member, ai, system`,
    );
  }
  return value as 'owner' | 'member' | 'ai' | 'system';
}

function messageType(value: unknown, column: string): 'text' | 'system' {
  if (typeof value !== 'string' || !['text', 'system'].includes(value)) {
    throw new ConversationError(
      'malformed-record',
      `${column} is "${String(value)}"; expected one of text, system`,
    );
  }
  return value as 'text' | 'system';
}

export function toConversation(row: Record<string, unknown>): ConversationRecord {
  return sealConversation(
    validateConversation(
      {
        conversationId: text(row.conversation_id, 'conversation_id'),
        title: optionalText(row.title, 'title'),
        context: context(row.context, 'context'),
        createdAt: instant(row.created_at, 'created_at'),
        idempotencyKey: text(row.idempotency_key, 'idempotency_key'),
      },
      'stored row',
    ),
  );
}

export function toParticipant(row: Record<string, unknown>): Participant {
  return sealParticipant(
    validateParticipant(
      {
        participantId: text(row.participant_id, 'participant_id'),
        conversationId: text(row.conversation_id, 'conversation_id'),
        accountId: text(row.account_id, 'account_id'),
        role: role(row.role, 'role'),
        joinedAt: instant(row.joined_at, 'joined_at'),
        idempotencyKey: text(row.idempotency_key, 'idempotency_key'),
      },
      'stored row',
    ),
  );
}

export function toMessage(row: Record<string, unknown>): Message {
  return sealMessage(
    validateMessage(
      {
        messageId: text(row.message_id, 'message_id'),
        conversationId: text(row.conversation_id, 'conversation_id'),
        participantId: text(row.participant_id, 'participant_id'),
        content: text(row.content, 'content'),
        messageType: messageType(row.message_type, 'message_type'),
        sentAt: instant(row.sent_at, 'sent_at'),
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
          new ConversationError(
            'nested-transaction',
            `an enlisted conversation write may not issue "${sql.trim().split(/\s+/, 2).join(' ')}". ` +
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

export class EnlistedConversationRepository implements ConversationRepository {
  readonly #client: DatabaseClient;

  constructor(client: DatabaseClient) {
    this.#client = enlistedClient(client);
  }

  withTransaction<T>(body: (tx: ConversationTransaction) => Promise<T>): Promise<T> {
    return body(new PostgresConversationTransaction(this.#client));
  }
}

export class PostgresConversationRepository implements ConversationRepository {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  static enlist(client: DatabaseClient): ConversationRepository {
    return new EnlistedConversationRepository(client);
  }

  async withTransaction<T>(body: (tx: ConversationTransaction) => Promise<T>): Promise<T> {
    const client = await this.#database.connect();
    try {
      await client.query('BEGIN;');
      try {
        const result = await body(new PostgresConversationTransaction(client));
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

class PostgresConversationTransaction implements ConversationTransaction {
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

  async findConversationById(conversationId: string): Promise<ConversationRecord | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${CONVERSATION_PROJECTION} FROM ${CONVERSATION_TABLE} WHERE conversation_id = $1;`,
      [conversationId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toConversation(row);
  }

  async findConversationByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<ConversationRecord | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${CONVERSATION_PROJECTION} FROM ${CONVERSATION_TABLE} WHERE idempotency_key = $1;`,
      [idempotencyKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : toConversation(row);
  }

  async insertConversation(conversation: ConversationRecord): Promise<void> {
    try {
      await this.#client.query(
        `INSERT INTO ${CONVERSATION_TABLE} (${CONVERSATION_COLUMNS.join(', ')})
         VALUES ($1, $2, $3, $4, $5);`,
        [
          conversation.conversationId,
          conversation.title,
          conversation.context,
          conversation.createdAt,
          conversation.idempotencyKey,
        ],
      );
    } catch (error) {
      throw normalizeDatabaseError(error, 'insertConversation');
    }
  }

  async findParticipantById(participantId: string): Promise<Participant | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${PARTICIPANT_PROJECTION} FROM ${PARTICIPANT_TABLE} WHERE participant_id = $1;`,
      [participantId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toParticipant(row);
  }

  async findParticipantByIdempotencyKey(idempotencyKey: string): Promise<Participant | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${PARTICIPANT_PROJECTION} FROM ${PARTICIPANT_TABLE} WHERE idempotency_key = $1;`,
      [idempotencyKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : toParticipant(row);
  }

  async findParticipantByConversationAndAccount(
    conversationId: string,
    accountId: string,
  ): Promise<Participant | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${PARTICIPANT_PROJECTION} FROM ${PARTICIPANT_TABLE}
       WHERE conversation_id = $1 AND account_id = $2;`,
      [conversationId, accountId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toParticipant(row);
  }

  async insertParticipant(participant: Participant): Promise<void> {
    try {
      await this.#client.query(
        `INSERT INTO ${PARTICIPANT_TABLE} (${PARTICIPANT_COLUMNS.join(', ')})
         VALUES ($1, $2, $3, $4, $5, $6);`,
        [
          participant.participantId,
          participant.conversationId,
          participant.accountId,
          participant.role,
          participant.joinedAt,
          participant.idempotencyKey,
        ],
      );
    } catch (error) {
      throw normalizeDatabaseError(error, 'insertParticipant');
    }
  }

  async findMessageById(messageId: string): Promise<Message | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${MESSAGE_PROJECTION} FROM ${MESSAGE_TABLE} WHERE message_id = $1;`,
      [messageId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toMessage(row);
  }

  async findMessageByIdempotencyKey(idempotencyKey: string): Promise<Message | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${MESSAGE_PROJECTION} FROM ${MESSAGE_TABLE} WHERE idempotency_key = $1;`,
      [idempotencyKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : toMessage(row);
  }

  async findMessagesByConversation(
    conversationId: string,
    options: { after: string | null; limit: number },
  ): Promise<readonly Message[]> {
    let sql = `SELECT ${MESSAGE_PROJECTION} FROM ${MESSAGE_TABLE} WHERE conversation_id = $1`;
    const params: unknown[] = [conversationId];

    if (options.after !== null) {
      sql += ` AND (sent_at, message_id) < (
        SELECT sent_at, message_id FROM ${MESSAGE_TABLE} WHERE message_id = $2
      )`;
      params.push(options.after);
    }
    sql += ` ORDER BY sent_at DESC, message_id DESC LIMIT $${params.length + 1};`;
    params.push(options.limit);

    const result = await this.#client.query<Record<string, unknown>>(sql, params);
    return Object.freeze(result.rows.map((row) => toMessage(row)));
  }

  async insertMessage(message: Message): Promise<void> {
    try {
      await this.#client.query(
        `INSERT INTO ${MESSAGE_TABLE} (${MESSAGE_COLUMNS.join(', ')})
         VALUES ($1, $2, $3, $4, $5, $6, $7);`,
        [
          message.messageId,
          message.conversationId,
          message.participantId,
          message.content,
          message.messageType,
          message.sentAt,
          message.idempotencyKey,
        ],
      );
    } catch (error) {
      throw normalizeDatabaseError(error, 'insertMessage');
    }
  }
}
