/**
 * K-02 Authentication — session secrets, and the one place they exist (FND-004c).
 *
 * A session secret is the only thing in this repository that is worth stealing on its own. Holding
 * one is being the subject, for as long as the session lives. So it gets a type of its own whose
 * whole job is to make careless handling **fail loudly**:
 *
 *   - `toString()` and `toJSON()` return a redaction marker, so a secret cannot reach a log line, a
 *     template literal, an error message or a JSON body by accident. That is the failure mode this
 *     guards: nobody writes `log(token.secret)`, but everybody writes `log({ result })`.
 *   - The secret comes out only through `reveal()`, which is deliberately ugly to read and
 *     deliberately easy to grep for.
 *   - `reveal()` works **once**. A second call throws. A session secret is presented to the caller
 *     one time — the whole point of returning it rather than storing it — and a component that
 *     could re-read it has, in effect, stored it.
 *
 * The stored representation is a SHA-256. Not a password hash: this is a 32-byte random value, not
 * a low-entropy human secret, so a slow KDF would buy nothing against an attacker who already has
 * the table and cost every request that validates a session. What it does buy is that a database
 * read yields no usable tokens.
 *
 * Owned by: K-02 Authentication.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

import { AuthenticationError } from './types.ts';

/** What a session secret looks like in any output that is not `reveal()`. */
export const REDACTED = '[redacted session secret]';

/** 32 bytes, base64url. Anything shorter is refused rather than issued. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43,512}$/;

/**
 * A session secret that can be read once and cannot be printed.
 *
 * Not a string, on purpose. A string would be indistinguishable from every other string in the
 * codebase the moment it left this file.
 */
export class SessionToken {
  #secret: string | null;

  constructor(secret: string) {
    assertUsableSecret(secret);
    this.#secret = secret;
  }

  /**
   * The secret, once.
   *
   * Named to be conspicuous in a diff and in a grep. A second call throws rather than returning
   * the value again — presenting a session secret twice is the same as storing it.
   */
  reveal(): string {
    if (this.#secret === null) {
      throw new AuthenticationError(
        'invalid-token',
        'a session secret has already been revealed and cannot be read again. It is presented ' +
          'exactly once; a component that could re-read it would be holding it',
      );
    }
    const secret = this.#secret;
    this.#secret = null;
    return secret;
  }

  /** True until `reveal()` has been called. */
  get revealed(): boolean {
    return this.#secret === null;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  /** Node's inspector, so `console.log` and assertion diffs redact too. */
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return REDACTED;
  }
}

/** The stored representation. Lower-case hex, 64 characters. */
export function hashToken(secret: string): string {
  assertUsableSecret(secret);
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/** Exactly what `hashToken` emits, and nothing else. */
export const TOKEN_HASH = /^[0-9a-f]{64}$/;

/**
 * Compare two hashes without leaking where they first differ.
 *
 * Both are already digests of a 32-byte random value, so a timing oracle here is of limited use —
 * but "of limited use" is the reasoning that precedes every timing attack, and the constant-time
 * comparison costs nothing.
 */
export function hashesEqual(left: string, right: string): boolean {
  if (!TOKEN_HASH.test(left) || !TOKEN_HASH.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

/**
 * Refuse a secret that is too short or wrongly shaped.
 *
 * The check exists because the entropy source is injected. A production wiring that pointed at
 * something degraded — a stub left behind, a counter, a truncated read — would otherwise mint
 * guessable sessions silently, and nothing would notice until somebody guessed one.
 */
function assertUsableSecret(secret: unknown): asserts secret is string {
  if (typeof secret !== 'string' || !TOKEN_SHAPE.test(secret)) {
    throw new AuthenticationError(
      'insufficient-entropy',
      'the entropy source produced an unusable session secret. At least 43 base64url characters ' +
        '(32 bytes) are required; a shorter or differently shaped value is refused rather than ' +
        'issued, because a degraded source would otherwise mint guessable sessions in silence',
    );
  }
}
