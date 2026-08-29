/**
 * K-02 Authentication — verifier adapters.
 *
 * These implementations live outside the core service so that K-02 itself never holds a credential,
 * a secret, or provider-specific logic. A real deployment wires one or more real provider adapters
 * here; the mock verifier exists for development and tests only.
 */

export { MockVerifier } from './mock-verifier.ts';
export type { MockVerifierOptions, ProofPredicate, ClockSupplier } from './mock-verifier.ts';
