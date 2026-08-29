/**
 * K-12 Conversation Foundation — public surface.
 *
 * Everything another unit may depend on is re-exported here. Anything not listed is internal and may
 * change without notice; see kernel/conversation-foundation/CONTRACT.md for the contract this fixes.
 *
 * K-12 owns conversation, participant, message and attachment primitives for a Telegram-like UX.
 * It depends only on K-01 Identity and K-03 Accounts, and does not import any business module, AI
 * gateway or financial module.
 *
 * Owned by: K-12 Conversation Foundation.
 */

export {
  CONVERSATION_CONTEXTS,
  ConversationError,
  MESSAGE_TYPES,
  PARTICIPANT_ROLES,
  type Conversation,
  type ConversationContext,
  type ConversationErrorCode,
  type Message,
  type MessageType,
  type Participant,
  type ParticipantRole,
} from './types.ts';

export { FOREIGN_FIELDS, IDENTITY_REFUSALS, assertConversationIdentifier } from './registry.ts';

export {
  isConversationSealed,
  isMessageSealed,
  isParticipantSealed,
  sealConversation,
  sealConversations,
  sealMessage,
  sealMessages,
  sealParticipant,
  sealParticipants,
} from './immutable.ts';

export { validateConversation, validateMessage, validateParticipant } from './validate.ts';
export type { RecordSource } from './validate.ts';

export { ConversationService } from './service.ts';
export type {
  AddParticipantRequest,
  AddParticipantResult,
  CreateConversationRequest,
  CreateConversationResult,
  GetMessagesOptions,
  GetMessagesResult,
  SendMessageRequest,
  SendMessageResult,
} from './service.ts';

export { InMemoryConversationRepository } from './repository.ts';
export type { ConversationRepository, ConversationTransaction } from './repository.ts';

export {
  CONVERSATION_SCHEMA,
  CONVERSATION_TABLE,
  EnlistedConversationRepository,
  MESSAGE_TABLE,
  OUTBOX_TABLE,
  PARTICIPANT_TABLE,
  PostgresConversationRepository,
  TIMESTAMP_COLUMNS,
  enlistedClient,
  toConversation,
  toMessage,
  toParticipant,
} from './postgres-repository.ts';

export {
  CONVERSATION_CREATED_ACTION,
  CONVERSATION_CREATED_EVENT,
  CONVERSATION_MESSAGE_SENT_ACTION,
  CONVERSATION_MESSAGE_SENT_EVENT,
  makeConversationCreatedAction,
  makeConversationCreatedEvent,
  makeConversationMessageSentAction,
  makeConversationMessageSentEvent,
} from './outbox.ts';
