/**
 * K-10 Ledger Foundation — the asset-type registry and identifier rules.
 *
 * Identifier rules are deliberately duplicated here rather than imported from K-01 Identity. K-10 is
 * in the financial authority zone and may depend only on the platform substrate; importing another
 * kernel component would create a dependency the architecture does not permit. The duplication is
 * guarded: migration 0017 carries a character-for-character copy of the rule set as a schema function,
 * and `tests/migrations.test.ts` asserts it matches every other copy.
 *
 * Owned by: K-10 Ledger Foundation.
 */

import { LedgerError, type LedgerErrorCode } from './types.ts';

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
 * Re-raises refusals in K-10's vocabulary so a caller passing an email as an account id hears a
 * `LedgerError` naming the field, not an error from a component it never called.
 */
export function assertOpaqueIdentifier(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new LedgerError(
      'malformed-identifier',
      `${field} is ${value === null ? 'null' : typeof value}; expected a string`,
    );
  }

  const secret = SECRET_FRAGMENTS.find((fragment) => value.toLowerCase().includes(fragment));
  if (secret !== undefined) {
    throw new LedgerError(
      'secret-bearing-input',
      `${field} contains "${secret}", so it is a credential rather than an identifier. ` +
        'Credentials belong to K-02 Authentication and must never be written into a field every ' +
        'ledger entry copies',
    );
  }

  for (const pattern of SECRET_VALUE_PATTERNS) {
    if (pattern.test(value)) {
      throw new LedgerError(
        'secret-bearing-input',
        `${field} matches the shape of a credential (${String(pattern)}). A ledger id is copied into ` +
          'every entry and audit record that references it; a secret there is disclosed for as long ' +
          'as the ledger exists',
      );
    }
  }

  const natural = NATURAL_IDENTIFIER_PATTERNS.find((entry) => entry.pattern.test(value));
  if (natural !== undefined) {
    throw new LedgerError(
      'natural-identifier',
      `${field} "${value}" looks like ${natural.what}. A ledger id must be opaque: it is copied ` +
        'into every entry and audit record that references this account or transaction, so a natural ' +
        'key publishes personal or sensitive data into places nobody can enumerate later',
    );
  }

  if (!OPAQUE_IDENTIFIER.test(value)) {
    throw new LedgerError(
      'malformed-identifier',
      `${field} "${value}" is not a valid identifier. Expected 1-128 characters of ` +
        '[A-Za-z0-9._:-] starting alphanumeric',
    );
  }

  if (value.length < MINIMUM_IDENTIFIER_LENGTH) {
    throw new LedgerError(
      'malformed-identifier',
      `${field} "${value}" is ${value.length} characters. An identifier shorter than ` +
        `${MINIMUM_IDENTIFIER_LENGTH} is guessable and usually an ordinal, and an enumerable ` +
        "identity space lets anybody count the platform's accounts and address one they were never given",
    );
  }

  return value;
}

/** Asset type ids are lower_snake_case so they read as vocabulary, not handles. */
const ASSET_TYPE_ID = /^[a-z][a-z0-9_]*$/;

/** Asset symbols are upper-case tokens like LKR or JAYA_POINTS. */
const ASSET_SYMBOL = /^[A-Z][A-Z0-9_]{1,31}$/;

/**
 * Refuse an asset type id that is not lower_snake_case.
 *
 * Asset type ids are deliberately not opaque identifiers: they are the platform's shared vocabulary
 * for money ("lkr", "jaya_points") and must be readable in code and queries.
 */
export function assertAssetTypeId(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new LedgerError(
      'malformed-asset-type-id',
      `${field} is ${typeof value}; expected a string`,
    );
  }
  if (!ASSET_TYPE_ID.test(value)) {
    throw new LedgerError(
      'malformed-asset-type-id',
      `${field} "${value}" is not a valid asset type id. Expected lower_snake_case starting with a letter`,
    );
  }
  if (value.length < 2 || value.length > 64) {
    throw new LedgerError(
      'malformed-asset-type-id',
      `${field} "${value}" must be between 2 and 64 characters`,
    );
  }
  return value;
}

/**
 * Refuse a symbol that is not an upper-case token.
 */
export function assertAssetSymbol(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new LedgerError('malformed-symbol', `${field} is ${typeof value}; expected a string`);
  }
  if (!ASSET_SYMBOL.test(value)) {
    throw new LedgerError(
      'malformed-symbol',
      `${field} "${value}" is not a valid asset symbol. Expected upper-case letters, digits and underscores`,
    );
  }
  if (value.length < 2 || value.length > 32) {
    throw new LedgerError(
      'malformed-symbol',
      `${field} "${value}" must be between 2 and 32 characters`,
    );
  }
  return value;
}

/** A refusal table for K-01-shaped identifier errors, if a future port imports them. */
export const IDENTITY_REFUSALS: Readonly<Record<string, LedgerErrorCode>> = Object.freeze({
  'malformed-identifier': 'malformed-identifier',
  'natural-identifier': 'natural-identifier',
  'secret-bearing-input': 'secret-bearing-input',
});
