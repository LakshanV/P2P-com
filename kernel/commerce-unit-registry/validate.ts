/**
 * K-11 Commerce Unit Registry — one validator per record, for requests and for stored rows (FND-005c).
 *
 * The same function judges a candidate record on the way in and a row on the way out. K-01 needed
 * a correction to reach that shape (CURRENT_IMPLEMENTATION_STATUS §11.22) because a row written
 * around the service decoded cleanly and was then acted upon; K-04 and K-06 found the same hole in
 * their adapters. Here a malformed row that decoded cleanly would be a category nobody registered,
 * copied into every listing created under it.
 *
 * Fail-closed everywhere. A type whose measures cannot be read is not "probably each" — it is
 * `malformed-record`, because a registry that guesses at the vocabulary is one every downstream
 * module then guesses along with.
 *
 * Owned by: K-11 Commerce Unit Registry.
 */

import { InvalidInstantError, compareInstants, parseInstant } from '../../platform/time/instant.ts';

import { REQUEST_FINGERPRINT } from './fingerprint.ts';
import {
  assertKind,
  assertKnownFields,
  assertMeasures,
  assertOrigin,
  assertOwner,
  assertTypeKey,
  assertUnitIdentifier,
} from './registry.ts';
import {
  CommerceUnitError,
  type UnitTypeActivation,
  type UnitTypeRetirement,
  type UnitTypeVersion,
} from './types.ts';

/** Where a record came from, which decides what a refusal should tell the reader. */
export type RecordSource = 'request' | 'stored row';

const STORED_ROW_NOTE =
  'A stored row that fails this was not written by this component — refusing it rather than ' +
  'describing a listing with a category nobody registered';

function inSource<T>(source: RecordSource, body: () => T): T {
  try {
    return body();
  } catch (error) {
    if (source === 'request' || !(error instanceof CommerceUnitError)) throw error;
    if (error.message.includes(STORED_ROW_NOTE)) throw error;
    throw new CommerceUnitError(error.code, `${error.message}. ${STORED_ROW_NOTE}`);
  }
}

/** Run a decode so that whatever it refuses says the row came from the database. */
export function inStoredRow<T>(body: () => T): T {
  return inSource('stored row', body);
}

const VERSION_FIELDS = [
  'typeVersionId',
  'typeKey',
  'version',
  'kind',
  'owner',
  'parentTypeKey',
  'measures',
  'riskPolicyKey',
  'effectiveFrom',
  'effectiveUntil',
  'publishedAt',
  'publishedBy',
  'idempotencyKey',
  'requestFingerprint',
];

const ACTIVATION_FIELDS = [
  'activationId',
  'typeKey',
  'typeVersionId',
  'supersedesVersionId',
  'riskPolicyVersionId',
  'activatedAt',
  'activatedBy',
  'idempotencyKey',
  'requestFingerprint',
];

const RETIREMENT_FIELDS = [
  'retirementId',
  'typeKey',
  'reason',
  'retiredAt',
  'retiredBy',
  'idempotencyKey',
  'requestFingerprint',
];

function instant(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new CommerceUnitError(
      'malformed-record',
      `${field} is ${value === null ? 'null' : typeof value}; expected a UTC instant`,
    );
  }
  try {
    parseInstant(value);
  } catch (error) {
    if (error instanceof InvalidInstantError) {
      throw new CommerceUnitError('malformed-record', `${field}: ${error.message}`);
    }
    throw error;
  }
  return value;
}

const optionalInstant = (value: unknown, field: string): string | null =>
  value === null || value === undefined ? null : instant(value, field);

function fingerprint(value: unknown, field: string): string {
  if (typeof value !== 'string' || !REQUEST_FINGERPRINT.test(value)) {
    throw new CommerceUnitError(
      'malformed-record',
      `${field} is "${String(value)}"; expected a lowercase SHA-256 in hex. A record with no ` +
        'fingerprint of the request that produced it cannot tell a genuine retry from a reused key',
    );
  }
  return value;
}

function reasonText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new CommerceUnitError(
      'malformed-record',
      `${field} is ${value === null ? 'null' : typeof value}; expected a non-empty reason. ` +
        'Retiring a category without recording why leaves the next reader unable to tell whether ' +
        'the listings under it were withdrawn or merely renamed',
    );
  }
  if (value.length > 500) {
    throw new CommerceUnitError('malformed-record', `${field} is longer than 500 characters`);
  }
  return value;
}

/**
 * A K-06 policy key, held as text and never resolved here.
 *
 * K-11 stores the key and pins the version K-06 returns; it does not parse, validate against
 * K-06's own rules, or interpret it. Anything more would be K-11 having an opinion about policy.
 */
function policyKey(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{1,30}(\.[a-z][a-z0-9-]{1,30}){1,3}$/.test(value)) {
    throw new CommerceUnitError(
      'malformed-record',
      `${field} is "${String(value)}"; expected a dotted policy key K-06 would recognise`,
    );
  }
  return value;
}

/**
 * Validate a type version.
 *
 * Two rules here are about honesty rather than shape: a type may not name itself as its parent
 * (the degenerate cycle, caught before it reaches the resolver so the message names the real
 * mistake), and the effective window must be a window — `effectiveUntil` at or before
 * `effectiveFrom` describes an interval containing no instant, so the type could never describe
 * anything while reading as though it were scheduled.
 */
export function validateUnitTypeVersion(candidate: unknown, source: RecordSource): UnitTypeVersion {
  return inSource(source, () => {
    if (candidate === null || typeof candidate !== 'object') {
      throw new CommerceUnitError('malformed-record', 'a type version must be an object');
    }
    assertKnownFields(candidate, VERSION_FIELDS, 'a type version');
    const value = candidate as Record<string, unknown>;

    const version = value.version;
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
      throw new CommerceUnitError(
        'malformed-record',
        `version is ${String(version)}; expected a positive integer. Version numbers order a ` +
          'type’s history, and a clock cannot: two publications can share an instant',
      );
    }

    const typeKey = assertTypeKey(value.typeKey);
    const parentTypeKey =
      value.parentTypeKey === null || value.parentTypeKey === undefined
        ? null
        : assertTypeKey(value.parentTypeKey, 'parentTypeKey');

    if (parentTypeKey !== null && parentTypeKey === typeKey) {
      throw new CommerceUnitError(
        'self-parent',
        `${typeKey} names itself as its parent. That is a lineage of one thing containing itself, ` +
          'and every category rule written for the parent would match the child that is it',
      );
    }

    const effectiveFrom = optionalInstant(value.effectiveFrom, 'effectiveFrom');
    const effectiveUntil = optionalInstant(value.effectiveUntil, 'effectiveUntil');
    if (
      effectiveFrom !== null &&
      effectiveUntil !== null &&
      compareInstants(effectiveUntil, effectiveFrom) <= 0
    ) {
      throw new CommerceUnitError(
        'invalid-effective-window',
        `effectiveUntil (${effectiveUntil}) is not after effectiveFrom (${effectiveFrom}), so the ` +
          'window contains no instant and the type could never describe anything. A category that ' +
          'reads as scheduled and can never apply is worse than one published without a window',
      );
    }

    const kind = assertKind(value.kind);
    return {
      typeVersionId: assertUnitIdentifier(value.typeVersionId, 'typeVersionId'),
      typeKey,
      version,
      kind,
      owner: assertOwner(value.owner),
      parentTypeKey,
      measures: assertMeasures(value.measures, kind),
      riskPolicyKey: policyKey(value.riskPolicyKey, 'riskPolicyKey'),
      effectiveFrom,
      effectiveUntil,
      publishedAt: instant(value.publishedAt, 'publishedAt'),
      publishedBy: assertOrigin(value.publishedBy, 'publishedBy'),
      idempotencyKey: assertUnitIdentifier(value.idempotencyKey, 'idempotencyKey'),
      requestFingerprint: fingerprint(value.requestFingerprint, 'requestFingerprint'),
    };
  });
}

export function validateActivation(candidate: unknown, source: RecordSource): UnitTypeActivation {
  return inSource(source, () => {
    if (candidate === null || typeof candidate !== 'object') {
      throw new CommerceUnitError('malformed-record', 'an activation must be an object');
    }
    assertKnownFields(candidate, ACTIVATION_FIELDS, 'an activation');
    const value = candidate as Record<string, unknown>;

    const typeVersionId = assertUnitIdentifier(value.typeVersionId, 'typeVersionId');
    const supersedes =
      value.supersedesVersionId === null || value.supersedesVersionId === undefined
        ? null
        : assertUnitIdentifier(value.supersedesVersionId, 'supersedesVersionId');
    if (supersedes !== null && supersedes === typeVersionId) {
      throw new CommerceUnitError(
        'malformed-record',
        'an activation supersedes itself, which records no transition at all',
      );
    }

    return {
      activationId: assertUnitIdentifier(value.activationId, 'activationId'),
      typeKey: assertTypeKey(value.typeKey),
      typeVersionId,
      supersedesVersionId: supersedes,
      riskPolicyVersionId:
        value.riskPolicyVersionId === null || value.riskPolicyVersionId === undefined
          ? null
          : assertUnitIdentifier(value.riskPolicyVersionId, 'riskPolicyVersionId'),
      activatedAt: instant(value.activatedAt, 'activatedAt'),
      activatedBy: assertOrigin(value.activatedBy, 'activatedBy'),
      idempotencyKey: assertUnitIdentifier(value.idempotencyKey, 'idempotencyKey'),
      requestFingerprint: fingerprint(value.requestFingerprint, 'requestFingerprint'),
    };
  });
}

export function validateRetirement(candidate: unknown, source: RecordSource): UnitTypeRetirement {
  return inSource(source, () => {
    if (candidate === null || typeof candidate !== 'object') {
      throw new CommerceUnitError('malformed-record', 'a retirement must be an object');
    }
    assertKnownFields(candidate, RETIREMENT_FIELDS, 'a retirement');
    const value = candidate as Record<string, unknown>;

    return {
      retirementId: assertUnitIdentifier(value.retirementId, 'retirementId'),
      typeKey: assertTypeKey(value.typeKey),
      reason: reasonText(value.reason, 'reason'),
      retiredAt: instant(value.retiredAt, 'retiredAt'),
      retiredBy: assertOrigin(value.retiredBy, 'retiredBy'),
      idempotencyKey: assertUnitIdentifier(value.idempotencyKey, 'idempotencyKey'),
      requestFingerprint: fingerprint(value.requestFingerprint, 'requestFingerprint'),
    };
  });
}
