/**
 * M-02 Capability & Verification — validation of complete records, wherever they came from.
 *
 * One function per record type, called by the service on the way in and by the PostgreSQL decoder
 * on the way out. There is no second list of rules to keep in step.
 *
 * Owned by: M-02 Capability & Verification.
 */

import { formatInstant, InvalidInstantError, parseInstant } from '../../platform/time/instant.ts';

import {
  assertCapabilityVerificationIdentifier,
  assertCaseStatus,
  assertEvidenceKind,
  assertEvidenceStatus,
  assertVerificationLevel,
} from './registry.ts';
import {
  CapabilityVerificationError,
  type Evidence,
  type LevelRecord,
  type VerificationCase,
  type VerificationLevel,
} from './types.ts';

/** Where the record came from. Only affects the wording of a refusal. */
export type RecordSource = 'request' | 'stored row';

export const STORED_ROW_NOTE =
  'A stored row that fails this was not written by this component — refusing it rather than ' +
  'presenting it as a real record';

export function validateVerificationCase(
  candidate: unknown,
  source: RecordSource,
): VerificationCase {
  try {
    return checkVerificationCase(candidate, source);
  } catch (error) {
    if (source === 'request' || !(error instanceof CapabilityVerificationError)) throw error;
    throw new CapabilityVerificationError(error.code, `${error.message}. ${STORED_ROW_NOTE}`);
  }
}

const VERIFICATION_CASE_FIELDS: readonly string[] = [
  'caseId',
  'accountId',
  'purpose',
  'status',
  'requestedLevel',
  'achievedLevel',
  'openedAt',
  'decidedAt',
  'attributes',
  'createdAt',
  'updatedAt',
  'correlationId',
  'idempotencyKey',
];

function checkVerificationCase(candidate: unknown, source: RecordSource): VerificationCase {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new CapabilityVerificationError(
      'malformed-record',
      `a verification case must be an object, got ${candidate === null ? 'null' : typeof candidate}`,
    );
  }

  for (const key of Object.keys(candidate)) {
    if (!VERIFICATION_CASE_FIELDS.includes(key)) {
      throw new CapabilityVerificationError(
        'malformed-record',
        `a verification case carried the unrecognised field "${key}"; the permitted fields are ` +
          VERIFICATION_CASE_FIELDS.join(', '),
      );
    }
  }

  const fields = candidate as Record<string, unknown>;
  return {
    caseId: assertCapabilityVerificationIdentifier(fields.caseId, 'caseId'),
    accountId: assertCapabilityVerificationIdentifier(fields.accountId, 'accountId'),
    purpose: assertPurpose(fields.purpose, 'purpose'),
    status: assertCaseStatus(fields.status, 'status'),
    requestedLevel: assertVerificationLevel(fields.requestedLevel, 'requestedLevel'),
    achievedLevel: assertVerificationLevel(fields.achievedLevel, 'achievedLevel'),
    openedAt: checkInstant(fields.openedAt, 'openedAt', source),
    decidedAt: assertOptionalInstant(fields.decidedAt, 'decidedAt', source),
    attributes: assertJsonObject(fields.attributes, 'attributes'),
    createdAt: checkInstant(fields.createdAt, 'createdAt', source),
    updatedAt: checkInstant(fields.updatedAt, 'updatedAt', source),
    correlationId: assertCapabilityVerificationIdentifier(fields.correlationId, 'correlationId'),
    idempotencyKey: assertCapabilityVerificationIdentifier(fields.idempotencyKey, 'idempotencyKey'),
  };
}

export function validateEvidence(candidate: unknown, source: RecordSource): Evidence {
  try {
    return checkEvidence(candidate, source);
  } catch (error) {
    if (source === 'request' || !(error instanceof CapabilityVerificationError)) throw error;
    throw new CapabilityVerificationError(error.code, `${error.message}. ${STORED_ROW_NOTE}`);
  }
}

const EVIDENCE_FIELDS: readonly string[] = [
  'evidenceId',
  'caseId',
  'accountId',
  'kind',
  'status',
  'reference',
  'note',
  'submittedAt',
  'correlationId',
  'idempotencyKey',
];

function checkEvidence(candidate: unknown, source: RecordSource): Evidence {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new CapabilityVerificationError(
      'malformed-record',
      `an evidence row must be an object, got ${candidate === null ? 'null' : typeof candidate}`,
    );
  }

  for (const key of Object.keys(candidate)) {
    if (!EVIDENCE_FIELDS.includes(key)) {
      throw new CapabilityVerificationError(
        'malformed-record',
        `an evidence row carried the unrecognised field "${key}"; the permitted fields are ` +
          EVIDENCE_FIELDS.join(', '),
      );
    }
  }

  const fields = candidate as Record<string, unknown>;
  return {
    evidenceId: assertCapabilityVerificationIdentifier(fields.evidenceId, 'evidenceId'),
    caseId: assertCapabilityVerificationIdentifier(fields.caseId, 'caseId'),
    accountId: assertCapabilityVerificationIdentifier(fields.accountId, 'accountId'),
    kind: assertEvidenceKind(fields.kind, 'kind'),
    status: assertEvidenceStatus(fields.status, 'status'),
    reference: assertReference(fields.reference, 'reference'),
    note: assertReason(fields.note, 'note'),
    submittedAt: checkInstant(fields.submittedAt, 'submittedAt', source),
    correlationId: assertCapabilityVerificationIdentifier(fields.correlationId, 'correlationId'),
    idempotencyKey: assertCapabilityVerificationIdentifier(fields.idempotencyKey, 'idempotencyKey'),
  };
}

export function validateLevelRecord(candidate: unknown, source: RecordSource): LevelRecord {
  try {
    return checkLevelRecord(candidate, source);
  } catch (error) {
    if (source === 'request' || !(error instanceof CapabilityVerificationError)) throw error;
    throw new CapabilityVerificationError(error.code, `${error.message}. ${STORED_ROW_NOTE}`);
  }
}

const LEVEL_RECORD_FIELDS: readonly string[] = [
  'recordId',
  'caseId',
  'accountId',
  'fromLevel',
  'toLevel',
  'reason',
  'occurredAt',
  'correlationId',
  'idempotencyKey',
];

function checkLevelRecord(candidate: unknown, source: RecordSource): LevelRecord {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new CapabilityVerificationError(
      'malformed-record',
      `a level record must be an object, got ${candidate === null ? 'null' : typeof candidate}`,
    );
  }

  for (const key of Object.keys(candidate)) {
    if (!LEVEL_RECORD_FIELDS.includes(key)) {
      throw new CapabilityVerificationError(
        'malformed-record',
        `a level record carried the unrecognised field "${key}"; the permitted fields are ` +
          LEVEL_RECORD_FIELDS.join(', '),
      );
    }
  }

  const fields = candidate as Record<string, unknown>;
  return {
    recordId: assertCapabilityVerificationIdentifier(fields.recordId, 'recordId'),
    caseId: assertCapabilityVerificationIdentifier(fields.caseId, 'caseId'),
    accountId: assertCapabilityVerificationIdentifier(fields.accountId, 'accountId'),
    fromLevel: assertOptionalLevel(fields.fromLevel, 'fromLevel'),
    toLevel: assertVerificationLevel(fields.toLevel, 'toLevel'),
    reason: assertReason(fields.reason, 'reason'),
    occurredAt: checkInstant(fields.occurredAt, 'occurredAt', source),
    correlationId: assertCapabilityVerificationIdentifier(fields.correlationId, 'correlationId'),
    idempotencyKey: assertCapabilityVerificationIdentifier(fields.idempotencyKey, 'idempotencyKey'),
  };
}

function assertOptionalLevel(value: unknown, field: string): VerificationLevel | null {
  if (value === null || value === undefined) return null;
  return assertVerificationLevel(value, field);
}

function assertJsonObject(value: unknown, field: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new CapabilityVerificationError(
      'malformed-record',
      `${field} must be a JSON object, got ${value === null ? 'null' : typeof value}`,
    );
  }
  return value as Record<string, unknown>;
}

function assertPurpose(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new CapabilityVerificationError(
      'malformed-purpose',
      `${field} is ${value === null ? 'null' : typeof value}; expected text`,
    );
  }
  // Lowercase kebab, starting with a **letter**, segments separated by single hyphens.
  //
  // The leading letter is not decoration. Migration 0025's CHECK is `^[a-z][a-z0-9-]{0,63}$`, so a
  // purpose beginning with a digit satisfied an earlier version of this function and was then
  // refused by PostgreSQL. This function is deliberately the stricter of the two — it also refuses
  // the doubled and trailing hyphens the CHECK would accept — because stricter here only ever
  // rejects rows the database would have taken, while looser here rejects them at the one boundary
  // where the caller cannot do anything about it.
  if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(value) || value.length > 64) {
    throw new CapabilityVerificationError(
      'malformed-purpose',
      `${field} is "${value}"; expected a lowercase kebab word of 1-64 characters starting with ` +
        'a letter',
    );
  }
  return value;
}

function assertReference(value: unknown, field: string): string {
  // References are opaque handles to artefacts held elsewhere; they are subject to the same rule
  // set as every other identifier, which already refuses emails, long digit strings, IBAN-shaped
  // values, URLs and credential-shaped values.
  return assertCapabilityVerificationIdentifier(value, field);
}

function assertReason(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new CapabilityVerificationError(
      'malformed-reason',
      `${field} is ${value === null ? 'null' : typeof value}; expected text`,
    );
  }
  // The migration's CHECK is `length(btrim(reason)) > 0 AND length(reason) <= 500`. Trimming here
  // rather than only testing for the empty string is what keeps the two in step.
  if (value.trim() === '' || value.length > 500) {
    throw new CapabilityVerificationError(
      'malformed-reason',
      `${field} is ${value.length} characters, ${value.trim().length} of them not whitespace; ` +
        'expected 1-500 characters with at least one that is not whitespace',
    );
  }
  return value;
}

/** The exact form PostgreSQL to_char(...) emits for a timestamptz. */
const STORED_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/;

function checkInstant(value: unknown, field: string, source: RecordSource): string {
  if (source === 'stored row') {
    if (typeof value !== 'string') {
      throw new CapabilityVerificationError(
        'malformed-record',
        `${field} came back as ${value instanceof Date ? 'a Date' : typeof value} rather than ` +
          'text. Timestamps are projected through to_char precisely so the driver never parses them',
      );
    }
    if (STORED_INSTANT.exec(value) === null) {
      throw new CapabilityVerificationError(
        'malformed-record',
        `${field} holds "${value}", which is not a finite UTC timestamp in the projected form ` +
          'YYYY-MM-DDTHH:MM:SS.ffffffZ',
      );
    }
    try {
      return formatInstant(parseInstant(value).epochMicros);
    } catch (error) {
      if (error instanceof InvalidInstantError) {
        throw new CapabilityVerificationError('malformed-record', `${field}: ${error.message}`);
      }
      throw error;
    }
  }

  if (typeof value !== 'string') {
    throw new CapabilityVerificationError(
      'malformed-instant',
      `${field} is ${value === null ? 'null' : typeof value}; expected a UTC instant string`,
    );
  }
  try {
    return parseInstant(value).source;
  } catch (error) {
    if (error instanceof InvalidInstantError) {
      throw new CapabilityVerificationError('malformed-instant', `${field}: ${error.message}`);
    }
    throw error;
  }
}

function assertOptionalInstant(value: unknown, field: string, source: RecordSource): string | null {
  if (value === null || value === undefined) return null;
  return checkInstant(value, field, source);
}
