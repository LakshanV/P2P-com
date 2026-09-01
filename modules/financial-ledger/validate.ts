/**
 * M-13 Financial Ledger — validation of complete records, wherever they came from.
 *
 * One function per record type, called by the service on the way in and by the PostgreSQL decoder
 * on the way out. There is no second list of rules to keep in step.
 *
 * Money is validated in three accepted forms — a `bigint`, a non-negative **safe** integer, or a
 * digits-only string — the same three K-10 accepts, and for the same reasons: the string form is
 * what PostgreSQL returns for a `bigint`, and the safe-integer check is what stops a value that has
 * already lost precision from being stored as though it had not.
 *
 * Owned by: M-13 Financial Ledger.
 */

import { formatInstant, InvalidInstantError, parseInstant } from '../../platform/time/instant.ts';

import {
  assertAssetTypeId,
  assertLedgerIdentifier,
  assertLegKind,
  assertLegStatus,
  assertObligationKind,
  assertPlanStatus,
  assertWalletPurpose,
  assertWalletStatus,
} from './registry.ts';
import {
  FinancialLedgerError,
  type ValueLeg,
  type ValuePlan,
  type ValueRate,
  type Wallet,
  type WalletStateRecord,
} from './types.ts';

/** Where the record came from. Only affects the wording of a refusal. */
export type RecordSource = 'request' | 'stored row';

export const STORED_ROW_NOTE =
  'A stored row that fails this was not written by this component — refusing it rather than ' +
  'presenting it as a real record';

// ---------------------------------------------------------------------------
// Wallet
// ---------------------------------------------------------------------------

const WALLET_FIELDS: readonly string[] = [
  'walletId',
  'ownerAccountId',
  'assetTypeId',
  'purpose',
  'ledgerAccountId',
  'status',
  'createdAt',
  'updatedAt',
  'correlationId',
  'idempotencyKey',
];

export function validateWallet(candidate: unknown, source: RecordSource): Wallet {
  try {
    const fields = asObject(candidate, 'a wallet', WALLET_FIELDS);
    return {
      walletId: assertLedgerIdentifier(fields.walletId, 'walletId'),
      ownerAccountId: assertLedgerIdentifier(fields.ownerAccountId, 'ownerAccountId'),
      assetTypeId: assertAssetTypeId(fields.assetTypeId, 'assetTypeId'),
      purpose: assertWalletPurpose(fields.purpose, 'purpose'),
      ledgerAccountId: assertLedgerIdentifier(fields.ledgerAccountId, 'ledgerAccountId'),
      status: assertWalletStatus(fields.status, 'status'),
      createdAt: checkInstant(fields.createdAt, 'createdAt', source),
      updatedAt: checkInstant(fields.updatedAt, 'updatedAt', source),
      correlationId: assertLedgerIdentifier(fields.correlationId, 'correlationId'),
      idempotencyKey: assertLedgerIdentifier(fields.idempotencyKey, 'idempotencyKey'),
    };
  } catch (error) {
    throw restate(error, source);
  }
}

const WALLET_STATE_FIELDS: readonly string[] = [
  'stateId',
  'walletId',
  'fromStatus',
  'toStatus',
  'reason',
  'occurredAt',
  'correlationId',
  'idempotencyKey',
];

export function validateWalletState(candidate: unknown, source: RecordSource): WalletStateRecord {
  try {
    const fields = asObject(candidate, 'a wallet state record', WALLET_STATE_FIELDS);
    const fromStatus =
      fields.fromStatus === null || fields.fromStatus === undefined
        ? null
        : assertWalletStatus(fields.fromStatus, 'fromStatus');
    const toStatus = assertWalletStatus(fields.toStatus, 'toStatus');

    // A transition that does not change the status is not a transition. The database says the same.
    if (fromStatus !== null && fromStatus === toStatus) {
      throw new FinancialLedgerError(
        'malformed-record',
        `a wallet state record moves from ${fromStatus} to ${toStatus}, which is not a move`,
      );
    }

    return {
      stateId: assertLedgerIdentifier(fields.stateId, 'stateId'),
      walletId: assertLedgerIdentifier(fields.walletId, 'walletId'),
      fromStatus,
      toStatus,
      reason: assertBoundedText(fields.reason, 'reason', 1, 500, 'malformed-reason'),
      occurredAt: checkInstant(fields.occurredAt, 'occurredAt', source),
      correlationId: assertLedgerIdentifier(fields.correlationId, 'correlationId'),
      idempotencyKey: assertLedgerIdentifier(fields.idempotencyKey, 'idempotencyKey'),
    };
  } catch (error) {
    throw restate(error, source);
  }
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

const PLAN_FIELDS: readonly string[] = [
  'planId',
  'obligationId',
  'obligationKind',
  'payerAccountId',
  'payeeAccountId',
  'status',
  'settlementAssetTypeId',
  'targetAmountMinor',
  'committedAt',
  'settledAt',
  'cancelledAt',
  'cancellationReason',
  'createdAt',
  'updatedAt',
  'correlationId',
  'idempotencyKey',
];

export function validateValuePlan(candidate: unknown, source: RecordSource): ValuePlan {
  try {
    const fields = asObject(candidate, 'a value plan', PLAN_FIELDS);
    const targetAmountMinor = assertNonNegativeBigint(
      fields.targetAmountMinor,
      'targetAmountMinor',
    );
    if (targetAmountMinor === 0n) {
      throw new FinancialLedgerError(
        'invalid-amount',
        'an obligation of zero needs no plan; refusing it here stops an empty plan being committed ' +
          'and reported as paid',
      );
    }

    const status = assertPlanStatus(fields.status, 'status');
    const cancellationReason =
      fields.cancellationReason === null || fields.cancellationReason === undefined
        ? null
        : assertBoundedText(
            fields.cancellationReason,
            'cancellationReason',
            1,
            500,
            'malformed-reason',
          );

    // The status and its reason must agree, exactly as the database CHECK requires.
    if ((status === 'cancelled') !== (cancellationReason !== null)) {
      throw new FinancialLedgerError(
        'malformed-record',
        `a plan with status ${status} carries ${cancellationReason === null ? 'no' : 'a'} ` +
          'cancellation reason. A cancellation nobody can attribute is a support ticket',
      );
    }

    return {
      planId: assertLedgerIdentifier(fields.planId, 'planId'),
      obligationId: assertLedgerIdentifier(fields.obligationId, 'obligationId'),
      obligationKind: assertObligationKind(fields.obligationKind, 'obligationKind'),
      payerAccountId: assertLedgerIdentifier(fields.payerAccountId, 'payerAccountId'),
      payeeAccountId: assertLedgerIdentifier(fields.payeeAccountId, 'payeeAccountId'),
      status,
      settlementAssetTypeId: assertAssetTypeId(
        fields.settlementAssetTypeId,
        'settlementAssetTypeId',
      ),
      targetAmountMinor,
      committedAt: assertOptionalInstant(fields.committedAt, 'committedAt', source),
      settledAt: assertOptionalInstant(fields.settledAt, 'settledAt', source),
      cancelledAt: assertOptionalInstant(fields.cancelledAt, 'cancelledAt', source),
      cancellationReason,
      createdAt: checkInstant(fields.createdAt, 'createdAt', source),
      updatedAt: checkInstant(fields.updatedAt, 'updatedAt', source),
      correlationId: assertLedgerIdentifier(fields.correlationId, 'correlationId'),
      idempotencyKey: assertLedgerIdentifier(fields.idempotencyKey, 'idempotencyKey'),
    };
  } catch (error) {
    throw restate(error, source);
  }
}

// ---------------------------------------------------------------------------
// Leg
// ---------------------------------------------------------------------------

const LEG_FIELDS: readonly string[] = [
  'legId',
  'planId',
  'kind',
  'status',
  'assetTypeId',
  'sourceWalletId',
  'destinationWalletId',
  'amountMinor',
  'rate',
  'settlementEquivalentMinor',
  'ledgerTransactionId',
  'reversalTransactionId',
  'externalReference',
  'createdAt',
  'updatedAt',
  'correlationId',
  'idempotencyKey',
];

export function validateValueLeg(candidate: unknown, source: RecordSource): ValueLeg {
  try {
    const fields = asObject(candidate, 'a value leg', LEG_FIELDS);

    const kind = assertLegKind(fields.kind, 'kind');
    const amountMinor = assertNonNegativeBigint(fields.amountMinor, 'amountMinor');
    if (amountMinor === 0n) {
      throw new FinancialLedgerError('invalid-amount', 'a leg that moves nothing is not a leg');
    }
    const settlementEquivalentMinor = assertNonNegativeBigint(
      fields.settlementEquivalentMinor,
      'settlementEquivalentMinor',
    );
    const rate = assertRate(fields.rate, 'rate');

    // The rate check, by cross-multiplication rather than division. An allocation that would need
    // rounding is refused rather than absorbing the remainder somewhere nobody looks — a fraction of
    // a cent per leg is a fraction of a cent that eventually turns up in an audit.
    if (amountMinor * rate.numerator !== settlementEquivalentMinor * rate.denominator) {
      throw new FinancialLedgerError(
        'rate-mismatch',
        `${String(amountMinor)} at ${String(rate.numerator)}/${String(rate.denominator)} is not ` +
          `${String(settlementEquivalentMinor)} of the settlement asset. The two are checked by ` +
          'cross-multiplication, so a rate that does not divide evenly is refused rather than rounded',
      );
    }

    const sourceWalletId =
      fields.sourceWalletId === null || fields.sourceWalletId === undefined
        ? null
        : assertLedgerIdentifier(fields.sourceWalletId, 'sourceWalletId');
    const destinationWalletId = assertLedgerIdentifier(
      fields.destinationWalletId,
      'destinationWalletId',
    );

    // An external leg has no source wallet: the value comes from outside the platform. An internal
    // one must have a source, or it is issuance pretending to be a transfer.
    if (kind === 'external' && sourceWalletId !== null) {
      throw new FinancialLedgerError(
        'malformed-record',
        'an external leg names a source wallet, but external value comes from outside the platform',
      );
    }
    if (kind === 'internal' && sourceWalletId === null) {
      throw new FinancialLedgerError(
        'malformed-record',
        'an internal leg names no source wallet. Value that comes from nowhere is issuance, and ' +
          'issuance is a movement out of the platform’s own issuance wallet, not an absent source',
      );
    }
    if (sourceWalletId !== null && sourceWalletId === destinationWalletId) {
      throw new FinancialLedgerError(
        'leg-self-transfer',
        `a leg moves value from wallet ${sourceWalletId} to itself, which moves nothing`,
      );
    }

    return {
      legId: assertLedgerIdentifier(fields.legId, 'legId'),
      planId: assertLedgerIdentifier(fields.planId, 'planId'),
      kind,
      status: assertLegStatus(fields.status, 'status'),
      assetTypeId: assertAssetTypeId(fields.assetTypeId, 'assetTypeId'),
      sourceWalletId,
      destinationWalletId,
      amountMinor,
      rate,
      settlementEquivalentMinor,
      ledgerTransactionId:
        fields.ledgerTransactionId === null || fields.ledgerTransactionId === undefined
          ? null
          : assertLedgerIdentifier(fields.ledgerTransactionId, 'ledgerTransactionId'),
      reversalTransactionId:
        fields.reversalTransactionId === null || fields.reversalTransactionId === undefined
          ? null
          : assertLedgerIdentifier(fields.reversalTransactionId, 'reversalTransactionId'),
      externalReference:
        fields.externalReference === null || fields.externalReference === undefined
          ? null
          : assertLedgerIdentifier(fields.externalReference, 'externalReference'),
      createdAt: checkInstant(fields.createdAt, 'createdAt', source),
      updatedAt: checkInstant(fields.updatedAt, 'updatedAt', source),
      correlationId: assertLedgerIdentifier(fields.correlationId, 'correlationId'),
      idempotencyKey: assertLedgerIdentifier(fields.idempotencyKey, 'idempotencyKey'),
    };
  } catch (error) {
    throw restate(error, source);
  }
}

// ---------------------------------------------------------------------------
// Shared assertions
// ---------------------------------------------------------------------------

function restate(error: unknown, source: RecordSource): unknown {
  if (source === 'request' || !(error instanceof FinancialLedgerError)) return error;
  return new FinancialLedgerError(error.code, `${error.message}. ${STORED_ROW_NOTE}`);
}

function asObject(
  candidate: unknown,
  what: string,
  permitted: readonly string[],
): Record<string, unknown> {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new FinancialLedgerError(
      'malformed-record',
      `${what} must be an object, got ${candidate === null ? 'null' : typeof candidate}`,
    );
  }
  for (const key of Object.keys(candidate)) {
    if (!permitted.includes(key)) {
      throw new FinancialLedgerError(
        'malformed-record',
        `${what} carried the unrecognised field "${key}"; the permitted fields are ` +
          permitted.join(', '),
      );
    }
  }
  return candidate as Record<string, unknown>;
}

/** A rate: two positive integers, and never a decimal. */
export function assertRate(value: unknown, field: string): ValueRate {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new FinancialLedgerError(
      'malformed-rate',
      `${field} must be an object with a numerator and a denominator, got ` +
        `${value === null ? 'null' : typeof value}`,
    );
  }
  const candidate = value as Record<string, unknown>;
  for (const key of Object.keys(candidate)) {
    if (key !== 'numerator' && key !== 'denominator') {
      throw new FinancialLedgerError(
        'malformed-rate',
        `${field} carried the unrecognised field "${key}"; a rate is a numerator and a denominator`,
      );
    }
  }

  const numerator = assertNonNegativeBigint(candidate.numerator, `${field}.numerator`);
  const denominator = assertNonNegativeBigint(candidate.denominator, `${field}.denominator`);
  if (numerator === 0n || denominator === 0n) {
    throw new FinancialLedgerError(
      'malformed-rate',
      `${field} is ${String(numerator)}/${String(denominator)}; both terms must be positive. A ` +
        'zero numerator makes value worthless and a zero denominator makes it undefined',
    );
  }
  return Object.freeze({ numerator, denominator });
}

function assertBoundedText(
  value: unknown,
  field: string,
  min: number,
  max: number,
  code: 'malformed-reason' | 'malformed-record',
): string {
  if (typeof value !== 'string') {
    throw new FinancialLedgerError(
      code,
      `${field} is ${value === null ? 'null' : typeof value}; expected text`,
    );
  }
  // Trimmed, so whitespace cannot pass for content — the database says `length(btrim(...)) > 0`
  // and a validator that disagreed would let TypeScript accept what PostgreSQL refuses.
  if (value.trim().length < min || value.length > max) {
    throw new FinancialLedgerError(
      code,
      `${field} is ${String(value.length)} characters; expected ${String(min)}-${String(max)}, not blank`,
    );
  }
  return value;
}

/** Money, in the three forms K-10 accepts. */
function assertNonNegativeBigint(value: unknown, field: string): bigint {
  if (typeof value === 'bigint') {
    if (value < 0n) {
      throw new FinancialLedgerError(
        'invalid-amount',
        `${field} is ${String(value)}; expected >= 0`,
      );
    }
    return value;
  }
  if (typeof value === 'string') {
    if (!/^\d+$/.test(value)) {
      throw new FinancialLedgerError(
        'invalid-amount',
        `${field} "${value}" is not a non-negative integer string`,
      );
    }
    return BigInt(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new FinancialLedgerError(
        'invalid-amount',
        `${field} is ${String(value)}; expected a non-negative safe integer`,
      );
    }
    return BigInt(value);
  }
  throw new FinancialLedgerError(
    'invalid-amount',
    `${field} is ${value === null ? 'null' : typeof value}; expected an integer minor-unit amount`,
  );
}

/** The exact form `to_char(...)` emits for a timestamptz. */
const STORED_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/;

function checkInstant(value: unknown, field: string, source: RecordSource): string {
  if (source === 'stored row') {
    if (typeof value !== 'string') {
      throw new FinancialLedgerError(
        'malformed-record',
        `${field} came back as ${value instanceof Date ? 'a Date' : typeof value} rather than ` +
          'text. Timestamps are projected through to_char precisely so the driver never parses them',
      );
    }
    if (STORED_INSTANT.exec(value) === null) {
      throw new FinancialLedgerError(
        'malformed-record',
        `${field} holds "${value}", which is not a finite UTC timestamp in the projected form ` +
          'YYYY-MM-DDTHH:MM:SS.ffffffZ',
      );
    }
    try {
      return formatInstant(parseInstant(value).epochMicros);
    } catch (error) {
      if (error instanceof InvalidInstantError) {
        throw new FinancialLedgerError('malformed-record', `${field}: ${error.message}`);
      }
      throw error;
    }
  }

  if (typeof value !== 'string') {
    throw new FinancialLedgerError(
      'malformed-instant',
      `${field} is ${value === null ? 'null' : typeof value}; expected a UTC instant string`,
    );
  }
  try {
    return parseInstant(value).source;
  } catch (error) {
    if (error instanceof InvalidInstantError) {
      throw new FinancialLedgerError('malformed-instant', `${field}: ${error.message}`);
    }
    throw error;
  }
}

function assertOptionalInstant(value: unknown, field: string, source: RecordSource): string | null {
  if (value === null || value === undefined) return null;
  return checkInstant(value, field, source);
}
