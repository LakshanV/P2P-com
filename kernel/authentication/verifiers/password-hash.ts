/**
 * Password hashing, and nothing else.
 *
 * Separated from the verifier so the hashing decisions can be read, argued with and tested on their
 * own. Everything in this file is about one question: given that a password will be stolen from
 * somewhere eventually, what makes the stolen thing useless?
 *
 * **scrypt, from `node:crypto`.** Not because it beats argon2id — argon2id is the better modern
 * choice — but because it is the best memory-hard KDF available without adding a dependency, and
 * this repository has exactly one runtime dependency (`pg`) on purpose. scrypt is on OWASP's
 * accepted list, and the alternative to using it is either a native module in the build or a fast
 * hash, and a fast hash is not a choice at all.
 *
 * **Parameters travel with the hash.** The stored form is
 * `scrypt$N=<n>,r=<r>,p=<p>,len=<len>$<salt>$<hash>`, so raising the cost later does not invalidate
 * a single existing credential: an old hash still verifies under its own parameters, and
 * `needsRehash` says it should be upgraded the next time the password is known — which is exactly
 * once, at the moment somebody logs in. A scheme with the parameters compiled in is a scheme that
 * is stuck at whatever was affordable in the year it shipped.
 *
 * **Comparison is timing-safe.** `===` on a hash leaks how many bytes matched, one byte at a time,
 * which over enough attempts is the whole hash.
 *
 * Owned by: K-02 Authentication.
 */

import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

export interface ScryptParameters {
  /** CPU/memory cost. A power of two. Doubling it doubles both time and memory. */
  readonly n: number;
  /** Block size. Raising it raises memory use without raising time much. */
  readonly r: number;
  /** Parallelisation. */
  readonly p: number;
  /** Derived key length, in bytes. */
  readonly keyLength: number;
}

/**
 * The parameters a deployment should use.
 *
 * N = 2^17, r = 8, p = 1 is OWASP's interactive-login recommendation, and costs roughly 128 MB and
 * a few hundred milliseconds per verification. That cost is the point: it is what makes a stolen
 * table expensive to attack, and it is why login is rate-limited elsewhere rather than made cheap
 * here.
 */
export const PRODUCTION_PARAMETERS: ScryptParameters = Object.freeze({
  n: 131_072,
  r: 8,
  p: 1,
  keyLength: 32,
});

/**
 * Cheap parameters, for tests only.
 *
 * Named `TEST_ONLY_` so it cannot be selected by accident or mistaken for a tuning choice. A suite
 * that ran at production cost would take minutes and would eventually be deleted by somebody in a
 * hurry, which is a worse outcome than a suite that hashes cheaply and says so.
 */
export const TEST_ONLY_FAST_PARAMETERS: ScryptParameters = Object.freeze({
  n: 1_024,
  r: 8,
  p: 1,
  keyLength: 32,
});

/** How much memory scrypt is permitted, derived from the parameters with headroom. */
function maxmemFor(parameters: ScryptParameters): number {
  return 256 * parameters.n * parameters.r * 2;
}

function encodeParameters(parameters: ScryptParameters): string {
  return `N=${String(parameters.n)},r=${String(parameters.r)},p=${String(parameters.p)},len=${String(parameters.keyLength)}`;
}

/**
 * Hash a password.
 *
 * The salt is 16 random bytes, per password. A shared salt would let one rainbow table cover every
 * account at once, which is the whole reason salts exist.
 */
export async function hashPassword(
  password: string,
  parameters: ScryptParameters = PRODUCTION_PARAMETERS,
  salt: Buffer = randomBytes(16),
): Promise<string> {
  assertUsablePassword(password);
  const derived = await derive(password.normalize('NFKC'), salt, parameters.keyLength, {
    N: parameters.n,
    r: parameters.r,
    p: parameters.p,
    maxmem: maxmemFor(parameters),
  });
  return `scrypt$${encodeParameters(parameters)}$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

interface ParsedHash {
  readonly parameters: ScryptParameters;
  readonly salt: Buffer;
  readonly hash: Buffer;
}

/** Read a stored hash, or null when it is not one this code wrote. */
export function parseStoredHash(stored: string): ParsedHash | null {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return null;

  const [, encoded, saltPart, hashPart] = parts;
  if (encoded === undefined || saltPart === undefined || hashPart === undefined) return null;

  const values = new Map<string, number>();
  for (const pair of encoded.split(',')) {
    const [key, raw] = pair.split('=');
    if (key === undefined || raw === undefined) return null;
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) return null;
    values.set(key, value);
  }

  const n = values.get('N');
  const r = values.get('r');
  const p = values.get('p');
  const keyLength = values.get('len');
  if (n === undefined || r === undefined || p === undefined || keyLength === undefined) return null;

  return {
    parameters: { n, r, p, keyLength },
    salt: Buffer.from(saltPart, 'base64url'),
    hash: Buffer.from(hashPart, 'base64url'),
  };
}

/**
 * Whether a password matches a stored hash.
 *
 * Returns false rather than throwing for a malformed stored value: a corrupt row is a failed
 * authentication, not a crash, and a caller that could tell the two apart would have learned
 * something about the row.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parseStoredHash(stored);
  if (parsed === null) return false;

  let derived: Buffer;
  try {
    derived = await derive(password.normalize('NFKC'), parsed.salt, parsed.parameters.keyLength, {
      N: parsed.parameters.n,
      r: parsed.parameters.r,
      p: parsed.parameters.p,
      maxmem: maxmemFor(parsed.parameters),
    });
  } catch {
    // Parameters the platform will not honour — an N large enough to exhaust memory, say. Refusing
    // is right; a stored hash nobody can compute is a credential nobody can use.
    return false;
  }

  if (derived.length !== parsed.hash.length) return false;
  return timingSafeEqual(derived, parsed.hash);
}

/**
 * Whether a stored hash was made with weaker parameters than the deployment now wants.
 *
 * The only moment a password can be rehashed is the moment it is known, which is the moment somebody
 * logs in. A system without this check keeps every credential at the parameters that were affordable
 * when the account was created, for ever.
 */
export function needsRehash(
  stored: string,
  wanted: ScryptParameters = PRODUCTION_PARAMETERS,
): boolean {
  const parsed = parseStoredHash(stored);
  if (parsed === null) return true;
  return (
    parsed.parameters.n < wanted.n ||
    parsed.parameters.r < wanted.r ||
    parsed.parameters.p < wanted.p ||
    parsed.parameters.keyLength < wanted.keyLength
  );
}

/**
 * The floor on what may be hashed at all.
 *
 * Deliberately a floor and not a policy. Length is the only rule with good evidence behind it;
 * composition rules ("one uppercase, one symbol") measurably push people towards `Password1!` and
 * are not imposed here. A deployment that wants a real policy — a breach-corpus check, a length
 * appropriate to its risk — owns that in K-06 Policy Engine, where it can be versioned and where
 * changing it leaves a record.
 *
 * The upper bound exists because scrypt's cost is a function of the parameters and not of the input,
 * so an unbounded password is a way to make the server do unbounded work.
 */
export const MINIMUM_PASSWORD_LENGTH = 12;
export const MAXIMUM_PASSWORD_LENGTH = 256;

export class WeakPasswordError extends Error {
  readonly code = 'weak-password';

  constructor(message: string) {
    super(message);
    this.name = 'WeakPasswordError';
  }
}

function assertUsablePassword(password: string): void {
  if (typeof password !== 'string') {
    throw new WeakPasswordError('a password must be a string');
  }
  // Counted in code points, not UTF-16 units: an emoji is one character to the person who typed it,
  // and counting it as two would make a rule about length behave differently by alphabet.
  const length = [...password].length;
  if (length < MINIMUM_PASSWORD_LENGTH) {
    throw new WeakPasswordError(
      `a password must be at least ${String(MINIMUM_PASSWORD_LENGTH)} characters. Length is the ` +
        'only rule with good evidence behind it; composition rules push people towards predictable ' +
        'passwords and are not imposed here',
    );
  }
  if (length > MAXIMUM_PASSWORD_LENGTH) {
    throw new WeakPasswordError(
      `a password may be at most ${String(MAXIMUM_PASSWORD_LENGTH)} characters. The bound exists ` +
        'because hashing cost is fixed by the parameters, so an unbounded input is a way to make ' +
        'the server do unbounded work',
    );
  }
}
