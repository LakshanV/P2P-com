/**
 * K-07 Feature Flags — one validator per record, for requests and for stored rows (FND-004e).
 *
 * The same function judges a candidate record on the way in and a row on the way out. K-01 needed
 * a correction to reach that shape (CURRENT_IMPLEMENTATION_STATUS §11.22) because a row written
 * around the service decoded cleanly and was then acted upon, and K-04 found the same hole in its
 * adapter. This component starts there.
 *
 * Fail-closed everywhere: a record that cannot be judged is refused, never coerced. A flag version
 * whose `state` is unreadable is not "probably off" — it is `malformed-record`, because a
 * component that guesses which code paths are running is one whose "off" cannot be trusted either.
 *
 * Owned by: K-07 Feature Flags.
 */

import { InvalidInstantError, compareInstants, parseInstant } from '../../platform/time/instant.ts';

import { REQUEST_FINGERPRINT } from './fingerprint.ts';
import {
  assertFlagIdentifier,
  assertFlagKey,
  assertKnownFields,
  assertOrigin,
  assertPredicate,
  assertSupportedScopes,
} from './registry.ts';
import {
  FLAG_STATES,
  FeatureFlagError,
  LIFECYCLE_KINDS,
  type Activation,
  type FlagState,
  type FlagVersion,
  type LifecycleEvent,
  type LifecycleKind,
} from './types.ts';

/** Where a record came from, which decides what a refusal should tell the reader. */
export type RecordSource = 'request' | 'stored row';

const STORED_ROW_NOTE =
  'A stored row that fails this was not written by this component — refusing it rather than ' +
  'deciding which code paths run on the strength of a malformed row';

function inSource<T>(source: RecordSource, body: () => T): T {
  try {
    return body();
  } catch (error) {
    if (source === 'request' || !(error instanceof FeatureFlagError)) throw error;
    if (error.message.includes(STORED_ROW_NOTE)) throw error;
    throw new FeatureFlagError(error.code, `${error.message}. ${STORED_ROW_NOTE}`);
  }
}

/** Run a decode so that whatever it refuses says the row came from the database. */
export function inStoredRow<T>(body: () => T): T {
  return inSource('stored row', body);
}

const VERSION_FIELDS = [
  'flagVersionId',
  'flagKey',
  'version',
  'state',
  'supportedScopes',
  'rules',
  'percentage',
  'rolloutSalt',
  'notBefore',
  'notAfter',
  'publishedAt',
  'publishedBy',
  'idempotencyKey',
  'requestFingerprint',
];

const ACTIVATION_FIELDS = [
  'activationId',
  'flagKey',
  'flagVersionId',
  'supersedesVersionId',
  'activatedAt',
  'activatedBy',
  'idempotencyKey',
  'requestFingerprint',
];

const LIFECYCLE_FIELDS = [
  'eventId',
  'flagKey',
  'kind',
  'reason',
  'recordedAt',
  'recordedBy',
  'idempotencyKey',
  'requestFingerprint',
];

const isFlagState = (value: unknown): value is FlagState =>
  typeof value === 'string' && (FLAG_STATES as readonly string[]).includes(value);

const isLifecycleKind = (value: unknown): value is LifecycleKind =>
  typeof value === 'string' && (LIFECYCLE_KINDS as readonly string[]).includes(value);

function instant(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new FeatureFlagError(
      'malformed-record',
      `${field} is ${value === null ? 'null' : typeof value}; expected a UTC instant`,
    );
  }
  try {
    parseInstant(value);
  } catch (error) {
    if (error instanceof InvalidInstantError) {
      throw new FeatureFlagError('malformed-record', `${field}: ${error.message}`);
    }
    throw error;
  }
  return value;
}

function optionalInstant(value: unknown, field: string): string | null {
  return value === null || value === undefined ? null : instant(value, field);
}

function fingerprint(value: unknown, field: string): string {
  if (typeof value !== 'string' || !REQUEST_FINGERPRINT.test(value)) {
    throw new FeatureFlagError(
      'malformed-record',
      `${field} is "${String(value)}"; expected a lowercase SHA-256 in hex. A record with no ` +
        'fingerprint of the request that produced it cannot tell a genuine retry from a reused key',
    );
  }
  return value;
}

function reasonText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new FeatureFlagError(
      'malformed-record',
      `${field} is ${value === null ? 'null' : typeof value}; expected a non-empty reason. ` +
        'Stopping a feature without recording why leaves the next operator guessing whether it ' +
        'is safe to turn back on',
    );
  }
  if (value.length > 500) {
    throw new FeatureFlagError('malformed-record', `${field} is longer than 500 characters`);
  }
  return value;
}

/**
 * Validate a flag version.
 *
 * Two rules here are about honesty rather than shape, and both refuse records that would "work":
 *
 *   - a state carries only the fields it uses — rules on a `percentage` flag, or a percentage on
 *     an `off` one, are settings somebody believes are in force and nothing reads;
 *   - the activation window must be a window — `notAfter` at or before `notBefore` describes an
 *     interval that never contains an instant, so the flag is permanently off while its
 *     definition says otherwise.
 */
export function validateFlagVersion(candidate: unknown, source: RecordSource): FlagVersion {
  return inSource(source, () => {
    if (candidate === null || typeof candidate !== 'object') {
      throw new FeatureFlagError('malformed-record', 'a flag version must be an object');
    }
    assertKnownFields(candidate, VERSION_FIELDS, 'a flag version');
    const value = candidate as Record<string, unknown>;

    const state = value.state;
    if (!isFlagState(state)) {
      throw new FeatureFlagError(
        'malformed-record',
        `state is "${String(state)}"; expected one of ${FLAG_STATES.join(', ')}`,
      );
    }

    const version = value.version;
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
      throw new FeatureFlagError(
        'malformed-record',
        `version is ${String(version)}; expected a positive integer. Versions order a flag's ` +
          'history, and a clock cannot: two publications can share an instant',
      );
    }

    const percentage = value.percentage;
    if (
      typeof percentage !== 'number' ||
      !Number.isInteger(percentage) ||
      percentage < 0 ||
      percentage > 100
    ) {
      throw new FeatureFlagError(
        'malformed-record',
        `percentage is ${String(percentage)}; expected a whole number of percent, 0 to 100`,
      );
    }

    if (!Array.isArray(value.rules)) {
      throw new FeatureFlagError('malformed-record', 'rules must be an array');
    }
    const rules = value.rules.map((rule, index) => assertPredicate(rule, `rules[${index}]`));

    if (state === 'targeted' && rules.length === 0) {
      throw new FeatureFlagError(
        'malformed-record',
        'a targeted flag with no rules matches nobody, which is an off flag whose definition ' +
          'says it is rolling out. Publish it as "off" if that is what is meant',
      );
    }
    if (state !== 'targeted' && rules.length > 0) {
      throw new FeatureFlagError(
        'malformed-record',
        `a ${state} flag carries ${rules.length} targeting rule(s), and nothing evaluates them. ` +
          'A rule nobody reads is a restriction somebody believes is in force',
      );
    }
    if (state !== 'percentage' && percentage !== 0) {
      throw new FeatureFlagError(
        'malformed-record',
        `a ${state} flag carries percentage ${percentage}, and nothing evaluates it`,
      );
    }

    const notBefore = optionalInstant(value.notBefore, 'notBefore');
    const notAfter = optionalInstant(value.notAfter, 'notAfter');
    if (notBefore !== null && notAfter !== null && compareInstants(notAfter, notBefore) <= 0) {
      throw new FeatureFlagError(
        'invalid-activation-window',
        `notAfter (${notAfter}) is not after notBefore (${notBefore}), so the window contains no ` +
          'instant and the flag can never be on. A permanently-off flag that reads as scheduled ' +
          'is worse than one published off',
      );
    }

    return {
      flagVersionId: assertFlagIdentifier(value.flagVersionId, 'flagVersionId'),
      flagKey: assertFlagKey(value.flagKey),
      version,
      state,
      supportedScopes: Object.freeze(assertSupportedScopes(value.supportedScopes)),
      rules: Object.freeze(rules),
      percentage,
      rolloutSalt: assertFlagIdentifier(value.rolloutSalt, 'rolloutSalt'),
      notBefore,
      notAfter,
      publishedAt: instant(value.publishedAt, 'publishedAt'),
      publishedBy: assertOrigin(value.publishedBy, 'publishedBy'),
      idempotencyKey: assertFlagIdentifier(value.idempotencyKey, 'idempotencyKey'),
      requestFingerprint: fingerprint(value.requestFingerprint, 'requestFingerprint'),
    };
  });
}

export function validateActivation(candidate: unknown, source: RecordSource): Activation {
  return inSource(source, () => {
    if (candidate === null || typeof candidate !== 'object') {
      throw new FeatureFlagError('malformed-record', 'an activation must be an object');
    }
    assertKnownFields(candidate, ACTIVATION_FIELDS, 'an activation');
    const value = candidate as Record<string, unknown>;

    const flagVersionId = assertFlagIdentifier(value.flagVersionId, 'flagVersionId');
    const supersedes =
      value.supersedesVersionId === null || value.supersedesVersionId === undefined
        ? null
        : assertFlagIdentifier(value.supersedesVersionId, 'supersedesVersionId');
    if (supersedes !== null && supersedes === flagVersionId) {
      throw new FeatureFlagError(
        'malformed-record',
        'an activation supersedes itself, which records no transition at all',
      );
    }

    return {
      activationId: assertFlagIdentifier(value.activationId, 'activationId'),
      flagKey: assertFlagKey(value.flagKey),
      flagVersionId,
      supersedesVersionId: supersedes,
      activatedAt: instant(value.activatedAt, 'activatedAt'),
      activatedBy: assertOrigin(value.activatedBy, 'activatedBy'),
      idempotencyKey: assertFlagIdentifier(value.idempotencyKey, 'idempotencyKey'),
      requestFingerprint: fingerprint(value.requestFingerprint, 'requestFingerprint'),
    };
  });
}

export function validateLifecycleEvent(candidate: unknown, source: RecordSource): LifecycleEvent {
  return inSource(source, () => {
    if (candidate === null || typeof candidate !== 'object') {
      throw new FeatureFlagError('malformed-record', 'a lifecycle event must be an object');
    }
    assertKnownFields(candidate, LIFECYCLE_FIELDS, 'a lifecycle event');
    const value = candidate as Record<string, unknown>;

    const kind = value.kind;
    if (!isLifecycleKind(kind)) {
      throw new FeatureFlagError(
        'malformed-record',
        `kind is "${String(kind)}"; expected one of ${LIFECYCLE_KINDS.join(', ')}`,
      );
    }

    return {
      eventId: assertFlagIdentifier(value.eventId, 'eventId'),
      flagKey: assertFlagKey(value.flagKey),
      kind,
      reason: reasonText(value.reason, 'reason'),
      recordedAt: instant(value.recordedAt, 'recordedAt'),
      recordedBy: assertOrigin(value.recordedBy, 'recordedBy'),
      idempotencyKey: assertFlagIdentifier(value.idempotencyKey, 'idempotencyKey'),
      requestFingerprint: fingerprint(value.requestFingerprint, 'requestFingerprint'),
    };
  });
}
