/**
 * K-13 AI Gateway — constants, identifier rules and foreign-field table.
 *
 * Identifier rules are duplicated here rather than imported from K-01 Identity, because the
 * architecture statement for this slice restricts K-13's direct kernel dependencies to K-05, K-06
 * and K-09. The duplication is guarded: migration 0019 carries a character-for-character copy of
 * the rule set as a schema function, and `tests/migrations.test.ts` asserts it matches every other
 * copy.
 *
 * The foreign-field table is the boundary of K-13. A gateway record carries only what this component
 * owns; anything else is refused by name.
 *
 * Owned by: K-13 AI Gateway.
 */

import { AIGatewayError } from './types.ts';

/** Shapes that mean an identifier is a natural or personal key rather than an opaque handle. */
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

/** Names that mean an identifier is a credential rather than a handle. */
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

/** The shape of an opaque internal identifier: 8-128 chars of the allowed alphabet, starting alphanumeric. */
const OPAQUE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MINIMUM_IDENTIFIER_LENGTH = 8;

/**
 * Refuse an identifier that is malformed, natural, or a credential.
 *
 * Re-raises refusals in K-13's vocabulary so a caller passing an email as a binding id hears an
 * `AIGatewayError` naming the field, not an error from a component it never called.
 */
export function assertOpaqueIdentifier(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new AIGatewayError(
      'malformed-identifier',
      `${field} is ${value === null ? 'null' : typeof value}; expected a string`,
    );
  }

  const secret = SECRET_FRAGMENTS.find((fragment) => value.toLowerCase().includes(fragment));
  if (secret !== undefined) {
    throw new AIGatewayError(
      'secret-bearing-input',
      `${field} contains "${secret}", so it is a credential rather than an identifier. ` +
        'Credentials belong to K-02 Authentication and must never be written into a field every ' +
        'AI run copies',
    );
  }

  for (const pattern of SECRET_VALUE_PATTERNS) {
    if (pattern.test(value)) {
      throw new AIGatewayError(
        'secret-bearing-input',
        `${field} matches the shape of a credential (${String(pattern)}). An AI gateway id is ` +
          'copied into every run and audit record that references it; a secret there is disclosed ' +
          'for as long as the gateway exists',
      );
    }
  }

  const natural = NATURAL_IDENTIFIER_PATTERNS.find((entry) => entry.pattern.test(value));
  if (natural !== undefined) {
    throw new AIGatewayError(
      'natural-identifier',
      `${field} "${value}" looks like ${natural.what}. An AI gateway id must be opaque: it is ` +
        'copied into every run and audit record that references this binding or run, so a natural ' +
        'key publishes personal or sensitive data into places nobody can enumerate later',
    );
  }

  if (!OPAQUE_IDENTIFIER.test(value)) {
    throw new AIGatewayError(
      'malformed-identifier',
      `${field} "${value}" is not a valid identifier. Expected 1-128 characters of ` +
        '[A-Za-z0-9._:-] starting alphanumeric',
    );
  }

  if (value.length < MINIMUM_IDENTIFIER_LENGTH) {
    throw new AIGatewayError(
      'malformed-identifier',
      `${field} "${value}" is ${value.length} characters. An identifier shorter than ` +
        `${MINIMUM_IDENTIFIER_LENGTH} is guessable and usually an ordinal, and an enumerable ` +
        "identity space lets anybody count the platform's runs and address one they were never given",
    );
  }

  return value;
}

/** Task ids are dotted lowercase so they read as vocabulary, not handles. */
const TASK_ID = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;

/**
 * Refuse a task id that is not dotted lowercase.
 *
 * Task ids are deliberately not opaque identifiers: they are the gateway's shared vocabulary for
 * work (`need.interpret`, `product.recognize`) and must be readable in code and queries.
 */
export function assertTaskId(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new AIGatewayError(
      'malformed-task-id',
      `${field} is ${value === null ? 'null' : typeof value}; expected a string`,
    );
  }
  if (!TASK_ID.test(value)) {
    throw new AIGatewayError(
      'malformed-task-id',
      `${field} "${value}" is not a valid task id. Expected dotted lower_snake_case such as ` +
        'need.interpret',
    );
  }
  if (value.length < 4 || value.length > 128) {
    throw new AIGatewayError(
      'malformed-task-id',
      `${field} "${value}" must be between 4 and 128 characters`,
    );
  }
  return value;
}

/** Asset type ids are lower_snake_case so they read as vocabulary, not handles. */
const ASSET_TYPE_ID = /^[a-z][a-z0-9_]*$/;

/**
 * Refuse an asset type id that is not lower_snake_case.
 *
 * Asset type ids are deliberately not opaque identifiers: they are the platform's shared vocabulary
 * for money ("lkr", "jaya_points") and must be readable in code and queries.
 */
export function assertAssetTypeId(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new AIGatewayError(
      'malformed-identifier',
      `${field} is ${value === null ? 'null' : typeof value}; expected a string`,
    );
  }
  if (!ASSET_TYPE_ID.test(value)) {
    throw new AIGatewayError(
      'malformed-identifier',
      `${field} "${value}" is not a valid asset type id. Expected lower_snake_case starting with a letter`,
    );
  }
  if (value.length < 2 || value.length > 64) {
    throw new AIGatewayError(
      'malformed-identifier',
      `${field} "${value}" must be between 2 and 64 characters`,
    );
  }
  return value;
}

/**
 * Fields that belong to another component, with the component named.
 *
 * A gateway record carries only what K-13 owns. A request carrying a business-module field is
 * refused by name because it is modelling the thing wrongly, not making a typo.
 */
export const FOREIGN_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  // K-01 Identity owns the party.
  subjectId:
    'K-01 Identity owns the subject; a gateway run references actors by id, not by subject',
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
    'K-03 Accounts owns the universal account; a run references one by id, not by embedding it',
  account: 'K-03 Accounts owns the universal account; a gateway record references one by id',
  origin: 'K-03 Accounts owns the provenance of an account creation, not an AI gateway record',

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
  ledgerAccountId: 'K-10 Ledger foundation owns ledger accounts; a run does not embed one',

  // Business modules own outcomes.
  orderId: 'orders belong to the Orders module, not to the AI gateway',
  paymentId: 'payments belong to the Payments module, not to the AI gateway',
  listingId: 'listings belong to the marketplace modules, not to the AI gateway',
  offerId: 'offers belong to the Offers module, not to the AI gateway',
  quoteId: 'quotes belong to the Quotes module, not to the AI gateway',
  merchantId: 'merchant identity belongs to the Seller modules, not to the AI gateway',
  buyerId: 'buyer identity belongs to the Cockpit modules, not to the AI gateway',
  productId: 'product identity belongs to the Product Catalog module, not to the AI gateway',

  // AI Model Registry and Routing own catalogue data above the runtime boundary.
  modelVersion: 'the AI Model Registry module owns model versions; K-13 is the runtime boundary',
  shadowMode: 'shadow mode evaluation belongs to the AI Model Registry module',
  evaluationId: 'model evaluation belongs to the AI Model Registry module',

  // Lifecycle fields this component does not have.
  status: 'K-13 owns no lifecycle state; a gateway record is written once',
  state: 'K-13 owns no lifecycle state; a gateway record is written once',
  updatedAt: 'K-13 owns no update timestamp; a gateway record is written once',
  deletedAt: 'K-13 owns no deletion timestamp; a gateway record is written once',
});
