/**
 * K-01 Identity — the subject-kind registry and the identifier refusals (FND-004a).
 *
 * Two jobs, both about keeping the identity layer from quietly becoming something else.
 *
 * **The kind registry is closed.** Three kinds, each with a written reason it exists and a written
 * note on what it is not. Closed rather than extensible because every open enumeration in an
 * identity system eventually acquires a role: somebody needs a "seller" and adds one, and from then
 * on a person who sells is a different party from the same person who buys. The guide's §4 forbids
 * exactly that, so the registry forbids it here instead of relying on everybody remembering.
 *
 * **Identifiers must be opaque.** A subject id is written into every foreign key, every audit
 * record and every log line for the life of the platform. If it is a natural key — an email, a
 * phone number, a passport number — then the platform has published personal data into places it
 * has no index of, and an erasure request has no answer that is not "rebuild the database". So
 * natural-looking identifiers are refused at the door, where the cost of the refusal is a caller
 * changing one line.
 *
 * The refusals are shape-based and therefore imperfect: a random-looking string that happens to be
 * somebody's employee number will pass. That is stated rather than hidden. What they catch is the
 * overwhelmingly common case — a developer wiring `subjectId: user.email` because it was to hand —
 * and catching that at the boundary is worth far more than the false negatives cost.
 *
 * Owned by: K-01 Identity.
 */

import { IdentityError, SUBJECT_KINDS, type SubjectKind } from './types.ts';

export interface SubjectKindDefinition {
  readonly kind: SubjectKind;
  /** What the kind stands for. */
  readonly description: string;
  /** What a reader might reasonably assume it means, and does not. */
  readonly isNot: string;
}

/**
 * The whole registry.
 *
 * Note what is absent: `buyer`, `seller`, `host`, `supplier`, `guest`, `introducer`,
 * `delivery_provider`, `staff`. Every one of those is a **capability of an account**, activated
 * against a subject when the party needs it (guide §4). None of them is a different kind of party.
 */
export const SUBJECT_KIND_DEFINITIONS: Readonly<Record<SubjectKind, SubjectKindDefinition>> =
  Object.freeze({
    person: Object.freeze({
      kind: 'person' as const,
      description:
        'One natural person. The kind that data-protection law, consent and erasure attach to.',
      isNot:
        'Not a user account and not a login. One person may hold one account with many ' +
        'capabilities, and may hold credentials that K-02 will own; none of that is here.',
    }),
    organisation: Object.freeze({
      kind: 'organisation' as const,
      description:
        'A legal entity: a company, a partnership, a sole trader acting in a business capacity. ' +
        'Distinct from a person because tax identity, liability and the applicable law differ.',
      isNot:
        'Not a seller. Selling is a capability an account activates; an organisation may buy, ' +
        'sell, host, supply or none of those, and the identity record says nothing about which.',
    }),
    system: Object.freeze({
      kind: 'system' as const,
      description:
        'A deterministic internal actor — a worker, a scheduled job, a service — that must be ' +
        'referable in the same way a party is, so its actions can be attributed rather than ' +
        'appearing to come from nobody.',
      isNot:
        'Not a service account with credentials. Whatever authenticates a worker belongs to ' +
        'K-02; this is only the handle its actions are attributed to.',
    }),
  });

/** Is this a registered kind? */
export function isSubjectKind(value: unknown): value is SubjectKind {
  return typeof value === 'string' && (SUBJECT_KINDS as readonly string[]).includes(value);
}

/** The definition, or a refusal that says what the permitted kinds are and why the list is short. */
export function requireSubjectKind(value: unknown): SubjectKindDefinition {
  if (!isSubjectKind(value)) {
    throw new IdentityError(
      'unknown-subject-kind',
      `"${String(value)}" is not a registered subject kind. The registry holds exactly ` +
        `${SUBJECT_KINDS.join(', ')}, and it is closed on purpose: a role such as buyer or ` +
        'seller is a capability of an account (K-03), not a kind of party. One person who both ' +
        'buys and sells is one subject',
    );
  }
  return SUBJECT_KIND_DEFINITIONS[value];
}

/**
 * The shape of an opaque internal identifier.
 *
 * Deliberately permissive about *form* — a ULID, a UUID, a prefixed key such as `sub_01H…`, a
 * random base32 string all pass — and strict about *content*, which is what the checks below are
 * for. Forcing one generator would be the wrong trade: the caller owns id generation (this
 * component is deterministic and produces no randomness), so the contract is about what an id may
 * not contain.
 */
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Minimum length. Shorter than this is not opaque, it is an ordinal. */
const MINIMUM_LENGTH = 8;

/**
 * Shapes that mean the caller passed a natural key rather than an internal handle.
 *
 * Each entry names what it catches, because a refusal that says only "invalid identifier" sends the
 * caller to the regex instead of to the decision.
 */
export const NATURAL_IDENTIFIER_PATTERNS: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly what: string;
}> = [
  { pattern: /@/, what: 'an email address' },
  { pattern: /^\+\d[\d.\-\s]{6,}$/, what: 'an international telephone number' },
  // One entry rather than three, because the shapes are indistinguishable from the outside: a bare
  // run of digits is a telephone number, a national identification number, a card number or a
  // customer reference from the system being migrated from, and every one of those is a natural key.
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

/** Names that mean the identifier is a credential rather than a handle. */
export const SECRET_FRAGMENTS: readonly string[] = [
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
export const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9]{16,}/,
  /\bghp_[A-Za-z0-9]{20,}/,
  /\bAKIA[0-9A-Z]{16}/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /\b(postgres(?:ql)?|mysql|mongodb):\/\/[^\s:]+:[^\s@]+@/,
];

/**
 * Refuse an identifier that is malformed, natural, or a credential.
 *
 * Ordered so the most specific refusal wins: a caller who passed an email should be told it looks
 * like an email, not that it failed a character-class test it also fails.
 */
export function assertOpaqueIdentifier(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new IdentityError(
      'malformed-identifier',
      `${field} is ${value === null ? 'null' : typeof value}; expected a string`,
    );
  }

  const secret = SECRET_FRAGMENTS.find((fragment) => value.toLowerCase().includes(fragment));
  if (secret !== undefined) {
    throw new IdentityError(
      'secret-bearing-input',
      `${field} contains "${secret}", so it is a credential rather than an identifier. ` +
        'Credentials belong to K-02 Authentication and must never be written into a field every ' +
        'downstream row copies',
    );
  }
  for (const pattern of SECRET_VALUE_PATTERNS) {
    if (pattern.test(value)) {
      throw new IdentityError(
        'secret-bearing-input',
        `${field} matches the shape of a credential (${String(pattern)}). An identity record is ` +
          'permanent; a secret in one is disclosed for as long as the platform exists',
      );
    }
  }

  const natural = NATURAL_IDENTIFIER_PATTERNS.find((entry) => entry.pattern.test(value));
  if (natural !== undefined) {
    throw new IdentityError(
      'natural-identifier',
      `${field} "${value}" looks like ${natural.what}. An identity id must be opaque: it is ` +
        'copied into every account, order, ledger entry and audit record that ever references ' +
        'this party, so a natural key publishes personal data into places nobody can enumerate ' +
        'later and leaves an erasure request with no answer. Generate an internal id instead',
    );
  }

  if (!IDENTIFIER.test(value)) {
    throw new IdentityError(
      'malformed-identifier',
      `${field} "${value}" is not a valid identifier. Expected 1-128 characters of ` +
        '[A-Za-z0-9._:-] starting alphanumeric',
    );
  }
  if (value.length < MINIMUM_LENGTH) {
    throw new IdentityError(
      'malformed-identifier',
      `${field} "${value}" is ${value.length} characters. An identifier shorter than ` +
        `${MINIMUM_LENGTH} is guessable and usually an ordinal, and an enumerable identity space ` +
        "lets anybody count the platform's parties and address one they were never given",
    );
  }

  return value;
}

/**
 * Fields that belong to another component, with the component named.
 *
 * This is the executable half of "an identity is not an account". A caller that passes `accountId`
 * or `email` is not making a typo; it is modelling the thing wrongly, and a silent `...request`
 * spread would store nothing while leaving the caller believing it had. The refusal names the
 * owning component so the caller knows where the field actually goes.
 */
export const FOREIGN_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  password: 'K-02 Authentication owns credentials',
  passwordHash: 'K-02 Authentication owns credentials',
  credential: 'K-02 Authentication owns credentials',
  mfa: 'K-02 Authentication owns second factors',
  sessionId: 'K-02 Authentication owns sessions; nothing has authenticated anybody yet',
  session: 'K-02 Authentication owns sessions',
  token: 'K-02 Authentication owns tokens',
  authenticated: 'K-02 Authentication decides that, and does not exist',
  accountId: 'K-03 Accounts owns the universal account and its link to a subject',
  account: 'K-03 Accounts owns the universal account',
  capabilities: 'K-03 Accounts and the Capability & Verification module own capabilities',
  capability: 'K-03 Accounts and the Capability & Verification module own capabilities',
  roles: 'K-04 Permissions owns roles and grants',
  role: 'K-04 Permissions owns roles and grants',
  permissions: 'K-04 Permissions owns permission evaluation',
  verified: 'the Capability & Verification module owns verification level',
  verificationLevel: 'the Capability & Verification module owns verification level',
  kyc: 'the Capability & Verification module owns identity verification',
  kycStatus: 'the Capability & Verification module owns identity verification',
  email: 'a profile field, and personal data. K-03 owns the account profile core',
  phone: 'a profile field, and personal data. K-03 owns the account profile core',
  name: 'a profile field, and personal data. K-03 owns the account profile core',
  displayName: 'a profile field. K-03 owns the account profile core',
  address: 'a profile field, and personal data',
  dateOfBirth: 'a profile field, and personal data',
  taxId: 'the Capability & Verification module owns tax identity',
  status: 'a lifecycle this component does not have: a subject is created and never changes',
  deletedAt: 'a deletion this component does not have',
  mergedInto: 'identity merge is deferred and deliberately unimplemented',
});
