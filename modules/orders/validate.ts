/**
 * M-11 Orders — validation of complete records, wherever they came from.
 *
 * One function per record type, called by the service on the way in and by the PostgreSQL decoder
 * on the way out. There is no second list of rules to keep in step.
 *
 * Owned by: M-11 Orders.
 */

import { formatInstant, InvalidInstantError, parseInstant } from '../../platform/time/instant.ts';

import {
  assertCancellationReason,
  assertLineKind,
  assertOrderEventKind,
  assertOrderIdentifier,
  assertOrderStatus,
} from './registry.ts';
import {
  FULFILMENT_ROLES,
  OrderError,
  type CancellationReason,
  type FulfilmentRole,
  type Order,
  type OrderEvent,
  type OrderItem,
  type OrderSnapshot,
  type OrderStatus,
} from './types.ts';

/** Where the record came from. Only affects the wording of a refusal. */
export type RecordSource = 'request' | 'stored row';

export const STORED_ROW_NOTE =
  'A stored row that fails this was not written by this component — refusing it rather than ' +
  'presenting it as a real record';

export function validateOrder(candidate: unknown, source: RecordSource): Order {
  try {
    return checkOrder(candidate, source);
  } catch (error) {
    if (source === 'request' || !(error instanceof OrderError)) throw error;
    throw new OrderError(error.code, `${error.message}. ${STORED_ROW_NOTE}`);
  }
}

const ORDER_FIELDS: readonly string[] = [
  'orderId',
  'buyerAccountId',
  'sellerAccountId',
  'status',
  'currency',
  'subtotalMinor',
  'totalMinor',
  'itemCount',
  'placedAt',
  'confirmedAt',
  'completedAt',
  'cancelledAt',
  'cancellationReason',
  'parentOrderId',
  'fulfilmentRole',
  'createdAt',
  'updatedAt',
  'correlationId',
  'idempotencyKey',
];

function checkOrder(candidate: unknown, source: RecordSource): Order {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new OrderError(
      'malformed-record',
      `an order must be an object, got ${candidate === null ? 'null' : typeof candidate}`,
    );
  }

  for (const key of Object.keys(candidate)) {
    if (!ORDER_FIELDS.includes(key)) {
      throw new OrderError(
        'malformed-record',
        `an order carried the unrecognised field "${key}"; the permitted fields are ` +
          ORDER_FIELDS.join(', '),
      );
    }
  }

  const fields = candidate as Record<string, unknown>;
  const parentOrderId = assertOptionalIdentifier(fields.parentOrderId, 'parentOrderId');
  const fulfilmentRole = assertFulfilmentRole(fields.fulfilmentRole, 'fulfilmentRole');

  if ((fulfilmentRole === 'child') !== (parentOrderId !== null)) {
    throw new OrderError(
      'malformed-record',
      `a ${fulfilmentRole} order ${
        parentOrderId === null ? 'must have a parentOrderId' : 'must not have a parentOrderId'
      }`,
    );
  }
  if (parentOrderId !== null && parentOrderId === fields.orderId) {
    throw new OrderError('malformed-record', 'an order may not be its own parent');
  }

  return {
    orderId: assertOrderIdentifier(fields.orderId, 'orderId'),
    buyerAccountId: assertOrderIdentifier(fields.buyerAccountId, 'buyerAccountId'),
    sellerAccountId: assertOrderIdentifier(fields.sellerAccountId, 'sellerAccountId'),
    status: assertOrderStatus(fields.status, 'status'),
    currency: assertCurrency(fields.currency, 'currency'),
    subtotalMinor: assertNonNegativeBigint(fields.subtotalMinor, 'subtotalMinor'),
    totalMinor: assertNonNegativeBigint(fields.totalMinor, 'totalMinor'),
    itemCount: assertNonNegativeInteger(fields.itemCount, 'itemCount'),
    placedAt: assertOptionalInstant(fields.placedAt, 'placedAt', source),
    confirmedAt: assertOptionalInstant(fields.confirmedAt, 'confirmedAt', source),
    completedAt: assertOptionalInstant(fields.completedAt, 'completedAt', source),
    cancelledAt: assertOptionalInstant(fields.cancelledAt, 'cancelledAt', source),
    cancellationReason: assertOptionalCancellationReason(
      fields.cancellationReason,
      'cancellationReason',
    ),
    parentOrderId,
    fulfilmentRole,
    createdAt: checkInstant(fields.createdAt, 'createdAt', source),
    updatedAt: checkInstant(fields.updatedAt, 'updatedAt', source),
    correlationId: assertOrderIdentifier(fields.correlationId, 'correlationId'),
    idempotencyKey: assertOrderIdentifier(fields.idempotencyKey, 'idempotencyKey'),
  };
}

export function validateOrderItem(candidate: unknown, source: RecordSource): OrderItem {
  try {
    return checkOrderItem(candidate, source);
  } catch (error) {
    if (source === 'request' || !(error instanceof OrderError)) throw error;
    throw new OrderError(error.code, `${error.message}. ${STORED_ROW_NOTE}`);
  }
}

const ORDER_ITEM_FIELDS: readonly string[] = [
  'itemId',
  'orderId',
  'listingId',
  'versionId',
  'commerceUnitTypeId',
  'quoteId',
  'lineKind',
  'quantity',
  'unitPriceMinor',
  'lineTotalMinor',
  'currency',
  'reservationId',
  'addedAt',
  'correlationId',
  'idempotencyKey',
];

function checkOrderItem(candidate: unknown, source: RecordSource): OrderItem {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new OrderError(
      'malformed-record',
      `an order item must be an object, got ${candidate === null ? 'null' : typeof candidate}`,
    );
  }

  for (const key of Object.keys(candidate)) {
    if (!ORDER_ITEM_FIELDS.includes(key)) {
      throw new OrderError(
        'malformed-record',
        `an order item carried the unrecognised field "${key}"; the permitted fields are ` +
          ORDER_ITEM_FIELDS.join(', '),
      );
    }
  }

  const fields = candidate as Record<string, unknown>;
  const quantity = assertPositiveQuantity(fields.quantity, 'quantity');
  const unitPriceMinor = assertNonNegativeBigint(fields.unitPriceMinor, 'unitPriceMinor');
  const lineTotalMinor = assertNonNegativeBigint(fields.lineTotalMinor, 'lineTotalMinor');
  if (lineTotalMinor !== quantity * unitPriceMinor) {
    throw new OrderError(
      'line-total-mismatch',
      `lineTotalMinor ${String(lineTotalMinor)} does not equal quantity * unitPriceMinor ` +
        `(${String(quantity)} * ${String(unitPriceMinor)} = ${String(quantity * unitPriceMinor)})`,
    );
  }

  const listingId = assertOptionalIdentifier(fields.listingId, 'listingId');
  const versionId = assertOptionalIdentifier(fields.versionId, 'versionId');
  const commerceUnitTypeId = assertOptionalIdentifier(
    fields.commerceUnitTypeId,
    'commerceUnitTypeId',
  );
  const quoteId = assertOptionalIdentifier(fields.quoteId, 'quoteId');

  // Exactly one source, in both directions. A line with neither cannot say what was agreed; a line
  // with both has two prices and no way to say which one a dispute is judged against. The database
  // says the same thing in `order_item_names_one_source`, because a rule this important should not
  // depend on one code path being the only writer.
  const fromListing = listingId !== null || versionId !== null || commerceUnitTypeId !== null;
  if (quoteId === null && !fromListing) {
    throw new OrderError(
      'ambiguous-line-source',
      'an order line names either a listing version or an accepted quote. This names neither, so ' +
        'nothing on it can say what the buyer agreed to',
    );
  }
  if (quoteId !== null && fromListing) {
    throw new OrderError(
      'ambiguous-line-source',
      `line ${String(fields.itemId)} names both a listing and quote ${quoteId}. That is two ` +
        'prices with no way to say which one a dispute is judged against',
    );
  }
  if (quoteId === null && (listingId === null || versionId === null)) {
    throw new OrderError(
      'ambiguous-line-source',
      'a listing line pins both the listing and the version. Without the version it reads whatever ' +
        'the terms have become, which is not what was agreed',
    );
  }
  if (quoteId === null && commerceUnitTypeId === null) {
    throw new OrderError(
      'ambiguous-line-source',
      'a listing line carries the K-11 commerce unit type the listing was published against',
    );
  }

  return {
    itemId: assertOrderIdentifier(fields.itemId, 'itemId'),
    orderId: assertOrderIdentifier(fields.orderId, 'orderId'),
    listingId,
    versionId,
    commerceUnitTypeId,
    quoteId,
    lineKind: assertLineKind(fields.lineKind, 'lineKind'),
    quantity,
    unitPriceMinor,
    lineTotalMinor,
    currency: assertCurrency(fields.currency, 'currency'),
    reservationId: assertOptionalIdentifier(fields.reservationId, 'reservationId'),
    addedAt: checkInstant(fields.addedAt, 'addedAt', source),
    correlationId: assertOrderIdentifier(fields.correlationId, 'correlationId'),
    idempotencyKey: assertOrderIdentifier(fields.idempotencyKey, 'idempotencyKey'),
  };
}

export function validateOrderSnapshot(candidate: unknown, source: RecordSource): OrderSnapshot {
  try {
    return checkOrderSnapshot(candidate, source);
  } catch (error) {
    if (source === 'request' || !(error instanceof OrderError)) throw error;
    throw new OrderError(error.code, `${error.message}. ${STORED_ROW_NOTE}`);
  }
}

const ORDER_SNAPSHOT_FIELDS: readonly string[] = [
  'snapshotId',
  'orderId',
  'buyerAccountId',
  'sellerAccountId',
  'currency',
  'subtotalMinor',
  'totalMinor',
  'lines',
  'policyVersionId',
  'capturedAt',
  'correlationId',
  'idempotencyKey',
];

function checkOrderSnapshot(candidate: unknown, source: RecordSource): OrderSnapshot {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new OrderError(
      'malformed-record',
      `an order snapshot must be an object, got ${candidate === null ? 'null' : typeof candidate}`,
    );
  }

  for (const key of Object.keys(candidate)) {
    if (!ORDER_SNAPSHOT_FIELDS.includes(key)) {
      throw new OrderError(
        'malformed-record',
        `an order snapshot carried the unrecognised field "${key}"; the permitted fields are ` +
          ORDER_SNAPSHOT_FIELDS.join(', '),
      );
    }
  }

  const fields = candidate as Record<string, unknown>;
  return {
    snapshotId: assertOrderIdentifier(fields.snapshotId, 'snapshotId'),
    orderId: assertOrderIdentifier(fields.orderId, 'orderId'),
    buyerAccountId: assertOrderIdentifier(fields.buyerAccountId, 'buyerAccountId'),
    sellerAccountId: assertOrderIdentifier(fields.sellerAccountId, 'sellerAccountId'),
    currency: assertCurrency(fields.currency, 'currency'),
    subtotalMinor: assertNonNegativeBigint(fields.subtotalMinor, 'subtotalMinor'),
    totalMinor: assertNonNegativeBigint(fields.totalMinor, 'totalMinor'),
    lines: assertJsonObject(fields.lines, 'lines'),
    policyVersionId: assertOptionalIdentifier(fields.policyVersionId, 'policyVersionId'),
    capturedAt: checkInstant(fields.capturedAt, 'capturedAt', source),
    correlationId: assertOrderIdentifier(fields.correlationId, 'correlationId'),
    idempotencyKey: assertOrderIdentifier(fields.idempotencyKey, 'idempotencyKey'),
  };
}

export function validateOrderEvent(candidate: unknown, source: RecordSource): OrderEvent {
  try {
    return checkOrderEvent(candidate, source);
  } catch (error) {
    if (source === 'request' || !(error instanceof OrderError)) throw error;
    throw new OrderError(error.code, `${error.message}. ${STORED_ROW_NOTE}`);
  }
}

const ORDER_EVENT_FIELDS: readonly string[] = [
  'eventId',
  'orderId',
  'kind',
  'fromStatus',
  'toStatus',
  'reason',
  'occurredAt',
  'correlationId',
  'idempotencyKey',
];

function checkOrderEvent(candidate: unknown, source: RecordSource): OrderEvent {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new OrderError(
      'malformed-record',
      `an order event must be an object, got ${candidate === null ? 'null' : typeof candidate}`,
    );
  }

  for (const key of Object.keys(candidate)) {
    if (!ORDER_EVENT_FIELDS.includes(key)) {
      throw new OrderError(
        'malformed-record',
        `an order event carried the unrecognised field "${key}"; the permitted fields are ` +
          ORDER_EVENT_FIELDS.join(', '),
      );
    }
  }

  const fields = candidate as Record<string, unknown>;
  return {
    eventId: assertOrderIdentifier(fields.eventId, 'eventId'),
    orderId: assertOrderIdentifier(fields.orderId, 'orderId'),
    kind: assertOrderEventKind(fields.kind, 'kind'),
    fromStatus: assertOptionalStatus(fields.fromStatus, 'fromStatus'),
    toStatus: assertOrderStatus(fields.toStatus, 'toStatus'),
    reason: assertReason(fields.reason, 'reason'),
    occurredAt: checkInstant(fields.occurredAt, 'occurredAt', source),
    correlationId: assertOrderIdentifier(fields.correlationId, 'correlationId'),
    idempotencyKey: assertOrderIdentifier(fields.idempotencyKey, 'idempotencyKey'),
  };
}

function assertJsonObject(value: unknown, field: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new OrderError(
      'malformed-record',
      `${field} must be a JSON object, got ${value === null ? 'null' : typeof value}`,
    );
  }
  return value as Record<string, unknown>;
}

function assertNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0) {
      throw new OrderError(
        'malformed-record',
        `${field} is ${value}; expected a non-negative integer`,
      );
    }
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (String(parsed) !== value || parsed < 0) {
      throw new OrderError('malformed-record', `${field} "${value}" is not a non-negative integer`);
    }
    return parsed;
  }
  if (typeof value === 'bigint') {
    if (value < 0n) {
      throw new OrderError(
        'malformed-record',
        `${field} is ${value}; expected a non-negative integer`,
      );
    }
    return Number(value);
  }
  throw new OrderError(
    'malformed-record',
    `${field} is ${value === null ? 'null' : typeof value}; expected a non-negative integer`,
  );
}

function assertNonNegativeBigint(value: unknown, field: string): bigint {
  if (typeof value === 'bigint') {
    if (value < 0n) {
      throw new OrderError('negative-amount', `${field} is ${value}; expected >= 0`);
    }
    return value;
  }
  if (typeof value === 'string') {
    if (!/^\d+$/.test(value)) {
      throw new OrderError(
        'negative-amount',
        `${field} "${value}" is not a non-negative integer string`,
      );
    }
    return BigInt(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new OrderError(
        'negative-amount',
        `${field} is ${value}; expected a non-negative safe integer`,
      );
    }
    return BigInt(value);
  }
  throw new OrderError(
    'malformed-record',
    `${field} is ${value === null ? 'null' : typeof value}; expected a non-negative integer`,
  );
}

function assertPositiveQuantity(value: unknown, field: string): bigint {
  if (typeof value === 'bigint') {
    if (value <= 0n) {
      throw new OrderError('negative-quantity', `${field} is ${value}; expected > 0`);
    }
    return value;
  }
  if (typeof value === 'string') {
    if (!/^\d+$/.test(value) || value === '0') {
      throw new OrderError(
        'negative-quantity',
        `${field} "${value}" is not a positive integer string`,
      );
    }
    return BigInt(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new OrderError(
        'negative-quantity',
        `${field} is ${value}; expected a positive safe integer`,
      );
    }
    return BigInt(value);
  }
  throw new OrderError(
    'malformed-record',
    `${field} is ${value === null ? 'null' : typeof value}; expected a positive integer`,
  );
}

function assertReason(value: unknown, field: string): string {
  return assertBoundedText(value, field, 'malformed-reason', 1, 500);
}

function assertOptionalIdentifier(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  return assertOrderIdentifier(value, field);
}

function assertOptionalStatus(value: unknown, field: string): OrderStatus | null {
  if (value === null || value === undefined) return null;
  return assertOrderStatus(value, field);
}

function assertOptionalCancellationReason(
  value: unknown,
  field: string,
): CancellationReason | null {
  if (value === null || value === undefined) return null;
  return assertCancellationReason(value, field);
}

function assertFulfilmentRole(value: unknown, field: string): FulfilmentRole {
  if (typeof value !== 'string' || !(FULFILMENT_ROLES as readonly string[]).includes(value)) {
    throw new OrderError(
      'unknown-fulfilment-role',
      `${field} is "${String(value)}"; expected one of ${FULFILMENT_ROLES.join(', ')}`,
    );
  }
  return value as FulfilmentRole;
}

function assertCurrency(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new OrderError(
      'malformed-currency',
      `${field} is ${value === null ? 'null' : typeof value}; expected text`,
    );
  }
  if (!/^[A-Z]{3}$/.test(value)) {
    throw new OrderError(
      'malformed-currency',
      `${field} is "${value}"; expected an ISO-4217 code of three uppercase letters`,
    );
  }
  return value;
}

function assertBoundedText(
  value: unknown,
  field: string,
  code: 'malformed-reason' | 'malformed-record',
  min: number,
  max: number,
): string {
  if (typeof value !== 'string') {
    throw new OrderError(
      code,
      `${field} is ${value === null ? 'null' : typeof value}; expected text`,
    );
  }
  if (value.trim() === '' || value.length > max || value.length < min) {
    throw new OrderError(
      code,
      `${field} is ${value.length} characters, ${value.trim().length} of them not whitespace; ` +
        `expected ${min}-${max} characters with at least one that is not whitespace`,
    );
  }
  return value;
}

/** The exact form PostgreSQL to_char(...) emits for a timestamptz. */
const STORED_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/;

function checkInstant(value: unknown, field: string, source: RecordSource): string {
  if (source === 'stored row') {
    if (typeof value !== 'string') {
      throw new OrderError(
        'malformed-record',
        `${field} came back as ${value instanceof Date ? 'a Date' : typeof value} rather than ` +
          'text. Timestamps are projected through to_char precisely so the driver never parses them',
      );
    }
    if (STORED_INSTANT.exec(value) === null) {
      throw new OrderError(
        'malformed-record',
        `${field} holds "${value}", which is not a finite UTC timestamp in the projected form ` +
          'YYYY-MM-DDTHH:MM:SS.ffffffZ',
      );
    }
    try {
      return formatInstant(parseInstant(value).epochMicros);
    } catch (error) {
      if (error instanceof InvalidInstantError) {
        throw new OrderError('malformed-record', `${field}: ${error.message}`);
      }
      throw error;
    }
  }

  if (typeof value !== 'string') {
    throw new OrderError(
      'malformed-instant',
      `${field} is ${value === null ? 'null' : typeof value}; expected a UTC instant string`,
    );
  }
  try {
    return parseInstant(value).source;
  } catch (error) {
    if (error instanceof InvalidInstantError) {
      throw new OrderError('malformed-instant', `${field}: ${error.message}`);
    }
    throw error;
  }
}

function assertOptionalInstant(value: unknown, field: string, source: RecordSource): string | null {
  if (value === null || value === undefined) return null;
  return checkInstant(value, field, source);
}
