/**
 * K-15 Search Foundation — constants, identifier rules and foreign-field table.
 *
 * Identifier rules are K-01's, copied here because K-15 depends only on the platform substrate and
 * must not import another kernel component. The copy must stay character-for-character identical to
 * K-01's rule set in migration 0006 so the migration validator's opacity comparison stays true.
 *
 * The foreign-field table is the boundary of K-15. A search document carries only what this
 * component owns; anything else is refused by name.
 *
 * Owned by: K-15 Search Foundation.
 */

import { SearchError } from './types.ts';

/** The shape of an opaque internal identifier. */
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Minimum length. Shorter than this is not opaque, it is an ordinal. */
const MINIMUM_LENGTH = 8;

/** Names that mean the identifier is a credential rather than a handle. */
const SECRET_FRAGMENTS: readonly string[] = [
  'password',
  'passwd',
  'secret',
  'token',
  'apikey',
  'api_key',
  'api-key',
  'privatekey',
  'private_key',
  'private-key',
  'accesskey',
  'access_key',
  'access-key',
  'credential',
  'authorization',
  'bearer',
];

/** Value shapes that are a credential whatever they are called. */
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9]{16,}/,
  /\bghp_[A-Za-z0-9]{20,}/,
  /\bAKIA[0-9A-Z]{16}/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /\b(postgres(?:ql)?|mysql|mongodb):\/\/[^\s:]+:[^\s@]+@/,
];

/** Shapes that mean the caller passed a natural key rather than an internal handle. */
const NATURAL_IDENTIFIER_PATTERNS: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly what: string;
}> = [
  { pattern: /@/, what: 'an email address' },
  { pattern: /^\+\d[\d.\-\s]{6,}$/, what: 'an international telephone number' },
  {
    pattern: /^\d{7,}$/,
    what: 'a bare run of digits — a telephone, document, card or national identification number',
  },
  { pattern: /\d{12,}/, what: 'a long digit run, which is how card and account numbers look' },
  { pattern: /^[A-Z]{2}\d{2}[A-Z0-9]{10,}$/, what: 'an IBAN' },
  { pattern: /^(https?|mailto|tel):/i, what: 'a URL or URI' },
  { pattern: /\.(com|net|org|io|co|uk|lk)$/i, what: 'a domain name' },
  { pattern: /^[A-Za-z]+[._-][A-Za-z]+$/, what: 'a personal name in first.last form' },
  { pattern: /^(dob|ssn|nic|nin|tin|vat|passport)[-._:]/i, what: 'a labelled document number' },
];

/**
 * Refuse an identifier that is malformed, natural, or a credential.
 *
 * Ordered so the most specific refusal wins: a caller who passed an email should be told it looks
 * like an email, not that it failed a character-class test it also fails.
 */
export function assertSearchIdentifier(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new SearchError(
      'malformed-identifier',
      `${field} is ${value === null ? 'null' : typeof value}; expected a string`,
    );
  }

  const secret = SECRET_FRAGMENTS.find((fragment) => value.toLowerCase().includes(fragment));
  if (secret !== undefined) {
    throw new SearchError(
      'secret-bearing-input',
      `${field} contains "${secret}", so it is a credential rather than an identifier. ` +
        'Credentials belong to K-02 Authentication and must never be written into a field every ' +
        'downstream row copies',
    );
  }
  for (const pattern of SECRET_VALUE_PATTERNS) {
    if (pattern.test(value)) {
      throw new SearchError(
        'secret-bearing-input',
        `${field} matches the shape of a credential (${String(pattern)}). A search document id is ` +
          'copied into query logs and event logs; a credential in one is disclosed for as long as ' +
          'the platform exists',
      );
    }
  }

  const natural = NATURAL_IDENTIFIER_PATTERNS.find((entry) => entry.pattern.test(value));
  if (natural !== undefined) {
    throw new SearchError(
      'natural-identifier',
      `${field} "${value}" looks like ${natural.what}. A search identifier must be opaque: it is ` +
        'copied into query logs and audit records, so a natural key publishes personal data into ' +
        'places nobody can enumerate later and leaves an erasure request with no answer',
    );
  }

  if (!IDENTIFIER.test(value)) {
    throw new SearchError(
      'malformed-identifier',
      `${field} "${value}" is not a valid identifier. Expected 1-128 characters of ` +
        '[A-Za-z0-9._:-] starting alphanumeric',
    );
  }
  if (value.length < MINIMUM_LENGTH) {
    throw new SearchError(
      'malformed-identifier',
      `${field} "${value}" is ${value.length} characters. An identifier shorter than ` +
        `${MINIMUM_LENGTH} is guessable and usually an ordinal, and an enumerable search space ` +
        "lets anybody count the platform's documents and address one they were never given",
    );
  }

  return value;
}

/**
 * Fields that belong to another component, with the component named.
 *
 * A search document is an index abstraction: it carries text, facets, optional vectors and ranking
 * signals, and nothing else. A request carrying a business-module field is refused by name because it
 * is modelling the thing wrongly, not making a typo.
 */
export const FOREIGN_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  // K-01 Identity owns the party.
  subjectId: 'K-01 Identity owns the subject; a search document references an owner by ownerId',
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

  // K-03 Accounts owns the universal account.
  accountId:
    'K-03 Accounts owns the universal account; a search document references an owner by ownerId',
  account: 'K-03 Accounts owns the universal account',
  origin: 'K-03 Accounts owns the provenance of an account creation, not a search document',

  // K-04 Permissions owns who may do what.
  roles: 'K-04 Permissions owns roles and grants',
  role: 'K-04 Permissions owns roles and grants',
  permissions: 'K-04 Permissions owns permission evaluation',
  grants: 'K-04 Permissions owns grants',

  // K-10 Ledger Foundation owns every amount.
  balance: 'K-10 Ledger foundation is the authority on every amount',
  balances: 'K-10 Ledger foundation is the authority on every amount',
  currency: 'K-10 Ledger foundation owns monetary representation',
  amount: 'K-10 Ledger foundation is the authority on every amount',
  price: 'K-10 Ledger foundation is the authority on every amount',

  // Business modules own outcomes and detailed state.
  orderId: 'orders belong to the Orders module, not to the search foundation',
  paymentId: 'payments belong to the Payments module, not to the search foundation',
  offerId: 'offers belong to the Offers module, not to the search foundation',
  quoteId: 'quotes belong to the Quotes module, not to the search foundation',
  listingId: 'listings belong to the marketplace modules, not to the search foundation',
  productId:
    'product identity belongs to the Product Catalogue module, not to the search foundation',
  merchantId: 'merchant identity belongs to the Seller modules, not to the search foundation',
  buyerId: 'buyer identity belongs to the Cockpit modules, not to the search foundation',
  supplierId: 'supplier identity belongs to the supplier modules, not to the search foundation',

  // AI provider packages are forbidden here.
  aiModel: 'the AI Gateway module owns model selection; K-15 carries no AI provider state',
  aiProvider: 'the AI Gateway module owns provider routing; K-15 carries no AI provider state',
  prompt: 'prompt engineering belongs to the AI Gateway module, not to search content',
  promptTemplate: 'prompt templates belong to the AI Gateway module, not to search content',
  systemPrompt: 'system prompts belong to the AI Gateway module, not to search content',
  model: 'model selection belongs to the AI Gateway module, not to a search document',
  embedding: 'embedding generation belongs to the AI Gateway module; K-15 stores vectors only',

  // Profile data is not stored in the search foundation.
  email: 'email is a profile field, and personal data. The account profile core is separate work',
  phone: 'phone is a profile field, and personal data',
  name: 'name is a profile field, and personal data',
  displayName:
    'displayName is a profile field, and often a real name — the account profile core is separate work',
  address: 'address is a profile field, and personal data',
  dateOfBirth: 'dateOfBirth is a profile field, and personal data',
  avatar: 'avatar is a profile field, owned by the account profile core',
  locale: 'locale is a preference, not a search property',
  preferences:
    'preferences are separate work and are not identity or account structure; search is not their owner',

  // Lifecycle and state fields this component does not own.
  status: 'status is a lifecycle field and is not owned by the search foundation',
  state: 'state is a lifecycle field and is not owned by the search foundation',
  deletedAt: 'a search document is removed, not soft-deleted, in this slice',
  sentAt: 'K-14 Notifications owns delivery instants',
  scheduledAt: 'K-14 Notifications owns scheduling instants',
  sentBy: 'K-14 Notifications owns delivery actors',
});
