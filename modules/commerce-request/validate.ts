/**
 * M-03 Commerce Request — validation of complete records, wherever they came from.
 *
 * One function per record type, called by the service on the way in and by the PostgreSQL decoder on
 * the way out. There is no second list of rules to keep in step, which is the point: a stored row
 * that would be refused as a request is refused as a row too, rather than being presented as a real
 * record because it happened to get past an older version of this file.
 *
 * Owned by: M-03 Commerce Request.
 */

import { formatInstant, InvalidInstantError, parseInstant } from '../../platform/time/instant.ts';

import {
  assertCaptureChannel,
  assertCommerceRequestIdentifier,
  assertConfidence,
  assertInterpretationOrigin,
  assertMediaKind,
  assertRationale,
  assertRawText,
  assertRequestStatus,
  assertStructured,
} from './registry.ts';
import {
  CommerceRequestError,
  type CommerceRequest,
  type RequestEvent,
  type RequestInterpretation,
  type RequestMedia,
} from './types.ts';

/** Where the record came from. Only affects the wording of a refusal. */
export type RecordSource = 'request' | 'stored row';

export const STORED_ROW_NOTE =
  'A stored row that fails this was not written by this component — refusing it rather than ' +
  'presenting it as a real record';

const STORED_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/;

const REQUEST_FIELDS: readonly string[] = [
  'requestId',
  'accountId',
  'channel',
  'rawText',
  'conversationId',
  'status',
  'currentInterpretationId',
  'capturedAt',
  'updatedAt',
  'neededBy',
  'closedAt',
  'closureReason',
  'correlationId',
  'idempotencyKey',
];

export function validateCommerceRequest(candidate: unknown, source: RecordSource): CommerceRequest {
  try {
    return checkRequest(candidate, source);
  } catch (error) {
    if (source === 'request' || !(error instanceof CommerceRequestError)) throw error;
    throw new CommerceRequestError(error.code, `${error.message}. ${STORED_ROW_NOTE}`);
  }
}

function checkRequest(candidate: unknown, source: RecordSource): CommerceRequest {
  const fields = asObject(candidate, 'a commerce request', REQUEST_FIELDS);
  return {
    requestId: assertCommerceRequestIdentifier(fields.requestId, 'requestId'),
    accountId: assertCommerceRequestIdentifier(fields.accountId, 'accountId'),
    channel: assertCaptureChannel(fields.channel, 'channel'),
    // The one field with no identifier rule applied to it. See `CommerceRequest.rawText`.
    rawText: assertRawText(fields.rawText, 'rawText'),
    conversationId: assertOptionalIdentifier(fields.conversationId, 'conversationId'),
    status: assertRequestStatus(fields.status, 'status'),
    currentInterpretationId: assertOptionalIdentifier(
      fields.currentInterpretationId,
      'currentInterpretationId',
    ),
    capturedAt: checkInstant(fields.capturedAt, 'capturedAt', source),
    updatedAt: checkInstant(fields.updatedAt, 'updatedAt', source),
    neededBy: assertOptionalInstant(fields.neededBy, 'neededBy', source),
    closedAt: assertOptionalInstant(fields.closedAt, 'closedAt', source),
    closureReason: assertOptionalReason(fields.closureReason, 'closureReason'),
    correlationId: assertCommerceRequestIdentifier(fields.correlationId, 'correlationId'),
    idempotencyKey: assertCommerceRequestIdentifier(fields.idempotencyKey, 'idempotencyKey'),
  };
}

const INTERPRETATION_FIELDS: readonly string[] = [
  'interpretationId',
  'requestId',
  'version',
  'origin',
  'confidencePerMille',
  'structured',
  'aiRunId',
  'rationale',
  'supersedesInterpretationId',
  'interpretedAt',
  'correlationId',
  'idempotencyKey',
];

export function validateInterpretation(
  candidate: unknown,
  source: RecordSource,
): RequestInterpretation {
  try {
    return checkInterpretation(candidate, source);
  } catch (error) {
    if (source === 'request' || !(error instanceof CommerceRequestError)) throw error;
    throw new CommerceRequestError(error.code, `${error.message}. ${STORED_ROW_NOTE}`);
  }
}

function checkInterpretation(candidate: unknown, source: RecordSource): RequestInterpretation {
  const fields = asObject(candidate, 'an interpretation', INTERPRETATION_FIELDS);
  const origin = assertInterpretationOrigin(fields.origin, 'origin');
  const aiRunId = assertOptionalIdentifier(fields.aiRunId, 'aiRunId');

  // A model interpretation with no run behind it cannot be traced back to the model and prompt that
  // produced it, which is the only way a wrong answer gets diagnosed rather than argued about. And a
  // human or rule interpretation carrying one is claiming an AI produced it when none did.
  if (origin === 'model' && aiRunId === null) {
    throw new CommerceRequestError(
      'malformed-record',
      'a model interpretation must name the K-13 run that produced it. Without it a wrong reading ' +
        'cannot be traced to the model and prompt behind it',
    );
  }
  if (origin !== 'model' && aiRunId !== null) {
    throw new CommerceRequestError(
      'malformed-record',
      `a ${origin} interpretation names an AI run, which would credit a model for a reading it did ` +
        'not produce',
    );
  }

  return {
    interpretationId: assertCommerceRequestIdentifier(fields.interpretationId, 'interpretationId'),
    requestId: assertCommerceRequestIdentifier(fields.requestId, 'requestId'),
    version: assertPositiveInteger(fields.version, 'version'),
    origin,
    confidencePerMille: assertConfidence(asNumber(fields.confidencePerMille), 'confidencePerMille'),
    structured: assertStructured(fields.structured, 'structured'),
    aiRunId,
    rationale: assertRationale(fields.rationale, 'rationale'),
    supersedesInterpretationId: assertOptionalIdentifier(
      fields.supersedesInterpretationId,
      'supersedesInterpretationId',
    ),
    interpretedAt: checkInstant(fields.interpretedAt, 'interpretedAt', source),
    correlationId: assertCommerceRequestIdentifier(fields.correlationId, 'correlationId'),
    idempotencyKey: assertCommerceRequestIdentifier(fields.idempotencyKey, 'idempotencyKey'),
  };
}

const MEDIA_FIELDS: readonly string[] = [
  'mediaId',
  'requestId',
  'kind',
  'reference',
  'position',
  'caption',
  'addedAt',
  'correlationId',
  'idempotencyKey',
];

export function validateRequestMedia(candidate: unknown, source: RecordSource): RequestMedia {
  try {
    return checkMedia(candidate, source);
  } catch (error) {
    if (source === 'request' || !(error instanceof CommerceRequestError)) throw error;
    throw new CommerceRequestError(error.code, `${error.message}. ${STORED_ROW_NOTE}`);
  }
}

function checkMedia(candidate: unknown, source: RecordSource): RequestMedia {
  const fields = asObject(candidate, 'request media', MEDIA_FIELDS);
  const caption = fields.caption;
  if (typeof caption !== 'string' || caption.length > 500) {
    throw new CommerceRequestError(
      'malformed-media',
      'caption must be a string of at most 500 characters. An empty one is fine: not every ' +
        'photograph comes with an explanation',
    );
  }
  return {
    mediaId: assertCommerceRequestIdentifier(fields.mediaId, 'mediaId'),
    requestId: assertCommerceRequestIdentifier(fields.requestId, 'requestId'),
    kind: assertMediaKind(fields.kind, 'kind'),
    // An **opaque** reference, so the same rule that stops a URL or a filename being stored here
    // applies. The artefact itself lives in object storage and never in this table.
    reference: assertCommerceRequestIdentifier(fields.reference, 'reference'),
    position: assertNonNegativeInteger(fields.position, 'position'),
    caption,
    addedAt: checkInstant(fields.addedAt, 'addedAt', source),
    correlationId: assertCommerceRequestIdentifier(fields.correlationId, 'correlationId'),
    idempotencyKey: assertCommerceRequestIdentifier(fields.idempotencyKey, 'idempotencyKey'),
  };
}

const EVENT_FIELDS: readonly string[] = [
  'eventId',
  'requestId',
  'fromStatus',
  'toStatus',
  'reason',
  'occurredAt',
  'correlationId',
  'idempotencyKey',
];

export function validateRequestEvent(candidate: unknown, source: RecordSource): RequestEvent {
  try {
    return checkEvent(candidate, source);
  } catch (error) {
    if (source === 'request' || !(error instanceof CommerceRequestError)) throw error;
    throw new CommerceRequestError(error.code, `${error.message}. ${STORED_ROW_NOTE}`);
  }
}

function checkEvent(candidate: unknown, source: RecordSource): RequestEvent {
  const fields = asObject(candidate, 'a request event', EVENT_FIELDS);
  const reason = fields.reason;
  if (typeof reason !== 'string' || reason.trim().length === 0 || reason.length > 500) {
    throw new CommerceRequestError(
      'malformed-record',
      'reason must be a non-empty string of at most 500 characters. A transition nobody explained ' +
        'is a transition nobody can review',
    );
  }
  return {
    eventId: assertCommerceRequestIdentifier(fields.eventId, 'eventId'),
    requestId: assertCommerceRequestIdentifier(fields.requestId, 'requestId'),
    fromStatus:
      fields.fromStatus === null || fields.fromStatus === undefined
        ? null
        : assertRequestStatus(fields.fromStatus, 'fromStatus'),
    toStatus: assertRequestStatus(fields.toStatus, 'toStatus'),
    reason,
    occurredAt: checkInstant(fields.occurredAt, 'occurredAt', source),
    correlationId: assertCommerceRequestIdentifier(fields.correlationId, 'correlationId'),
    idempotencyKey: assertCommerceRequestIdentifier(fields.idempotencyKey, 'idempotencyKey'),
  };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function asObject(
  candidate: unknown,
  what: string,
  permitted: readonly string[],
): Record<string, unknown> {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new CommerceRequestError(
      'malformed-record',
      `${what} must be an object, got ${candidate === null ? 'null' : typeof candidate}`,
    );
  }
  for (const key of Object.keys(candidate)) {
    if (!permitted.includes(key)) {
      throw new CommerceRequestError(
        'malformed-record',
        `${what} carried the unrecognised field "${key}"; the permitted fields are ` +
          permitted.join(', '),
      );
    }
  }
  return candidate as Record<string, unknown>;
}

function asNumber(value: unknown): number {
  // PostgreSQL returns a smallint as a number and a bigint as a string; accepting both here means
  // the decoder does not need a second rule that could drift from this one.
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return Number.parseInt(value, 10);
  return value as number;
}

function assertOptionalIdentifier(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  return assertCommerceRequestIdentifier(value, field);
}

function assertOptionalReason(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 500) {
    throw new CommerceRequestError(
      'malformed-record',
      `${field} must be a non-empty string of at most 500 characters when present`,
    );
  }
  return value;
}

function assertNonNegativeInteger(value: unknown, field: string): number {
  const parsed = asNumber(value);
  if (typeof parsed !== 'number' || !Number.isInteger(parsed) || parsed < 0) {
    throw new CommerceRequestError(
      'malformed-record',
      `${field} is ${String(value)}; expected a non-negative integer`,
    );
  }
  return parsed;
}

function assertPositiveInteger(value: unknown, field: string): number {
  const parsed = assertNonNegativeInteger(value, field);
  if (parsed === 0) {
    throw new CommerceRequestError(
      'malformed-record',
      `${field} is 0; expected a positive integer. Versions start at 1`,
    );
  }
  return parsed;
}

function checkInstant(value: unknown, field: string, source: RecordSource): string {
  if (source === 'stored row') {
    if (typeof value !== 'string') {
      throw new CommerceRequestError(
        'malformed-record',
        `${field} came back as ${value instanceof Date ? 'a Date' : typeof value} rather than ` +
          'text. Timestamps are projected through to_char precisely so the driver never parses them',
      );
    }
    if (STORED_INSTANT.exec(value) === null) {
      throw new CommerceRequestError(
        'malformed-record',
        `${field} holds "${value}", which is not a finite UTC timestamp in the projected form ` +
          'YYYY-MM-DDTHH:MM:SS.ffffffZ',
      );
    }
    try {
      return formatInstant(parseInstant(value).epochMicros);
    } catch (error) {
      if (error instanceof InvalidInstantError) {
        throw new CommerceRequestError('malformed-record', `${field}: ${error.message}`);
      }
      throw error;
    }
  }

  if (typeof value !== 'string') {
    throw new CommerceRequestError(
      'malformed-instant',
      `${field} is ${value === null ? 'null' : typeof value}; expected a UTC instant string`,
    );
  }
  try {
    return parseInstant(value).source;
  } catch (error) {
    if (error instanceof InvalidInstantError) {
      throw new CommerceRequestError('malformed-instant', `${field}: ${error.message}`);
    }
    throw error;
  }
}

function assertOptionalInstant(value: unknown, field: string, source: RecordSource): string | null {
  if (value === null || value === undefined) return null;
  return checkInstant(value, field, source);
}
