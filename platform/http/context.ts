/**
 * The request context: the one place where nondeterminism enters the platform.
 *
 * Every module in this repository refuses to read a clock or generate a random value. That is not
 * asceticism — it is what makes a replayed request produce a byte-identical record, and what lets
 * every suite assert exact instants and exact identifiers. But *somebody* has to decide what time it
 * is and what the new order's id will be, and that somebody is here, at the edge, once per request.
 *
 * So this file reads the clock and the random number generator, and nothing below it does. The
 * consequence worth stating: **an identifier minted here is the caller's from that moment on.** A
 * retry that reuses it converges on the same record; a retry that mints a new one creates a second.
 * Which is why the identifiers a client cares about are derived from the client's own
 * `Idempotency-Key` rather than freshly generated.
 *
 * **The opacity rule is injected, not imported.** `platform` sits below `kernel` in the dependency
 * graph, so this file may not reach K-01's identifier rules directly — the boundary check refuses it,
 * and correctly: a substrate that knew what an identity is would no longer be a substrate. The
 * application wires K-01's rule in as `validate`, which is what makes a generated id one every
 * module downstream will accept.
 *
 * Owned by: platform substrate.
 */

import { randomBytes } from 'node:crypto';

/**
 * Everything a request needs that is not in the request.
 *
 * Injected as a whole so a test supplies a context with a fixed clock and a counting id generator,
 * and the handlers under test become entirely deterministic.
 */
export interface RequestContext {
  /** The instant this request is being handled, as a UTC string. Read once, used everywhere. */
  readonly now: string;
  /** Ties every record and event this request produces to one causal chain. */
  readonly correlationId: string;
  /**
   * The caller's idempotency key, or a generated one.
   *
   * A client that supplies one gets convergence on retry; a client that does not gets a fresh key
   * and therefore a fresh record, which is the honest interpretation of "I did not tell you this
   * was the same request".
   */
  readonly idempotencyKey: string;
  /** Mint an opaque identifier with the given prefix. */
  newId(prefix: string): string;
  /**
   * Derive a stable identifier from the idempotency key.
   *
   * The point of the whole idempotency mechanism: the same key produces the same id, so a retried
   * request addresses the record the first attempt created rather than making a second one.
   */
  derivedId(prefix: string, discriminator: string): string;
}

/**
 * Crockford's base32, without `I`, `L`, `O` or `U`.
 *
 * Chosen because the alphabet is unambiguous when a human reads an id off a screen, which is what
 * an identifier in a support ticket actually gets used for.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encode(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) {
    out += ALPHABET[byte >> 3] ?? '0';
    out += ALPHABET[((byte & 0b111) << 2) % ALPHABET.length] ?? '0';
  }
  return out;
}

/**
 * A random opaque identifier.
 *
 * Generated and then **checked against the same rule the modules apply**, and regenerated if it
 * fails. That is not paranoia: the opacity rule refuses any run of twelve digits, because that is
 * what a card number or a national id looks like, and a base32 string of random bytes will produce
 * one eventually. Roughly one identifier in a hundred thousand — which at any real volume is a
 * refusal in production and a very confusing bug report.
 */
export function randomId(
  prefix: string,
  options: {
    readonly bytes?: () => Uint8Array;
    /** Throws when the candidate is not acceptable. The application supplies K-01's rule. */
    readonly validate?: (candidate: string) => void;
  } = {},
): string {
  const bytes = options.bytes ?? ((): Uint8Array => randomBytes(12));
  const validate = options.validate ?? ((): void => undefined);

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = `${prefix}_${encode(bytes())}`;
    try {
      validate(candidate);
      return candidate;
    } catch {
      // Try again. The loop is bounded so a broken prefix fails loudly rather than spinning.
    }
  }
  throw new Error(
    `could not mint an opaque identifier with prefix "${prefix}" in 8 attempts. The prefix itself ` +
      'is probably refused by the opacity rule — check it is not an email, a URL or a credential',
  );
}

/**
 * An identifier derived from a key, stably.
 *
 * Not a hash: a hex digest is a long digit-and-letter run that the opacity rule refuses about as
 * often as a random one, and it would be no more meaningful. This maps the key's own characters into
 * the safe alphabet, so the same key always yields the same id and two different keys effectively
 * never collide within one prefix and discriminator.
 */
export function deriveId(
  prefix: string,
  discriminator: string,
  key: string,
  validate: (candidate: string) => void = () => undefined,
): string {
  const source = `${discriminator}:${key}`;
  // FNV-1a over 128 bits, four 32-bit lanes seeded differently. Not cryptographic and not trying to
  // be: this needs determinism and a low collision rate, and it needs to be readable.
  const lanes = [0x811c9dc5, 0x01000193, 0x9e3779b9, 0x85ebca6b];
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    for (let lane = 0; lane < lanes.length; lane += 1) {
      const current = lanes[lane] ?? 0;
      lanes[lane] = Math.imul(current ^ (code + lane), 0x01000193) >>> 0;
    }
  }

  let out = '';
  for (const lane of lanes) {
    let value = lane >>> 0;
    for (let index = 0; index < 6; index += 1) {
      out += ALPHABET[value % ALPHABET.length] ?? '0';
      value = Math.floor(value / ALPHABET.length);
    }
  }

  const candidate = `${prefix}_${out}`;
  validate(candidate);
  return candidate;
}

/**
 * The context a real request gets.
 *
 * The only caller of `new Date()` in the request path, and the only caller of `randomBytes`.
 */
export function requestContext(options: {
  readonly correlationId: string;
  readonly idempotencyKey: string;
  /** Overridable so a test can be exact. Defaults to the system clock. */
  readonly now?: string;
  /** K-01's opacity rule, supplied by the application. */
  readonly validate?: (candidate: string) => void;
}): RequestContext {
  const now = options.now ?? nowInstant();
  const validate = options.validate;
  return {
    now,
    correlationId: options.correlationId,
    idempotencyKey: options.idempotencyKey,
    newId: (prefix) => randomId(prefix, validate === undefined ? {} : { validate }),
    derivedId: (prefix, discriminator) =>
      deriveId(prefix, discriminator, options.idempotencyKey, validate),
  };
}

/**
 * The current instant, in the form every validator in this repository accepts.
 *
 * `toISOString` gives milliseconds; the platform's instants are microsecond-capable, so the extra
 * digits are supplied as zeros rather than left off, which keeps every instant the same width.
 */
export function nowInstant(clock: () => number = Date.now): string {
  return new Date(clock()).toISOString().replace(/\.(\d{3})Z$/, '.$1000Z');
}
