/**
 * K-02 Authentication — the immutability boundary (FND-004c).
 *
 * One function per record type, applied at every point one crosses a boundary: service results,
 * every in-memory seed, read and write, and PostgreSQL decoding. One boundary rather than a freeze
 * at each site, because a rule applied in six places is a rule that will be applied in five after
 * the next change — which is how K-09 shipped with a frozen record whose `actor` was still writable
 * (CURRENT_IMPLEMENTATION_STATUS §11.20).
 *
 * Each seal **clones and freezes**. Cloning severs the caller's reference; freezing makes the
 * attempt throw rather than fail silently.
 *
 * `factors` is an array, so it is copied and frozen too. A caller that could push onto the factor
 * list of a session it holds could make a single-factor session claim to be multi-factor — which is
 * the whole assurance model, defeated through an array nobody thought of as state.
 *
 * Owned by: K-02 Authentication.
 */

import type {
  AuthenticationBinding,
  AuthenticationEvidence,
  AuthenticationSession,
  FactorCategory,
} from './types.ts';

/** Sorted, copied and frozen. Sorted so two equal sets compare equal by value. */
export function sealFactors(factors: readonly FactorCategory[]): readonly FactorCategory[] {
  return Object.freeze([...factors].sort());
}

export function sealBinding(binding: AuthenticationBinding): AuthenticationBinding {
  return Object.freeze({ ...binding });
}

export function sealBindings(
  bindings: readonly AuthenticationBinding[],
): readonly AuthenticationBinding[] {
  return Object.freeze(bindings.map(sealBinding));
}

export function sealEvidence(evidence: AuthenticationEvidence): AuthenticationEvidence {
  return Object.freeze({ ...evidence, factors: sealFactors(evidence.factors) });
}

export function sealEvidenceList(
  list: readonly AuthenticationEvidence[],
): readonly AuthenticationEvidence[] {
  return Object.freeze(list.map(sealEvidence));
}

export function sealSession(session: AuthenticationSession): AuthenticationSession {
  return Object.freeze({ ...session, factors: sealFactors(session.factors) });
}

export function sealSessions(
  sessions: readonly AuthenticationSession[],
): readonly AuthenticationSession[] {
  return Object.freeze(sessions.map(sealSession));
}

/**
 * Is this record sealed all the way down?
 *
 * Exported so a test can assert the property directly rather than by attempting one mutation and
 * hoping that attempt was representative of the rest.
 */
export function isSealed(record: { readonly factors?: readonly unknown[] }): boolean {
  return Object.isFrozen(record) && (record.factors === undefined || Object.isFrozen(record.factors));
}
