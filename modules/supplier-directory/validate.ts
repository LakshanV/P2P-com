/**
 * M-48 — validation of complete records, wherever they came from.
 *
 * Owned by: M-48 Supplier & Merchant Directory.
 */

import { formatInstant, InvalidInstantError, parseInstant } from '../../platform/time/instant.ts';

import {
  assertCapacity,
  assertCode,
  assertDirectoryIdentifier,
  assertDirectoryKind,
  assertDirectoryStatus,
  assertFacetStatus,
  assertFacetKind,
  assertName,
  assertReason,
} from './registry.ts';
import {
  DirectoryError,
  type DirectoryEntry,
  type DirectoryEvent,
  type SupplierFacet,
  type SupplierLocation,
} from './types.ts';

export type RecordSource = 'request' | 'stored row';

export const STORED_ROW_NOTE =
  'A stored row that fails this was not written by this component — refusing it rather than ' +
  'presenting it as a real record';

const STORED_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/;

const ENTRY_FIELDS: readonly string[] = [
  'supplierId',
  'accountId',
  'kind',
  'displayName',
  'status',
  'acceptsOrders',
  'dailyCapacity',
  'registeredAt',
  'updatedAt',
  'closedAt',
  'closureReason',
  'correlationId',
  'idempotencyKey',
];

export function validateEntry(candidate: unknown, source: RecordSource): DirectoryEntry {
  try {
    const fields = asObject(candidate, 'a directory entry', ENTRY_FIELDS);
    const status = assertDirectoryStatus(fields.status, 'status');
    const closedAt = assertOptionalInstant(fields.closedAt, 'closedAt', source);

    // A closed entry says when, and an open one does not pretend to have.
    if ((status === 'closed') !== (closedAt !== null)) {
      throw new DirectoryError(
        'malformed-record',
        `status is ${status} and closedAt is ${closedAt === null ? 'absent' : 'set'}; a closed ` +
          'entry records when it closed, and an open one has not closed',
      );
    }

    return {
      supplierId: assertDirectoryIdentifier(fields.supplierId, 'supplierId'),
      accountId: assertDirectoryIdentifier(fields.accountId, 'accountId'),
      kind: assertDirectoryKind(fields.kind, 'kind'),
      displayName: assertName(fields.displayName, 'displayName'),
      status,
      acceptsOrders: asBoolean(fields.acceptsOrders, 'acceptsOrders'),
      dailyCapacity: assertCapacity(fields.dailyCapacity, 'dailyCapacity'),
      registeredAt: checkInstant(fields.registeredAt, 'registeredAt', source),
      updatedAt: checkInstant(fields.updatedAt, 'updatedAt', source),
      closedAt,
      closureReason:
        fields.closureReason === null || fields.closureReason === undefined
          ? null
          : assertReason(fields.closureReason, 'closureReason'),
      correlationId: assertDirectoryIdentifier(fields.correlationId, 'correlationId'),
      idempotencyKey: assertDirectoryIdentifier(fields.idempotencyKey, 'idempotencyKey'),
    };
  } catch (error) {
    if (source === 'request' || !(error instanceof DirectoryError)) throw error;
    throw new DirectoryError(error.code, `${error.message}. ${STORED_ROW_NOTE}`);
  }
}

const FACET_FIELDS: readonly string[] = [
  'facetId',
  'supplierId',
  'kind',
  'value',
  'status',
  'declaredAt',
  'withdrawnAt',
  'correlationId',
  'idempotencyKey',
];

export function validateFacet(candidate: unknown, source: RecordSource): SupplierFacet {
  try {
    const fields = asObject(candidate, 'a facet', FACET_FIELDS);
    const status = assertFacetStatus(fields.status, 'status');
    const withdrawnAt = assertOptionalInstant(fields.withdrawnAt, 'withdrawnAt', source);

    if ((status === 'withdrawn') !== (withdrawnAt !== null)) {
      throw new DirectoryError(
        'malformed-record',
        `status is ${status} and withdrawnAt is ${withdrawnAt === null ? 'absent' : 'set'}`,
      );
    }

    return {
      facetId: assertDirectoryIdentifier(fields.facetId, 'facetId'),
      supplierId: assertDirectoryIdentifier(fields.supplierId, 'supplierId'),
      kind: assertFacetKind(fields.kind, 'kind'),
      value: assertCode(fields.value, 'value'),
      status,
      declaredAt: checkInstant(fields.declaredAt, 'declaredAt', source),
      withdrawnAt,
      correlationId: assertDirectoryIdentifier(fields.correlationId, 'correlationId'),
      idempotencyKey: assertDirectoryIdentifier(fields.idempotencyKey, 'idempotencyKey'),
    };
  } catch (error) {
    if (source === 'request' || !(error instanceof DirectoryError)) throw error;
    throw new DirectoryError(error.code, `${error.message}. ${STORED_ROW_NOTE}`);
  }
}

const LOCATION_FIELDS: readonly string[] = [
  'locationId',
  'supplierId',
  'name',
  'district',
  'primary',
  'status',
  'openedAt',
  'closedAt',
  'correlationId',
  'idempotencyKey',
];

export function validateLocation(candidate: unknown, source: RecordSource): SupplierLocation {
  try {
    const fields = asObject(candidate, 'a location', LOCATION_FIELDS);
    const status = assertFacetStatus(fields.status, 'status');
    const closedAt = assertOptionalInstant(fields.closedAt, 'closedAt', source);

    if ((status === 'withdrawn') !== (closedAt !== null)) {
      throw new DirectoryError(
        'malformed-record',
        `status is ${status} and closedAt is ${closedAt === null ? 'absent' : 'set'}`,
      );
    }

    return {
      locationId: assertDirectoryIdentifier(fields.locationId, 'locationId'),
      supplierId: assertDirectoryIdentifier(fields.supplierId, 'supplierId'),
      name: assertName(fields.name, 'name'),
      district: assertCode(fields.district, 'district'),
      primary: asBoolean(fields.primary, 'primary'),
      status,
      openedAt: checkInstant(fields.openedAt, 'openedAt', source),
      closedAt,
      correlationId: assertDirectoryIdentifier(fields.correlationId, 'correlationId'),
      idempotencyKey: assertDirectoryIdentifier(fields.idempotencyKey, 'idempotencyKey'),
    };
  } catch (error) {
    if (source === 'request' || !(error instanceof DirectoryError)) throw error;
    throw new DirectoryError(error.code, `${error.message}. ${STORED_ROW_NOTE}`);
  }
}

const EVENT_FIELDS: readonly string[] = [
  'eventId',
  'supplierId',
  'fromStatus',
  'toStatus',
  'reason',
  'occurredAt',
  'correlationId',
  'idempotencyKey',
];

export function validateDirectoryEvent(candidate: unknown, source: RecordSource): DirectoryEvent {
  try {
    const fields = asObject(candidate, 'a directory event', EVENT_FIELDS);
    return {
      eventId: assertDirectoryIdentifier(fields.eventId, 'eventId'),
      supplierId: assertDirectoryIdentifier(fields.supplierId, 'supplierId'),
      fromStatus:
        fields.fromStatus === null || fields.fromStatus === undefined
          ? null
          : assertDirectoryStatus(fields.fromStatus, 'fromStatus'),
      toStatus: assertDirectoryStatus(fields.toStatus, 'toStatus'),
      reason: assertReason(fields.reason, 'reason'),
      occurredAt: checkInstant(fields.occurredAt, 'occurredAt', source),
      correlationId: assertDirectoryIdentifier(fields.correlationId, 'correlationId'),
      idempotencyKey: assertDirectoryIdentifier(fields.idempotencyKey, 'idempotencyKey'),
    };
  } catch (error) {
    if (source === 'request' || !(error instanceof DirectoryError)) throw error;
    throw new DirectoryError(error.code, `${error.message}. ${STORED_ROW_NOTE}`);
  }
}

function asObject(
  candidate: unknown,
  what: string,
  permitted: readonly string[],
): Record<string, unknown> {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new DirectoryError(
      'malformed-record',
      `${what} must be an object, got ${candidate === null ? 'null' : typeof candidate}`,
    );
  }
  for (const key of Object.keys(candidate)) {
    if (!permitted.includes(key)) {
      throw new DirectoryError(
        'malformed-record',
        `${what} carried the unrecognised field "${key}"; the permitted fields are ` +
          permitted.join(', '),
      );
    }
  }
  return candidate as Record<string, unknown>;
}

function asBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new DirectoryError('malformed-record', `${field} must be true or false`);
  }
  return value;
}

function checkInstant(value: unknown, field: string, source: RecordSource): string {
  if (source === 'stored row') {
    if (typeof value !== 'string') {
      throw new DirectoryError(
        'malformed-record',
        `${field} came back as ${value instanceof Date ? 'a Date' : typeof value} rather than ` +
          'text. Timestamps are projected through to_char precisely so the driver never parses them',
      );
    }
    if (STORED_INSTANT.exec(value) === null) {
      throw new DirectoryError(
        'malformed-record',
        `${field} holds "${value}", which is not a finite UTC timestamp in the projected form`,
      );
    }
    try {
      return formatInstant(parseInstant(value).epochMicros);
    } catch (error) {
      if (error instanceof InvalidInstantError) {
        throw new DirectoryError('malformed-record', `${field}: ${error.message}`);
      }
      throw error;
    }
  }

  if (typeof value !== 'string') {
    throw new DirectoryError(
      'malformed-instant',
      `${field} is ${value === null ? 'null' : typeof value}; expected a UTC instant string`,
    );
  }
  try {
    return parseInstant(value).source;
  } catch (error) {
    if (error instanceof InvalidInstantError) {
      throw new DirectoryError('malformed-instant', `${field}: ${error.message}`);
    }
    throw error;
  }
}

function assertOptionalInstant(value: unknown, field: string, source: RecordSource): string | null {
  if (value === null || value === undefined) return null;
  return checkInstant(value, field, source);
}
