/**
 * K-02 Authentication — the four things this component refuses to do itself (FND-004c).
 *
 * Each port exists because the alternative is worse:
 *
 *   - **`Verifier`** decides whether a proof is good. K-02 must not, because deciding would mean
 *     holding the proof — a password, a key, a biometric template — and the single most valuable
 *     thing this component can do is never hold one. It asks, and it checks the answer.
 *   - **`SubjectLookup`** says whether a K-01 subject exists. K-01's `IdentityService.exists`
 *     satisfies it structurally, exactly as it does for K-03.
 *   - **`Clock`** supplies "now". Session expiry is the one thing here that is a function of time,
 *     so a component that read the wall clock would have tests that pass in the morning.
 *   - **`EntropySource`** supplies session secrets. Injected so tests are deterministic — and
 *     because it is the only way to state, and check, that **a caller cannot choose a session
 *     secret**. A `sessionToken` field on a request would let anybody mint the session they wanted.
 *
 * The verifier port is the security boundary of the whole component. Everything else here is
 * bookkeeping around it.
 *
 * Owned by: K-02 Authentication.
 */

import type { AssuranceLevel, FactorCategory } from './types.ts';

/**
 * What K-02 hands a verifier.
 *
 * `proof` is opaque and is **never stored, never logged and never included in an error message**.
 * It is whatever the provider's adapter needs — a signed assertion, a one-time code, a WebAuthn
 * response — and this component's only interest in it is handing it over.
 */
export interface VerifierChallenge {
  readonly provider: string;
  /** The opaque handle the provider knows this subject by. */
  readonly providerReference: string;
  /**
   * Opaque proof material. Passed straight through to the verifier and dropped.
   *
   * Typed as `unknown` on purpose: K-02 has no business inspecting it, and a typed shape would
   * invite code that does.
   */
  readonly proof: unknown;
}

/**
 * What a verifier hands back.
 *
 * Every field is checked against what was asked. A verifier that returns an assertion for a
 * different provider or a different reference is either buggy or being replayed across bindings,
 * and both are refused.
 */
export interface VerifierAssertion {
  /** The verifier's own identifier for this assertion. Consumed exactly once, ever. */
  readonly assertionId: string;
  readonly provider: string;
  readonly providerReference: string;
  /** Which factor categories the verifier actually checked. */
  readonly factors: readonly FactorCategory[];
  readonly assurance: AssuranceLevel;
  /** When the verifier verified, by its own clock. */
  readonly verifiedAt: string;
  /** After this instant the assertion is stale and K-02 refuses it. */
  readonly expiresAt: string;
}

/**
 * The authority on whether a proof is good.
 *
 * Implementations live outside this component — a provider adapter, an external identity service,
 * a hardware token backend. **None ships in this slice**, which is why nothing here can actually
 * authenticate a real person yet, and why the contract says so.
 *
 * A verifier that throws is a verifier that refused. K-02 normalises the throw into
 * `invalid-assertion` without inspecting it, because a verifier's internal failure modes are not
 * this component's vocabulary — and because an error object from a provider is exactly the kind of
 * thing that carries a fragment of the proof in its message.
 */
export interface Verifier {
  readonly provider: string;
  verify(challenge: VerifierChallenge): Promise<VerifierAssertion>;
}

/** K-01's existence check. `IdentityService` satisfies this structurally. */
export interface SubjectLookup {
  exists(subjectId: string): Promise<boolean>;
}

/** "Now", as a canonical UTC instant. */
export interface Clock {
  now(): string;
}

/**
 * A source of session secrets.
 *
 * Must return at least 32 bytes of cryptographic randomness, base64url-encoded. K-02 checks the
 * shape and refuses anything weaker (`insufficient-entropy`) rather than minting a guessable
 * session — a source that silently degraded would otherwise be undetectable until somebody guessed
 * a token.
 */
export interface EntropySource {
  token(): string;
}

/**
 * A lookup that reports no subject at all.
 *
 * Fails closed: a caller with no identity component wired refuses every authentication rather than
 * quietly authenticating parties nobody has heard of.
 */
export const NO_SUBJECTS: SubjectLookup = {
  exists(): Promise<boolean> {
    return Promise.resolve(false);
  },
};

/**
 * A verifier that refuses everything, and the default when none is registered.
 *
 * The honest default. A missing verifier must not mean "skip verification"; it means nobody can
 * authenticate through that provider, which is exactly right when no provider adapter exists.
 */
export function refusingVerifier(provider: string): Verifier {
  return {
    provider,
    verify(): Promise<VerifierAssertion> {
      return Promise.reject(
        new Error(
          `no verifier is wired for provider "${provider}". Refusing rather than treating an ` +
            'unverifiable proof as verified',
        ),
      );
    },
  };
}
