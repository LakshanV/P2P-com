/**
 * M-09 RFQ — validation of complete records, wherever they came from.
 *
 * Owned by: M-09 RFQ.
 */

import { formatInstant, InvalidInstantError, parseInstant } from '../../platform/time/instant.ts';

import {
  MAXIMUM_ITEM_DESCRIPTION_LENGTH,
  assertNoPrivateText,
  assertReason,
  assertRfqIdentifier,
  assertRfqStatus,
  assertSubstitutionPolicy,
  assertVisibility,
} from './registry.ts';
import {
  RfqError,
  type Rfq,
  type RfqEvent,
  type RfqInvitation,
  type RfqSpecification,
} from './types.ts';

export type RecordSource = 'request' | 'stored row';

export const STORED_ROW_NOTE =
  'A stored row that fails this was not written by this component — refusing it rather than ' +
  'presenting it as a real record';

const STORED_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/;

const SPECIFICATION_FIELDS: readonly string[] = [
  'category',
  'itemDescription',
  'quantity',
  'unit',
  'attributes',
  'deliveryDistrict',
  'requiredBy',
  'condition',
  'qualityRequirements',
  'substitutionPolicy',
  'attachmentReferences',
];

/**
 * Check a specification, and check every string a supplier will read.
 *
 * The private-text guard runs over the description, the attribute values, the condition and the
 * quality requirements — every field that reaches a supplier's screen. Missing one would leave a
 * place for a customer's message to travel.
 */
export function validateSpecification(candidate: unknown, source: RecordSource): RfqSpecification {
  const fields = asObject(candidate, 'a specification', SPECIFICATION_FIELDS);

  const description = asText(fields.itemDescription, 'itemDescription');
  if (description.length > MAXIMUM_ITEM_DESCRIPTION_LENGTH) {
    throw new RfqError(
      'malformed-specification',
      `itemDescription may be at most ${String(MAXIMUM_ITEM_DESCRIPTION_LENGTH)} characters. It ` +
        'is short on purpose: a field long enough to hold a customer message will eventually hold ' +
        'one',
    );
  }
  assertNoPrivateText(description, 'itemDescription');

  const attributes: Record<string, string> = {};
  const rawAttributes = fields.attributes;
  if (rawAttributes === null || typeof rawAttributes !== 'object' || Array.isArray(rawAttributes)) {
    throw new RfqError('malformed-specification', 'attributes must be a JSON object of strings');
  }
  for (const [key, value] of Object.entries(rawAttributes)) {
    if (typeof value !== 'string') {
      throw new RfqError(
        'malformed-specification',
        `attribute "${key}" is ${typeof value}; a specification a supplier can filter on holds ` +
          'strings, not arbitrary structure',
      );
    }
    assertNoPrivateText(value, `attributes.${key}`);
    attributes[key] = value;
  }

  const quality = asStringList(fields.qualityRequirements, 'qualityRequirements');
  for (const requirement of quality) assertNoPrivateText(requirement, 'qualityRequirements');

  const condition =
    fields.condition === null || fields.condition === undefined
      ? null
      : assertNoPrivateText(asText(fields.condition, 'condition'), 'condition');

  return {
    category: asText(fields.category, 'category'),
    itemDescription: description,
    quantity: asQuantity(fields.quantity, 'quantity'),
    unit: asText(fields.unit, 'unit'),
    attributes: Object.freeze(attributes),
    deliveryDistrict:
      fields.deliveryDistrict === null || fields.deliveryDistrict === undefined
        ? null
        : asText(fields.deliveryDistrict, 'deliveryDistrict'),
    requiredBy: assertOptionalInstant(fields.requiredBy, 'requiredBy', source),
    condition,
    qualityRequirements: Object.freeze(quality),
    substitutionPolicy: assertSubstitutionPolicy(fields.substitutionPolicy, 'substitutionPolicy'),
    // Opaque references only. The rule that stops a URL or a filename being stored applies here for
    // the same reason it applies to listing media.
    attachmentReferences: Object.freeze(
      asStringList(fields.attachmentReferences, 'attachmentReferences').map((one) =>
        assertRfqIdentifier(one, 'attachmentReferences'),
      ),
    ),
  };
}

const RFQ_FIELDS: readonly string[] = [
  'rfqId',
  'requestId',
  'accountId',
  'matchRunId',
  'status',
  'visibility',
  'specification',
  'closesAt',
  'openedAt',
  'updatedAt',
  'closedAt',
  'awardedQuoteId',
  'closureReason',
  'correlationId',
  'idempotencyKey',
];

export function validateRfq(candidate: unknown, source: RecordSource): Rfq {
  try {
    const fields = asObject(candidate, 'an RFQ', RFQ_FIELDS);
    const status = assertRfqStatus(fields.status, 'status');
    const awardedQuoteId =
      fields.awardedQuoteId === null || fields.awardedQuoteId === undefined
        ? null
        : assertRfqIdentifier(fields.awardedQuoteId, 'awardedQuoteId');

    // An award names the offer that won. An awarded RFQ with no winner cannot say who was chosen,
    // and a winner on an RFQ that was not awarded claims a decision nobody made.
    if ((status === 'awarded') !== (awardedQuoteId !== null)) {
      throw new RfqError(
        'malformed-record',
        `an RFQ with status "${status}" ${awardedQuoteId === null ? 'names no winning quote' : 'names one'}. ` +
          'An award is exactly one chosen offer',
      );
    }

    return {
      rfqId: assertRfqIdentifier(fields.rfqId, 'rfqId'),
      requestId: assertRfqIdentifier(fields.requestId, 'requestId'),
      accountId: assertRfqIdentifier(fields.accountId, 'accountId'),
      matchRunId:
        fields.matchRunId === null || fields.matchRunId === undefined
          ? null
          : assertRfqIdentifier(fields.matchRunId, 'matchRunId'),
      status,
      visibility: assertVisibility(fields.visibility, 'visibility'),
      specification: validateSpecification(fields.specification, source),
      closesAt: checkInstant(fields.closesAt, 'closesAt', source),
      openedAt: checkInstant(fields.openedAt, 'openedAt', source),
      updatedAt: checkInstant(fields.updatedAt, 'updatedAt', source),
      closedAt: assertOptionalInstant(fields.closedAt, 'closedAt', source),
      awardedQuoteId,
      closureReason:
        fields.closureReason === null || fields.closureReason === undefined
          ? null
          : asText(fields.closureReason, 'closureReason'),
      correlationId: assertRfqIdentifier(fields.correlationId, 'correlationId'),
      idempotencyKey: assertRfqIdentifier(fields.idempotencyKey, 'idempotencyKey'),
    };
  } catch (error) {
    if (source === 'request' || !(error instanceof RfqError)) throw error;
    throw new RfqError(error.code, `${error.message}. ${STORED_ROW_NOTE}`);
  }
}

const INVITATION_FIELDS: readonly string[] = [
  'invitationId',
  'rfqId',
  'supplierAccountId',
  'sourceRung',
  'reason',
  'scorePerMille',
  'invitedAt',
  'correlationId',
  'idempotencyKey',
];

export function validateInvitation(candidate: unknown, source: RecordSource): RfqInvitation {
  try {
    const fields = asObject(candidate, 'an invitation', INVITATION_FIELDS);
    return {
      invitationId: assertRfqIdentifier(fields.invitationId, 'invitationId'),
      rfqId: assertRfqIdentifier(fields.rfqId, 'rfqId'),
      supplierAccountId: assertRfqIdentifier(fields.supplierAccountId, 'supplierAccountId'),
      sourceRung:
        fields.sourceRung === null || fields.sourceRung === undefined
          ? null
          : asText(fields.sourceRung, 'sourceRung'),
      reason: assertReason(fields.reason, 'reason'),
      scorePerMille:
        fields.scorePerMille === null || fields.scorePerMille === undefined
          ? null
          : asScore(fields.scorePerMille, 'scorePerMille'),
      invitedAt: checkInstant(fields.invitedAt, 'invitedAt', source),
      correlationId: assertRfqIdentifier(fields.correlationId, 'correlationId'),
      idempotencyKey: assertRfqIdentifier(fields.idempotencyKey, 'idempotencyKey'),
    };
  } catch (error) {
    if (source === 'request' || !(error instanceof RfqError)) throw error;
    throw new RfqError(error.code, `${error.message}. ${STORED_ROW_NOTE}`);
  }
}

const EVENT_FIELDS: readonly string[] = [
  'eventId',
  'rfqId',
  'fromStatus',
  'toStatus',
  'reason',
  'occurredAt',
  'correlationId',
  'idempotencyKey',
];

export function validateRfqEvent(candidate: unknown, source: RecordSource): RfqEvent {
  try {
    const fields = asObject(candidate, 'an RFQ event', EVENT_FIELDS);
    return {
      eventId: assertRfqIdentifier(fields.eventId, 'eventId'),
      rfqId: assertRfqIdentifier(fields.rfqId, 'rfqId'),
      fromStatus:
        fields.fromStatus === null || fields.fromStatus === undefined
          ? null
          : assertRfqStatus(fields.fromStatus, 'fromStatus'),
      toStatus: assertRfqStatus(fields.toStatus, 'toStatus'),
      reason: asText(fields.reason, 'reason'),
      occurredAt: checkInstant(fields.occurredAt, 'occurredAt', source),
      correlationId: assertRfqIdentifier(fields.correlationId, 'correlationId'),
      idempotencyKey: assertRfqIdentifier(fields.idempotencyKey, 'idempotencyKey'),
    };
  } catch (error) {
    if (source === 'request' || !(error instanceof RfqError)) throw error;
    throw new RfqError(error.code, `${error.message}. ${STORED_ROW_NOTE}`);
  }
}

function asObject(
  candidate: unknown,
  what: string,
  permitted: readonly string[],
): Record<string, unknown> {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new RfqError(
      'malformed-record',
      `${what} must be an object, got ${candidate === null ? 'null' : typeof candidate}`,
    );
  }
  for (const key of Object.keys(candidate)) {
    if (!permitted.includes(key)) {
      throw new RfqError(
        'malformed-record',
        `${what} carried the unrecognised field "${key}"; the permitted fields are ` +
          permitted.join(', '),
      );
    }
  }
  return candidate as Record<string, unknown>;
}

function asText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RfqError('malformed-specification', `${field} must be a non-empty string`);
  }
  return value;
}

function asStringList(value: unknown, field: string): string[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new RfqError('malformed-specification', `${field} must be an array of strings`);
  }
  return value.map((one) => asText(one, field));
}

function asQuantity(value: unknown, field: string): bigint {
  if (typeof value === 'bigint') {
    if (value <= 0n) {
      throw new RfqError('malformed-specification', `${field} must be greater than zero`);
    }
    return value;
  }
  if (typeof value === 'string' && /^\d+$/.test(value) && BigInt(value) > 0n) return BigInt(value);
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return BigInt(value);
  throw new RfqError(
    'malformed-specification',
    `${field} is ${String(value)}; a tender for nothing is not a tender`,
  );
}

function asScore(value: unknown, field: string): number {
  const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : value;
  if (typeof parsed !== 'number' || !Number.isInteger(parsed) || parsed < 0 || parsed > 1000) {
    throw new RfqError(
      'malformed-record',
      `${field} is ${String(value)}; expected a whole number of per-mille from 0 to 1000`,
    );
  }
  return parsed;
}

function checkInstant(value: unknown, field: string, source: RecordSource): string {
  if (source === 'stored row') {
    if (typeof value !== 'string') {
      throw new RfqError(
        'malformed-record',
        `${field} came back as ${value instanceof Date ? 'a Date' : typeof value} rather than ` +
          'text. Timestamps are projected through to_char precisely so the driver never parses them',
      );
    }
    if (STORED_INSTANT.exec(value) === null) {
      throw new RfqError(
        'malformed-record',
        `${field} holds "${value}", which is not a finite UTC timestamp in the projected form`,
      );
    }
    try {
      return formatInstant(parseInstant(value).epochMicros);
    } catch (error) {
      if (error instanceof InvalidInstantError) {
        throw new RfqError('malformed-record', `${field}: ${error.message}`);
      }
      throw error;
    }
  }

  if (typeof value !== 'string') {
    throw new RfqError(
      'malformed-instant',
      `${field} is ${value === null ? 'null' : typeof value}; expected a UTC instant string`,
    );
  }
  try {
    return parseInstant(value).source;
  } catch (error) {
    if (error instanceof InvalidInstantError) {
      throw new RfqError('malformed-instant', `${field}: ${error.message}`);
    }
    throw error;
  }
}

function assertOptionalInstant(value: unknown, field: string, source: RecordSource): string | null {
  if (value === null || value === undefined) return null;
  return checkInstant(value, field, source);
}
