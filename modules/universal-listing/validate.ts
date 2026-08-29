/**
 * M-04 Universal Listing — slice A validation of complete records, wherever they came from.
 *
 * One function per record type, called by the service on the way in and by the PostgreSQL decoder
 * on the way out. There is no second list of rules to keep in step.
 *
 * Owned by: M-04 Universal Listing.
 */

import { formatInstant, InvalidInstantError, parseInstant } from '../../platform/time/instant.ts';

import {
  assertDeclarationKind,
  assertListingStatus,
  assertMediaKind,
  assertUniversalListingIdentifier,
} from './registry.ts';
import {
  UniversalListingError,
  type Listing,
  type ListingDeclaration,
  type ListingMedia,
  type ListingVersion,
} from './types.ts';

/** Where the record came from. Only affects the wording of a refusal. */
export type RecordSource = 'request' | 'stored row';

export const STORED_ROW_NOTE =
  'A stored row that fails this was not written by this component — refusing it rather than ' +
  'presenting it as a real record';

export function validateListing(candidate: unknown, source: RecordSource): Listing {
  try {
    return checkListing(candidate, source);
  } catch (error) {
    if (source === 'request' || !(error instanceof UniversalListingError)) throw error;
    throw new UniversalListingError(error.code, `${error.message}. ${STORED_ROW_NOTE}`);
  }
}

const LISTING_FIELDS: readonly string[] = [
  'listingId',
  'accountId',
  'commerceUnitTypeId',
  'status',
  'currentVersion',
  'createdAt',
  'updatedAt',
  'publishedAt',
  'withdrawnAt',
  'correlationId',
  'idempotencyKey',
];

function checkListing(candidate: unknown, source: RecordSource): Listing {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new UniversalListingError(
      'malformed-record',
      `a listing must be an object, got ${candidate === null ? 'null' : typeof candidate}`,
    );
  }

  for (const key of Object.keys(candidate)) {
    if (!LISTING_FIELDS.includes(key)) {
      throw new UniversalListingError(
        'malformed-record',
        `a listing carried the unrecognised field "${key}"; the permitted fields are ` +
          LISTING_FIELDS.join(', '),
      );
    }
  }

  const fields = candidate as Record<string, unknown>;
  return {
    listingId: assertUniversalListingIdentifier(fields.listingId, 'listingId'),
    accountId: assertUniversalListingIdentifier(fields.accountId, 'accountId'),
    commerceUnitTypeId: assertUniversalListingIdentifier(
      fields.commerceUnitTypeId,
      'commerceUnitTypeId',
    ),
    status: assertListingStatus(fields.status, 'status'),
    currentVersion: assertNonNegativeInteger(fields.currentVersion, 'currentVersion'),
    createdAt: checkInstant(fields.createdAt, 'createdAt', source),
    updatedAt: checkInstant(fields.updatedAt, 'updatedAt', source),
    publishedAt: assertOptionalInstant(fields.publishedAt, 'publishedAt', source),
    withdrawnAt: assertOptionalInstant(fields.withdrawnAt, 'withdrawnAt', source),
    correlationId: assertUniversalListingIdentifier(fields.correlationId, 'correlationId'),
    idempotencyKey: assertUniversalListingIdentifier(fields.idempotencyKey, 'idempotencyKey'),
  };
}

export function validateListingVersion(candidate: unknown, source: RecordSource): ListingVersion {
  try {
    return checkListingVersion(candidate, source);
  } catch (error) {
    if (source === 'request' || !(error instanceof UniversalListingError)) throw error;
    throw new UniversalListingError(error.code, `${error.message}. ${STORED_ROW_NOTE}`);
  }
}

const LISTING_VERSION_FIELDS: readonly string[] = [
  'versionId',
  'listingId',
  'versionNumber',
  'title',
  'description',
  'unitPriceMinor',
  'currency',
  'quantityAvailable',
  'attributes',
  'publishedAt',
  'correlationId',
  'idempotencyKey',
];

function checkListingVersion(candidate: unknown, source: RecordSource): ListingVersion {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new UniversalListingError(
      'malformed-record',
      `a listing version must be an object, got ${candidate === null ? 'null' : typeof candidate}`,
    );
  }

  for (const key of Object.keys(candidate)) {
    if (!LISTING_VERSION_FIELDS.includes(key)) {
      throw new UniversalListingError(
        'malformed-record',
        `a listing version carried the unrecognised field "${key}"; the permitted fields are ` +
          LISTING_VERSION_FIELDS.join(', '),
      );
    }
  }

  const fields = candidate as Record<string, unknown>;
  return {
    versionId: assertUniversalListingIdentifier(fields.versionId, 'versionId'),
    listingId: assertUniversalListingIdentifier(fields.listingId, 'listingId'),
    versionNumber: assertPositiveInteger(fields.versionNumber, 'versionNumber'),
    title: assertTitle(fields.title, 'title'),
    description: assertDescription(fields.description, 'description'),
    unitPriceMinor: assertNonNegativeBigint(fields.unitPriceMinor, 'unitPriceMinor'),
    currency: assertCurrency(fields.currency, 'currency'),
    quantityAvailable: assertNonNegativeQuantity(fields.quantityAvailable, 'quantityAvailable'),
    attributes: assertJsonObject(fields.attributes, 'attributes'),
    publishedAt: checkInstant(fields.publishedAt, 'publishedAt', source),
    correlationId: assertUniversalListingIdentifier(fields.correlationId, 'correlationId'),
    idempotencyKey: assertUniversalListingIdentifier(fields.idempotencyKey, 'idempotencyKey'),
  };
}

export function validateListingMedia(candidate: unknown, source: RecordSource): ListingMedia {
  try {
    return checkListingMedia(candidate, source);
  } catch (error) {
    if (source === 'request' || !(error instanceof UniversalListingError)) throw error;
    throw new UniversalListingError(error.code, `${error.message}. ${STORED_ROW_NOTE}`);
  }
}

const LISTING_MEDIA_FIELDS: readonly string[] = [
  'mediaId',
  'listingId',
  'versionId',
  'kind',
  'reference',
  'position',
  'caption',
  'addedAt',
  'correlationId',
  'idempotencyKey',
];

function checkListingMedia(candidate: unknown, source: RecordSource): ListingMedia {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new UniversalListingError(
      'malformed-record',
      `a listing media row must be an object, got ${candidate === null ? 'null' : typeof candidate}`,
    );
  }

  for (const key of Object.keys(candidate)) {
    if (!LISTING_MEDIA_FIELDS.includes(key)) {
      throw new UniversalListingError(
        'malformed-record',
        `a listing media row carried the unrecognised field "${key}"; the permitted fields are ` +
          LISTING_MEDIA_FIELDS.join(', '),
      );
    }
  }

  const fields = candidate as Record<string, unknown>;
  return {
    mediaId: assertUniversalListingIdentifier(fields.mediaId, 'mediaId'),
    listingId: assertUniversalListingIdentifier(fields.listingId, 'listingId'),
    versionId: assertUniversalListingIdentifier(fields.versionId, 'versionId'),
    kind: assertMediaKind(fields.kind, 'kind'),
    reference: assertReference(fields.reference, 'reference'),
    position: assertNonNegativeInteger(fields.position, 'position'),
    caption: assertCaption(fields.caption, 'caption'),
    addedAt: checkInstant(fields.addedAt, 'addedAt', source),
    correlationId: assertUniversalListingIdentifier(fields.correlationId, 'correlationId'),
    idempotencyKey: assertUniversalListingIdentifier(fields.idempotencyKey, 'idempotencyKey'),
  };
}

export function validateListingDeclaration(
  candidate: unknown,
  source: RecordSource,
): ListingDeclaration {
  try {
    return checkListingDeclaration(candidate, source);
  } catch (error) {
    if (source === 'request' || !(error instanceof UniversalListingError)) throw error;
    throw new UniversalListingError(error.code, `${error.message}. ${STORED_ROW_NOTE}`);
  }
}

const LISTING_DECLARATION_FIELDS: readonly string[] = [
  'declarationId',
  'listingId',
  'versionId',
  'kind',
  'statement',
  'declaredAt',
  'correlationId',
  'idempotencyKey',
];

function checkListingDeclaration(candidate: unknown, source: RecordSource): ListingDeclaration {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new UniversalListingError(
      'malformed-record',
      `a listing declaration must be an object, got ${candidate === null ? 'null' : typeof candidate}`,
    );
  }

  for (const key of Object.keys(candidate)) {
    if (!LISTING_DECLARATION_FIELDS.includes(key)) {
      throw new UniversalListingError(
        'malformed-record',
        `a listing declaration carried the unrecognised field "${key}"; the permitted fields are ` +
          LISTING_DECLARATION_FIELDS.join(', '),
      );
    }
  }

  const fields = candidate as Record<string, unknown>;
  return {
    declarationId: assertUniversalListingIdentifier(fields.declarationId, 'declarationId'),
    listingId: assertUniversalListingIdentifier(fields.listingId, 'listingId'),
    versionId: assertUniversalListingIdentifier(fields.versionId, 'versionId'),
    kind: assertDeclarationKind(fields.kind, 'kind'),
    statement: assertStatement(fields.statement, 'statement'),
    declaredAt: checkInstant(fields.declaredAt, 'declaredAt', source),
    correlationId: assertUniversalListingIdentifier(fields.correlationId, 'correlationId'),
    idempotencyKey: assertUniversalListingIdentifier(fields.idempotencyKey, 'idempotencyKey'),
  };
}

function assertJsonObject(value: unknown, field: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new UniversalListingError(
      'malformed-record',
      `${field} must be a JSON object, got ${value === null ? 'null' : typeof value}`,
    );
  }
  return value as Record<string, unknown>;
}

function assertNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0) {
      throw new UniversalListingError(
        'malformed-record',
        `${field} is ${value}; expected a non-negative integer`,
      );
    }
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (String(parsed) !== value || parsed < 0) {
      throw new UniversalListingError(
        'malformed-record',
        `${field} "${value}" is not a non-negative integer`,
      );
    }
    return parsed;
  }
  if (typeof value === 'bigint') {
    if (value < 0n) {
      throw new UniversalListingError(
        'malformed-record',
        `${field} is ${value}; expected a non-negative integer`,
      );
    }
    return Number(value);
  }
  throw new UniversalListingError(
    'malformed-record',
    `${field} is ${value === null ? 'null' : typeof value}; expected a non-negative integer`,
  );
}

function assertPositiveInteger(value: unknown, field: string): number {
  const parsed = assertNonNegativeInteger(value, field);
  if (parsed === 0) {
    throw new UniversalListingError(
      'malformed-record',
      `${field} is 0; expected a positive integer`,
    );
  }
  return parsed;
}

function assertNonNegativeBigint(value: unknown, field: string): bigint {
  if (typeof value === 'bigint') {
    if (value < 0n) {
      throw new UniversalListingError('negative-amount', `${field} is ${value}; expected >= 0`);
    }
    return value;
  }
  if (typeof value === 'string') {
    if (!/^\d+$/.test(value)) {
      throw new UniversalListingError(
        'negative-amount',
        `${field} "${value}" is not a non-negative integer string`,
      );
    }
    return BigInt(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new UniversalListingError(
        'negative-amount',
        `${field} is ${value}; expected a non-negative safe integer`,
      );
    }
    return BigInt(value);
  }
  throw new UniversalListingError(
    'malformed-record',
    `${field} is ${value === null ? 'null' : typeof value}; expected a non-negative integer`,
  );
}

function assertNonNegativeQuantity(value: unknown, field: string): bigint {
  if (typeof value === 'bigint') {
    if (value < 0n) {
      throw new UniversalListingError('negative-quantity', `${field} is ${value}; expected >= 0`);
    }
    return value;
  }
  if (typeof value === 'string') {
    if (!/^\d+$/.test(value)) {
      throw new UniversalListingError(
        'negative-quantity',
        `${field} "${value}" is not a non-negative integer string`,
      );
    }
    return BigInt(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new UniversalListingError(
        'negative-quantity',
        `${field} is ${value}; expected a non-negative safe integer`,
      );
    }
    return BigInt(value);
  }
  throw new UniversalListingError(
    'malformed-record',
    `${field} is ${value === null ? 'null' : typeof value}; expected a non-negative integer`,
  );
}

function assertCurrency(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new UniversalListingError(
      'malformed-currency',
      `${field} is ${value === null ? 'null' : typeof value}; expected text`,
    );
  }
  if (!/^[A-Z]{3}$/.test(value)) {
    throw new UniversalListingError(
      'malformed-currency',
      `${field} is "${value}"; expected an ISO-4217 code of three uppercase letters`,
    );
  }
  return value;
}

function assertTitle(value: unknown, field: string): string {
  return assertBoundedText(value, field, 'malformed-title', 1, 200);
}

function assertDescription(value: unknown, field: string): string {
  return assertBoundedText(value, field, 'malformed-description', 1, 5000);
}

function assertCaption(value: unknown, field: string): string {
  return assertBoundedText(value, field, 'malformed-caption', 1, 500);
}

function assertStatement(value: unknown, field: string): string {
  return assertBoundedText(value, field, 'malformed-statement', 1, 2000);
}

function assertBoundedText(
  value: unknown,
  field: string,
  code: 'malformed-title' | 'malformed-description' | 'malformed-caption' | 'malformed-statement',
  min: number,
  max: number,
): string {
  if (typeof value !== 'string') {
    throw new UniversalListingError(
      code,
      `${field} is ${value === null ? 'null' : typeof value}; expected text`,
    );
  }
  if (value.trim() === '' || value.length > max || value.length < min) {
    throw new UniversalListingError(
      code,
      `${field} is ${value.length} characters, ${value.trim().length} of them not whitespace; ` +
        `expected ${min}-${max} characters with at least one that is not whitespace`,
    );
  }
  return value;
}

function assertReference(value: unknown, field: string): string {
  // References are opaque handles to artefacts held elsewhere; they are subject to the same rule
  // set as every other identifier, which already refuses emails, long digit strings, IBAN-shaped
  // values, URLs and credential-shaped values.
  return assertUniversalListingIdentifier(value, field);
}

/** The exact form PostgreSQL to_char(...) emits for a timestamptz. */
const STORED_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/;

function checkInstant(value: unknown, field: string, source: RecordSource): string {
  if (source === 'stored row') {
    if (typeof value !== 'string') {
      throw new UniversalListingError(
        'malformed-record',
        `${field} came back as ${value instanceof Date ? 'a Date' : typeof value} rather than ` +
          'text. Timestamps are projected through to_char precisely so the driver never parses them',
      );
    }
    if (STORED_INSTANT.exec(value) === null) {
      throw new UniversalListingError(
        'malformed-record',
        `${field} holds "${value}", which is not a finite UTC timestamp in the projected form ` +
          'YYYY-MM-DDTHH:MM:SS.ffffffZ',
      );
    }
    try {
      return formatInstant(parseInstant(value).epochMicros);
    } catch (error) {
      if (error instanceof InvalidInstantError) {
        throw new UniversalListingError('malformed-record', `${field}: ${error.message}`);
      }
      throw error;
    }
  }

  if (typeof value !== 'string') {
    throw new UniversalListingError(
      'malformed-instant',
      `${field} is ${value === null ? 'null' : typeof value}; expected a UTC instant string`,
    );
  }
  try {
    return parseInstant(value).source;
  } catch (error) {
    if (error instanceof InvalidInstantError) {
      throw new UniversalListingError('malformed-instant', `${field}: ${error.message}`);
    }
    throw error;
  }
}

function assertOptionalInstant(value: unknown, field: string, source: RecordSource): string | null {
  if (value === null || value === undefined) return null;
  return checkInstant(value, field, source);
}
