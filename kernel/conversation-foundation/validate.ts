/**
 * K-12 Conversation Foundation — validation of complete records, wherever they came from.
 *
 * One function per record type, called by the service on the way in and by the PostgreSQL decoder
 * on the way out. There is no second list of rules to keep in step.
 *
 * Owned by: K-12 Conversation Foundation.
 */

import { InvalidInstantError, parseInstant } from '../../platform/time/instant.ts';

import { assertConversationIdentifier } from './registry.ts';
import {
  CONVERSATION_CONTEXTS,
  ConversationError,
  MESSAGE_TYPES,
  PARTICIPANT_ROLES,
  type Conversation,
  type ConversationContext,
  type Message,
  type MessageType,
  type Participant,
  type ParticipantRole,
} from './types.ts';

/** Where the record came from. Only affects the wording of a refusal. */
export type RecordSource = 'request' | 'stored row';

const STORED_ROW_NOTE =
  'A stored row that fails this was not written by this component — refusing it rather than ' +
  'presenting it as a real record';

export function validateConversation(candidate: unknown, source: RecordSource): Conversation {
  try {
    return checkConversation(candidate);
  } catch (error) {
    if (source === 'request' || !(error instanceof ConversationError)) throw error;
    throw new ConversationError(error.code, `${error.message}. ${STORED_ROW_NOTE}`);
  }
}

const CONVERSATION_FIELDS: readonly string[] = [
  'conversationId',
  'title',
  'context',
  'createdAt',
  'idempotencyKey',
];

function checkConversation(candidate: unknown): Conversation {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new ConversationError(
      'malformed-record',
      `a conversation must be an object, got ${candidate === null ? 'null' : typeof candidate}`,
    );
  }

  for (const key of Object.keys(candidate)) {
    if (!CONVERSATION_FIELDS.includes(key)) {
      throw new ConversationError(
        'malformed-record',
        `a conversation carried the unrecognised field "${key}"; the permitted fields are ` +
          CONVERSATION_FIELDS.join(', '),
      );
    }
  }

  const fields = candidate as Record<string, unknown>;
  return {
    conversationId: assertConversationIdentifier(fields.conversationId, 'conversationId'),
    title: checkOptionalText(fields.title, 'title'),
    context: assertContext(fields.context, 'context'),
    createdAt: checkInstant(fields.createdAt, 'createdAt'),
    idempotencyKey: assertConversationIdentifier(fields.idempotencyKey, 'idempotencyKey'),
  };
}

export function validateParticipant(candidate: unknown, source: RecordSource): Participant {
  try {
    return checkParticipant(candidate);
  } catch (error) {
    if (source === 'request' || !(error instanceof ConversationError)) throw error;
    throw new ConversationError(error.code, `${error.message}. ${STORED_ROW_NOTE}`);
  }
}

const PARTICIPANT_FIELDS: readonly string[] = [
  'participantId',
  'conversationId',
  'accountId',
  'role',
  'joinedAt',
  'idempotencyKey',
];

function checkParticipant(candidate: unknown): Participant {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new ConversationError(
      'malformed-record',
      `a participant must be an object, got ${candidate === null ? 'null' : typeof candidate}`,
    );
  }

  for (const key of Object.keys(candidate)) {
    if (!PARTICIPANT_FIELDS.includes(key)) {
      throw new ConversationError(
        'malformed-record',
        `a participant carried the unrecognised field "${key}"; the permitted fields are ` +
          PARTICIPANT_FIELDS.join(', '),
      );
    }
  }

  const fields = candidate as Record<string, unknown>;
  return {
    participantId: assertConversationIdentifier(fields.participantId, 'participantId'),
    conversationId: assertConversationIdentifier(fields.conversationId, 'conversationId'),
    accountId: assertConversationIdentifier(fields.accountId, 'accountId'),
    role: assertRole(fields.role, 'role'),
    joinedAt: checkInstant(fields.joinedAt, 'joinedAt'),
    idempotencyKey: assertConversationIdentifier(fields.idempotencyKey, 'idempotencyKey'),
  };
}

export function validateMessage(candidate: unknown, source: RecordSource): Message {
  try {
    return checkMessage(candidate);
  } catch (error) {
    if (source === 'request' || !(error instanceof ConversationError)) throw error;
    throw new ConversationError(error.code, `${error.message}. ${STORED_ROW_NOTE}`);
  }
}

const MESSAGE_FIELDS: readonly string[] = [
  'messageId',
  'conversationId',
  'participantId',
  'content',
  'messageType',
  'sentAt',
  'idempotencyKey',
];

function checkMessage(candidate: unknown): Message {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new ConversationError(
      'malformed-record',
      `a message must be an object, got ${candidate === null ? 'null' : typeof candidate}`,
    );
  }

  for (const key of Object.keys(candidate)) {
    if (!MESSAGE_FIELDS.includes(key)) {
      throw new ConversationError(
        'malformed-record',
        `a message carried the unrecognised field "${key}"; the permitted fields are ` +
          MESSAGE_FIELDS.join(', '),
      );
    }
  }

  const fields = candidate as Record<string, unknown>;
  return {
    messageId: assertConversationIdentifier(fields.messageId, 'messageId'),
    conversationId: assertConversationIdentifier(fields.conversationId, 'conversationId'),
    participantId: assertConversationIdentifier(fields.participantId, 'participantId'),
    content: assertContent(fields.content, 'content'),
    messageType: assertMessageType(fields.messageType, 'messageType'),
    sentAt: checkInstant(fields.sentAt, 'sentAt'),
    idempotencyKey: assertConversationIdentifier(fields.idempotencyKey, 'idempotencyKey'),
  };
}

function assertContext(value: unknown, field: string): ConversationContext {
  if (typeof value !== 'string' || !(CONVERSATION_CONTEXTS as readonly string[]).includes(value)) {
    throw new ConversationError(
      'malformed-record',
      `${field} is "${String(value)}"; expected one of ${CONVERSATION_CONTEXTS.join(', ')}`,
    );
  }
  return value as ConversationContext;
}

function assertRole(value: unknown, field: string): ParticipantRole {
  if (typeof value !== 'string' || !(PARTICIPANT_ROLES as readonly string[]).includes(value)) {
    throw new ConversationError(
      'malformed-record',
      `${field} is "${String(value)}"; expected one of ${PARTICIPANT_ROLES.join(', ')}`,
    );
  }
  return value as ParticipantRole;
}

function assertMessageType(value: unknown, field: string): MessageType {
  if (typeof value !== 'string' || !(MESSAGE_TYPES as readonly string[]).includes(value)) {
    throw new ConversationError(
      'malformed-record',
      `${field} is "${String(value)}"; expected one of ${MESSAGE_TYPES.join(', ')}`,
    );
  }
  return value as MessageType;
}

function assertContent(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConversationError(
      'malformed-record',
      `${field} is ${value === null ? 'null' : typeof value}; expected non-empty text`,
    );
  }
  return value;
}

function checkOptionalText(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new ConversationError(
      'malformed-record',
      `${field} is ${typeof value}; expected text or null`,
    );
  }
  return value;
}

function checkInstant(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new ConversationError(
      'malformed-instant',
      `${field} is ${value === null ? 'null' : typeof value}; expected a UTC instant string`,
    );
  }
  try {
    return parseInstant(value).source;
  } catch (error) {
    if (error instanceof InvalidInstantError) {
      throw new ConversationError('malformed-instant', `${field}: ${error.message}`);
    }
    throw error;
  }
}
