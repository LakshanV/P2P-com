/**
 * K-03 Accounts — validation of a complete account, wherever it came from (FND-004b).
 *
 * One function, called by the service on the account it builds and by the PostgreSQL decoder on the
 * account it decodes. There is no second list of rules to keep in step, because there is no second
 * list.
 *
 * This is the shape K-01 arrived at by correction rather than by design (§11.22): its first
 * revision validated a request on the way in and a row on the way out, and the two were not the
 * same check, so a row written around the adapter came back carrying exactly the natural key
 * creation exists to keep out. Validation on the way *in* protects the store from a caller;
 * validation on the way *out* protects every consumer from the store, and the store is the thing a
 * component controls least. K-03 starts there.
 *
 * Deliberately **not** the same thing as the request check in service.ts. That one refuses fields
 * belonging to K-01, K-02, K-04, a profile or a financial module, and only a *request* can carry
 * them. This one judges a finished account.
 *
 * Owned by: K-03 Accounts.
 */

import { InvalidInstantError, parseInstant } from '../../platform/time/instant.ts';

import { assertAccountIdentifier } from './registry.ts';
import {
  AccountError,
  ORIGIN_KINDS,
  type AccountOrigin,
  type OriginKind,
  type UniversalAccount,
} from './types.ts';

/**
 * Where the account came from.
 *
 * Only affects the wording of a refusal, and the wording matters: "this is invalid" sends a reader
 * to the validator, while "this row was not written by this component" sends them to the database,
 * which is where the problem actually is.
 */
export type AccountSource = 'request' | 'stored row';

/** Exactly the fields an account may carry. */
const ACCOUNT_FIELDS: readonly string[] = [
  'accountId',
  'subjectId',
  'createdAt',
  'origin',
  'idempotencyKey',
];

const ORIGIN_FIELDS: readonly string[] = ['kind', 'id'];

const STORED_ROW_NOTE =
  'A stored row that fails this was not written by this component — refusing it rather than ' +
  'presenting it as a real account';

/**
 * Validate a complete account, or refuse.
 *
 * Returns a new plain object built field by field from what was checked, so a candidate carrying a
 * getter, a prototype or an extra own property cannot smuggle any of it past this point. Sealing is
 * the caller's job (`sealAccount`), because the caller knows whether it is about to store the result
 * or return it.
 */
export function validateAccount(candidate: unknown, source: AccountSource): UniversalAccount {
  try {
    return check(candidate);
  } catch (error) {
    if (source === 'request' || !(error instanceof AccountError)) throw error;
    // Same code, because it is the same guarantee. The added clause says where to look.
    throw new AccountError(error.code, `${error.message}. ${STORED_ROW_NOTE}`);
  }
}

function check(candidate: unknown): UniversalAccount {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new AccountError(
      'malformed-record',
      `an account must be an object, got ${candidate === null ? 'null' : typeof candidate}`,
    );
  }

  for (const key of Object.keys(candidate)) {
    if (!ACCOUNT_FIELDS.includes(key)) {
      throw new AccountError(
        'malformed-record',
        `an account carried the unrecognised field "${key}"; the permitted fields are ` +
          `${ACCOUNT_FIELDS.join(', ')}`,
      );
    }
  }

  const fields = candidate as Record<string, unknown>;
  const origin = checkOrigin(fields.origin);
  const accountId = assertAccountIdentifier(fields.accountId, 'accountId');
  const subjectId = assertAccountIdentifier(fields.subjectId, 'subjectId');
  const idempotencyKey = assertAccountIdentifier(fields.idempotencyKey, 'idempotencyKey');
  const createdAt = checkInstant(fields.createdAt, 'createdAt');

  return { accountId, subjectId, createdAt, origin, idempotencyKey };
}

/** The origin, validated, with AI refused by name. */
function checkOrigin(origin: unknown): AccountOrigin {
  if (origin === null || typeof origin !== 'object' || Array.isArray(origin)) {
    throw new AccountError(
      'malformed-record',
      `origin must be an object, got ${origin === null ? 'null' : typeof origin}`,
    );
  }
  for (const key of Object.keys(origin)) {
    if (!ORIGIN_FIELDS.includes(key)) {
      throw new AccountError(
        'foreign-concern',
        `origin carried "${key}"; the permitted fields are ${ORIGIN_FIELDS.join(', ')}. ` +
          'An origin is who caused the creation, not a record of how they were authenticated — ' +
          'K-02 does not exist and nothing has verified anybody',
      );
    }
  }

  const fields = origin as { kind?: unknown; id?: unknown };
  if (
    typeof fields.kind !== 'string' ||
    !(ORIGIN_KINDS as readonly string[]).includes(fields.kind)
  ) {
    throw new AccountError(
      'malformed-record',
      `origin.kind is "${String(fields.kind)}"; expected one of ${ORIGIN_KINDS.join(', ')}`,
    );
  }

  if (fields.kind === 'ai') {
    // An account is the party a contract is with. Every order, payment and settlement in the
    // platform eventually names one, so an account AI decided should exist is a counterparty
    // nobody agreed to — and the financial modules bar AI from authority outright (MODULE_MAP
    // §11). AI may draft the request or prompt an operator; the human or deterministic system
    // that acts on it owns the account.
    //
    // Checked here rather than only at creation, so a row that reached the table another way
    // cannot become a real account merely by being selected.
    throw new AccountError(
      'ai-not-permitted',
      'origin.kind is "ai", and AI may not author an account. An account is the party every ' +
        'order, payment and settlement is with; one AI decided should exist is a counterparty ' +
        'nobody agreed to. AI may prompt a human or a deterministic system to create it, and that ' +
        'actor owns the account',
    );
  }

  return {
    kind: fields.kind as Exclude<OriginKind, 'ai'>,
    id: assertAccountIdentifier(fields.id, 'origin.id'),
  };
}

/** Instants are validated in this component's own vocabulary, not the platform utility's. */
function checkInstant(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new AccountError(
      'malformed-instant',
      `${field} is ${value === null ? 'null' : typeof value}; expected a UTC instant string`,
    );
  }
  try {
    return parseInstant(value).source;
  } catch (error) {
    if (error instanceof InvalidInstantError) {
      throw new AccountError('malformed-instant', `${field}: ${error.message}`);
    }
    throw error;
  }
}
