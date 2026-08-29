/**
 * K-12 Conversation Foundation — constants, identifier rules and foreign-field table.
 *
 * Identifier rules are K-01's, not a copy. K-12 may depend on K-01, so this component imports K-01's
 * `assertOpaqueIdentifier` and re-raises its refusals in its own vocabulary. A caller passing an
 * email as a `conversationId` hears a `ConversationError` naming `conversationId`, not an
 * `IdentityError` from a component it never called.
 *
 * The foreign-field table is the boundary of K-12. A conversation record carries only what this
 * component owns; anything else is refused by name.
 *
 * Owned by: K-12 Conversation Foundation.
 */

import { IdentityError, assertOpaqueIdentifier } from '../identity/index.ts';

import { ConversationError, type ConversationErrorCode } from './types.ts';

/**
 * K-01's identifier refusals, in this component's vocabulary.
 *
 * The mapping is total over what `assertOpaqueIdentifier` can raise. A new K-01 refusal code must
 * be given a K-12 meaning rather than escaping as an `IdentityError` from a call the caller never
 * made.
 */
export const IDENTITY_REFUSALS: Readonly<Record<string, ConversationErrorCode>> = Object.freeze({
  'malformed-identifier': 'malformed-identifier',
  'natural-identifier': 'natural-identifier',
  'secret-bearing-input': 'secret-bearing-input',
});

/**
 * Refuse an identifier that is malformed, natural, or a credential.
 *
 * One rule set, K-01's, applied to every K-12 identifier. An `IdentityError` this cannot translate
 * is rethrown unchanged rather than mislabelled.
 */
export function assertConversationIdentifier(value: unknown, field: string): string {
  try {
    return assertOpaqueIdentifier(value, field);
  } catch (error) {
    if (!(error instanceof IdentityError)) throw error;
    const code = IDENTITY_REFUSALS[error.code];
    if (code === undefined) throw error;
    throw new ConversationError(code, error.message);
  }
}

/**
 * Fields that belong to another component, with the component named.
 *
 * A conversation is a container for messages; it is not an account, a session, a role, an order, a
 * payment, or an AI decision. A request carrying any of these fields is refused by name.
 */
export const FOREIGN_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  // K-01 Identity owns the party, not the conversation.
  subjectId: 'K-01 Identity owns the subject; an account id references one and does not embed it',
  personKind: 'K-01 Identity owns what kind of party a subject is',
  subjectKind: 'K-01 Identity owns what kind of party a subject is',

  // K-02 Authentication owns everything about proving who is calling.
  password: 'K-02 Authentication owns credentials',
  passwordHash: 'K-02 Authentication owns credentials',
  credential: 'K-02 Authentication owns credentials',
  mfa: 'K-02 Authentication owns second factors',
  sessionId: 'K-02 Authentication owns sessions; nothing has authenticated anybody yet',
  session: 'K-02 Authentication owns sessions',
  token: 'K-02 Authentication owns tokens',
  authenticated: 'K-02 Authentication decides that, and does not exist yet',
  lastLoginAt: 'K-02 Authentication owns sessions, and this component records no activity',

  // K-03 owns the universal account, which a participant references by id.
  account: 'K-03 Accounts owns the universal account; a participant references one by accountId',
  accountId:
    'K-03 Accounts owns the universal account; it is referenced by a participant, not embedded in a conversation',
  origin: 'K-03 Accounts owns the provenance of an account creation, not a conversation',
  capabilities: 'K-03 Accounts and the Capability & Verification module own capabilities',
  capability: 'K-03 Accounts and the Capability & Verification module own capabilities',

  // K-04 Permissions owns who may do what.
  roles: 'K-04 Permissions owns roles and grants',
  role: 'K-04 Permissions owns roles and grants',
  permissions: 'K-04 Permissions owns permission evaluation',
  grants: 'K-04 Permissions owns grants',

  // Money and commerce belong elsewhere.
  balance: 'K-10 Ledger foundation is the authority on every amount',
  balances: 'K-10 Ledger foundation is the authority on every amount',
  currency: 'K-10 Ledger foundation owns monetary representation',
  amount: 'K-10 Ledger foundation is the authority on every amount',
  price: 'pricing is a business-module concern, not a conversation primitive',
  orderId: 'orders belong to the Orders module, not to the conversation foundation',
  listingId: 'listings belong to the marketplace modules, not to the conversation foundation',
  paymentId: 'payments belong to the Payments module, not to the conversation foundation',
  offerId: 'offers belong to the Offers module, not to the conversation foundation',
  quoteId: 'quotes belong to the Quotes module, not to the conversation foundation',

  // AI provider packages are forbidden here.
  aiModel: 'the AI Gateway module owns model selection; K-12 carries no AI provider state',
  aiProvider: 'the AI Gateway module owns provider routing; K-12 carries no AI provider state',
  prompt: 'prompt engineering belongs to the AI Gateway module, not to message content',
  promptTemplate: 'prompt templates belong to the AI Gateway module, not to message content',
  systemPrompt: 'system prompts belong to the AI Gateway module, not to message content',
  model: 'model selection belongs to the AI Gateway module, not to a conversation record',

  // Profile data is not stored in the conversation foundation.
  email: 'a profile field, and personal data. The account profile core is separate work',
  phone: 'a profile field, and personal data',
  name: 'a profile field, and personal data',
  displayName: 'a profile field, and often a real name — the account profile core is separate work',
  address: 'a profile field, and personal data',
  dateOfBirth: 'a profile field, and personal data',
  avatar: 'a profile field, owned by the account profile core',
  locale: 'a preference, not a conversation property',
  preferences: 'preferences are separate work and are not identity or account structure',

  // Lifecycle fields this component does not have.
  status: 'a conversation has no lifecycle state in this slice; context describes why it exists',
  state: 'a conversation has no lifecycle state in this slice; context describes why it exists',
  closedAt: 'closure is deferred and deliberately unimplemented',
  deletedAt: 'a conversation is written once; deletion is deferred and deliberately unimplemented',
  updatedAt:
    'a lifecycle field and this component does not track updates; a conversation is written once',
});
