/**
 * K-10 Ledger Foundation — validation of complete records, wherever they came from.
 *
 * One function per record type, called by the service on the way in and by the PostgreSQL decoder
 * on the way out. There is no second list of rules to keep in step.
 *
 * Owned by: K-10 Ledger Foundation.
 */

import { InvalidInstantError, parseInstant } from '../../platform/time/instant.ts';

import { assertAssetSymbol, assertAssetTypeId, assertOpaqueIdentifier } from './registry.ts';
import {
  ASSET_CLASSES,
  BALANCE_STATES,
  ENTRY_SIDES,
  LedgerError,
  NORMAL_BALANCES,
  type AssetClass,
  type AssetType,
  type BalanceState,
  type EntrySide,
  type LedgerAccount,
  type LedgerEntry,
  type LedgerTransaction,
  type NormalBalance,
} from './types.ts';

/** Where the record came from. Only affects the wording of a refusal. */
export type RecordSource = 'request' | 'stored row';

const STORED_ROW_NOTE =
  'A stored row that fails this was not written by this component — refusing it rather than ' +
  'presenting it as a real record';

export function validateAssetType(candidate: unknown, source: RecordSource): AssetType {
  try {
    return checkAssetType(candidate);
  } catch (error) {
    if (source === 'request' || !(error instanceof LedgerError)) throw error;
    throw new LedgerError(error.code, `${error.message}. ${STORED_ROW_NOTE}`);
  }
}

const ASSET_TYPE_FIELDS: readonly string[] = [
  'assetTypeId',
  'assetClass',
  'symbol',
  'precision',
  'transferability',
  'withdrawability',
  'valuationSource',
  'issuer',
  'unit',
  'redeemable',
  'convertible',
  'expiryDays',
  'restrictions',
  'custodyProvider',
  'jurisdiction',
];

function checkAssetType(candidate: unknown): AssetType {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new LedgerError(
      'malformed-record',
      `an asset type must be an object, got ${candidate === null ? 'null' : typeof candidate}`,
    );
  }

  for (const key of Object.keys(candidate)) {
    if (!ASSET_TYPE_FIELDS.includes(key)) {
      throw new LedgerError(
        'malformed-record',
        `an asset type carried the unrecognised field "${key}"; the permitted fields are ` +
          ASSET_TYPE_FIELDS.join(', '),
      );
    }
  }

  const fields = candidate as Record<string, unknown>;
  const assetTypeId = assertAssetTypeId(fields.assetTypeId, 'assetTypeId');
  const assetClass = assertAssetClass(fields.assetClass, 'assetClass');
  const symbol = assertAssetSymbol(fields.symbol, 'symbol');
  const precision = assertPrecision(fields.precision, 'precision');
  const transferability = assertBoolean(fields.transferability, 'transferability');
  const withdrawability = assertBoolean(fields.withdrawability, 'withdrawability');
  const valuationSource = assertValuationSource(fields.valuationSource, 'valuationSource');
  const issuer = assertIssuer(fields.issuer, 'issuer');
  const unit = assertUnit(fields.unit, 'unit');
  const redeemable = assertBoolean(fields.redeemable, 'redeemable');
  const convertible = assertBoolean(fields.convertible, 'convertible');
  const expiryDays = assertExpiryDays(fields.expiryDays, 'expiryDays');
  const restrictions = assertRestrictions(fields.restrictions, 'restrictions');
  const custodyProvider = assertCustodyProvider(fields.custodyProvider, 'custodyProvider');
  const jurisdiction = assertJurisdiction(fields.jurisdiction, 'jurisdiction');

  return {
    assetTypeId,
    assetClass,
    symbol,
    precision,
    transferability,
    withdrawability,
    valuationSource,
    issuer,
    unit,
    redeemable,
    convertible,
    expiryDays,
    restrictions,
    custodyProvider,
    jurisdiction,
  };
}

/**
 * The issuer must be an opaque handle for the same reason every other identifier must: it is copied
 * into every account, entry and event that touches the asset type.
 */
function assertIssuer(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new LedgerError(
      'malformed-issuer',
      `${field} is ${value === null ? 'null' : typeof value}; expected the opaque identifier of ` +
        'the party that issued this value. Who a holder has a claim against is not optional',
    );
  }
  return assertOpaqueIdentifier(value, field);
}

/** The minor unit's name: lower_snake_case, e.g. `cent`, `satoshi`, `point`. */
const UNIT = /^[a-z][a-z0-9_]*$/;

function assertUnit(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UNIT.test(value)) {
    throw new LedgerError(
      'malformed-unit',
      `${field} is ${JSON.stringify(value)}; expected a lower_snake_case unit name such as ` +
        '"cent", "satoshi" or "point"',
    );
  }
  return value;
}

function assertExpiryDays(value: unknown, field: string): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new LedgerError(
      'invalid-expiry',
      `${field} is ${JSON.stringify(value)}; expected a positive whole number of days, or null ` +
        'when the value never expires',
    );
  }
  return value;
}

function assertRestrictions(value: unknown, field: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new LedgerError(
      'malformed-record',
      `${field} is ${value === null ? 'null' : typeof value}; expected a JSON object. Use {} for ` +
        'unrestricted value rather than omitting the field, so "unrestricted" is a decision on ' +
        'the record rather than an absence',
    );
  }
  return value as Record<string, unknown>;
}

function assertCustodyProvider(value: unknown, field: string): string | null {
  if (value === null) return null;
  return assertOpaqueIdentifier(value, field);
}

/** ISO 3166-1 alpha-2, or the reserved word GLOBAL. */
const JURISDICTION = /^([A-Z]{2}|GLOBAL)$/;

function assertJurisdiction(value: unknown, field: string): string {
  if (typeof value !== 'string' || !JURISDICTION.test(value)) {
    throw new LedgerError(
      'malformed-jurisdiction',
      `${field} is ${JSON.stringify(value)}; expected an ISO 3166-1 alpha-2 country code such as ` +
        '"LK", or "GLOBAL" when the value is not bound to one jurisdiction',
    );
  }
  return value;
}

function assertAssetClass(value: unknown, field: string): AssetClass {
  if (typeof value !== 'string' || !(ASSET_CLASSES as readonly string[]).includes(value)) {
    throw new LedgerError(
      'unsupported-asset-class',
      `${field} is "${String(value)}"; expected one of ${ASSET_CLASSES.join(', ')}`,
    );
  }
  return value as AssetClass;
}

/**
 * How many decimal places the asset divides into.
 *
 * **Zero is legitimate and means indivisible.** A loyalty stamp, a ticket, a seat and a reward
 * point that comes only in whole units are all real value types, and a ledger that cannot express
 * one is not a universal ledger. Refusing zero here would have forced every such scheme to invent a
 * fictional minor unit and then remember never to use it.
 *
 * The ceiling is eighteen, the largest decimal exponent in common use; beyond that is a mistake
 * rather than an exotic asset.
 */
function assertPrecision(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 18) {
    throw new LedgerError(
      'invalid-precision',
      `${field} is ${JSON.stringify(value)}; expected a whole number of decimal places from 0 ` +
        '(indivisible) to 18',
    );
  }
  return value;
}

function assertBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new LedgerError('malformed-record', `${field} is ${typeof value}; expected a boolean`);
  }
  return value;
}

function assertValuationSource(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new LedgerError(
      'malformed-record',
      `${field} is ${value === null ? 'null' : typeof value}; expected non-empty text`,
    );
  }
  return value.trim();
}

export function validateAccount(candidate: unknown, source: RecordSource): LedgerAccount {
  try {
    return checkAccount(candidate);
  } catch (error) {
    if (source === 'request' || !(error instanceof LedgerError)) throw error;
    throw new LedgerError(error.code, `${error.message}. ${STORED_ROW_NOTE}`);
  }
}

const ACCOUNT_FIELDS: readonly string[] = [
  'accountId',
  'assetTypeId',
  'ownerId',
  'normalBalance',
  'createdAt',
  'idempotencyKey',
];

function checkAccount(candidate: unknown): LedgerAccount {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new LedgerError(
      'malformed-record',
      `a ledger account must be an object, got ${candidate === null ? 'null' : typeof candidate}`,
    );
  }

  for (const key of Object.keys(candidate)) {
    if (!ACCOUNT_FIELDS.includes(key)) {
      throw new LedgerError(
        'malformed-record',
        `a ledger account carried the unrecognised field "${key}"; the permitted fields are ` +
          ACCOUNT_FIELDS.join(', '),
      );
    }
  }

  const fields = candidate as Record<string, unknown>;
  return {
    accountId: assertOpaqueIdentifier(fields.accountId, 'accountId'),
    assetTypeId: assertAssetTypeId(fields.assetTypeId, 'assetTypeId'),
    ownerId: assertOpaqueIdentifier(fields.ownerId, 'ownerId'),
    normalBalance: assertNormalBalance(fields.normalBalance, 'normalBalance'),
    createdAt: checkInstant(fields.createdAt, 'createdAt'),
    idempotencyKey: assertOpaqueIdentifier(fields.idempotencyKey, 'idempotencyKey'),
  };
}

function assertNormalBalance(value: unknown, field: string): NormalBalance {
  if (typeof value !== 'string' || !(NORMAL_BALANCES as readonly string[]).includes(value)) {
    throw new LedgerError(
      'malformed-record',
      `${field} is "${String(value)}"; expected one of ${NORMAL_BALANCES.join(', ')}`,
    );
  }
  return value as NormalBalance;
}

export function validateTransaction(candidate: unknown, source: RecordSource): LedgerTransaction {
  try {
    return checkTransaction(candidate);
  } catch (error) {
    if (source === 'request' || !(error instanceof LedgerError)) throw error;
    throw new LedgerError(error.code, `${error.message}. ${STORED_ROW_NOTE}`);
  }
}

const TRANSACTION_FIELDS: readonly string[] = [
  'transactionId',
  'idempotencyKey',
  'postedAt',
  'assetTypeId',
  'entries',
];

function checkTransaction(candidate: unknown): LedgerTransaction {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new LedgerError(
      'malformed-record',
      `a ledger transaction must be an object, got ${candidate === null ? 'null' : typeof candidate}`,
    );
  }

  for (const key of Object.keys(candidate)) {
    if (!TRANSACTION_FIELDS.includes(key)) {
      throw new LedgerError(
        'malformed-record',
        `a ledger transaction carried the unrecognised field "${key}"; the permitted fields are ` +
          TRANSACTION_FIELDS.join(', '),
      );
    }
  }

  const fields = candidate as Record<string, unknown>;
  const transactionId = assertOpaqueIdentifier(fields.transactionId, 'transactionId');
  const idempotencyKey = assertOpaqueIdentifier(fields.idempotencyKey, 'idempotencyKey');
  const postedAt = checkInstant(fields.postedAt, 'postedAt');
  const assetTypeId = assertAssetTypeId(fields.assetTypeId, 'assetTypeId');
  const entries = checkEntries(fields.entries, 'entries');

  if (entries.length === 0) {
    throw new LedgerError('unbalanced-transaction', 'a transaction must have at least one entry');
  }

  let debits = 0n;
  let credits = 0n;
  for (const entry of entries) {
    if (entry.side === 'debit') {
      debits += entry.amount;
    } else {
      credits += entry.amount;
    }
  }

  if (debits !== credits) {
    throw new LedgerError(
      'unbalanced-transaction',
      `debits (${debits}) do not equal credits (${credits})`,
    );
  }

  // One line per position, not one line per account.
  //
  // Before balance states existed this was one line per account, which was the same rule: an account
  // had one position, so naming it twice meant debiting and crediting the same balance in one
  // movement — a pair that nets to nothing and hides what was meant.
  //
  // A position transfer is the case that breaks the older reading. Locking value debits an account's
  // available position and credits its locked position, so the account legitimately appears twice.
  // Keying on the pair keeps the original protection exactly where it applied and stops nowhere else.
  const positions = new Set<string>();
  for (const entry of entries) {
    const position = `${entry.accountId} ${entry.balanceState}`;
    if (positions.has(position)) {
      throw new LedgerError(
        'unbalanced-transaction',
        `account ${entry.accountId} appears more than once in the transaction against its ` +
          `${entry.balanceState} position. A transaction may move each position once; debiting ` +
          'and crediting one position in one movement nets to nothing and hides what was meant',
      );
    }
    positions.add(position);
  }

  return { transactionId, idempotencyKey, postedAt, assetTypeId, entries };
}

function checkEntries(value: unknown, field: string): LedgerEntry[] {
  if (!Array.isArray(value)) {
    throw new LedgerError('malformed-record', `${field} is ${typeof value}; expected an array`);
  }
  return value.map((entry, index) => checkEntry(entry, `${field}[${index}]`));
}

const ENTRY_FIELDS: readonly string[] = ['accountId', 'side', 'balanceState', 'amount'];

function checkEntry(candidate: unknown, field: string): LedgerEntry {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new LedgerError(
      'malformed-record',
      `${field} must be an object, got ${candidate === null ? 'null' : typeof candidate}`,
    );
  }

  for (const key of Object.keys(candidate)) {
    if (!ENTRY_FIELDS.includes(key)) {
      throw new LedgerError(
        'malformed-record',
        `${field} carried the unrecognised field "${key}"; the permitted fields are ` +
          ENTRY_FIELDS.join(', '),
      );
    }
  }

  const fields = candidate as Record<string, unknown>;
  const accountId = assertOpaqueIdentifier(fields.accountId, `${field}.accountId`);
  const side = assertSide(fields.side, `${field}.side`);
  const balanceState = assertBalanceState(fields.balanceState, `${field}.balanceState`);
  const amount = assertAmount(fields.amount, `${field}.amount`);

  return { accountId, side, balanceState, amount };
}

/**
 * Which position the line moves.
 *
 * Absent means `available`. An entry that does not say otherwise is moving spendable value, which is
 * both the common case and the only reading that does not silently invent a reservation.
 */
function assertBalanceState(value: unknown, field: string): BalanceState {
  if (value === undefined) return 'available';
  if (typeof value !== 'string' || !(BALANCE_STATES as readonly string[]).includes(value)) {
    throw new LedgerError(
      'invalid-balance-state',
      `${field} is ${JSON.stringify(value)}; expected one of ${BALANCE_STATES.join(', ')}`,
    );
  }
  return value as BalanceState;
}

function assertSide(value: unknown, field: string): EntrySide {
  if (typeof value !== 'string' || !(ENTRY_SIDES as readonly string[]).includes(value)) {
    throw new LedgerError(
      'invalid-side',
      `${field} is "${String(value)}"; expected debit or credit`,
    );
  }
  return value as EntrySide;
}

export function assertAmount(value: unknown, field: string): bigint {
  if (typeof value === 'bigint') {
    if (value < 0n) {
      throw new LedgerError('negative-amount', `${field} is negative`);
    }
    return value;
  }

  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new LedgerError(
        'negative-amount',
        `${field} is ${JSON.stringify(value)}; expected a non-negative integer`,
      );
    }
    return BigInt(value);
  }

  if (typeof value === 'string') {
    if (!/^\d+$/.test(value)) {
      throw new LedgerError(
        'negative-amount',
        `${field} "${value}" is not a non-negative integer string`,
      );
    }
    return BigInt(value);
  }

  throw new LedgerError(
    'negative-amount',
    `${field} is ${value === null ? 'null' : typeof value}; expected a non-negative integer`,
  );
}

function checkInstant(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new LedgerError(
      'malformed-instant',
      `${field} is ${value === null ? 'null' : typeof value}; expected a UTC instant string`,
    );
  }
  try {
    return parseInstant(value).source;
  } catch (error) {
    if (error instanceof InvalidInstantError) {
      throw new LedgerError('malformed-instant', `${field}: ${error.message}`);
    }
    throw error;
  }
}
