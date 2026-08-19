/**
 * K-05 Configuration — canonical instants (FND-003a, hardened).
 *
 * Effective time decides which version answers a question, so how instants are *compared* is a
 * correctness concern rather than a formatting one. Comparing the ISO strings directly, which the
 * previous revision did, is wrong in two ways that both matter:
 *
 *   - **Equivalent instants compare unequal.** `2026-01-01T00:00:00Z` and
 *     `2026-01-01T00:00:00.000Z` are the same moment, but `.` sorts before `Z`, so the fractional
 *     form compares *earlier* than the whole-second one. A replacement offered at the same instant
 *     as the incumbent, written with a fraction, slipped past the "must be strictly after" check —
 *     which is precisely the ambiguity that check exists to prevent.
 *   - **Impossible dates parse.** A pattern match accepts `2026-02-30T00:00:00Z` and
 *     `2026-01-01T24:00:00Z`. Stored, they are unorderable nonsense that no later validation
 *     recovers from.
 *
 * So an instant is validated against the real calendar and reduced to a number of microseconds
 * since the epoch, and every comparison in this component goes through that number. Microseconds
 * because the accepted syntax allows six fractional digits; `bigint` because the arithmetic must
 * be exact rather than approximately exact.
 *
 * The caller's spelling is preserved on the stored record — a version records the instant as it
 * was expressed — while ordering uses the canonical value. Two spellings of one moment are one
 * moment everywhere it matters.
 *
 * Owned by: K-05 Configuration.
 */

import { ConfigurationError } from './types.ts';

/** Syntax: ISO-8601 UTC with an optional fraction of up to six digits. */
const SYNTAX = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?Z$/;

export interface Instant {
  /** Exactly what the caller wrote. */
  readonly source: string;
  /** One spelling per moment: always six fractional digits. */
  readonly canonical: string;
  /** Microseconds since the Unix epoch. The only thing ever compared. */
  readonly epochMicros: bigint;
}

/**
 * Parse and validate, or refuse.
 *
 * Refuses anything the calendar does not contain, which a pattern match alone cannot do: the
 * components are rebuilt into a UTC date and required to survive the round trip, so 31 April and
 * 30 February are rejected rather than silently rolled forward into May and March.
 */
export function parseInstant(value: string, field: string): Instant {
  const match = SYNTAX.exec(value);
  if (match === null) {
    throw new ConfigurationError(
      'invalid-value',
      `${field} must be an ISO-8601 UTC instant such as 2026-01-01T00:00:00Z or ` +
        `2026-01-01T00:00:00.000000Z, got "${value}"`,
    );
  }

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fractionText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);

  // Checked before the round trip so the message can name what is wrong, rather than reporting
  // every failure as "not a real date".
  if (month < 1 || month > 12) {
    throw invalid(field, value, `month ${monthText} is not 01–12`);
  }
  if (day < 1 || day > 31) {
    throw invalid(field, value, `day ${dayText} is not 01–31`);
  }
  if (hour > 23) {
    throw invalid(field, value, `hour ${hourText} is not 00–23`);
  }
  if (minute > 59) {
    throw invalid(field, value, `minute ${minuteText} is not 00–59`);
  }
  if (second > 59) {
    // 60 would be a leap second. PostgreSQL accepts it and normalises; this component refuses it,
    // because an instant that changes when stored is not the instant the caller wrote.
    throw invalid(
      field,
      value,
      `second ${secondText} is not 00–59 (leap seconds are not accepted)`,
    );
  }

  const utcMillis = Date.UTC(year, month - 1, day, hour, minute, second);
  const rebuilt = new Date(utcMillis);
  const survivesRoundTrip =
    rebuilt.getUTCFullYear() === year &&
    rebuilt.getUTCMonth() === month - 1 &&
    rebuilt.getUTCDate() === day;
  if (!survivesRoundTrip) {
    throw invalid(
      field,
      value,
      `${yearText}-${monthText}-${dayText} is not a date in the calendar`,
    );
  }

  const micros = Number((fractionText ?? '').padEnd(6, '0'));
  const epochMicros = BigInt(utcMillis) * 1000n + BigInt(micros);

  return {
    source: value,
    canonical:
      `${yearText}-${monthText}-${dayText}T${hourText}:${minuteText}:${secondText}.` +
      `${(fractionText ?? '').padEnd(6, '0')}Z`,
    epochMicros,
  };
}

function invalid(field: string, value: string, reason: string): ConfigurationError {
  return new ConfigurationError(
    'invalid-value',
    `${field} "${value}" is not a real instant: ${reason}`,
  );
}

/** Validate without keeping the result, for the fields that are only checked. */
export function assertInstant(value: string, field: string): void {
  parseInstant(value, field);
}

/** Negative, zero or positive as `a` precedes, equals or follows `b`. Both must be valid. */
export function compareInstants(a: string, b: string, field = 'instant'): number {
  const left = parseInstant(a, field).epochMicros;
  const right = parseInstant(b, field).epochMicros;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** True when both spell the same moment, whatever their precision. */
export function instantsEqual(a: string, b: string): boolean {
  return compareInstants(a, b) === 0;
}

/** One spelling per moment, for comparing requests rather than for storage. */
export function canonicalInstant(value: string, field = 'instant'): string {
  return parseInstant(value, field).canonical;
}
