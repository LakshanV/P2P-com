/**
 * K-02 Authentication — verifier adapters.
 *
 * These implementations live outside the core service so that K-02 itself never holds a credential,
 * a secret, or provider-specific logic. A real deployment wires one or more real provider adapters
 * here; the mock verifier exists for development and tests only.
 */

export { MockVerifier } from './mock-verifier.ts';
export type { MockVerifierOptions, ProofPredicate, ClockSupplier } from './mock-verifier.ts';

export {
  InMemoryPasswordCredentialStore,
  PasswordVerifier,
  resetDecoyForTests,
} from './password-verifier.ts';
export type {
  PasswordCredential,
  PasswordCredentialStore,
  PasswordVerifierOptions,
} from './password-verifier.ts';

export {
  MAXIMUM_PASSWORD_LENGTH,
  MINIMUM_PASSWORD_LENGTH,
  PRODUCTION_PARAMETERS,
  TEST_ONLY_FAST_PARAMETERS,
  WeakPasswordError,
  hashPassword,
  needsRehash,
  parseStoredHash,
  verifyPassword,
} from './password-hash.ts';
export type { ScryptParameters } from './password-hash.ts';
