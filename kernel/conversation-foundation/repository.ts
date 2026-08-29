/**
 * K-12 Conversation Foundation — the persistence port.
 *
 * The service is written against this interface. The port exposes conversation, participant and
 * message storage, plus the outbox insert every producing module must support.
 *
 * Owned by: K-12 Conversation Foundation.
 */

import { InMemoryOutboxStore } from '../../platform/outbox/repository.ts';
import type { OutboxEntry, OutboxTransaction } from '../../platform/outbox/types.ts';

import {
  sealConversation,
  sealConversations,
  sealMessage,
  sealMessages,
  sealParticipant,
  sealParticipants,
} from './immutable.ts';
import { ConversationError, type Conversation, type Message, type Participant } from './types.ts';

export interface ConversationTransaction extends OutboxTransaction {
  /** Conversation lookup and creation. */
  findConversationById(conversationId: string): Promise<Conversation | null>;
  findConversationByIdempotencyKey(idempotencyKey: string): Promise<Conversation | null>;
  insertConversation(conversation: Conversation): Promise<void>;

  /** Participant lookup and creation. */
  findParticipantById(participantId: string): Promise<Participant | null>;
  findParticipantByIdempotencyKey(idempotencyKey: string): Promise<Participant | null>;
  findParticipantByConversationAndAccount(
    conversationId: string,
    accountId: string,
  ): Promise<Participant | null>;
  insertParticipant(participant: Participant): Promise<void>;

  /** Message lookup and creation. */
  findMessageById(messageId: string): Promise<Message | null>;
  findMessageByIdempotencyKey(idempotencyKey: string): Promise<Message | null>;
  findMessagesByConversation(
    conversationId: string,
    options: { after: string | null; limit: number },
  ): Promise<readonly Message[]>;
  insertMessage(message: Message): Promise<void>;
}

export interface ConversationRepository {
  /**
   * Run `body` in one transaction. An exception must roll everything back — a caller that sees a
   * failure must be able to assume nothing was written, including a half-written conversation.
   */
  withTransaction<T>(body: (tx: ConversationTransaction) => Promise<T>): Promise<T>;
}

/**
 * An in-memory repository.
 *
 * The reference implementation of the port's contract. It enforces the same uniqueness rules the
 * database does, and checks them **at commit against the store as it stands** rather than against the
 * snapshot the transaction read. Two callers that both read "no such participant" must not both win.
 */
export class InMemoryConversationRepository implements ConversationRepository {
  #conversations: Conversation[] = [];
  #participants: Participant[] = [];
  #messages: Message[] = [];
  readonly #outbox = new InMemoryOutboxStore('K-12', 'kernel_conversation_foundation');
  transactionsCommitted = 0;
  transactionsRolledBack = 0;

  conversations(): readonly Conversation[] {
    return sealConversations(this.#conversations);
  }

  participants(): readonly Participant[] {
    return sealParticipants(this.#participants);
  }

  messages(): readonly Message[] {
    return sealMessages(this.#messages);
  }

  outbox(): InMemoryOutboxStore {
    return this.#outbox;
  }

  /** Seed state directly, for tests that need a starting point without going through the service. */
  seed(state: {
    readonly conversations?: readonly Conversation[];
    readonly participants?: readonly Participant[];
    readonly messages?: readonly Message[];
    readonly outbox?: readonly OutboxEntry[];
  }): void {
    this.#conversations = (state.conversations ?? []).map(sealConversation);
    this.#participants = (state.participants ?? []).map(sealParticipant);
    this.#messages = (state.messages ?? []).map(sealMessage);
    this.#outbox.seed(state.outbox ?? []);
  }

  async withTransaction<T>(body: (tx: ConversationTransaction) => Promise<T>): Promise<T> {
    const working = {
      conversations: this.#conversations.map(sealConversation),
      participants: this.#participants.map(sealParticipant),
      messages: this.#messages.map(sealMessage),
    };
    const outboxWorking = new InMemoryOutboxStore(this.#outbox.name, this.#outbox.schema);
    outboxWorking.seed(this.#outbox.entries());

    const touched = new Touched();
    const tx = new InMemoryConversationTransaction(working, outboxWorking, touched);

    try {
      const result = await body(tx);
      this.#commit(working, touched);
      this.#outbox.seed(outboxWorking.entries());
      this.transactionsCommitted += 1;
      return result;
    } catch (error) {
      this.transactionsRolledBack += 1;
      throw error;
    }
  }

  #commit(working: WorkingSet, touched: Touched): void {
    // Conversations
    for (const conversation of working.conversations) {
      if (touched.conversations.has(conversation.conversationId)) {
        if (
          this.#conversations.some((held) => held.conversationId === conversation.conversationId)
        ) {
          throw new ConversationError(
            'duplicate-conversation-id',
            `conversation ${conversation.conversationId} was created by another transaction while this one was open`,
          );
        }
      }
      if (touched.conversationKeys.has(conversation.idempotencyKey)) {
        const holder = this.#conversations.find(
          (held) => held.idempotencyKey === conversation.idempotencyKey,
        );
        if (holder !== undefined) {
          throw new ConversationError(
            'idempotency-key-reuse',
            `idempotency key "${conversation.idempotencyKey}" was used by conversation ` +
              `${holder.conversationId}, created by another transaction while this one was open`,
          );
        }
      }
    }

    // Participants
    for (const participant of working.participants) {
      if (touched.participants.has(participant.participantId)) {
        if (this.#participants.some((held) => held.participantId === participant.participantId)) {
          throw new ConversationError(
            'duplicate-participant-id',
            `participant ${participant.participantId} was created by another transaction while this one was open`,
          );
        }
      }
      if (touched.participantKeys.has(participant.idempotencyKey)) {
        const holder = this.#participants.find(
          (held) => held.idempotencyKey === participant.idempotencyKey,
        );
        if (holder !== undefined) {
          throw new ConversationError(
            'idempotency-key-reuse',
            `idempotency key "${participant.idempotencyKey}" was used by participant ` +
              `${holder.participantId}, created by another transaction while this one was open`,
          );
        }
      }
      if (
        touched.participantAccounts.has(`${participant.conversationId}:${participant.accountId}`)
      ) {
        const holder = this.#participants.find(
          (held) =>
            held.conversationId === participant.conversationId &&
            held.accountId === participant.accountId,
        );
        if (holder !== undefined) {
          throw new ConversationError(
            'duplicate-participant-account',
            `account ${participant.accountId} is already a participant in conversation ` +
              `${participant.conversationId} as participant ${holder.participantId}`,
          );
        }
      }
    }

    // Messages
    for (const message of working.messages) {
      if (touched.messages.has(message.messageId)) {
        if (this.#messages.some((held) => held.messageId === message.messageId)) {
          throw new ConversationError(
            'duplicate-message-id',
            `message ${message.messageId} was created by another transaction while this one was open`,
          );
        }
      }
      if (touched.messageKeys.has(message.idempotencyKey)) {
        const holder = this.#messages.find(
          (held) => held.idempotencyKey === message.idempotencyKey,
        );
        if (holder !== undefined) {
          throw new ConversationError(
            'idempotency-key-reuse',
            `idempotency key "${message.idempotencyKey}" was used by message ${holder.messageId}, ` +
              'created by another transaction while this one was open',
          );
        }
      }
    }

    this.#conversations = [
      ...this.#conversations,
      ...working.conversations.filter((c) => touched.conversations.has(c.conversationId)),
    ];
    this.#participants = [
      ...this.#participants,
      ...working.participants.filter((p) => touched.participants.has(p.participantId)),
    ];
    this.#messages = [
      ...this.#messages,
      ...working.messages.filter((m) => touched.messages.has(m.messageId)),
    ];
  }
}

class WorkingSet {
  conversations: Conversation[];
  participants: Participant[];
  messages: Message[];

  constructor(snapshot: {
    conversations: Conversation[];
    participants: Participant[];
    messages: Message[];
  }) {
    this.conversations = snapshot.conversations;
    this.participants = snapshot.participants;
    this.messages = snapshot.messages;
  }
}

class Touched {
  readonly conversations = new Set<string>();
  readonly conversationKeys = new Set<string>();
  readonly participants = new Set<string>();
  readonly participantKeys = new Set<string>();
  readonly participantAccounts = new Set<string>();
  readonly messages = new Set<string>();
  readonly messageKeys = new Set<string>();
}

class InMemoryConversationTransaction implements ConversationTransaction {
  readonly #state: WorkingSet;
  readonly #outbox: InMemoryOutboxStore;
  readonly #touched: Touched;

  constructor(state: WorkingSet, outbox: InMemoryOutboxStore, touched: Touched) {
    this.#state = state;
    this.#outbox = outbox;
    this.#touched = touched;
  }

  insertOutbox(entry: OutboxEntry): Promise<void> {
    this.#outbox.insert(entry);
    return Promise.resolve();
  }

  findConversationById(conversationId: string): Promise<Conversation | null> {
    const found = this.#state.conversations.find((c) => c.conversationId === conversationId);
    return Promise.resolve(found === undefined ? null : sealConversation(found));
  }

  findConversationByIdempotencyKey(idempotencyKey: string): Promise<Conversation | null> {
    const found = this.#state.conversations.find((c) => c.idempotencyKey === idempotencyKey);
    return Promise.resolve(found === undefined ? null : sealConversation(found));
  }

  insertConversation(conversation: Conversation): Promise<void> {
    if (
      this.#state.conversations.some((held) => held.conversationId === conversation.conversationId)
    ) {
      return Promise.reject(
        new ConversationError(
          'duplicate-conversation-id',
          `conversation ${conversation.conversationId} already exists. A conversation is created once and never rewritten`,
        ),
      );
    }
    if (
      this.#state.conversations.some((held) => held.idempotencyKey === conversation.idempotencyKey)
    ) {
      return Promise.reject(
        new ConversationError(
          'idempotency-key-reuse',
          `idempotency key "${conversation.idempotencyKey}" has already been used`,
        ),
      );
    }
    this.#state.conversations.push(sealConversation(conversation));
    this.#touched.conversations.add(conversation.conversationId);
    this.#touched.conversationKeys.add(conversation.idempotencyKey);
    return Promise.resolve();
  }

  findParticipantById(participantId: string): Promise<Participant | null> {
    const found = this.#state.participants.find((p) => p.participantId === participantId);
    return Promise.resolve(found === undefined ? null : sealParticipant(found));
  }

  findParticipantByIdempotencyKey(idempotencyKey: string): Promise<Participant | null> {
    const found = this.#state.participants.find((p) => p.idempotencyKey === idempotencyKey);
    return Promise.resolve(found === undefined ? null : sealParticipant(found));
  }

  findParticipantByConversationAndAccount(
    conversationId: string,
    accountId: string,
  ): Promise<Participant | null> {
    const found = this.#state.participants.find(
      (p) => p.conversationId === conversationId && p.accountId === accountId,
    );
    return Promise.resolve(found === undefined ? null : sealParticipant(found));
  }

  insertParticipant(participant: Participant): Promise<void> {
    if (this.#state.participants.some((held) => held.participantId === participant.participantId)) {
      return Promise.reject(
        new ConversationError(
          'duplicate-participant-id',
          `participant ${participant.participantId} already exists. A participant is created once and never rewritten`,
        ),
      );
    }
    if (
      this.#state.participants.some((held) => held.idempotencyKey === participant.idempotencyKey)
    ) {
      return Promise.reject(
        new ConversationError(
          'idempotency-key-reuse',
          `idempotency key "${participant.idempotencyKey}" has already been used`,
        ),
      );
    }
    if (
      this.#state.participants.some(
        (held) =>
          held.conversationId === participant.conversationId &&
          held.accountId === participant.accountId,
      )
    ) {
      return Promise.reject(
        new ConversationError(
          'duplicate-participant-account',
          `account ${participant.accountId} is already a participant in conversation ` +
            participant.conversationId,
        ),
      );
    }
    this.#state.participants.push(sealParticipant(participant));
    this.#touched.participants.add(participant.participantId);
    this.#touched.participantKeys.add(participant.idempotencyKey);
    this.#touched.participantAccounts.add(`${participant.conversationId}:${participant.accountId}`);
    return Promise.resolve();
  }

  findMessageById(messageId: string): Promise<Message | null> {
    const found = this.#state.messages.find((m) => m.messageId === messageId);
    return Promise.resolve(found === undefined ? null : sealMessage(found));
  }

  findMessageByIdempotencyKey(idempotencyKey: string): Promise<Message | null> {
    const found = this.#state.messages.find((m) => m.idempotencyKey === idempotencyKey);
    return Promise.resolve(found === undefined ? null : sealMessage(found));
  }

  findMessagesByConversation(
    conversationId: string,
    options: { after: string | null; limit: number },
  ): Promise<readonly Message[]> {
    let found = this.#state.messages.filter((m) => m.conversationId === conversationId);
    if (options.after !== null) {
      const cursor = options.after;
      const afterMessage = this.#state.messages.find((m) => m.messageId === cursor);
      if (afterMessage !== undefined) {
        found = found.filter(
          (m) =>
            m.sentAt < afterMessage.sentAt ||
            (m.sentAt === afterMessage.sentAt &&
              m.messageId.localeCompare(afterMessage.messageId) < 0),
        );
      }
    }
    found.sort((a, b) => {
      const byTime = b.sentAt.localeCompare(a.sentAt);
      return byTime !== 0 ? byTime : b.messageId.localeCompare(a.messageId);
    });
    return Promise.resolve(Object.freeze(found.slice(0, options.limit).map(sealMessage)));
  }

  insertMessage(message: Message): Promise<void> {
    if (this.#state.messages.some((held) => held.messageId === message.messageId)) {
      return Promise.reject(
        new ConversationError(
          'duplicate-message-id',
          `message ${message.messageId} already exists. A message is created once and never rewritten`,
        ),
      );
    }
    if (this.#state.messages.some((held) => held.idempotencyKey === message.idempotencyKey)) {
      return Promise.reject(
        new ConversationError(
          'idempotency-key-reuse',
          `idempotency key "${message.idempotencyKey}" has already been used`,
        ),
      );
    }
    this.#state.messages.push(sealMessage(message));
    this.#touched.messages.add(message.messageId);
    this.#touched.messageKeys.add(message.idempotencyKey);
    return Promise.resolve();
  }
}
