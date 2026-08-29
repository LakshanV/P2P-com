/**
 * K-12 Conversation Foundation — the service.
 *
 * Four operations:
 *
 *   `createConversation` — create a conversation, refusing duplicates and malformed fields.
 *   `addParticipant`     — add a participant to a conversation, refusing unknown conversations,
 *                          duplicate accounts, and malformed fields.
 *   `sendMessage`        — send a message in a conversation, refusing unknown conversations,
 *                          unknown participants, and malformed fields.
 *   `getMessages`        — paginated message history by sentAt descending.
 *
 * Deterministic by construction: the caller supplies the identifiers and the instants. Nothing here
 * reads a clock or generates randomness.
 *
 * Owned by: K-12 Conversation Foundation.
 */

import {
  makeConversationCreatedAction,
  makeConversationCreatedEvent,
  makeConversationMessageSentAction,
  makeConversationMessageSentEvent,
} from './outbox.ts';
import { FOREIGN_FIELDS, assertConversationIdentifier } from './registry.ts';
import type { ConversationRepository } from './repository.ts';
import { sealConversation, sealMessage, sealMessages, sealParticipant } from './immutable.ts';
import { validateConversation, validateMessage, validateParticipant } from './validate.ts';
import {
  ConversationError,
  type Conversation as ConversationRecord,
  type ConversationContext,
  type Message,
  type Participant,
  type ParticipantRole,
} from './types.ts';

export interface CreateConversationRequest {
  readonly conversationId: string;
  readonly title?: string | null;
  readonly context: ConversationContext;
  readonly createdAt: string;
  readonly idempotencyKey: string;
}

export interface CreateConversationResult {
  readonly conversation: ConversationRecord;
  readonly deduplicated: boolean;
}

export interface AddParticipantRequest {
  readonly participantId: string;
  readonly conversationId: string;
  readonly accountId: string;
  readonly role: ParticipantRole;
  readonly joinedAt: string;
  readonly idempotencyKey: string;
}

export interface AddParticipantResult {
  readonly participant: Participant;
  readonly deduplicated: boolean;
}

export interface SendMessageRequest {
  readonly messageId: string;
  readonly conversationId: string;
  readonly participantId: string;
  readonly content: string;
  readonly messageType?: MessageType;
  readonly sentAt: string;
  readonly idempotencyKey: string;
}

export type MessageType = 'text' | 'system';

export interface SendMessageResult {
  readonly message: Message;
  readonly deduplicated: boolean;
}

export interface GetMessagesOptions {
  readonly limit?: number;
  readonly after?: string;
}

export interface GetMessagesResult {
  readonly messages: readonly Message[];
  readonly hasMore: boolean;
}

const CREATE_CONVERSATION_KEYS: readonly string[] = [
  'conversationId',
  'title',
  'context',
  'createdAt',
  'idempotencyKey',
];

const ADD_PARTICIPANT_KEYS: readonly string[] = [
  'participantId',
  'conversationId',
  'accountId',
  'role',
  'joinedAt',
  'idempotencyKey',
];

const SEND_MESSAGE_KEYS: readonly string[] = [
  'messageId',
  'conversationId',
  'participantId',
  'content',
  'messageType',
  'sentAt',
  'idempotencyKey',
];

export class ConversationService {
  readonly #repository: ConversationRepository;

  constructor(repository: ConversationRepository) {
    this.#repository = repository;
  }

  /**
   * Create a conversation.
   *
   * Validates, checks idempotency, and emits a K-08 event and a K-09 audit record through the
   * module-owned outbox inside the same transaction.
   */
  async createConversation(request: CreateConversationRequest): Promise<CreateConversationResult> {
    assertNoForeignConcerns(request, CREATE_CONVERSATION_KEYS, 'createConversation');
    const conversation = sealConversation(
      validateConversation(
        {
          conversationId: request.conversationId,
          title: request.title ?? null,
          context: request.context,
          createdAt: request.createdAt,
          idempotencyKey: request.idempotencyKey,
        },
        'request',
      ),
    );

    try {
      return await this.#insertConversation(conversation);
    } catch (error) {
      const conflicted =
        error instanceof ConversationError &&
        (error.code === 'duplicate-conversation-id' || error.code === 'idempotency-key-reuse');
      if (!conflicted) throw error;

      const winner = await this.#repository.withTransaction((tx) =>
        tx.findConversationByIdempotencyKey(conversation.idempotencyKey),
      );
      if (winner === null || !conversationEquals(winner, conversation)) throw error;
      return { conversation: sealConversation(winner), deduplicated: true };
    }
  }

  async #insertConversation(conversation: ConversationRecord): Promise<CreateConversationResult> {
    return this.#repository.withTransaction(async (tx) => {
      const existingKey = await tx.findConversationByIdempotencyKey(conversation.idempotencyKey);
      if (existingKey !== null) {
        if (!conversationEquals(existingKey, conversation)) {
          throw new ConversationError(
            'idempotency-key-reuse',
            `idempotency key "${conversation.idempotencyKey}" has already been used for a different conversation`,
          );
        }
        return { conversation: sealConversation(existingKey), deduplicated: true };
      }

      const existingId = await tx.findConversationById(conversation.conversationId);
      if (existingId !== null) {
        if (conversationEquals(existingId, conversation)) {
          return { conversation: sealConversation(existingId), deduplicated: true };
        }
        throw new ConversationError(
          'duplicate-conversation-id',
          `conversation ${conversation.conversationId} already exists. A conversation is created once and never rewritten`,
        );
      }

      await tx.insertConversation(conversation);

      const correlationId = conversation.conversationId;
      const causationId: string | null = null;
      await tx.insertOutbox(makeConversationCreatedEvent(conversation, correlationId, causationId));
      await tx.insertOutbox(
        makeConversationCreatedAction(conversation, correlationId, causationId),
      );

      return { conversation, deduplicated: false };
    });
  }

  /**
   * Add a participant to a conversation.
   *
   * Validates, checks the conversation exists, checks idempotency, and ensures the account is not
   * already a participant in this conversation.
   */
  async addParticipant(request: AddParticipantRequest): Promise<AddParticipantResult> {
    assertNoForeignConcerns(request, ADD_PARTICIPANT_KEYS, 'addParticipant');
    const participant = sealParticipant(
      validateParticipant(
        {
          participantId: request.participantId,
          conversationId: request.conversationId,
          accountId: request.accountId,
          role: request.role,
          joinedAt: request.joinedAt,
          idempotencyKey: request.idempotencyKey,
        },
        'request',
      ),
    );

    try {
      return await this.#insertParticipant(participant);
    } catch (error) {
      const conflicted =
        error instanceof ConversationError &&
        (error.code === 'duplicate-participant-id' ||
          error.code === 'idempotency-key-reuse' ||
          error.code === 'duplicate-participant-account');
      if (!conflicted) throw error;

      const winner = await this.#repository.withTransaction((tx) =>
        tx.findParticipantByIdempotencyKey(participant.idempotencyKey),
      );
      if (winner === null || !participantEquals(winner, participant)) throw error;
      return { participant: sealParticipant(winner), deduplicated: true };
    }
  }

  async #insertParticipant(participant: Participant): Promise<AddParticipantResult> {
    return this.#repository.withTransaction(async (tx) => {
      const existingKey = await tx.findParticipantByIdempotencyKey(participant.idempotencyKey);
      if (existingKey !== null) {
        if (!participantEquals(existingKey, participant)) {
          throw new ConversationError(
            'idempotency-key-reuse',
            `idempotency key "${participant.idempotencyKey}" has already been used for a different participant`,
          );
        }
        return { participant: sealParticipant(existingKey), deduplicated: true };
      }

      const existingId = await tx.findParticipantById(participant.participantId);
      if (existingId !== null) {
        if (participantEquals(existingId, participant)) {
          return { participant: sealParticipant(existingId), deduplicated: true };
        }
        throw new ConversationError(
          'duplicate-participant-id',
          `participant ${participant.participantId} already exists. A participant is created once and never rewritten`,
        );
      }

      const existingAccount = await tx.findParticipantByConversationAndAccount(
        participant.conversationId,
        participant.accountId,
      );
      if (existingAccount !== null) {
        if (participantEquals(existingAccount, participant)) {
          return { participant: sealParticipant(existingAccount), deduplicated: true };
        }
        throw new ConversationError(
          'duplicate-participant-account',
          `account ${participant.accountId} is already a participant in conversation ` +
            `${participant.conversationId} as participant ${existingAccount.participantId}`,
        );
      }

      const conversation = await tx.findConversationById(participant.conversationId);
      if (conversation === null) {
        throw new ConversationError(
          'unknown-conversation',
          `conversation ${participant.conversationId} does not exist. A participant must be added ` +
            'to a conversation that has already been created',
        );
      }

      await tx.insertParticipant(participant);
      return { participant, deduplicated: false };
    });
  }

  /**
   * Send a message in a conversation.
   *
   * Validates, checks the conversation exists, checks the participant exists in the conversation,
   * checks idempotency, appends the message, and emits a K-08 event and a K-09 audit record.
   */
  async sendMessage(request: SendMessageRequest): Promise<SendMessageResult> {
    assertNoForeignConcerns(request, SEND_MESSAGE_KEYS, 'sendMessage');
    const message = sealMessage(
      validateMessage(
        {
          messageId: request.messageId,
          conversationId: request.conversationId,
          participantId: request.participantId,
          content: request.content,
          messageType: request.messageType ?? 'text',
          sentAt: request.sentAt,
          idempotencyKey: request.idempotencyKey,
        },
        'request',
      ),
    );

    try {
      return await this.#insertMessage(message);
    } catch (error) {
      const conflicted =
        error instanceof ConversationError &&
        (error.code === 'duplicate-message-id' || error.code === 'idempotency-key-reuse');
      if (!conflicted) throw error;

      const winner = await this.#repository.withTransaction((tx) =>
        tx.findMessageByIdempotencyKey(message.idempotencyKey),
      );
      if (winner === null || !messageEquals(winner, message)) throw error;
      return { message: sealMessage(winner), deduplicated: true };
    }
  }

  async #insertMessage(message: Message): Promise<SendMessageResult> {
    return this.#repository.withTransaction(async (tx) => {
      const existingKey = await tx.findMessageByIdempotencyKey(message.idempotencyKey);
      if (existingKey !== null) {
        if (!messageEquals(existingKey, message)) {
          throw new ConversationError(
            'idempotency-key-reuse',
            `idempotency key "${message.idempotencyKey}" has already been used for a different message`,
          );
        }
        return { message: sealMessage(existingKey), deduplicated: true };
      }

      const existingId = await tx.findMessageById(message.messageId);
      if (existingId !== null) {
        if (messageEquals(existingId, message)) {
          return { message: sealMessage(existingId), deduplicated: true };
        }
        throw new ConversationError(
          'duplicate-message-id',
          `message ${message.messageId} already exists. A message is created once and never rewritten`,
        );
      }

      const conversation = await tx.findConversationById(message.conversationId);
      if (conversation === null) {
        throw new ConversationError(
          'unknown-conversation',
          `conversation ${message.conversationId} does not exist. A message must be sent to a ` +
            'conversation that has already been created',
        );
      }

      const participant = await tx.findParticipantById(message.participantId);
      if (participant === null || participant.conversationId !== message.conversationId) {
        throw new ConversationError(
          'unknown-participant',
          `participant ${message.participantId} is not a member of conversation ${message.conversationId}. ` +
            'A message must be sent by a participant that has already been added to the conversation',
        );
      }

      await tx.insertMessage(message);

      const correlationId = message.conversationId;
      const causationId = message.participantId;
      await tx.insertOutbox(makeConversationMessageSentEvent(message, correlationId, causationId));
      await tx.insertOutbox(makeConversationMessageSentAction(message, correlationId, causationId));

      return { message, deduplicated: false };
    });
  }

  /**
   * Paginated message history for a conversation.
   *
   * Ordered by sentAt descending, then messageId descending for stability. Default page size 50,
   * maximum 100. `after` is the messageId of the last message on the previous page.
   */
  async getMessages(
    conversationId: string,
    options: GetMessagesOptions = {},
  ): Promise<GetMessagesResult> {
    assertConversationIdentifier(conversationId, 'conversationId');
    const limit = clampLimit(options.limit ?? 50);

    return this.#repository.withTransaction(async (tx) => {
      const conversation = await tx.findConversationById(conversationId);
      if (conversation === null) {
        throw new ConversationError(
          'unknown-conversation',
          `conversation ${conversationId} does not exist`,
        );
      }

      const messages = await tx.findMessagesByConversation(conversationId, {
        after: options.after ?? null,
        limit: limit + 1,
      });
      const hasMore = messages.length > limit;
      return {
        messages: sealMessages(messages.slice(0, limit)),
        hasMore,
      };
    });
  }
}

function clampLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1) return 50;
  if (value > 100) return 100;
  return value;
}

function assertNoForeignConcerns(
  request: object,
  permitted: readonly string[],
  operation: string,
): void {
  if (request === null || typeof request !== 'object') {
    throw new ConversationError(
      'malformed-record',
      `${operation} needs a request object, got ${request === null ? 'null' : typeof request}`,
    );
  }

  for (const key of Object.keys(request)) {
    if (permitted.includes(key)) continue;

    const owner = FOREIGN_FIELDS[key];
    if (owner !== undefined) {
      throw new ConversationError(
        'foreign-concern',
        `${operation} carried "${key}", but ${owner}. A conversation record carries only what K-12 owns`,
      );
    }
    throw new ConversationError(
      'foreign-concern',
      `${operation} carried the unrecognised field "${key}". The permitted fields are ` +
        `${permitted.join(', ')}; anything else would be accepted and silently dropped`,
    );
  }
}

function conversationEquals(a: ConversationRecord, b: ConversationRecord): boolean {
  return (
    a.conversationId === b.conversationId &&
    a.title === b.title &&
    a.context === b.context &&
    a.createdAt === b.createdAt
  );
}

function participantEquals(a: Participant, b: Participant): boolean {
  return (
    a.participantId === b.participantId &&
    a.conversationId === b.conversationId &&
    a.accountId === b.accountId &&
    a.role === b.role &&
    a.joinedAt === b.joinedAt
  );
}

function messageEquals(a: Message, b: Message): boolean {
  return (
    a.messageId === b.messageId &&
    a.conversationId === b.conversationId &&
    a.participantId === b.participantId &&
    a.content === b.content &&
    a.messageType === b.messageType &&
    a.sentAt === b.sentAt
  );
}
