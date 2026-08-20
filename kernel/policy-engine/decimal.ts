/**
 * K-06 Policy Engine — canonical decimals, with no floating point anywhere (FND-005b).
 *
 * v3 §38 requires deterministic services for order totals, payments, refunds, ledger, commissions,
 * rewards, settlements, reserves, guarantee exposure and payouts. Every one of those reads a
 * number out of a policy, so the number a policy returns has to be exact — and IEEE-754 doubles
 * are not. `0.1 + 0.2 !== 0.3` is the famous example; the one that matters here is quieter:
 *
 * ```js
 * 1234.56 * 0.175   // 216.048  — but the double is 216.04800000000003
 * ```
 *
 * A commission computed from that rounds correctly today, incorrectly on a different total, and
 * the difference is a penny that reconciliation cannot explain. So a policy never holds a
 * `number`. It holds an **integer of minor units and a scale**, carried as text end to end:
 *
 *   `{ units: "17500", scale: 4 }`  is  `1.7500`  is  17.5%
 *
 * Three properties follow, and each is tested:
 *
 *   - **Exact.** Parsing, comparing and rendering go through `BigInt`. Nothing is ever converted
 *     to `number`, so nothing is ever rounded on the way in or out.
 *   - **Canonical.** One value has one representation. `1.50` at scale 2 and `1.5000` at scale 4
 *     are the same quantity, and comparison says so, but a stored decimal keeps the scale it was
 *     written with — because "17.5%" and "17.5000%" say different things about how precisely
 *     somebody meant it, and a policy that silently trimmed trailing zeros would be editing an
 *     author's statement of precision.
 *   - **Bounded.** Scale is 0–9 and the significand is at most 30 digits. A policy value needing
 *     more than that is not a rate; it is somebody putting an identifier in a numeric field.
 *
 * There is no arithmetic here beyond comparison. K-06 *returns* rates and amounts; it does not
 * multiply an order total by one. That is K-10 Ledger foundation's job, and the boundary is the
 * point — a policy engine that did the arithmetic would be a second place money is computed.
 *
 * Owned by: K-06 Policy Engine.
 */

import { PolicyError } from './types.ts';

/** The widest scale a policy value may carry. Nine is a nanosecond, or a billionth of a unit. */
export const MAX_SCALE = 9;

/** The most significant digits a policy value may carry, sign excluded. */
export const MAX_DIGITS = 30;

/**
 * An exact decimal: an integer of minor units, and how many of its digits are fractional.
 *
 * `units` is text rather than a `bigint` so a decimal survives JSON, `jsonb` and a structured
 * clone unchanged. A `bigint` does none of those.
 */
export interface Decimal {
  /** The signed integer significand, in decimal digits. No separators, no exponent. */
  readonly units: string;
  /** Fractional digit count, 0–9. */
  readonly scale: number;
}

const SIGNIFICAND = /^-?(0|[1-9][0-9]*)$/;

/** Validate and freeze a decimal, or refuse it. */
export function assertDecimal(value: unknown, field: string): Decimal {
  if (value === null || typeof value !== 'object') {
    throw new PolicyError(
      'malformed-decimal',
      `${field} is ${value === null ? 'null' : typeof value}; expected { units, scale }`,
    );
  }
  const candidate = value as { units?: unknown; scale?: unknown };

  if (typeof candidate.units === 'number' || typeof candidate.scale === 'string') {
    throw new PolicyError(
      'malformed-decimal',
      `${field} carries units as a number or scale as text. The significand is text precisely so ` +
        'it never passes through a double, where 216.048 becomes 216.04800000000003 and a ' +
        'commission is a penny out for reasons nobody can reconstruct',
    );
  }
  if (typeof candidate.units !== 'string' || !SIGNIFICAND.test(candidate.units)) {
    throw new PolicyError(
      'malformed-decimal',
      `${field}.units is "${String(candidate.units)}"; expected a signed integer in digits, with ` +
        'no separators, no exponent and no leading zeros',
    );
  }
  if (
    typeof candidate.scale !== 'number' ||
    !Number.isInteger(candidate.scale) ||
    candidate.scale < 0 ||
    candidate.scale > MAX_SCALE
  ) {
    throw new PolicyError(
      'malformed-decimal',
      `${field}.scale is ${String(candidate.scale)}; expected a whole number of fractional ` +
        `digits, 0 to ${MAX_SCALE}`,
    );
  }

  const digits = candidate.units.replace('-', '').length;
  if (digits > MAX_DIGITS) {
    throw new PolicyError(
      'malformed-decimal',
      `${field} carries ${digits} significant digits; at most ${MAX_DIGITS}. A policy value that ` +
        'needs more than that is not a rate',
    );
  }

  return Object.freeze({ units: candidate.units, scale: candidate.scale });
}

/**
 * Refuse a `number` where a decimal belongs.
 *
 * Separate from `assertDecimal` because the message is different and the mistake is common: a
 * caller writing `{ rate: 0.175 }` is not malformed, it is *lossy*, and it will keep working right
 * up until the value is one a double cannot hold.
 */
export function refuseFloatingPoint(value: unknown, field: string): void {
  if (typeof value !== 'number') return;
  throw new PolicyError(
    'lossy-numeric-value',
    `${field} is the number ${String(value)}. Policy values are exact decimals — ` +
      `{ units: "${String(value).replace('.', '').replace('-', '')}", scale: n } — because a ` +
      'double cannot hold most rates exactly, and money computed from an inexact rate is money ' +
      'nobody can reconcile',
  );
}

/** The value as a `bigint` rescaled to a common scale, for comparison. */
function rescaled(value: Decimal, toScale: number): bigint {
  return BigInt(value.units) * 10n ** BigInt(toScale - value.scale);
}

/** −1, 0 or 1. Exact at any scale: `1.50` and `1.5000` compare equal. */
export function compareDecimals(a: Decimal, b: Decimal): number {
  const scale = Math.max(a.scale, b.scale);
  const left = rescaled(a, scale);
  const right = rescaled(b, scale);
  return left === right ? 0 : left < right ? -1 : 1;
}

export function decimalsEqual(a: Decimal, b: Decimal): boolean {
  return compareDecimals(a, b) === 0;
}

/** True when the value is exactly zero, at any scale. */
export function isZero(value: Decimal): boolean {
  return BigInt(value.units) === 0n;
}

export function isNegative(value: Decimal): boolean {
  return BigInt(value.units) < 0n;
}

/**
 * Render as text: `{ units: "17500", scale: 4 }` becomes `"1.7500"`.
 *
 * The scale is preserved rather than trimmed, so what an author wrote is what a reader sees. This
 * is the form written to the database and quoted in an explanation.
 */
export function decimalToText(value: Decimal): string {
  const negative = value.units.startsWith('-');
  const digits = negative ? value.units.slice(1) : value.units;
  if (value.scale === 0) return value.units;

  const padded = digits.padStart(value.scale + 1, '0');
  const whole = padded.slice(0, padded.length - value.scale);
  const fraction = padded.slice(padded.length - value.scale);
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

const TEXT_DECIMAL = /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?$/;

/**
 * Parse the text form back, exactly.
 *
 * Used by the PostgreSQL adapter, where `numeric` comes back as text — which is the whole reason
 * the column is `numeric` and the driver's `Date`-style coercion is never involved.
 */
export function decimalFromText(text: unknown, field: string): Decimal {
  if (typeof text !== 'string') {
    throw new PolicyError(
      'malformed-decimal',
      `${field} came back as ${typeof text} rather than text. A numeric column is read as text so ` +
        'the driver never converts it to a double',
    );
  }
  const match = TEXT_DECIMAL.exec(text);
  if (match === null) {
    throw new PolicyError(
      'malformed-decimal',
      `${field} holds "${text}", which is not an exact decimal. Scientific notation, Infinity and ` +
        'NaN are all refused: none of them is a policy value',
    );
  }
  const [, sign = '', whole = '0', fraction = ''] = match;
  const units = `${sign}${(whole + fraction).replace(/^0+(?=\d)/, '')}`;
  return assertDecimal({ units: units === '-' ? '0' : units, scale: fraction.length }, field);
}
