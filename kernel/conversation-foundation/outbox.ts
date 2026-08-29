/**
 * K-12 Conversation Foundation — outbox event and audit definitions (FND-003d).
 *
 * These definitions describe the facts K-12 publishes to the platform event log and audit log when
 * a conversation is created or a message is sent. They are declared separately from the service so
 * a relay can register them without importing K-12 internals, and so the payloads stay stable once
 * consumers depend on them.
 *
 * Owned by: K-12 Conversation Foundation.
 */

import type { AuditActionDefinition, EvidenceField } from '../audit-foundation/registry.ts';
import { auditOutboxEntry, eventOutboxEntry } from '../../platform/outbox/builder.ts';
import type { OutboxEntry } from '../../platform/outbox/types.ts';
import type { EventTypeDefinition, PayloadField } from '../event-infrastructure/registry.ts';

import type { Conversation, Message } from './types.ts';

export const CONVERSATION_CREATED_EVENT: EventTypeDefinition = {
  type: 'conversation.created',
  schemaVersion: 1,
  owner: 'K-12',
  description: 'A conversation was created and its participants may now be added.',
  payloadFields: [
    {
      name: 'conversation_id',
      kind: 'string',
      required: true,
      description: 'The created conversation id.',
    },
    {
      name: 'context',
      kind: 'string',
      required: true,
      description: 'The conversation context.',
    },
    {
      name: 'created_at',
      kind: 'string',
      required: true,
      description: 'ISO-8601 instant when the conversation was created.',
    },
    {
      name: 'idempotency_key',
      kind: 'string',
      required: true,
      description: 'The idempotency key supplied when creating the conversation.',
    },
  ] satisfies PayloadField[],
};

export const CONVERSATION_CREATED_ACTION: AuditActionDefinition = {
  action: 'conversation.created',
  owner: 'K-12',
  authority: 'business-authoritative',
  description: 'A conversation was created.',
  resourceTypes: ['conversation'],
  evidenceFields: [
    {
      name: 'conversation_id',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The created conversation id.',
    },
    {
      name: 'context',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The conversation context.',
    },
    {
      name: 'created_at',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'ISO-8601 instant when the conversation was created.',
    },
    {
      name: 'idempotency_key',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The idempotency key supplied when creating the conversation.',
    },
  ] satisfies EvidenceField[],
};

export const CONVERSATION_MESSAGE_SENT_EVENT: EventTypeDefinition = {
  type: 'conversation.message_sent',
  schemaVersion: 1,
  owner: 'K-12',
  description: 'A message was sent in a conversation.',
  payloadFields: [
    {
      name: 'message_id',
      kind: 'string',
      required: true,
      description: 'The sent message id.',
    },
    {
      name: 'conversation_id',
      kind: 'string',
      required: true,
      description: 'The conversation the message belongs to.',
    },
    {
      name: 'participant_id',
      kind: 'string',
      required: true,
      description: 'The participant that sent the message.',
    },
    {
      name: 'message_type',
      kind: 'string',
      required: true,
      description: 'The kind of message.',
    },
    {
      name: 'sent_at',
      kind: 'string',
      description: 'ISO-8601 instant when the message was sent.',
      required: true,
    },
    {
      name: 'idempotency_key',
      kind: 'string',
      required: true,
      description: 'The idempotency key supplied when sending the message.',
    },
  ] satisfies PayloadField[],
};

export const CONVERSATION_MESSAGE_SENT_ACTION: AuditActionDefinition = {
  action: 'conversation.message_sent',
  owner: 'K-12',
  authority: 'business-authoritative',
  description: 'A message was sent in a conversation.',
  resourceTypes: ['conversation_message'],
  evidenceFields: [
    {
      name: 'message_id',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The sent message id.',
    },
    {
      name: 'conversation_id',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The conversation the message belongs to.',
    },
    {
      name: 'participant_id',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The participant that sent the message.',
    },
    {
      name: 'message_type',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The kind of message.',
    },
    {
      name: 'sent_at',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'ISO-8601 instant when the message was sent.',
    },
    {
      name: 'idempotency_key',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The idempotency key supplied when sending the message.',
    },
  ] satisfies EvidenceField[],
};

export function makeConversationCreatedEvent(
  conversation: Conversation,
  correlationId: string,
  causationId: string | null,
): OutboxEntry {
  const eventId = `${conversation.conversationId}:created`;
  const recordedAt = conversation.createdAt;

  return eventOutboxEntry({
    outboxId: `K-12:${eventId}`,
    idempotencyKey: `K-12:${eventId}`,
    payload: {
      eventId,
      type: CONVERSATION_CREATED_EVENT.type,
      schemaVersion: CONVERSATION_CREATED_EVENT.schemaVersion,
      occurredAt: recordedAt,
      recordedAt,
      producer: 'K-12',
      correlationId,
      causationId,
      origin: 'system',
      actor: { kind: 'system', id: 'K-12' },
      idempotencyKey: `K-12:${eventId}`,
      now: recordedAt,
      payload: {
        conversation_id: conversation.conversationId,
        context: conversation.context,
        created_at: conversation.createdAt,
        idempotency_key: conversation.idempotencyKey,
      },
    },
    occurredAt: recordedAt,
    recordedAt,
    producer: 'K-12',
    correlationId,
    causationId,
  });
}

export function makeConversationCreatedAction(
  conversation: Conversation,
  correlationId: string,
  causationId: string | null,
): OutboxEntry {
  const recordId = `${conversation.conversationId}:created`;
  const outboxId = `K-12:audit:${recordId}`;
  const recordedAt = conversation.createdAt;

  return auditOutboxEntry({
    outboxId,
    idempotencyKey: outboxId,
    payload: {
      recordId,
      action: CONVERSATION_CREATED_ACTION.action,
      recordedAt,
      actor: { kind: 'system', id: 'K-12', authentication: 'unauthenticated', sessionId: null },
      resource: { owner: 'K-12', type: 'conversation', id: conversation.conversationId },
      outcome: 'succeeded',
      reason: `conversation ${conversation.conversationId} created with context ${conversation.context}`,
      correlationId,
      causationId,
      idempotencyKey: outboxId,
      evidence: {
        conversation_id: conversation.conversationId,
        context: conversation.context,
        created_at: conversation.createdAt,
        idempotency_key: conversation.idempotencyKey,
      },
    },
    recordedAt,
    producer: 'K-12',
    correlationId,
    causationId,
  });
}

export function makeConversationMessageSentEvent(
  message: Message,
  correlationId: string,
  causationId: string | null,
): OutboxEntry {
  const eventId = `${message.messageId}:sent`;
  const recordedAt = message.sentAt;

  return eventOutboxEntry({
    outboxId: `K-12:${eventId}`,
    idempotencyKey: `K-12:${eventId}`,
    payload: {
      eventId,
      type: CONVERSATION_MESSAGE_SENT_EVENT.type,
      schemaVersion: CONVERSATION_MESSAGE_SENT_EVENT.schemaVersion,
      occurredAt: recordedAt,
      recordedAt,
      producer: 'K-12',
      correlationId,
      causationId,
      origin: 'system',
      actor: { kind: 'system', id: 'K-12' },
      idempotencyKey: `K-12:${eventId}`,
      now: recordedAt,
      payload: {
        message_id: message.messageId,
        conversation_id: message.conversationId,
        participant_id: message.participantId,
        message_type: message.messageType,
        sent_at: message.sentAt,
        idempotency_key: message.idempotencyKey,
      },
    },
    occurredAt: recordedAt,
    recordedAt,
    producer: 'K-12',
    correlationId,
    causationId,
  });
}

export function makeConversationMessageSentAction(
  message: Message,
  correlationId: string,
  causationId: string | null,
): OutboxEntry {
  const recordId = `${message.messageId}:sent`;
  const outboxId = `K-12:audit:${recordId}`;
  const recordedAt = message.sentAt;

  return auditOutboxEntry({
    outboxId,
    idempotencyKey: outboxId,
    payload: {
      recordId,
      action: CONVERSATION_MESSAGE_SENT_ACTION.action,
      recordedAt,
      actor: { kind: 'system', id: 'K-12', authentication: 'unauthenticated', sessionId: null },
      resource: {
        owner: 'K-12',
        type: 'conversation_message',
        id: message.messageId,
      },
      outcome: 'succeeded',
      reason: `message ${message.messageId} sent in conversation ${message.conversationId}`,
      correlationId,
      causationId,
      idempotencyKey: outboxId,
      evidence: {
        message_id: message.messageId,
        conversation_id: message.conversationId,
        participant_id: message.participantId,
        message_type: message.messageType,
        sent_at: message.sentAt,
        idempotency_key: message.idempotencyKey,
      },
    },
    recordedAt,
    producer: 'K-12',
    correlationId,
    causationId,
  });
}
