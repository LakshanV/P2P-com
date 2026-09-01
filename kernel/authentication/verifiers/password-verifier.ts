/**
 * K-02 Authentication — a password verifier.
 *
 * The first verifier in this repository that can authenticate a real person. Until now K-02 shipped
 * only `mock-verifier.ts`, which accepts any non-empty string, and the contract said plainly that
 * nobody could log in.
 *
 * It sits behind K-02's `Verifier` port, so what it establishes is narrow and replaceable: it says
 * "this proof is good for this reference", and K-02 does everything else — the binding, the
 * assertion consumed exactly once, the session, the MFA floor. Adding OTP or OIDC later means
 * writing another implementation of the same interface, not changing this one.
 *
 * **K-02 still never holds a password.** This verifier holds a *hash*, which is the whole reason
 * the port exists: the component that manages sessions is kept away from the proof, and the thing
 * that touches the proof does nothing else.
 *
 * Three decisions are worth reading before the code.
 *
 * **A missing credential costs the same as a wrong password.** If an unknown reference returned
 * immediately and a known one spent 200ms hashing, the response time would answer the question "does
 * this account exist?" for anyone who cared to ask — and that question is worth answering for an
 * attacker long before the password is. So an unknown reference is hashed against a fixed decoy and
 * the result discarded.
 *
 * **A single factor is reported as a single factor.** `assurance: 'single-factor'`,
 * `factors: ['knowledge']`. It would be trivial to claim more and it would defeat K-02's MFA floor,
 * which is the mechanism by which a deployment can insist on more than a password.
 *
 * **Nothing here logs, stores or returns the proof.** Not on success, not on failure, not in an
 * error message. A password in a log is a password that has been disclosed.
 *
 * Owned by: K-02 Authentication.
 */

import type { Verifier, VerifierAssertion, VerifierChallenge } from '../ports.ts';

import {
  PRODUCTION_PARAMETERS,
  hashPassword,
  needsRehash,
  verifyPassword,
  type ScryptParameters,
} from './password-hash.ts';

/** One stored credential. The password itself is not here and never was. */
export interface PasswordCredential {
  /** The opaque handle the provider knows this subject by. */
  readonly providerReference: string;
  /** `scrypt$N=…,r=…,p=…,len=…$salt$hash`. */
  readonly storedHash: string;
  /** When the credential was last set, as a UTC instant. */
  readonly updatedAt: string;
}

/**
 * Where credentials live.
 *
 * A port, so this verifier does not decide on a database. An in-memory implementation ships for
 * tests; the PostgreSQL one is wired by the application.
 */
export interface PasswordCredentialStore {
  find(providerReference: string): Promise<PasswordCredential | null>;
  /** Replace the stored hash. Used to set a password and to upgrade one after a parameter change. */
  put(credential: PasswordCredential): Promise<void>;
}

/** An in-memory store, for tests and local development. */
export class InMemoryPasswordCredentialStore implements PasswordCredentialStore {
  readonly #credentials = new Map<string, PasswordCredential>();

  find(providerReference: string): Promise<PasswordCredential | null> {
    return Promise.resolve(this.#credentials.get(providerReference) ?? null);
  }

  put(credential: PasswordCredential): Promise<void> {
    this.#credentials.set(credential.providerReference, { ...credential });
    return Promise.resolve();
  }

  /** Every reference held, for a test that needs to assert on the store rather than through it. */
  references(): readonly string[] {
    return Object.freeze([...this.#credentials.keys()].sort());
  }
}

export interface PasswordVerifierOptions {
  readonly provider?: string;
  readonly store: PasswordCredentialStore;
  /** "Now", injected. A verifier that read the wall clock would have tests that pass in the morning. */
  readonly now: () => string;
  /** Mints assertion identifiers. Injected so a test can assert on an exact assertion. */
  readonly newAssertionId: () => string;
  /** Hashing cost. Tests pass `TEST_ONLY_FAST_PARAMETERS`. */
  readonly parameters?: ScryptParameters;
  /** How long an assertion stays usable. Short: it is handed straight back to K-02. */
  readonly assertionLifetimeSeconds?: number;
  /**
   * Called when a credential verified under weaker parameters than the deployment now wants.
   *
   * The rehash itself happens here — this is the one moment the password is known — and the callback
   * exists so an application can observe it rather than discover it from a metric it does not have.
   */
  readonly onRehash?: (providerReference: string) => void;
}

const DEFAULT_PROVIDER = 'password';
const DEFAULT_ASSERTION_LIFETIME_SECONDS = 120;

/**
 * A fixed decoy hash, used when no credential exists.
 *
 * Computed once, lazily, under the deployment's own parameters, so an unknown reference costs the
 * same as a known one. The password behind it is a constant that nothing can authenticate with,
 * because the decoy result is discarded rather than compared.
 */
let decoy: { readonly parameters: ScryptParameters; readonly hash: string } | null = null;

async function decoyHashFor(parameters: ScryptParameters): Promise<string> {
  if (decoy !== null && decoy.parameters === parameters) return decoy.hash;
  const hash = await hashPassword(
    'a-decoy-that-authenticates-nothing-at-all',
    parameters,
    Buffer.alloc(16, 7),
  );
  decoy = { parameters, hash };
  return hash;
}

/** Reset the memoised decoy. Test-only; parameters change between suites. */
export function resetDecoyForTests(): void {
  decoy = null;
}

export class PasswordVerifier implements Verifier {
  readonly provider: string;
  readonly #store: PasswordCredentialStore;
  readonly #now: () => string;
  readonly #newAssertionId: () => string;
  readonly #parameters: ScryptParameters;
  readonly #lifetimeSeconds: number;
  readonly #onRehash: ((providerReference: string) => void) | undefined;

  constructor(options: PasswordVerifierOptions) {
    this.provider = options.provider ?? DEFAULT_PROVIDER;
    this.#store = options.store;
    this.#now = options.now;
    this.#newAssertionId = options.newAssertionId;
    this.#parameters = options.parameters ?? PRODUCTION_PARAMETERS;
    this.#lifetimeSeconds = options.assertionLifetimeSeconds ?? DEFAULT_ASSERTION_LIFETIME_SECONDS;
    this.#onRehash = options.onRehash;
  }

  /**
   * Set or replace a password.
   *
   * Not part of the `Verifier` port: verifying and enrolling are different operations with different
   * authority, and a port that offered both would let anything holding a verifier set a password.
   */
  async setPassword(providerReference: string, password: string): Promise<void> {
    const storedHash = await hashPassword(password, this.#parameters);
    await this.#store.put({ providerReference, storedHash, updatedAt: this.#now() });
  }

  /**
   * Check a proof.
   *
   * Throws on any failure, with a message that says nothing about which failure it was. K-02
   * normalises a throwing verifier into `invalid-assertion` without inspecting it, so the distinction
   * between "no such account" and "wrong password" never leaves this function — and it must not, or
   * the error becomes an account-enumeration oracle to go with the timing one.
   */
  async verify(challenge: VerifierChallenge): Promise<VerifierAssertion> {
    if (challenge.provider !== this.provider) {
      throw new Error('this verifier was asked about a provider it does not serve');
    }

    const proof = challenge.proof;
    const credential = await this.#store.find(challenge.providerReference);

    // The proof is read as a string and never inspected further. A non-string proof still costs a
    // hash, for the same reason a missing credential does.
    const password = typeof proof === 'string' ? proof : '';

    if (credential === null) {
      // Hash against the decoy and throw the same refusal. The work is deliberate: without it, the
      // response time answers "does this account exist?" for anybody who asks.
      await verifyPassword(password, await decoyHashFor(this.#parameters));
      throw new Error('verification failed');
    }

    const matched = await verifyPassword(password, credential.storedHash);
    if (!matched) throw new Error('verification failed');

    // The one moment the password is known. A deployment that raised its parameters would otherwise
    // keep every existing credential at the old cost for ever.
    if (needsRehash(credential.storedHash, this.#parameters)) {
      await this.setPassword(challenge.providerReference, password);
      this.#onRehash?.(challenge.providerReference);
    }

    const verifiedAt = this.#now();
    return Object.freeze({
      assertionId: this.#newAssertionId(),
      provider: this.provider,
      providerReference: challenge.providerReference,
      // A password is one thing you know. Claiming more would defeat K-02's MFA floor, which is the
      // mechanism a deployment uses to insist on more than this.
      factors: Object.freeze(['knowledge'] as const),
      assurance: 'single-factor',
      verifiedAt,
      expiresAt: addSeconds(verifiedAt, this.#lifetimeSeconds),
    });
  }
}

/** Add seconds to a UTC instant, keeping the width every validator in this repository expects. */
function addSeconds(instant: string, seconds: number): string {
  const millis = Date.parse(instant);
  if (Number.isNaN(millis)) {
    throw new Error(`the injected clock returned "${instant}", which is not a UTC instant`);
  }
  return new Date(millis + seconds * 1000).toISOString().replace(/\.(\d{3})Z$/, '.$1000Z');
}
