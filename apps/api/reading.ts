/**
 * Reading a request body.
 *
 * Everything a client sends arrives as `unknown`, and every field has to be checked before it
 * reaches a module. These helpers do that checking in one place, so a handler reads as a list of
 * what it needs rather than a wall of type guards.
 *
 * **They refuse rather than coerce.** `"12"` is not `12`, `null` is not an empty string, and a
 * missing field is not `undefined` quietly passed along. Coercion at an API boundary is how a
 * client's typo becomes a record nobody can explain — and the modules below would refuse most of it
 * anyway, with a message written for a different audience.
 *
 * The one deliberate exception is money. A JSON number cannot hold an exact amount above 2^53, so
 * amounts arrive as **strings** and are parsed to `bigint` here. A client that sends a number gets
 * told to send a string, which is a better outcome than silently rounding somebody's balance.
 *
 * Owned by: apps/api.
 */

import { ApiError } from './errors.ts';

function fields(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(
      400,
      'malformed-body',
      `The request body must be a JSON object, and this one is ${
        body === null ? 'null' : Array.isArray(body) ? 'an array' : typeof body
      }.`,
    );
  }
  return body as Record<string, unknown>;
}

/** A required string. */
export function readString(body: unknown, name: string): string {
  const value = fields(body)[name];
  if (typeof value !== 'string' || value === '') {
    throw new ApiError(
      400,
      'missing-field',
      `"${name}" must be a non-empty string, and it was ${describe(value)}.`,
    );
  }
  return value;
}

/** An optional string, or null. */
export function readOptionalString(body: unknown, name: string): string | null {
  const value = fields(body)[name];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value === '') {
    throw new ApiError(
      400,
      'malformed-field',
      `"${name}" must be a non-empty string when present, and it was ${describe(value)}.`,
    );
  }
  return value;
}

/**
 * A money amount, as a decimal string.
 *
 * Strings, not numbers: a JSON number is a double, and a double cannot hold 9007199254740993 —
 * which is a perfectly ordinary number of satoshis. A client that sends a number is told to send a
 * string, because rounding somebody's balance without telling them is worse than a 400.
 */
export function readAmount(body: unknown, name: string): bigint {
  const value = fields(body)[name];
  if (typeof value === 'number') {
    throw new ApiError(
      400,
      'amount-must-be-a-string',
      `"${name}" must be a string of digits, not a JSON number. A JSON number is a double and ` +
        'cannot hold an exact amount above 2^53 minor units, so sending one would silently round it.',
    );
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new ApiError(
      400,
      'malformed-amount',
      `"${name}" must be a string of digits in minor units, and it was ${describe(value)}.`,
    );
  }
  return BigInt(value);
}

/** A required integer, within bounds. */
export function readInteger(body: unknown, name: string, min: number, max: number): number {
  const value = fields(body)[name];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new ApiError(
      400,
      'malformed-field',
      `"${name}" must be a whole number from ${String(min)} to ${String(max)}, and it was ` +
        `${describe(value)}.`,
    );
  }
  return value;
}

/** A required boolean. No coercion: `"true"` is a string, and a string is not a boolean. */
export function readBoolean(body: unknown, name: string): boolean {
  const value = fields(body)[name];
  if (typeof value !== 'boolean') {
    throw new ApiError(
      400,
      'malformed-field',
      `"${name}" must be true or false, and it was ${describe(value)}.`,
    );
  }
  return value;
}

/** A required array, mapped element by element. */
export function readArray<T>(
  body: unknown,
  name: string,
  read: (element: unknown, index: number) => T,
): readonly T[] {
  const value = fields(body)[name];
  if (!Array.isArray(value)) {
    throw new ApiError(
      400,
      'malformed-field',
      `"${name}" must be an array, and it was ${describe(value)}.`,
    );
  }
  return value.map((element, index) => read(element, index));
}

/** A required JSON object, passed through as-is. Used for a provider's own webhook payload. */
export function readObject(body: unknown, name: string): Record<string, unknown> {
  const value = fields(body)[name];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiError(
      400,
      'malformed-field',
      `"${name}" must be a JSON object, and it was ${describe(value)}.`,
    );
  }
  return value as Record<string, unknown>;
}

/** A required header, by lower-cased name. */
export function readHeader(headers: Readonly<Record<string, string>>, name: string): string {
  const value = headers[name];
  if (value === undefined || value === '') {
    throw new ApiError(400, 'missing-header', `The "${name}" header is required.`);
  }
  return value;
}

/** What the value actually was, for a message a client can act on. */
function describe(value: unknown): string {
  if (value === undefined) return 'absent';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'string') return `the string ${JSON.stringify(value)}`;
  if (typeof value === 'number' || typeof value === 'boolean')
    return `the ${typeof value} ${String(value)}`;
  return `a ${typeof value}`;
}
