/**
 * K-12 Conversation Foundation — the immutability boundary.
 *
 * Every record that crosses a service or repository boundary is deep-frozen and cloned, so a caller
 * cannot edit what was stored. Conversations, participants and messages are append-only; the only
 * defence against silent mutation at the boundary is to make mutation throw.
 *
 * Owned by: K-12 Conversation Foundation.
 */

import type { Conversation, Message, Participant } from './types.ts';

/** A deep, frozen copy of a conversation. */
export function sealConversation(conversation: Conversation): Conversation {
  return Object.freeze({ ...conversation });
}

/** A deep, frozen copy of a participant. */
export function sealParticipant(participant: Participant): Participant {
  return Object.freeze({ ...participant });
}

/** A deep, frozen copy of a message. */
export function sealMessage(message: Message): Message {
  return Object.freeze({ ...message });
}

/** Frozen copies of a list of conversations. */
export function sealConversations(conversations: readonly Conversation[]): readonly Conversation[] {
  return Object.freeze(conversations.map(sealConversation));
}

/** Frozen copies of a list of participants. */
export function sealParticipants(participants: readonly Participant[]): readonly Participant[] {
  return Object.freeze(participants.map(sealParticipant));
}

/** Frozen copies of a list of messages. */
export function sealMessages(messages: readonly Message[]): readonly Message[] {
  return Object.freeze(messages.map(sealMessage));
}

/** Is this conversation sealed? */
export function isConversationSealed(conversation: Conversation): boolean {
  return Object.isFrozen(conversation);
}

/** Is this participant sealed? */
export function isParticipantSealed(participant: Participant): boolean {
  return Object.isFrozen(participant);
}

/** Is this message sealed? */
export function isMessageSealed(message: Message): boolean {
  return Object.isFrozen(message);
}
