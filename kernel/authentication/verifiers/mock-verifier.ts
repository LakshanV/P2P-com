/**
 * K-02 Authentication — a deterministic mock verifier for local development and tests.
 *
 * This verifier does **not** authenticate a real person. It exists so that development and tests can
 * exercise the authentication flow without external credentials or side channels (SMS, email,
 * passkey hardware). Every real deployment must wire at least one real verifier instead.
 *
 * The mock validates proof material against a caller-supplied predicate. By default it accepts any
 * non-empty proof string as a single-factor possession assertion, which is enough for local
 * development but would be catastrophically insecure in production.
 *
 * Owned by: K-02 Authentication.
 */

import {
  ASSURANCE_LEVELS,
  FACTOR_CATEGORIES,
  type AssuranceLevel,
  type FactorCategory,
} from '../types.ts';
import type { Verifier, VerifierAssertion, VerifierChallenge } from '../ports.ts';

export type ProofPredicate = (reference: string, proof: unknown) => boolean;

/** Supplier of "now" for deterministic tests. Defaults to the system clock. */
export interface ClockSupplier {
  now(): number;
}

export interface MockVerifierOptions {
  /** Provider name. Must match the provider registered with AuthenticationService. */
  readonly provider?: string;
  /** Predicate that decides whether proof material is valid. */
  readonly isValidProof?: ProofPredicate;
  /** Fixed map of provider reference -> valid proof string. */
  readonly validCodes?: Readonly<Record<string, string>>;
  /** Factor categories reported in successful assertions. */
  readonly factors?: readonly FactorCategory[];
  /** Assurance level reported in successful assertions. */
  readonly assurance?: AssuranceLevel;
  /** Assertion expiry in seconds from verification time. */
  readonly assertionExpiresAfterSeconds?: number;
  /** Clock supplier for deterministic tests. */
  readonly clock?: ClockSupplier;
}

const DEFAULT_PROVIDER = 'mock';

const systemClock: ClockSupplier = {
  now(): number {
    return Date.now();
  },
};

function defaultIsValidProof(_reference: string, proof: unknown): boolean {
  return typeof proof === 'string' && proof.length > 0;
}

function isValidCode(
  reference: string,
  proof: unknown,
  codes: Readonly<Record<string, string>>,
): boolean {
  const expected = codes[reference];
  if (expected === undefined) return false;
  return typeof proof === 'string' && proof === expected;
}

/** Extract a human-readable proof string for logging, never echoing raw secrets beyond their type. */
function proofDescription(proof: unknown): string {
  if (proof === null) return 'null';
  if (proof === undefined) return 'undefined';
  if (typeof proof === 'string') return `string(${proof.length} chars)`;
  if (typeof proof === 'object') return `object(${Object.keys(proof).join(', ')})`;
  return typeof proof;
}

/**
 * A deterministic mock verifier.
 *
 * Assertion ids are derived from the challenge content so that the same challenge always produces the
 * same assertion id, which makes tests reproducible without requiring a database sequence.
 */
export class MockVerifier implements Verifier {
  readonly provider: string;
  readonly #isValidProof: ProofPredicate;
  readonly #factors: readonly FactorCategory[];
  readonly #assurance: AssuranceLevel;
  readonly #assertionExpiresAfterSeconds: number;
  readonly #clock: ClockSupplier;
  readonly #assertionCounter = new Map<string, number>();

  constructor(options: MockVerifierOptions = {}) {
    this.provider = options.provider ?? DEFAULT_PROVIDER;
    this.#clock = options.clock ?? systemClock;

    if (options.validCodes !== undefined && options.isValidProof !== undefined) {
      throw new Error(
        'MockVerifier accepts either validCodes or isValidProof, not both. Provide one way to ' +
          'decide proof validity.',
      );
    }

    if (options.validCodes !== undefined) {
      this.#isValidProof = (reference, proof) => isValidCode(reference, proof, options.validCodes!);
    } else {
      this.#isValidProof = options.isValidProof ?? defaultIsValidProof;
    }

    this.#factors = options.factors ?? ['knowledge'];
    this.#assurance = options.assurance ?? 'single-factor';
    this.#assertionExpiresAfterSeconds = options.assertionExpiresAfterSeconds ?? 300;

    this.#assertFactorsValid(this.#factors);
    this.#assertAssuranceValid(this.#assurance);
  }

  verify(challenge: VerifierChallenge): Promise<VerifierAssertion> {
    if (challenge.provider !== this.provider) {
      return Promise.reject(
        new Error(
          `MockVerifier for "${this.provider}" was asked to verify a challenge for ` +
            `"${challenge.provider}". A verifier must only answer for its own provider.`,
        ),
      );
    }

    if (!this.#isValidProof(challenge.providerReference, challenge.proof)) {
      return Promise.reject(
        new Error(
          `mock verifier refused proof for ${challenge.providerReference}: ${proofDescription(challenge.proof)}`,
        ),
      );
    }

    const nowMs = this.#clock.now();
    const now = new Date(nowMs).toISOString();
    const expiresAt = new Date(nowMs + this.#assertionExpiresAfterSeconds * 1000).toISOString();

    const assertionId = this.#nextAssertionId(challenge);

    return Promise.resolve({
      assertionId,
      provider: this.provider,
      providerReference: challenge.providerReference,
      factors: [...this.#factors],
      assurance: this.#assurance,
      verifiedAt: now,
      expiresAt,
    });
  }

  #nextAssertionId(challenge: VerifierChallenge): string {
    const key = `${challenge.provider}:${challenge.providerReference}`;
    const count = (this.#assertionCounter.get(key) ?? 0) + 1;
    this.#assertionCounter.set(key, count);
    return `asrt_mock_${this.provider}_${challenge.providerReference}_${count}`;
  }

  #assertFactorsValid(factors: readonly FactorCategory[]): void {
    const distinct = new Set(factors);
    if (distinct.size !== factors.length) {
      throw new Error(`MockVerifier factors contain duplicates: ${JSON.stringify(factors)}`);
    }
    for (const factor of factors) {
      if (!(FACTOR_CATEGORIES as readonly string[]).includes(factor)) {
        throw new Error(
          `MockVerifier factor "${factor}" is not one of ${FACTOR_CATEGORIES.join(', ')}`,
        );
      }
    }
  }

  #assertAssuranceValid(assurance: AssuranceLevel): void {
    if (!(ASSURANCE_LEVELS as readonly string[]).includes(assurance)) {
      throw new Error(
        `MockVerifier assurance "${assurance}" is not one of ${ASSURANCE_LEVELS.join(', ')}`,
      );
    }
  }
}
