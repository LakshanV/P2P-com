/**
 * K-15 Search Foundation — validation of complete records, wherever they came from.
 *
 * One function per record type, called by the service on the way in and by the PostgreSQL decoder
 * on the way out. There is no second list of rules to keep in step.
 *
 * Owned by: K-15 Search Foundation.
 */

import { InvalidInstantError, parseInstant } from '../../platform/time/instant.ts';

import { assertSearchIdentifier } from './registry.ts';
import { SearchError, type SearchQueryLog, type SearchDocument } from './types.ts';

/** Where the record came from. Only affects the wording of a refusal. */
export type RecordSource = 'request' | 'stored row';

const STORED_ROW_NOTE =
  'A stored row that fails this was not written by this component — refusing it rather than ' +
  'presenting it as a real record';

export function validateSearchDocument(candidate: unknown, source: RecordSource): SearchDocument {
  try {
    return checkSearchDocument(candidate, source);
  } catch (error) {
    if (source === 'request' || !(error instanceof SearchError)) throw error;
    throw new SearchError(error.code, `${error.message}. ${STORED_ROW_NOTE}`);
  }
}

const DOCUMENT_FIELDS: readonly string[] = [
  'documentId',
  'ownerType',
  'ownerId',
  'scope',
  'language',
  'title',
  'description',
  'keywords',
  'attributes',
  'vectors',
  'ranking',
  'createdAt',
  'updatedAt',
  'idempotencyKey',
];

function checkSearchDocument(candidate: unknown, source: RecordSource): SearchDocument {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new SearchError(
      'malformed-record',
      `a document must be an object, got ${candidate === null ? 'null' : typeof candidate}`,
    );
  }

  for (const key of Object.keys(candidate)) {
    if (!DOCUMENT_FIELDS.includes(key)) {
      throw new SearchError(
        'malformed-record',
        `a document carried the unrecognised field "${key}"; the permitted fields are ` +
          DOCUMENT_FIELDS.join(', '),
      );
    }
  }

  const fields = candidate as Record<string, unknown>;
  return {
    documentId: assertSearchIdentifier(fields.documentId, 'documentId'),
    ownerType: assertNonEmptyText(fields.ownerType, 'ownerType'),
    ownerId: assertSearchIdentifier(fields.ownerId, 'ownerId'),
    scope: assertNonEmptyText(fields.scope, 'scope'),
    language: assertNonEmptyText(fields.language, 'language'),
    title: assertNonEmptyText(fields.title, 'title'),
    description: assertNonEmptyText(fields.description, 'description'),
    keywords: assertStringArray(fields.keywords, 'keywords'),
    attributes: assertJsonObject(fields.attributes, 'attributes'),
    vectors: assertJsonObject(fields.vectors, 'vectors'),
    ranking: assertJsonObject(fields.ranking, 'ranking'),
    createdAt: checkInstant(fields.createdAt, 'createdAt', source),
    updatedAt: checkInstant(fields.updatedAt, 'updatedAt', source),
    idempotencyKey: assertSearchIdentifier(fields.idempotencyKey, 'idempotencyKey'),
  };
}

export function validateSearchQueryLog(candidate: unknown, source: RecordSource): SearchQueryLog {
  try {
    return checkSearchQueryLog(candidate, source);
  } catch (error) {
    if (source === 'request' || !(error instanceof SearchError)) throw error;
    throw new SearchError(error.code, `${error.message}. ${STORED_ROW_NOTE}`);
  }
}

const QUERY_LOG_FIELDS: readonly string[] = [
  'queryId',
  'queryText',
  'filters',
  'resultCount',
  'executedAt',
  'correlationId',
  'idempotencyKey',
];

function checkSearchQueryLog(candidate: unknown, source: RecordSource): SearchQueryLog {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new SearchError(
      'malformed-record',
      `a query log must be an object, got ${candidate === null ? 'null' : typeof candidate}`,
    );
  }

  for (const key of Object.keys(candidate)) {
    if (!QUERY_LOG_FIELDS.includes(key)) {
      throw new SearchError(
        'malformed-record',
        `a query log carried the unrecognised field "${key}"; the permitted fields are ` +
          QUERY_LOG_FIELDS.join(', '),
      );
    }
  }

  const fields = candidate as Record<string, unknown>;
  return {
    queryId: assertSearchIdentifier(fields.queryId, 'queryId'),
    queryText: assertNonEmptyText(fields.queryText, 'queryText'),
    filters: assertJsonObject(fields.filters, 'filters'),
    resultCount: assertNonNegativeInteger(fields.resultCount, 'resultCount'),
    executedAt: checkInstant(fields.executedAt, 'executedAt', source),
    correlationId: assertSearchIdentifier(fields.correlationId, 'correlationId'),
    idempotencyKey: assertSearchIdentifier(fields.idempotencyKey, 'idempotencyKey'),
  };
}

function assertNonEmptyText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new SearchError(
      'malformed-record',
      `${field} is ${value === null ? 'null' : typeof value}; expected non-empty text`,
    );
  }
  return value;
}

function assertStringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new SearchError(
      'malformed-record',
      `${field} is ${value === null ? 'null' : typeof value}; expected an array of strings`,
    );
  }
  if (value.some((entry) => typeof entry !== 'string')) {
    throw new SearchError('malformed-record', `${field} contains a non-string entry`);
  }
  return value as readonly string[];
}

function assertJsonObject(value: unknown, field: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SearchError(
      'malformed-record',
      `${field} is ${value === null ? 'null' : typeof value}; expected a JSON object`,
    );
  }
  return value as Record<string, unknown>;
}

function assertNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new SearchError(
      'malformed-record',
      `${field} is ${JSON.stringify(value)}; expected a non-negative integer`,
    );
  }
  return value;
}

/** The exact form PostgreSQL to_char(...) emits for a timestamptz. */
const STORED_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/;

function checkInstant(value: unknown, field: string, source: RecordSource = 'request'): string {
  if (source === 'stored row') {
    if (typeof value !== 'string') {
      throw new SearchError(
        'malformed-record',
        `${field} came back as ${value instanceof Date ? 'a Date' : typeof value} rather than ` +
          'text. Timestamps are projected through to_char precisely so the driver never parses them',
      );
    }
    if (STORED_INSTANT.exec(value) === null) {
      throw new SearchError(
        'malformed-record',
        `${field} holds "${value}", which is not a finite UTC timestamp in the projected form ` +
          'YYYY-MM-DDTHH:MM:SS.ffffffZ',
      );
    }
    try {
      parseInstant(value);
    } catch (error) {
      if (error instanceof InvalidInstantError) {
        throw new SearchError('malformed-record', `${field}: ${error.message}`);
      }
      throw error;
    }
    return value;
  }

  if (typeof value !== 'string') {
    throw new SearchError(
      'malformed-instant',
      `${field} is ${value === null ? 'null' : typeof value}; expected a UTC instant string`,
    );
  }
  try {
    return parseInstant(value).source;
  } catch (error) {
    if (error instanceof InvalidInstantError) {
      throw new SearchError('malformed-instant', `${field}: ${error.message}`);
    }
    throw error;
  }
}
