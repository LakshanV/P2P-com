/**
 * M-01 Universal Account — validation of complete records, wherever they came from.
 *
 * One function per record type, called by the service on the way in and by the PostgreSQL decoder
 * on the way out. There is no second list of rules to keep in step.
 *
 * Owned by: M-01 Universal Account.
 */

import { formatInstant, InvalidInstantError, parseInstant } from '../../platform/time/instant.ts';

import {
  assertCapability,
  assertStatus,
  assertUniversalAccountIdentifier,
} from './registry.ts';
import {
  UniversalAccountError,
  type AccountCapability,
  type CapabilityState,
} from './types.ts';

/** Where the record came from. Only affects the wording of a refusal. */
export type RecordSource = 'request' | 'stored row';

export const STORED_ROW_NOTE =
  'A stored row that fails this was not written by this component — refusing it rather than ' +
  'presenting it as a real record';

export function validateAccountCapability(
  candidate: unknown,
  source: RecordSource,
): AccountCapability {
  try {
    return checkAccountCapability(candidate, source);
  } catch (error) {
    if (source === 'request' || !(error instanceof UniversalAccountError)) throw error;
    throw new UniversalAccountError(error.code, `${error.message}. ${STORED_ROW_NOTE}`);
  }
}

const ACCOUNT_CAPABILITY_FIELDS: readonly string[] = [
  'capabilityId',
  'accountId',
  'capability',
  'status',
  'activatedAt',
  'deactivatedAt',
  'attributes',
  'createdAt',
  'updatedAt',
  'correlationId',
  'idempotencyKey',
];

function checkAccountCapability(
  candidate: unknown,
  source: RecordSource,
): AccountCapability {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new UniversalAccountError(
      'malformed-record',
      `a capability must be an object, got ${candidate === null ? 'null' : typeof candidate}`,
    );
  }

  for (const key of Object.keys(candidate)) {
    if (!ACCOUNT_CAPABILITY_FIELDS.includes(key)) {
      throw new UniversalAccountError(
        'malformed-record',
        `a capability carried the unrecognised field "${key}"; the permitted fields are ` +
          ACCOUNT_CAPABILITY_FIELDS.join(', '),
      );
    }
  }

  const fields = candidate as Record<string, unknown>;
  return {
    capabilityId: assertUniversalAccountIdentifier(fields.capabilityId, 'capabilityId'),
    accountId: assertUniversalAccountIdentifier(fields.accountId, 'accountId'),
    capability: assertCapability(fields.capability, 'capability'),
    status: assertStatus(fields.status, 'status'),
    activatedAt: checkInstant(fields.activatedAt, 'activatedAt', source),
    deactivatedAt: assertOptionalInstant(fields.deactivatedAt, 'deactivatedAt', source),
    attributes: assertJsonObject(fields.attributes, 'attributes'),
    createdAt: checkInstant(fields.createdAt, 'createdAt', source),
    updatedAt: checkInstant(fields.updatedAt, 'updatedAt', source),
    correlationId: assertUniversalAccountIdentifier(fields.correlationId, 'correlationId'),
    idempotencyKey: assertUniversalAccountIdentifier(
      fields.idempotencyKey,
      'idempotencyKey',
    ),
  };
}

export function validateCapabilityState(
  candidate: unknown,
  source: RecordSource,
): CapabilityState {
  try {
    return checkCapabilityState(candidate, source);
  } catch (error) {
    if (source === 'request' || !(error instanceof UniversalAccountError)) throw error;
    throw new UniversalAccountError(error.code, `${error.message}. ${STORED_ROW_NOTE}`);
  }
}

const CAPABILITY_STATE_FIELDS: readonly string[] = [
  'stateId',
  'capabilityId',
  'accountId',
  'fromStatus',
  'toStatus',
  'reason',
  'occurredAt',
  'correlationId',
  'idempotencyKey',
];

function checkCapabilityState(candidate: unknown, source: RecordSource): CapabilityState {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new UniversalAccountError(
      'malformed-record',
      `a capability state must be an object, got ${candidate === null ? 'null' : typeof candidate}`,
    );
  }

  for (const key of Object.keys(candidate)) {
    if (!CAPABILITY_STATE_FIELDS.includes(key)) {
      throw new UniversalAccountError(
        'malformed-record',
        `a capability state carried the unrecognised field "${key}"; the permitted fields are ` +
          CAPABILITY_STATE_FIELDS.join(', '),
      );
    }
  }

  const fields = candidate as Record<string, unknown>;
  return {
    stateId: assertUniversalAccountIdentifier(fields.stateId, 'stateId'),
    capabilityId: assertUniversalAccountIdentifier(fields.capabilityId, 'capabilityId'),
    accountId: assertUniversalAccountIdentifier(fields.accountId, 'accountId'),
    fromStatus: assertOptionalStatus(fields.fromStatus, 'fromStatus'),
    toStatus: assertStatus(fields.toStatus, 'toStatus'),
    reason: assertReason(fields.reason, 'reason'),
    occurredAt: checkInstant(fields.occurredAt, 'occurredAt', source),
    correlationId: assertUniversalAccountIdentifier(fields.correlationId, 'correlationId'),
    idempotencyKey: assertUniversalAccountIdentifier(fields.idempotencyKey, 'idempotencyKey'),
  };
}

function assertOptionalStatus(
  value: unknown,
  field: string,
): CapabilityStatus | null {
  if (value === null || value === undefined) return null;
  return assertStatus(value, field);
}

function assertJsonObject(
  value: unknown,
  field: string,
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new UniversalAccountError(
      'malformed-record',
      `${field} must be a JSON object, got ${value === null ? 'null' : typeof value}`,
    );
  }
  return value as Record<string, unknown>;
}

function assertReason(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new UniversalAccountError(
      'malformed-reason',
      `${field} is ${value === null ? 'null' : typeof value}; expected text`,
    );
  }
  if (value === '' || value.length > 500) {
    throw new UniversalAccountError(
      'malformed-reason',
      `${field} is ${value.length} characters; expected 1-500 characters`,
    );
  }
  return value;
}

/** The exact form PostgreSQL to_char(...) emits for a timestamptz. */
const STORED_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/;

function checkInstant(value: unknown, field: string, source: RecordSource): string {
  if (source === 'stored row') {
    if (typeof value !== 'string') {
      throw new UniversalAccountError(
        'malformed-record',
        `${field} came back as ${value instanceof Date ? 'a Date' : typeof value} rather than ` +
          'text. Timestamps are projected through to_char precisely so the driver never parses them',
      );
    }
    if (STORED_INSTANT.exec(value) === null) {
      throw new UniversalAccountError(
        'malformed-record',
        `${field} holds "${value}", which is not a finite UTC timestamp in the projected form ` +
          'YYYY-MM-DDTHH:MM:SS.ffffffZ',
      );
    }
    try {
      return formatInstant(parseInstant(value).epochMicros);
    } catch (error) {
      if (error instanceof InvalidInstantError) {
        throw new UniversalAccountError('malformed-record', `${field}: ${error.message}`);
      }
      throw error;
    }
  }

  if (typeof value !== 'string') {
    throw new UniversalAccountError(
      'malformed-instant',
      `${field} is ${value === null ? 'null' : typeof value}; expected a UTC instant string`,
    );
  }
  try {
    return parseInstant(value).source;
  } catch (error) {
    if (error instanceof InvalidInstantError) {
      throw new UniversalAccountError('malformed-instant', `${field}: ${error.message}`);
    }
    throw error;
  }
}

function assertOptionalInstant(
  value: unknown,
  field: string,
  source: RecordSource,
): string | null {
  if (value === null || value === undefined) return null;
  return checkInstant(value, field, source);
}
