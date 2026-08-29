/**
 * K-12 Conversation Foundation — domain types.
 *
 * Primitives for a Telegram-like conversation UX: a conversation, the participants in it, and the
 * messages they exchange. Nothing here knows about AI providers, business modules, or money.
 *
 * Deterministic by construction: the caller supplies every identifier and every instant. Nothing
 * here reads a clock or generates randomness.
 *
 * Owned by: K-12 Conversation Foundation.
 */

/** The context a conversation exists in. */
export const CONVERSATION_CONTEXTS = ['direct', 'transaction', 'support', 'ai'] as const;
export type ConversationContext = (typeof CONVERSATION_CONTEXTS)[number];

/** A participant's role in a conversation. */
export const PARTICIPANT_ROLES = ['owner', 'member', 'ai', 'system'] as const;
export type ParticipantRole = (typeof PARTICIPANT_ROLES)[number];

/** The kind of message sent. */
export const MESSAGE_TYPES = ['text', 'system'] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

/**
 * A conversation.
 *
 * A conversation is a container with a context. It carries no state machine and no business logic:
 * those live in the modules that use it.
 */
export interface Conversation {
  /** Caller-supplied, opaque and stable. */
  readonly conversationId: string;
  /** Optional human-readable title; may be empty or null. */
  readonly title: string | null;
  /** Why this conversation exists. */
  readonly context: ConversationContext;
  /** When the conversation was created, as a canonical UTC instant. */
  readonly createdAt: string;
  /** Stable across retries of one logical creation. */
  readonly idempotencyKey: string;
}

/**
 * A participant in a conversation.
 *
 * One account per conversation: a party enters a conversation exactly once. The account id is a
 * K-03 universal account id; this component does not verify it, because that verification is
 * deferred to the integration layer.
 */
export interface Participant {
  /** Caller-supplied, opaque and stable. */
  readonly participantId: string;
  /** The conversation this participant belongs to. */
  readonly conversationId: string;
  /** The K-03 universal account that participates. */
  readonly accountId: string;
  /** The participant's role. */
  readonly role: ParticipantRole;
  /** When the participant joined, as a canonical UTC instant. */
  readonly joinedAt: string;
  /** Stable across retries of one logical addition. */
  readonly idempotencyKey: string;
}

/**
 * A message in a conversation.
 *
 * Messages are append-only. The content is required text; attachments are a deferred concern.
 */
export interface Message {
  /** Caller-supplied, opaque and stable. */
  readonly messageId: string;
  /** The conversation this message belongs to. */
  readonly conversationId: string;
  /** The participant that sent this message. */
  readonly participantId: string;
  /** Non-empty message content. */
  readonly content: string;
  /** The kind of message. */
  readonly messageType: MessageType;
  /** When the message was sent, as a canonical UTC instant. */
  readonly sentAt: string;
  /** Stable across retries of one logical send. */
  readonly idempotencyKey: string;
}

export type ConversationErrorCode =
  /** An identifier is not well formed. */
  | 'malformed-identifier'
  /** An identifier looks like a natural key. */
  | 'natural-identifier'
  /** An identifier names or looks like a credential. */
  | 'secret-bearing-input'
  /** The instant is not a real UTC instant. */
  | 'malformed-instant'
  /** A request carried a field belonging to another component. */
  | 'foreign-concern'
  /** The conversation id already exists with different content. */
  | 'duplicate-conversation-id'
  /** The participant id already exists with different content. */
  | 'duplicate-participant-id'
  /** The message id already exists with different content. */
  | 'duplicate-message-id'
  /** The idempotency key was already used for a different record. */
  | 'idempotency-key-reuse'
  /** The requested conversation does not exist. */
  | 'unknown-conversation'
  /** The requested participant does not exist in this conversation. */
  | 'unknown-participant'
  /** The account is already a participant in this conversation. */
  | 'duplicate-participant-account'
  /** A stored row, or a candidate record, is not what this component writes. */
  | 'malformed-record'
  /** An enlisted write tried to issue transaction control. */
  | 'nested-transaction';

/** A refusal the caller must act on. */
export class ConversationError extends Error {
  readonly code: ConversationErrorCode;

  constructor(code: ConversationErrorCode, message: string) {
    super(message);
    this.name = 'ConversationError';
    this.code = code;
  }
}
