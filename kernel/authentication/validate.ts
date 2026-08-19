/**
 * K-02 Authentication — validation of complete records, wherever they came from (FND-004c).
 *
 * One validator per record type, called by the service on what it has just built and by the
 * PostgreSQL decoder on what it has just decoded. There is no second list of rules to keep in step,
 * because there is no second list.
 *
 * This is the shape K-01 reached by correction (§11.22): its first revision validated a request on
 * the way in and a row on the way out, and the two were not the same check, so a row written around
 * the adapter came back carrying exactly what creation refuses. Validation on the way *in* protects
 * the store from a caller; validation on the way *out* protects every consumer from the store.
 *
 * For this component the second direction is sharper than usual. A session decoded from a row is
 * about to be treated as proof that somebody is who they say they are. A row with a `token_hash`
 * that is not a SHA-256, or an assurance level nobody registered, or an expiry before its issue
 * instant, is not a session — and returning it would be authenticating on the strength of a
 * malformed row.
 *
 * Owned by: K-02 Authentication.
 */

import { InvalidInstantError, compareInstants, parseInstant } from '../../platform/time/instant.ts';

import { assertAuthIdentifier } from './registry.ts';
import { TOKEN_HASH } from './tokens.ts';
import {
  ASSURANCE_LEVELS,
  AuthenticationError,
  FACTOR_CATEGORIES,
  REVOCATION_REASONS,
  type AssuranceLevel,
  type AuthenticationBinding,
  type AuthenticationEvidence,
  type AuthenticationSession,
  type FactorCategory,
  type RevocationReason,
} from './types.ts';

export type RecordSource = 'request' | 'stored row';

const STORED_ROW_NOTE =
  'A stored row that fails this was not written by this component — refusing it rather than ' +
  'authenticating on the strength of a malformed row';

const BINDING_FIELDS: readonly string[] = [
  'bindingId',
  'subjectId',
  'provider',
  'providerReference',
  'createdAt',
  'idempotencyKey',
];

const EVIDENCE_FIELDS: readonly string[] = [
  'evidenceId',
  'bindingId',
  'subjectId',
  'provider',
  'assertionId',
  'factors',
  'assurance',
  'verifiedAt',
  'recordedAt',
  'idempotencyKey',
];

const SESSION_FIELDS: readonly string[] = [
  'sessionId',
  'bindingId',
  'subjectId',
  'evidenceId',
  'assurance',
  'factors',
  'tokenHash',
  'issuedAt',
  'absoluteExpiresAt',
  'idleExpiresAt',
  'rotationCount',
  'revokedAt',
  'revocationReason',
  'idempotencyKey',
];

function inSource<T>(source: RecordSource, body: () => T): T {
  try {
    return body();
  } catch (error) {
    if (source === 'request' || !(error instanceof AuthenticationError)) throw error;
    // Idempotent, because a decode may be wrapped twice: once around the row-shape checks the
    // adapter runs before this file sees anything, and once here. Two copies of the note would be
    // noise in the one message somebody reads while a login is failing.
    if (error.message.includes(STORED_ROW_NOTE)) throw error;
    throw new AuthenticationError(error.code, `${error.message}. ${STORED_ROW_NOTE}`);
  }
}

/**
 * Run a decode so that whatever it refuses says where the row came from.
 *
 * The adapter checks the *shape* of a row — is this column text, is `factors` an array, is the
 * timestamp the projected form — before it can hand anything to the validators here, so those
 * refusals were escaping without the note that tells a reader the row came out of the database
 * rather than out of a request. That is the whole difference between "your call was wrong" and
 * "something wrote a row this component never would", and it is the second one that matters at
 * three in the morning.
 */
export function inStoredRow<T>(body: () => T): T {
  return inSource('stored row', body);
}

export function validateBinding(candidate: unknown, source: RecordSource): AuthenticationBinding {
  return inSource(source, () => {
    const fields = shapeOf(candidate, BINDING_FIELDS, 'a binding');
    return {
      bindingId: assertAuthIdentifier(fields.bindingId, 'bindingId'),
      subjectId: assertAuthIdentifier(fields.subjectId, 'subjectId'),
      provider: providerName(fields.provider),
      providerReference: assertAuthIdentifier(fields.providerReference, 'providerReference'),
      createdAt: instant(fields.createdAt, 'createdAt'),
      idempotencyKey: assertAuthIdentifier(fields.idempotencyKey, 'idempotencyKey'),
    };
  });
}

export function validateEvidence(candidate: unknown, source: RecordSource): AuthenticationEvidence {
  return inSource(source, () => {
    const fields = shapeOf(candidate, EVIDENCE_FIELDS, 'an evidence record');
    const verifiedAt = instant(fields.verifiedAt, 'verifiedAt');
    const recordedAt = instant(fields.recordedAt, 'recordedAt');

    return {
      evidenceId: assertAuthIdentifier(fields.evidenceId, 'evidenceId'),
      bindingId: assertAuthIdentifier(fields.bindingId, 'bindingId'),
      subjectId: assertAuthIdentifier(fields.subjectId, 'subjectId'),
      provider: providerName(fields.provider),
      assertionId: assertAuthIdentifier(fields.assertionId, 'assertionId'),
      factors: factorList(fields.factors),
      assurance: assuranceLevel(fields.assurance),
      verifiedAt,
      recordedAt,
      idempotencyKey: assertAuthIdentifier(fields.idempotencyKey, 'idempotencyKey'),
    };
  });
}

export function validateSession(candidate: unknown, source: RecordSource): AuthenticationSession {
  return inSource(source, () => {
    const fields = shapeOf(candidate, SESSION_FIELDS, 'a session');

    const tokenHash = text(fields.tokenHash, 'tokenHash');
    if (!TOKEN_HASH.test(tokenHash)) {
      // Deliberately does not echo the value. It is a hash rather than a secret, but a refusal
      // that prints token material is a habit, and habits generalise to the cases that matter.
      throw new AuthenticationError(
        'malformed-record',
        'tokenHash is not a SHA-256 in lower-case hex. A session whose stored hash is the wrong ' +
          'shape cannot have been written by this component',
      );
    }

    const issuedAt = instant(fields.issuedAt, 'issuedAt');
    const absoluteExpiresAt = instant(fields.absoluteExpiresAt, 'absoluteExpiresAt');
    const idleExpiresAt = instant(fields.idleExpiresAt, 'idleExpiresAt');

    if (compareInstants(absoluteExpiresAt, issuedAt) <= 0) {
      throw new AuthenticationError(
        'malformed-record',
        `absoluteExpiresAt ${absoluteExpiresAt} is not after issuedAt ${issuedAt}. A session that ` +
          'expired before it was issued is not a session',
      );
    }
    if (compareInstants(idleExpiresAt, absoluteExpiresAt) > 0) {
      throw new AuthenticationError(
        'malformed-record',
        `idleExpiresAt ${idleExpiresAt} is after absoluteExpiresAt ${absoluteExpiresAt}. The ` +
          'absolute expiry is the hard stop; an idle window past it would never apply, which ' +
          'means somebody meant something else',
      );
    }

    const rotationCount = fields.rotationCount;
    if (!Number.isSafeInteger(rotationCount) || (rotationCount as number) < 0) {
      throw new AuthenticationError(
        'malformed-record',
        `rotationCount is ${String(rotationCount)}; expected a whole number of rotations`,
      );
    }

    const revokedAt =
      fields.revokedAt === null || fields.revokedAt === undefined
        ? null
        : instant(fields.revokedAt, 'revokedAt');
    const revocationReason = optionalRevocationReason(fields.revocationReason);

    if ((revokedAt === null) !== (revocationReason === null)) {
      throw new AuthenticationError(
        'malformed-record',
        'revokedAt and revocationReason must be set together. A revocation with no reason, or a ' +
          'reason with no instant, is half a record and a reader cannot tell which half is true',
      );
    }

    return {
      sessionId: assertAuthIdentifier(fields.sessionId, 'sessionId'),
      bindingId: assertAuthIdentifier(fields.bindingId, 'bindingId'),
      subjectId: assertAuthIdentifier(fields.subjectId, 'subjectId'),
      evidenceId: assertAuthIdentifier(fields.evidenceId, 'evidenceId'),
      assurance: assuranceLevel(fields.assurance),
      factors: factorList(fields.factors),
      tokenHash,
      issuedAt,
      absoluteExpiresAt,
      idleExpiresAt,
      rotationCount: rotationCount as number,
      revokedAt,
      revocationReason,
      idempotencyKey: assertAuthIdentifier(fields.idempotencyKey, 'idempotencyKey'),
    };
  });
}

// ---------------------------------------------------------------------------

function shapeOf(
  candidate: unknown,
  permitted: readonly string[],
  what: string,
): Record<string, unknown> {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new AuthenticationError(
      'malformed-record',
      `${what} must be an object, got ${candidate === null ? 'null' : typeof candidate}`,
    );
  }
  for (const key of Object.keys(candidate)) {
    if (!permitted.includes(key)) {
      throw new AuthenticationError(
        'malformed-record',
        `${what} carried the unrecognised field "${key}"; the permitted fields are ` +
          `${permitted.join(', ')}`,
      );
    }
  }
  return candidate as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new AuthenticationError(
      'malformed-record',
      `${field} is ${value === null ? 'null' : typeof value}; expected non-empty text`,
    );
  }
  return value;
}

const PROVIDER_NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

function providerName(value: unknown): string {
  const candidate = text(value, 'provider');
  if (!PROVIDER_NAME.test(candidate)) {
    throw new AuthenticationError(
      'malformed-record',
      `provider "${candidate}" is not a valid provider name. Expected lower-case dashed`,
    );
  }
  return candidate;
}

function assuranceLevel(value: unknown): AssuranceLevel {
  const candidate = text(value, 'assurance');
  if (!(ASSURANCE_LEVELS as readonly string[]).includes(candidate)) {
    throw new AuthenticationError(
      'malformed-record',
      `assurance is "${candidate}"; expected one of ${ASSURANCE_LEVELS.join(', ')}`,
    );
  }
  return candidate as AssuranceLevel;
}

/**
 * The confirmed factor categories: a non-empty set of known values, with no duplicates.
 *
 * Duplicates are refused rather than deduplicated, because `['knowledge', 'knowledge']` is either a
 * bug or an attempt to make one factor look like two — and quietly collapsing it would hide both.
 */
function factorList(value: unknown): readonly FactorCategory[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new AuthenticationError(
      'malformed-record',
      'factors must be a non-empty array of factor categories. An authentication that confirmed ' +
        'nothing is not an authentication',
    );
  }
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string' || !(FACTOR_CATEGORIES as readonly string[]).includes(entry)) {
      throw new AuthenticationError(
        'malformed-record',
        `factors contains "${String(entry)}"; expected ${FACTOR_CATEGORIES.join(', ')}`,
      );
    }
    if (seen.has(entry)) {
      throw new AuthenticationError(
        'malformed-record',
        `factors lists "${entry}" twice. Two of one category is one category, and collapsing the ` +
          'duplicate silently would let a single factor be presented as multi-factor',
      );
    }
    seen.add(entry);
  }
  return Object.freeze([...(value as FactorCategory[])].sort());
}

function optionalRevocationReason(value: unknown): RevocationReason | null {
  if (value === null || value === undefined) return null;
  const candidate = text(value, 'revocationReason');
  if (!(REVOCATION_REASONS as readonly string[]).includes(candidate)) {
    throw new AuthenticationError(
      'malformed-record',
      `revocationReason is "${candidate}"; expected one of ${REVOCATION_REASONS.join(', ')}`,
    );
  }
  return candidate as RevocationReason;
}

function instant(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new AuthenticationError(
      'malformed-instant',
      `${field} is ${value === null ? 'null' : typeof value}; expected a UTC instant string`,
    );
  }
  try {
    return parseInstant(value).source;
  } catch (error) {
    if (error instanceof InvalidInstantError) {
      throw new AuthenticationError('malformed-instant', `${field}: ${error.message}`);
    }
    throw error;
  }
}
