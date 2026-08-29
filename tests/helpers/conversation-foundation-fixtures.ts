/**
 * Shared fixtures for the K-12 Conversation Foundation suites.
 */

import {
  ConversationService,
  InMemoryConversationRepository,
  type Conversation,
  type CreateConversationRequest,
  type Message,
  type Participant,
  type SendMessageRequest,
  type AddParticipantRequest,
} from '../../kernel/conversation-foundation/index.ts';

export interface Harness {
  readonly service: ConversationService;
  readonly repository: InMemoryConversationRepository;
}

export function build(): Harness {
  const repository = new InMemoryConversationRepository();
  return { service: new ConversationService(repository), repository };
}

let sequence = 0;

function seq(): string {
  sequence += 1;
  return String(sequence).padStart(4, '0');
}

export function createConversationRequest(
  overrides: Partial<CreateConversationRequest> = {},
): CreateConversationRequest {
  const n = seq();
  return {
    conversationId: `conv_01HQZX${n}`,
    title: null,
    context: 'direct',
    createdAt: '2026-04-01T12:00:00Z',
    idempotencyKey: `idem_conv_${n}`,
    ...overrides,
  };
}

export function conversationRecord(overrides: Partial<Conversation> = {}): Conversation {
  const n = seq();
  return {
    conversationId: `conv_01HQZY${n}`,
    title: null,
    context: 'direct',
    createdAt: '2026-04-01T12:00:00Z',
    idempotencyKey: `idem_conv_${n}`,
    ...overrides,
  };
}

export function addParticipantRequest(
  overrides: Partial<AddParticipantRequest> = {},
): AddParticipantRequest {
  const n = seq();
  return {
    participantId: `part_01HQZX${n}`,
    conversationId: `conv_01HQZX${n}`,
    accountId: `acct_01HQZX${n}`,
    role: 'member',
    joinedAt: '2026-04-01T12:00:00Z',
    idempotencyKey: `idem_part_${n}`,
    ...overrides,
  };
}

export function participantRecord(overrides: Partial<Participant> = {}): Participant {
  const n = seq();
  return {
    participantId: `part_01HQZY${n}`,
    conversationId: `conv_01HQZY${n}`,
    accountId: `acct_01HQZY${n}`,
    role: 'member',
    joinedAt: '2026-04-01T12:00:00Z',
    idempotencyKey: `idem_part_${n}`,
    ...overrides,
  };
}

export function sendMessageRequest(
  overrides: Partial<SendMessageRequest> = {},
): SendMessageRequest {
  const n = seq();
  return {
    messageId: `msg_01HQZX${n}`,
    conversationId: `conv_01HQZX${n}`,
    participantId: `part_01HQZX${n}`,
    content: 'Hello, world!',
    messageType: 'text',
    sentAt: '2026-04-01T12:00:00Z',
    idempotencyKey: `idem_msg_${n}`,
    ...overrides,
  };
}

export function messageRecord(overrides: Partial<Message> = {}): Message {
  const n = seq();
  return {
    messageId: `msg_01HQZY${n}`,
    conversationId: `conv_01HQZY${n}`,
    participantId: `part_01HQZY${n}`,
    content: 'Hello, world!',
    messageType: 'text',
    sentAt: '2026-04-01T12:00:00Z',
    idempotencyKey: `idem_msg_${n}`,
    ...overrides,
  };
}

export function conversationRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    conversation_id: 'conv_01HQZXTESTROW',
    title: null,
    context: 'direct',
    created_at: '2026-04-01T12:00:00.000000Z',
    idempotency_key: 'idem_01HQZXTESTROW',
    ...overrides,
  };
}

export function participantRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    participant_id: 'part_01HQZXTESTROW',
    conversation_id: 'conv_01HQZXTESTROW',
    account_id: 'acct_01HQZXTESTROW',
    role: 'member',
    joined_at: '2026-04-01T12:00:00.000000Z',
    idempotency_key: 'idem_01HQZXTESTROW',
    ...overrides,
  };
}

export function messageRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    message_id: 'msg_01HQZXTESTROW',
    conversation_id: 'conv_01HQZXTESTROW',
    participant_id: 'part_01HQZXTESTROW',
    content: 'Hello, world!',
    message_type: 'text',
    sent_at: '2026-04-01T12:00:00.000000Z',
    idempotency_key: 'idem_01HQZXTESTROW',
    ...overrides,
  };
}
