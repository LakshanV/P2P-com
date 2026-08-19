/**
 * Canonical UTC instants (FND-003b).
 *
 * Any component that orders events, schedules a retry or decides whether a lease has expired needs
 * two things from an instant: that it is a point in time the calendar actually contains, and that
 * comparing two of them agrees with the calendar rather than with ASCII. Neither is free.
 * `2026-01-01T00:00:00.000Z` and `2026-01-01T00:00:00Z` are the same moment but sort differently as
 * text, and `new Date('2026-02-30T00:00:00Z')` silently reports 2 March.
 *
 * So an instant is validated against the calendar and reduced to microseconds since the epoch, and
 * every comparison goes through that number. `bigint`, because the arithmetic must be exact.
 *
 * Deliberately error-agnostic: it throws `InvalidInstantError`, and a component that has its own
 * refusal vocabulary catches that and re-raises in its own terms. A shared utility that threw one
 * component's error type would make every other component's failures lie about their origin.
 *
 * **Known duplication.** K-05 Configuration carries its own copy of this logic
 * (`kernel/configuration/instant.ts`), delivered before this file existed and left alone here
 * because FND-003b is explicitly not permitted to change K-05's behaviour. Collapsing K-05 onto
 * this module is a bounded follow-up, recorded in CURRENT_IMPLEMENTATION_STATUS §11.14.
 *
 * Owned by: platform substrate. No business logic, no I/O, no clock — the caller supplies "now".
 */

/** Syntax: ISO-8601 UTC with an optional fraction of up to six digits. */
const SYNTAX = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?Z$/;

const MICROS_PER_SECOND = 1_000_000n;

export class InvalidInstantError extends Error {
  readonly value: string;

  constructor(value: string, reason: string) {
    super(`"${value}" is not a valid UTC instant: ${reason}`);
    this.name = 'InvalidInstantError';
    this.value = value;
  }
}

export interface Instant {
  /** Exactly what the caller wrote. */
  readonly source: string;
  /** One spelling per moment: always six fractional digits. */
  readonly canonical: string;
  /** Microseconds since the Unix epoch. The only thing ever compared. */
  readonly epochMicros: bigint;
}

/**
 * Parse and validate, or throw.
 *
 * The components are rebuilt into a UTC date and required to survive the round trip, which is what
 * a pattern match alone cannot do: 31 April and 30 February are refused rather than rolled forward
 * into May and March.
 */
export function parseInstant(value: string): Instant {
  const match = SYNTAX.exec(value);
  if (match === null) {
    throw new InvalidInstantError(
      value,
      'expected ISO-8601 UTC such as 2026-01-01T00:00:00Z or 2026-01-01T00:00:00.000000Z',
    );
  }

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fractionText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);

  if (month < 1 || month > 12)
    throw new InvalidInstantError(value, `month ${monthText} is not 01-12`);
  if (day < 1 || day > 31) throw new InvalidInstantError(value, `day ${dayText} is not 01-31`);
  if (hour > 23) throw new InvalidInstantError(value, `hour ${hourText} is not 00-23`);
  if (minute > 59) throw new InvalidInstantError(value, `minute ${minuteText} is not 00-59`);
  if (second > 59) {
    // 60 would be a leap second. PostgreSQL accepts and normalises it; an instant that changes
    // when stored is not the instant the caller wrote, so it is refused here.
    throw new InvalidInstantError(value, `second ${secondText} is not 00-59; no leap seconds`);
  }

  const utcMillis = Date.UTC(year, month - 1, day, hour, minute, second);
  const rebuilt = new Date(utcMillis);
  if (
    rebuilt.getUTCFullYear() !== year ||
    rebuilt.getUTCMonth() !== month - 1 ||
    rebuilt.getUTCDate() !== day
  ) {
    throw new InvalidInstantError(
      value,
      `${yearText}-${monthText}-${dayText} is not in the calendar`,
    );
  }

  const fraction = (fractionText ?? '').padEnd(6, '0');
  return {
    source: value,
    canonical: `${yearText}-${monthText}-${dayText}T${hourText}:${minuteText}:${secondText}.${fraction}Z`,
    epochMicros: BigInt(utcMillis) * 1000n + BigInt(Number(fraction)),
  };
}

/** Validate without keeping the result. */
export function assertInstant(value: string): void {
  parseInstant(value);
}

/** True when the text is a valid instant, for callers that want a boolean rather than a throw. */
export function isInstant(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    parseInstant(value);
    return true;
  } catch {
    return false;
  }
}

/** Negative, zero or positive as `a` precedes, equals or follows `b`. */
export function compareInstants(a: string, b: string): number {
  const left = parseInstant(a).epochMicros;
  const right = parseInstant(b).epochMicros;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** True when both spell the same moment, whatever their precision. */
export function instantsEqual(a: string, b: string): boolean {
  return compareInstants(a, b) === 0;
}

/** One spelling per moment: six fractional digits. */
export function canonicalInstant(value: string): string {
  return parseInstant(value).canonical;
}

/** The shortest spelling of a moment: trailing zeros trimmed, so equal moments read equal. */
export function formatInstant(epochMicros: bigint): string {
  const millis = Number(epochMicros / 1000n);
  const remainderMicros = Number(epochMicros % 1000n);
  const base = new Date(millis).toISOString(); // …THH:MM:SS.mmmZ
  const fraction = `${base.slice(20, 23)}${String(remainderMicros).padStart(3, '0')}`.replace(
    /0+$/,
    '',
  );
  return `${base.slice(0, 19)}${fraction === '' ? '' : `.${fraction}`}Z`;
}

/**
 * `instant` plus a whole number of seconds.
 *
 * Retry scheduling needs this and nothing more: a backoff is a count of seconds, and computing it
 * by string surgery or by round-tripping through a local-time `Date` is how time zones get into a
 * scheduler that has no business knowing about them.
 */
export function addSeconds(instant: string, seconds: number): string {
  if (!Number.isSafeInteger(seconds)) {
    throw new InvalidInstantError(
      instant,
      `cannot add ${seconds} seconds; expected a whole number`,
    );
  }
  return formatInstant(parseInstant(instant).epochMicros + BigInt(seconds) * MICROS_PER_SECOND);
}

/** Whole seconds from `from` to `to`, truncated. Negative when `to` precedes `from`. */
export function secondsBetween(from: string, to: string): number {
  const delta = parseInstant(to).epochMicros - parseInstant(from).epochMicros;
  return Number(delta / MICROS_PER_SECOND);
}
