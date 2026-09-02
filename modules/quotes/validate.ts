/**
 * M-10 Quotes — validation of complete records, wherever they came from.
 *
 * Owned by: M-10 Quotes.
 */

import { formatInstant, InvalidInstantError, parseInstant } from '../../platform/time/instant.ts';

import {
  assertAmount,
  assertQuantity,
  assertQuoteIdentifier,
  assertQuoteKind,
  assertQuoteStatus,
} from './registry.ts';
import { QuoteError, type Quote } from './types.ts';

export type RecordSource = 'request' | 'stored row';

export const STORED_ROW_NOTE =
  'A stored row that fails this was not written by this component — refusing it rather than ' +
  'presenting it as a real record';

const STORED_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/;

const QUOTE_FIELDS: readonly string[] = [
  'quoteId',
  'rfqId',
  'supplierAccountId',
  'kind',
  'status',
  'quantity',
  'unitPriceMinor',
  'totalMinor',
  'currency',
  'leadTimeDays',
  'deliveryTerms',
  'validUntil',
  'substitutionNote',
  'evidenceReferences',
  'submittedAt',
  'updatedAt',
  'closedAt',
  'closureReason',
  'correlationId',
  'idempotencyKey',
];

export function validateQuote(candidate: unknown, source: RecordSource): Quote {
  try {
    const fields = asObject(candidate, 'a quote', QUOTE_FIELDS);
    const kind = assertQuoteKind(fields.kind, 'kind');
    const note =
      fields.substitutionNote === null || fields.substitutionNote === undefined
        ? null
        : asText(fields.substitutionNote, 'substitutionNote');

    // An undeclared substitution is how a buyer receives something they did not order and finds out
    // on delivery day. A declaration on a non-substitute is the opposite mistake: it says something
    // differs when nothing does.
    if (kind === 'substitute' && (note === null || note.trim().length < 8)) {
      throw new QuoteError(
        'undeclared-substitution',
        'a substitute must say what differs from the specification. An undeclared substitution is ' +
          'how a buyer discovers on delivery day that they did not get what they ordered',
      );
    }
    if (kind !== 'substitute' && note !== null) {
      throw new QuoteError(
        'undeclared-substitution',
        `a ${kind} offer carries a substitution note, which says something differs when the offer ` +
          'claims nothing does',
      );
    }

    const quantity = assertQuantity(fields.quantity, 'quantity');
    const unitPriceMinor = assertAmount(fields.unitPriceMinor, 'unitPriceMinor');
    const totalMinor = assertAmount(fields.totalMinor, 'totalMinor');

    // The landed total covers the goods it lands. The difference above the subtotal is delivery,
    // duties and handling; below it there is no honest reading, because it says the stated unit
    // price is not the price. A supplier giving a volume discount states a lower unit price, which
    // is what a discount is — and M-11 opens an order from this pair, so a negative remainder would
    // surface far downstream as an arithmetic error nobody could trace back here.
    if (totalMinor < quantity * unitPriceMinor) {
      throw new QuoteError(
        'malformed-amount',
        `the landed total ${String(totalMinor)} is below ${String(quantity)} × ` +
          `${String(unitPriceMinor)} = ${String(quantity * unitPriceMinor)}. A total under the ` +
          'goods it lands says the stated unit price is not the price; a discount is a lower unit ' +
          'price',
      );
    }

    const currency = asText(fields.currency, 'currency');
    if (!/^[A-Z]{3}$/.test(currency)) {
      throw new QuoteError('malformed-record', `currency is "${currency}"; expected ISO-4217`);
    }

    return {
      quoteId: assertQuoteIdentifier(fields.quoteId, 'quoteId'),
      rfqId: assertQuoteIdentifier(fields.rfqId, 'rfqId'),
      supplierAccountId: assertQuoteIdentifier(fields.supplierAccountId, 'supplierAccountId'),
      kind,
      status: assertQuoteStatus(fields.status, 'status'),
      quantity,
      unitPriceMinor,
      totalMinor,
      currency,
      leadTimeDays: asNonNegativeInteger(fields.leadTimeDays, 'leadTimeDays'),
      deliveryTerms: asText(fields.deliveryTerms, 'deliveryTerms'),
      validUntil: checkInstant(fields.validUntil, 'validUntil', source),
      substitutionNote: note,
      evidenceReferences: Object.freeze(
        asStringList(fields.evidenceReferences, 'evidenceReferences').map((one) =>
          assertQuoteIdentifier(one, 'evidenceReferences'),
        ),
      ),
      submittedAt: checkInstant(fields.submittedAt, 'submittedAt', source),
      updatedAt: checkInstant(fields.updatedAt, 'updatedAt', source),
      closedAt: assertOptionalInstant(fields.closedAt, 'closedAt', source),
      closureReason:
        fields.closureReason === null || fields.closureReason === undefined
          ? null
          : asText(fields.closureReason, 'closureReason'),
      correlationId: assertQuoteIdentifier(fields.correlationId, 'correlationId'),
      idempotencyKey: assertQuoteIdentifier(fields.idempotencyKey, 'idempotencyKey'),
    };
  } catch (error) {
    if (source === 'request' || !(error instanceof QuoteError)) throw error;
    throw new QuoteError(error.code, `${error.message}. ${STORED_ROW_NOTE}`);
  }
}

function asObject(
  candidate: unknown,
  what: string,
  permitted: readonly string[],
): Record<string, unknown> {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new QuoteError(
      'malformed-record',
      `${what} must be an object, got ${candidate === null ? 'null' : typeof candidate}`,
    );
  }
  for (const key of Object.keys(candidate)) {
    if (!permitted.includes(key)) {
      throw new QuoteError(
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
    throw new QuoteError('malformed-record', `${field} must be a non-empty string`);
  }
  return value;
}

function asStringList(value: unknown, field: string): string[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new QuoteError('malformed-record', `${field} must be an array of strings`);
  }
  return value.map((one) => asText(one, field));
}

function asNonNegativeInteger(value: unknown, field: string): number {
  const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : value;
  if (typeof parsed !== 'number' || !Number.isInteger(parsed) || parsed < 0) {
    throw new QuoteError(
      'malformed-record',
      `${field} is ${String(value)}; expected a non-negative whole number of days`,
    );
  }
  return parsed;
}

function checkInstant(value: unknown, field: string, source: RecordSource): string {
  if (source === 'stored row') {
    if (typeof value !== 'string') {
      throw new QuoteError(
        'malformed-record',
        `${field} came back as ${value instanceof Date ? 'a Date' : typeof value} rather than ` +
          'text. Timestamps are projected through to_char precisely so the driver never parses them',
      );
    }
    if (STORED_INSTANT.exec(value) === null) {
      throw new QuoteError(
        'malformed-record',
        `${field} holds "${value}", which is not a finite UTC timestamp in the projected form`,
      );
    }
    try {
      return formatInstant(parseInstant(value).epochMicros);
    } catch (error) {
      if (error instanceof InvalidInstantError) {
        throw new QuoteError('malformed-record', `${field}: ${error.message}`);
      }
      throw error;
    }
  }

  if (typeof value !== 'string') {
    throw new QuoteError(
      'malformed-instant',
      `${field} is ${value === null ? 'null' : typeof value}; expected a UTC instant string`,
    );
  }
  try {
    return parseInstant(value).source;
  } catch (error) {
    if (error instanceof InvalidInstantError) {
      throw new QuoteError('malformed-instant', `${field}: ${error.message}`);
    }
    throw error;
  }
}

function assertOptionalInstant(value: unknown, field: string, source: RecordSource): string | null {
  if (value === null || value === undefined) return null;
  return checkInstant(value, field, source);
}
